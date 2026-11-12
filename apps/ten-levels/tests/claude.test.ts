import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeToolName, hookSettings, LEVEL_HOOKS, LEVEL_TOOLS, mcpConfig } from "../claude/config.ts";
import { textOf, writeTarget } from "../claude/hooks/guard.ts";
import { handle, selectTools } from "../claude/mcp/server.ts";
import { TOOLS } from "../claude/tools.ts";
import { growthOf, parseTranscript } from "../claude/transcript.ts";
import { agentEnv, splitTools } from "../server/agent-session.mjs";

const CLAUDE_DIR = fileURLToPath(new URL("../claude/", import.meta.url));

/** Run a script the way Claude Code does: JSON on stdin, JSON or text on stdout. Mock backend, private state. */
function run(script: string[], input: unknown, env: Record<string, string> = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", [join(CLAUDE_DIR, ...script)], { env: { ...process.env, JEV_BACKEND: "mock", ...env } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(input));
  });
}

const privateEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-test-"));
  return { dir, env: { JEV_STATE_DIR: dir, JEV_EVENT_LOG: join(dir, "events.jsonl") } };
};

const line = (o: unknown) => JSON.stringify(o);
const userEntry = (text: string, extra: object = {}) => line({ type: "user", message: { role: "user", content: text }, ...extra });
const assistantEntry = (tokens: number, tools: string[] = []) =>
  line({ type: "assistant", message: { role: "assistant", content: tools.map((name) => ({ type: "tool_use", name })), usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0 } } });

// transcript

test("Claude Code: the transcript yields requests, tool names, and context growth", () => {
  const t = parseTranscript([
    userEntry("Read the auth files"),
    assistantEntry(6000, ["Read"]),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    assistantEntry(9000, ["Read", "Bash"]),
    userEntry("<local-command-stdout>noise</local-command-stdout>"),
    userEntry("meta", { isMeta: true }),
    userEntry("sidechain", { isSidechain: true }),
    userEntry("Now write docs"),
    assistantEntry(12_500, ["Write"]),
  ].join("\n"));
  assert.deepEqual(t.userMessages, ["Read the auth files", "Now write docs"]);
  assert.equal(t.baselineTokens, 6000);
  assert.equal(t.contextTokens, 12_500);
  assert.equal(growthOf(t), 6500);
  assert.deepEqual(t.toolsThisTurn, ["Write"]);
});

test("Claude Code: a compaction summary resets the requests and the baseline", () => {
  const t = parseTranscript([
    userEntry("first"), assistantEntry(5000), userEntry("second"), assistantEntry(9000),
    userEntry("This session is being continued from a previous conversation. Summary: did things.", { isCompactSummary: true }),
    userEntry("third"), assistantEntry(3000),
  ].join("\n"));
  assert.deepEqual(t.userMessages, ["third"]);
  assert.match(t.lastSummary, /Summary: did things/);
  assert.equal(growthOf(t), 0);
});

test("Claude Code: a broken or empty transcript is an empty transcript", () => {
  assert.deepEqual(parseTranscript("not json\n\n{").userMessages, []);
  assert.equal(growthOf(parseTranscript("")), 0);
});

// level 6 hooks

test("L6 hook: tool response text is found in any shape, and write targets in any tool", () => {
  assert.equal(textOf({ stdout: "a", stderr: "b", interrupted: false }), "a\nb");
  assert.equal(textOf({ type: "text", file: { filePath: "/x", content: "hello" } }).includes("hello"), true);
  assert.deepEqual(writeTarget("Write", { file_path: "a.ts", content: "x" }), { path: "a.ts", content: "x" });
  assert.deepEqual(writeTarget("Edit", { file_path: "a.ts", old_string: "o", new_string: "n" }), { path: "a.ts", content: "n" });
  assert.deepEqual(writeTarget("MultiEdit", { file_path: "a.ts", edits: [{ new_string: "1" }, { new_string: "2" }] }), { path: "a.ts", content: "1\n2" });
});

test("L6 hook: a write outside the repo is denied in code, with Claude Code's deny shape", async () => {
  const { env } = privateEnv();
  const { stdout, code } = await run(["hooks", "guard.ts"], {
    hook_event_name: "PreToolUse", tool_name: "Write", cwd: "/repo", tool_input: { file_path: "/tmp/notes.txt", content: "hi" },
  }, { ...env, JEV_LEVEL_CONFIG: JSON.stringify({ gates: ["B"] }) });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /outside the repo/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /This block is final/);
});

