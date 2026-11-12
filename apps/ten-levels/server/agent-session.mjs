/**
 * Agent sessions: one Claude Code conversation per lab run, driven headless.
 *
 * Each prompt is one `claude -p --output-format stream-json` process, resumed onto the same conversation, so a
 * stop is a kill and nothing stays running between prompts. The agent runs on your Claude Code subscription: the
 * lab never passes ANTHROPIC_API_KEY, and `--bare` is not used because bare mode skips the subscription login
 * and does not run hooks from --settings.
 *
 * The level's hooks and MCP tools write every Jev call and hook decision to an event log, which this module tails
 * and folds into the same event stream the window subscribes to. Claude's stream-json events are translated into
 * the shape the window already reads: message_end, tool_execution_start, tool_execution_end, stats, agent_settled.
 *
 *   start(config)         copy the sandbox, write the level's settings, return a session
 *   session.prompt(text)  run one prompt, rejected while the agent is running
 *   session.abort()       kill the run in flight
 *   session.subscribe(fn) every event so far, then live
 *   session.close()       kill the run and remove the sandbox copy
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeToolName, hookSettings, LEVEL_HOOKS, mcpConfig } from "../claude/config.ts";

const APP = fileURLToPath(new URL("../", import.meta.url));
const SESSIONS_DIR = join(APP, ".sessions");
const WORK_DIR = join(APP, ".sandboxes");
const IDLE_KILL_MS = 15 * 60_000;
const DEFAULT_WINDOW = 200_000;

/** `haiku`, `sonnet`, or a full model ID. Haiku is the fast workhorse, and the cheapest against your subscription limits. */
export const agentModel = () => process.env.JEV_AGENT_MODEL || "haiku";

const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
const JEV_KEYS = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"];

/**
 * The environment the agent can see. Its Bash tool can print every variable, so Claude Code gets only what a session
 * needs: the shell basics (HOME carries the subscription login), the Jev keys the hooks and tools read, JEV_* settings,
 * and any names listed in JEV_AGENT_ENV, comma separated. ANTHROPIC_API_KEY is never forwarded: it would switch the
 * agent from your subscription to per token billing. Add it to JEV_AGENT_ENV only if you want that.
 */
export function agentEnv(paths, config) {
  const extra = (process.env.JEV_AGENT_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const names = new Set([...BASE_ENV, ...JEV_KEYS, ...extra]);
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (names.has(name) || name.startsWith("JEV_"))) env[name] = value;
  }
  return {
    ...env,
    JEV_LEVEL_CONFIG: JSON.stringify(config ?? {}),
    JEV_EVENT_LOG: paths.eventLog,
    JEV_STATE_DIR: paths.dir,
    JEV_CWD: paths.cwd,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
}

/** The scenario's tool list, split into Claude Code's built in tools and the Jev tools the MCP server exposes. */
export function splitTools(tools) {
  const builtIn = tools.filter((t) => ["read", "bash", "edit", "write"].includes(t));
  return { builtIn: builtIn.map(claudeToolName), mcp: tools.filter((t) => !builtIn.includes(t)) };
}

const sessions = new Map();

export function getSession(id) {
  return sessions.get(id);
}

/**
 * `cwd` is the pristine sandbox. Each session gets its own copy under .sandboxes, so an agent that
 * fixes the bug or writes a file never changes what the next session sees. The copy is removed on close.
 */
export function start({ level, option, tools, cwd, config }) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const session = new AgentSession({ level, option, tools, cwd, config });
  sessions.set(session.id, session);
  return session;
}

const textOfBlocks = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "";

