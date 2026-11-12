/**
 * Level 7, the evaluation both the Stop hook and the should_i_compact tool run: transcript in, tier out.
 * Numbers come from the transcript in code. Jev judges whether the work moved on.
 */
import { readFileSync } from "node:fs";
import { decide, levelConfig, report } from "./lib.ts";
import { growthOf, parseTranscript, type Transcript } from "./transcript.ts";
import {
  COMPACT_QUESTIONS, DEFAULT_LINES, decideTier, tierMessage,
  type CompactAnswers, type CompactDecision, type CompactState, type Lines, type Usage,
} from "../src/levels/level07/index.ts";

/** Context window used for the percent on the gauge. Hooks are not told the model's window. */
const DEFAULT_WINDOW = 200_000;
/** Below this much growth there is nothing worth compacting. */
const MIN_COMPACTABLE = 2000;

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export interface Evaluation {
  decision: CompactDecision;
  message: string | null;
  usage: Usage;
  answers: CompactAnswers | null;
  transcript: Transcript;
}

export function loadTranscript(path: string | undefined): Transcript {
  try {
    return parseTranscript(path ? readFileSync(path, "utf8") : "");
  } catch {
    return parseTranscript("");
  }
}

export function configLines(): { lines: Lines; window: number } {
  const cfg = levelConfig<{ lines: Partial<Lines>; window: number }>({ lines: {}, window: DEFAULT_WINDOW });
  return { lines: { ...DEFAULT_LINES, ...cfg.lines }, window: cfg.window };
}

export function buildState(t: Transcript, lastAssistantText: string): CompactState {
  const previous = [
    ...t.userMessages.slice(0, -1).map((m) => clip(m, 200)),
    t.lastSummary ? `Summary so far: ${clip(t.lastSummary, 400)}` : "",
  ].filter(Boolean).join("\n");
  return {
    current_request: clip(t.userMessages.at(-1) ?? "", 600),
    previous_work: previous || "(nothing before this request)",
    recent_turn: clip(lastAssistantText.trim() || `(tool calls only: ${t.toolsThisTurn.join(", ") || "none"})`, 600),
    tools_this_turn: t.toolsThisTurn,
  };
}

/** One evaluation. `source` labels the row in the lab: the hook name, or the tool. */
export async function evaluate(transcriptPath: string | undefined, lastAssistantText: string, source: string, turn?: number): Promise<Evaluation> {
  const { lines, window } = configLines();
  const transcript = loadTranscript(transcriptPath);
  const growth = growthOf(transcript);
  const usage: Usage = { tokens: growth, pct: ((transcript.contextTokens ?? 0) / window) * 100 };
  const compactable = growth > MIN_COMPACTABLE;
  const turnNo = turn ?? transcript.userMessages.length;

  const silent = (reason: string): Evaluation => {
    const decision: CompactDecision = { tier: "silent", reason };
    report("hook", { hook: source, turn: turnNo, usage, lines, compactable, tier: decision.tier, reason, message: null, skipped: true });
    return { decision, message: null, usage, answers: null, transcript };
  };

  if (transcript.userMessages.length < 2) return silent("first request, nothing to move on from");

  const state = buildState(transcript, lastAssistantText);
  const { answers } = await decide(source, state, COMPACT_QUESTIONS, { turn: turnNo, context: usage, lines });
  const a = answers as unknown as CompactAnswers;
  const decision = decideTier(a, usage, compactable, lines, state);
  const message = tierMessage(decision, usage);
  report("hook", { hook: source, turn: turnNo, usage, lines, compactable, tier: decision.tier, reason: decision.reason, message });
  return { decision, message, usage, answers: a, transcript };
}
