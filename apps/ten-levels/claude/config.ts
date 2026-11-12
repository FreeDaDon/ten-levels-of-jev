/**
 * Claude Code configuration for each agentic level, as data.
 *
 * The lab builds its session settings from these functions, and you can print the same JSON for your own session:
 *
 *   claude --settings "$(node claude/config.ts 6 settings)"
 *   claude --settings "$(node claude/config.ts 7 settings)" --mcp-config "$(node claude/config.ts 7 mcp)"
 *   claude --mcp-config "$(node claude/config.ts 10 mcp)"
 *
 * Nothing here holds a key. Hooks and the MCP server read OPENROUTER_API_KEY or TYPESAFE_API_KEY from the
 * environment Claude Code runs in. The agent itself runs on your Claude subscription, not on a key.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOOK_TIMEOUT_SECONDS = 40;

export type HookSet = "guard" | "compact";

/** Levels 6, 7, and 10 carry hooks. */
export const LEVEL_HOOKS: Record<number, HookSet> = { 6: "guard", 7: "compact", 10: "guard" };

/**
 * Level 10 lets the agent write its own questions and still has its own Bash tool, so the bash gate sits on that tool
 * too. The lab applies this config; printed settings for your own session default to all three gates.
 */
export const LEVEL_DEFAULT_CONFIG: Record<number, object> = { 10: { gates: ["A"] } };

/** Levels 7 to 10 add tools the agent can call. */
export const LEVEL_TOOLS: Record<number, string[]> = {
  7: ["should_i_compact", "compact_now"],
  8: ["ask_jev_file_bool", "ask_jev_file_choice", "ask_jev_file_score"],
  9: ["ask_jev_files", "pick_first_file"],
  10: ["ask_jev"],
};

const command = (script: string, extra: object = {}) => ({ type: "command", command: "node", args: [join(ROOT, "hooks", script)], timeout: HOOK_TIMEOUT_SECONDS, ...extra });

export function hookSettings(set: HookSet): { hooks: Record<string, unknown[]> } {
  if (set === "guard") {
    return {
      hooks: {
        // onFailure "block": a crash or a timeout denies the call, the same as the hook's own fail closed path.
        PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", hooks: [command("guard.ts", { onFailure: "block" })] }],
        PostToolUse: [{ matcher: "Read|Bash", hooks: [command("guard.ts")] }],
      },
    };
  }
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [command("compact.ts")] }],
      Stop: [{ hooks: [command("compact.ts")] }],
      PreCompact: [{ hooks: [command("compact.ts")] }],
    },
  };
}

/** The MCP server entry. `env` carries lab paths and settings, never a key. */
export function mcpConfig(tools: string[], env: Record<string, string> = {}) {
  return {
    mcpServers: {
      jev: { command: "node", args: [join(ROOT, "mcp", "server.ts")], env: { ...env, JEV_MCP_TOOLS: tools.join(",") } },
    },
  };
}

/** Claude Code's name for a tool the lab scenarios list: built in tools capitalized, Jev tools under the jev server. */
const BUILT_IN = new Set(["read", "bash", "edit", "write"]);
export const claudeToolName = (name: string) => (BUILT_IN.has(name) ? name[0].toUpperCase() + name.slice(1) : `mcp__jev__${name}`);

if (isMain(import.meta.url)) {
  const [level, kind] = [Number(process.argv[2]), process.argv[3]];
  const set = LEVEL_HOOKS[level];
  const tools = LEVEL_TOOLS[level];
  if ((kind === "settings" && set) || (kind === "mcp" && tools)) {
    console.log(JSON.stringify(kind === "settings" ? hookSettings(set) : mcpConfig(tools)));
  } else {
    console.error(`usage: node claude/config.ts <level> <settings|mcp>\n  settings: levels ${Object.keys(LEVEL_HOOKS).join(", ")}\n  mcp:      levels ${Object.keys(LEVEL_TOOLS).join(", ")}`);
    process.exit(2);
  }
}