test("L6 hook: a gate that is not turned on says nothing, and a tool it does not watch says nothing", async () => {
  const { env } = privateEnv();
  const off = await run(["hooks", "guard.ts"], {
    hook_event_name: "PreToolUse", tool_name: "Write", cwd: "/repo", tool_input: { file_path: "/tmp/notes.txt", content: "hi" },
  }, { ...env, JEV_LEVEL_CONFIG: JSON.stringify({ gates: ["A"] }) });
  assert.equal(off.stdout, "");
  const other = await run(["hooks", "guard.ts"], { hook_event_name: "PreToolUse", tool_name: "Glob", cwd: "/repo", tool_input: {} }, env);
  assert.equal(other.stdout, "");
});

// level 7 hooks

test("L7 hook: the first request is silent, and the user hears nothing", async () => {
  const { dir, env } = privateEnv();
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, [userEntry("only request"), assistantEntry(9000)].join("\n"));
  const { stdout } = await run(["hooks", "compact.ts"], { hook_event_name: "Stop", cwd: dir, transcript_path: transcript, last_assistant_message: "done" }, env);
  assert.equal(stdout, "");
  const events = readFileSync(env.JEV_EVENT_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events[0].kind, "hook");
  assert.equal(events[0].tier, "silent");
});

test("L7 hook: a waiting tier message rides on the next prompt once, then is gone", async () => {
  const { dir, env } = privateEnv();
  const memory = { pending_message: "Recommended: compact now.", pending_tier: "recommend" };
  const { writeMemory } = await import("../claude/lib.ts");
  const saved = process.env.JEV_STATE_DIR;
  process.env.JEV_STATE_DIR = env.JEV_STATE_DIR;
  writeMemory(dir, memory);
  process.env.JEV_STATE_DIR = saved;
  const prompt = { hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "next" };
  const first = JSON.parse((await run(["hooks", "compact.ts"], prompt, env)).stdout);
  assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(first.hookSpecificOutput.additionalContext, "Recommended: compact now.");
  assert.equal((await run(["hooks", "compact.ts"], prompt, env)).stdout, "");
});

test("L7 hook: PreCompact folds the agent's note into the summary instructions on stdout", async () => {
  const { dir, env } = privateEnv();
  const { writeMemory, readMemory } = await import("../claude/lib.ts");
  const saved = process.env.JEV_STATE_DIR;
  process.env.JEV_STATE_DIR = env.JEV_STATE_DIR;
  writeMemory(dir, { note: "Fixed rounding in billing.ts, tests next.", compact_requested: true });
  const out = await run(["hooks", "compact.ts"], { hook_event_name: "PreCompact", trigger: "manual", cwd: dir, transcript_path: join(dir, "missing.jsonl") }, env);
  assert.match(out.stdout, /Keep this note from the agent verbatim/);
  assert.match(out.stdout, /Fixed rounding in billing.ts/);
  assert.equal(readMemory(dir).note, null);
  assert.equal(readMemory(dir).compact_requested, false);
  process.env.JEV_STATE_DIR = saved;
});

test("L7 hook: when the agent asked to compact, the Stop hook tells the user to run /compact", async () => {
  const { dir, env } = privateEnv();
  const { writeMemory } = await import("../claude/lib.ts");
  const saved = process.env.JEV_STATE_DIR;
  process.env.JEV_STATE_DIR = env.JEV_STATE_DIR;
  writeMemory(dir, { compact_requested: true });
  process.env.JEV_STATE_DIR = saved;
  const out = JSON.parse((await run(["hooks", "compact.ts"], { hook_event_name: "Stop", cwd: dir }, env)).stdout);
  assert.match(out.systemMessage, /Run \/compact/);
});

// the MCP server

test("MCP: initialize, list, and call speak JSON-RPC and expose the selected tools", async () => {
  const tools = selectTools("ask_jev_file_bool,ask_jev");
  assert.deepEqual(tools.map((t) => t.name), ["ask_jev_file_bool", "ask_jev"]);
  assert.equal(selectTools(undefined).length, TOOLS.length);

  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, tools) as any;
  assert.equal(init.result.serverInfo.name, "jev");
  assert.match(init.result.instructions, /ask_jev/);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, tools), null);

  const listed = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tools) as any;
  assert.equal(listed.result.tools[0].inputSchema.type, "object");
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ["path", "question"]);

  const unknown = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }, tools) as any;
  assert.equal(unknown.error.code, -32602);
  const missing = await handle({ jsonrpc: "2.0", id: 4, method: "nope" }, tools) as any;
  assert.equal(missing.error.code, -32601);
});