class AgentSession {
  constructor({ level, option, tools, cwd, config }) {
    this.id = randomUUID().slice(0, 8);
    this.level = level;
    this.option = option;
    this.model = agentModel();
    this.events = [];
    this.listeners = new Set();
    this.running = false;
    this.closed = false;
    this.child = null;
    this.claudeSession = null;
    this.compactRequested = false;
    this.lastLedger = null;
    this.window = DEFAULT_WINDOW;
    this.cost = 0;
    this.seq = 0;
    this.logOffset = 0;
    this.logBuffer = "";
    this.cwd = join(WORK_DIR, this.id);
    cpSync(cwd, this.cwd, { recursive: true });
    // A git repo of its own with a baseline commit, so `git diff` and `git status` show what the agent changed.
    try {
      const git = (...args) => execFileSync("git", args, { cwd: this.cwd, stdio: "ignore" });
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.name=lab", "-c", "user.email=lab@local", "commit", "-qm", "sandbox baseline");
    } catch (err) {
      console.error(`sandbox git init failed: ${err?.message ?? err}`);
    }

    // Settings live beside the sandbox copy, not in it, so the agent cannot edit its own hooks.
    this.dir = join(SESSIONS_DIR, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.paths = { dir: this.dir, cwd: this.cwd, eventLog: join(this.dir, "events.jsonl") };
    writeFileSync(this.paths.eventLog, "");
    const { builtIn, mcp } = splitTools(tools);
    const hooks = LEVEL_HOOKS[level];
    this.settingsFile = join(this.dir, "settings.json");
    writeFileSync(this.settingsFile, JSON.stringify(hooks ? hookSettings(hooks) : {}));
    this.mcpFile = join(this.dir, "mcp.json");
    writeFileSync(this.mcpFile, JSON.stringify(mcp.length ? mcpConfig(mcp) : { mcpServers: {} }));
    this.args = [
      "-p", "--output-format", "stream-json", "--verbose",
      "--model", this.model,
      "--setting-sources", "project",
      "--settings", this.settingsFile,
      "--strict-mcp-config", "--mcp-config", this.mcpFile,
      "--tools", builtIn.join(","),
      "--allowedTools", [...builtIn, ...(mcp.length ? ["mcp__jev"] : [])].join(","),
      "--permission-mode", "dontAsk",
    ];
    this.env = agentEnv(this.paths, config);
    this.tailTimer = setInterval(() => this.drainLog(), 100);
    this.touch();
    this.push("session", { id: this.id, level, option, model: this.model, cwd: this.cwd });
  }

  /** New lines from the event log, pushed as `jev` events. A ledger is held back and shown once, when the run ends. */
  drainLog() {
    let size;
    try { size = statSync(this.paths.eventLog).size; } catch { return; }
    if (size <= this.logOffset) return;
    const fd = openSync(this.paths.eventLog, "r");
    const buf = Buffer.alloc(size - this.logOffset);
    readSync(fd, buf, 0, buf.length, this.logOffset);
    closeSync(fd);
    this.logOffset = size;
    this.logBuffer += buf.toString("utf8");
    let i;
    while ((i = this.logBuffer.indexOf("\n")) >= 0) {
      const line = this.logBuffer.slice(0, i);
      this.logBuffer = this.logBuffer.slice(i + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.kind === "ledger") this.lastLedger = event;
      else if (event.kind === "compact") { this.compactRequested = true; this.push("jev", event); }
      else this.push("jev", event);
    }
  }

  /** One claude process, to completion. Resolves when it exits. */
  runClaude(message) {
    return new Promise((resolve) => {
      const args = this.claudeSession ? [...this.args, "--resume", this.claudeSession] : this.args;
      this.child = spawn("claude", args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      this.child.on("error", (err) => { this.push("error", { message: String(err?.message ?? err) }); resolve(); });
      this.child.on("close", () => { this.child = null; resolve(); });
      this.readLines(this.child.stdout, (line) => this.onStdout(line));
      this.readLines(this.child.stderr, (line) => this.push("log", { stream: "stderr", text: line.slice(0, 2000) }));
      this.child.stdin.end(message);
    });
  }

  /** Strict JSONL: split on LF only. Node's readline also splits on U+2028, which breaks JSON strings. */
  readLines(stream, onLine) {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (line) onLine(line);
      }
    });
  }

  onStdout(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return this.push("log", { stream: "stdout", text: line }); }
    this.drainLog();
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.claudeSession = msg.session_id;
          this.push("state", { model: { id: msg.model, provider: "" }, auth: msg.apiKeySource === "none" ? "subscription" : msg.apiKeySource });
        } else if (msg.subtype === "compact_boundary") {
          const m = msg.compact_metadata ?? {};
          this.push("compaction_end", { result: { tokensBefore: m.pre_tokens, estimatedTokensAfter: m.post_tokens }, trigger: m.trigger });
        }
        return;
      case "assistant": return this.onAssistant(msg.message);
      case "user": return this.onUser(msg.message);
      case "result": return this.onResult(msg);
      default: return;
    }
  }

  onAssistant(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const shown = blocks.filter((b) => b.type === "text" || b.type === "thinking").map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "thinking", thinking: b.thinking }));
    if (shown.length) this.push("message_end", { message: { role: "assistant", content: shown, usage: message.usage } });
    for (const b of blocks) {
      if (b.type === "tool_use") this.push("tool_execution_start", { toolName: b.name.replace(/^mcp__jev__/, ""), args: b.input, toolCallId: b.id });
    }
    const u = message?.usage;
    if (u) {
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      this.push("stats", { cost: this.cost, contextUsage: { tokens, percent: (tokens / this.window) * 100, contextWindow: this.window } });
    }
  }

  onUser(message) {
    for (const b of Array.isArray(message?.content) ? message.content : []) {
      if (b.type !== "tool_result") continue;
      this.push("tool_execution_end", { toolCallId: b.tool_use_id, isError: !!b.is_error, result: { content: [{ type: "text", text: textOfBlocks(b.content) }] } });
    }
  }

  onResult(msg) {
    // total_cost_usd is a list price estimate; on a subscription nothing is billed per token.
    this.cost = Number(msg.total_cost_usd ?? this.cost);
    const usage = Object.values(msg.modelUsage ?? {})[0];
    if (usage?.contextWindow) this.window = usage.contextWindow;
    this.push("stats", { cost: this.cost, contextUsage: this.lastContext(), subscription: true });
    if (msg.is_error) this.push("error", { message: String(msg.result ?? msg.subtype ?? "the run failed") });
  }

  lastContext() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].event === "stats" && this.events[i].data.contextUsage) {
        const c = this.events[i].data.contextUsage;
        return { ...c, contextWindow: this.window, percent: (c.tokens / this.window) * 100 };
      }
    }
    return undefined;
  }

  push(event, data) {
    const item = { seq: ++this.seq, event, data, at: Date.now() };
    this.events.push(item);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
    for (const l of this.listeners) l(item);
    this.touch();
  }

  subscribe(listener) {
    for (const item of this.events) listener(item);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the run and returns at once; the window follows the event stream. */
  async prompt(message) {
    if (this.closed) throw new Error("session closed");
    if (this.running) throw new Error("the agent is still running; Stop it first");
    this.running = true;
    this.push("prompt", { message });
    this.push("agent_start", {});
    this.finish(message);
  }

  async finish(message) {
    try {
      this.aborted = false;
      await this.runClaude(message);
      this.drainLog();
      // The agent asked to compact: Claude Code cannot do it mid turn, so the lab runs /compact when the turn is over.
      if (this.compactRequested && !this.aborted && !this.closed && this.claudeSession) {
        this.compactRequested = false;
        await this.runClaude("/compact");
        this.drainLog();
      }
      if (this.lastLedger) { this.push("jev", this.lastLedger); this.lastLedger = null; }
    } finally {
      this.running = false;
      if (!this.closed) this.push("agent_settled", {});
    }
  }

  async abort() {
    this.push("abort", {});
    this.aborted = true;
    const child = this.child;
    if (!child) return { ok: true };
    child.kill("SIGINT");
    await new Promise((resolve) => {
      const force = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
      child.once("close", () => { clearTimeout(force); resolve(); });
    });
    return { ok: true };
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  close() {
    clearTimeout(this.idleTimer);
    clearInterval(this.tailTimer);
    sessions.delete(this.id);
    if (this.closed) return;
    this.closed = true;
    this.push("closed", {});
    try { this.child?.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => {
      try { this.child?.kill("SIGKILL"); } catch { /* gone */ }
      try { rmSync(this.cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    }, 2000).unref?.();
  }
}
