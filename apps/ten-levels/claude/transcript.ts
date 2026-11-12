/**
 * Reading a Claude Code session transcript (the JSONL file a hook is pointed at).
 *
 * Level 7 needs three things from it: the user's requests, the last compaction summary, and how many
 * tokens the context holds. Pure functions, so the offline suite covers them.
 */

export interface Transcript {
  /** Real user prompts since the last compaction, oldest first. */
  userMessages: string[];
  /** The last compaction summary, or an empty string. */
  lastSummary: string;
  /** Tokens in context at the last assistant message, or null before the first reply. */
  contextTokens: number | null;
  /** Tokens in context at the first assistant message after the last compaction: system prompt and tools, not compactable. */
  baselineTokens: number | null;
  /** Tool names the assistant called since the last user prompt. */
  toolsThisTurn: string[];
}

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
      : "";

/** Slash command echoes and hook output are not requests. */
const isNoise = (text: string) => /^(<(local-command|command-|system-reminder)|\/compact\b)/.test(text.trim());
const isSummaryText = (text: string) => text.startsWith("This session is being continued from a previous conversation");

export function parseTranscript(jsonl: string): Transcript {
  const t: Transcript = { userMessages: [], lastSummary: "", contextTokens: null, baselineTokens: null, toolsThisTurn: [] };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.isSidechain) continue;
    if (entry.type === "user") {
      const text = contentText(entry.message?.content).trim();
      if (entry.isCompactSummary || isSummaryText(text)) {
        t.lastSummary = text;
        t.userMessages = [];
        t.baselineTokens = null;
        t.contextTokens = null;
        continue;
      }
      if (entry.isMeta || !text || isNoise(text)) continue;
      t.userMessages.push(text);
      t.toolsThisTurn = [];
    } else if (entry.type === "assistant") {
      const u = entry.message?.usage;
      if (u && typeof u.input_tokens === "number") {
        const tokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        t.contextTokens = tokens;
        t.baselineTokens ??= tokens;
      }
      for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (block?.type === "tool_use" && typeof block.name === "string") t.toolsThisTurn.push(block.name);
      }
    }
  }
  return t;
}

/** Tokens the conversation has added since the first reply. The lines in level 7 are measured on this. */
export const growthOf = (t: Transcript): number =>
  t.contextTokens === null || t.baselineTokens === null ? 0 : Math.max(0, t.contextTokens - t.baselineTokens);
