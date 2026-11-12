/**
 * Level 7 hook: should I compact.
 *
 *   Stop              the turn is over: four questions about the work, one Jev call, decide the tier.
 *                     A tier above silent shows the user a notice and waits for the next prompt.
 *   UserPromptSubmit  the waiting tier message rides on the next prompt as context, once. Silent adds nothing.
 *   PreCompact        compaction is about to run, by /compact or automatically: which turn starts the live
 *                     work, and the agent's note to itself, become the instructions for the summary.
 *
 * Claude Code has no way for a hook or a tool to start a compaction, so the human types /compact.
 * Numbers stay in code: context growth from the transcript, the lines from JEV_LEVEL_CONFIG.
 * Wire it with `node claude/config.ts 7`, which prints the settings JSON for `claude --settings`.
 */
import { clip, evaluate, loadTranscript } from "../compact-eval.ts";
import { decide, isMain, readHookInput, readMemory, report, writeMemory } from "../lib.ts";
import { cutPointInstructions, cutPointQuestion, type TurnSummary } from "../../src/levels/level07/index.ts";

async function main(): Promise<Record<string, unknown> | string | null> {
  const input = await readHookInput();
  const cwd = String(input.cwd ?? process.cwd());
  const event = input.hook_event_name;
  if (input.transcript_path) writeMemory(cwd, { transcript_path: input.transcript_path });
  const memory = readMemory(cwd);

  if (event === "Stop") {
    if (memory.compact_requested) {
      report("hook", { hook: "Stop", tier: "request", reason: "the agent asked to compact", message: "The agent asked to compact. Run /compact." });
      return { systemMessage: "Jev: the agent asked to compact. Run /compact, its note will lead the summary." };
    }
    const ev = await evaluate(input.transcript_path, String(input.last_assistant_message ?? ""), "Stop");
    writeMemory(cwd, { pending_message: ev.message, pending_tier: ev.message ? ev.decision.tier : null });
    return ev.message ? { systemMessage: `Jev (${ev.decision.tier}): ${ev.message} Run /compact when you are ready.` } : null;
  }

  if (event === "UserPromptSubmit") {
    if (!memory.pending_message) return null;
    report("hook", { hook: "prompt_context", tier: memory.pending_tier ?? "notice", reason: "guidance added to the prompt", message: memory.pending_message });
    writeMemory(cwd, { pending_message: null, pending_tier: null });
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: memory.pending_message } };
  }

  if (event === "PreCompact") {
    const parts: string[] = [];
    const turns: TurnSummary[] = loadTranscript(input.transcript_path ?? memory.transcript_path).userMessages.map((m, i) => ({ index: i, request: clip(m, 120) }));
    if (turns.length >= 2) {
      const { answers } = await decide("PreCompact", { turns }, cutPointQuestion(turns));
      const cut = cutPointInstructions(turns, answers.live_from as any);
      report("hook", { hook: "session_before_compact", liveFrom: cut.liveFrom, confidence: cut.confidence, instructions: cut.instructions });
      parts.push(cut.instructions);
    }
    if (memory.note) parts.push(`Keep this note from the agent verbatim at the top of the summary:\n${memory.note}`);
    writeMemory(cwd, { pending_message: null, pending_tier: null, note: null, compact_requested: false });
    return parts.join("\n") || null;
  }
  return null;
}

if (isMain(import.meta.url)) {
  try {
    const out = await main();
    if (typeof out === "string") process.stdout.write(out);
    else if (out) process.stdout.write(JSON.stringify(out));
  } catch (err: any) {
    report("error", { hook: "compact", message: err?.message ?? String(err) });
  }
}
