/**
 * Level 6 hook: guardrails. The agent never asks for this check and never sees Jev.
 *
 *   PreToolUse   Bash                              gateBashCommand: block irreversible or destructive commands
 *                Write, Edit, MultiEdit, Notebook  gateWriteCall: block paths outside the repo (code) and credentials (Jev)
 *   PostToolUse  Read, Bash                        screenToolResult: add a warning when the output carries instructions
 *
 * Wire it with `node claude/config.ts 6`, which prints the settings JSON for `claude --settings`.
 * Every decision is reported to the event log so the lab window shows it as it happens.
 */
import { decide, isMain, levelConfig, readHookInput, report } from "../lib.ts";
import { BLOCK_NOTICE, gateBashCommand, gateWriteCall, screenToolResult } from "../../src/levels/level06/index.ts";

type Option = "A" | "B" | "C";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Every string inside a tool response, joined. Built in tool outputs differ in shape; the text is what matters. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(textOf).filter(Boolean).join("\n");
  return "";
}

/** The path and the new content of a write, whichever tool made it. */
export function writeTarget(tool: string, input: Record<string, any>): { path: string; content: string } {
  const path = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
  if (tool === "MultiEdit") return { path, content: (input.edits ?? []).map((e: any) => String(e?.new_string ?? "")).join("\n") };
  return { path, content: String(input.content ?? input.new_string ?? input.new_source ?? "") };
}

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

async function main() {
  const input = await readHookInput();
  const cfg = levelConfig<{ gates: Option[] }>({ gates: ["A", "B", "C"] });
  const on = (o: Option) => cfg.gates.includes(o);
  const tool = String(input.tool_name ?? "");
  const cwd = String(input.cwd ?? process.cwd());

  if (input.hook_event_name === "PreToolUse") {
    if (tool === "Bash" && on("A")) {
      const command = String(input.tool_input?.command ?? "");
      const d = await gateBashCommand(command, cwd, (s, q) => decide("PreToolUse Bash", s, q));
      report("hook", { hook: "tool_call", tool: "bash", command, block: d.block, reason: d.reason });
      if (d.block) return deny(`jev-guard blocked this command: ${d.reason}. ${BLOCK_NOTICE}`);
    }
    if (WRITE_TOOLS.has(tool) && on("B")) {
      const { path, content } = writeTarget(tool, input.tool_input ?? {});
      const d = await gateWriteCall(path, content, cwd, (s, q) => decide(`PreToolUse ${tool}`, s, q));
      report("hook", { hook: "tool_call", tool: tool.toLowerCase(), path, block: d.block, reason: d.reason });
      if (d.block) return deny(`jev-guard blocked this ${tool.toLowerCase()}: ${d.reason}. ${BLOCK_NOTICE}`);
    }
    return null;
  }

  if (input.hook_event_name === "PostToolUse" && on("C") && (tool === "Read" || tool === "Bash")) {
    const text = textOf(input.tool_response);
    const d = await screenToolResult(tool.toLowerCase(), text, (s, q) => decide(`PostToolUse ${tool}`, s, q));
    report("hook", { hook: "tool_result", tool: tool.toLowerCase(), flag: d.flag, noul: d.noul, banner: d.banner });
    if (d.flag && d.banner) {
      return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `${d.banner} This applies to the output of the ${tool} call you just made.` } };
    }
  }
  return null;
}

if (isMain(import.meta.url)) {
  try {
    const out = await main();
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err: any) {
    report("error", { hook: "guard", message: err?.message ?? String(err) });
  }
}