test("MCP: a tool call over a real stdio process returns the typed answer, never the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-mcp-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "session.ts"), "export function validateToken(token) { return verify(token); }\n");
  const child = spawn("node", [join(CLAUDE_DIR, "mcp", "server.ts")], {
    env: { ...process.env, JEV_BACKEND: "mock", JEV_CWD: dir, JEV_MCP_TOOLS: "ask_jev_file_bool", JEV_STATE_DIR: dir, JEV_EVENT_LOG: join(dir, "events.jsonl") },
  });
  const replies: any[] = [];
  let buffer = "";
  const done = new Promise<void>((resolve) => {
    child.stdout.on("data", (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
        if (replies.length === 2) resolve();
      }
    });
  });
  child.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  child.stdin.write(line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_jev_file_bool", arguments: { path: "src/session.ts", question: "Does `content` validate tokens?" } } }) + "\n");
  await done;
  child.kill();
  const list = replies.find((r) => r.id === 1);
  const call = replies.find((r) => r.id === 2);
  assert.equal(list.result.tools.length, 1);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.path, "src/session.ts");
  assert.equal(typeof payload.noul, "number");
  assert.equal(call.result.content[0].text.includes("verify(token)"), false);
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events[0].source, "ask_jev_file_bool");
});

// configuration

test("Config: hooks for levels 6 and 7 are Claude Code's settings shape, and tools map to MCP names", () => {
  assert.deepEqual(Object.keys(hookSettings("guard").hooks), ["PreToolUse", "PostToolUse"]);
  assert.deepEqual(Object.keys(hookSettings("compact").hooks), ["UserPromptSubmit", "Stop", "PreCompact"]);
  const pre = hookSettings("guard").hooks.PreToolUse[0] as any;
  assert.match(pre.matcher, /Bash/);
  assert.equal(pre.hooks[0].type, "command");
  assert.equal(pre.hooks[0].command, "node");
  assert.match(pre.hooks[0].args[0], /hooks\/guard\.ts$/);
  assert.deepEqual(LEVEL_HOOKS, { 6: "guard", 7: "compact" });
  assert.deepEqual(Object.keys(LEVEL_TOOLS), ["7", "8", "9", "10"]);
  assert.equal(mcpConfig(["ask_jev"]).mcpServers.jev.env.JEV_MCP_TOOLS, "ask_jev");
  assert.equal(claudeToolName("bash"), "Bash");
  assert.equal(claudeToolName("ask_jev"), "mcp__jev__ask_jev");
  for (const names of Object.values(LEVEL_TOOLS)) {
    for (const name of names) assert.ok(TOOLS.some((t) => t.name === name), `${name} has a tool`);
  }
});

test("Lab: the session splits the scenario's tools, and the agent environment keeps the subscription and drops API keys", () => {
  const { builtIn, mcp } = splitTools(["read", "bash", "edit", "write", "compact_now", "should_i_compact"]);
  assert.deepEqual(builtIn, ["Read", "Bash", "Edit", "Write"]);
  assert.deepEqual(mcp, ["compact_now", "should_i_compact"]);

  const saved = { ...process.env };
  Object.assign(process.env, { HOME: "/home/x", ANTHROPIC_API_KEY: "sk-ant-secret", ANTHROPIC_AUTH_TOKEN: "t", OPENROUTER_API_KEY: "or-key", AWS_SECRET: "nope", JEV_AGENT_MODEL: "sonnet" });
  try {
    const env = agentEnv({ dir: "/d", cwd: "/c", eventLog: "/d/events.jsonl" }, { gates: ["A"] });
    assert.equal(env.HOME, "/home/x");
    assert.equal(env.OPENROUTER_API_KEY, "or-key");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.AWS_SECRET, undefined);
    assert.equal(env.JEV_EVENT_LOG, "/d/events.jsonl");
    assert.equal(env.JEV_CWD, "/c");
    assert.equal(JSON.parse(env.JEV_LEVEL_CONFIG).gates[0], "A");
    process.env.JEV_AGENT_ENV = "ANTHROPIC_API_KEY";
    assert.equal(agentEnv({ dir: "/d", cwd: "/c", eventLog: "/e" }, {}).ANTHROPIC_API_KEY, "sk-ant-secret");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
