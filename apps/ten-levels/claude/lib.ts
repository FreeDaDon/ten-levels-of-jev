/**
 * Shared plumbing for the Claude Code hooks and the MCP server.
 *
 * Every hook is a short lived process that reads one JSON object on stdin. Every decision it makes is
 * appended as one JSON line to the event log, which the lab tails and which you can `tail -f`.
 * `decide` is the one way this layer calls Jev: it validates, calls, reports, and returns.
 *
 * Environment:
 *   JEV_EVENT_LOG     where events go. Default: <tmp>/jev-claude/events.jsonl
 *   JEV_STATE_DIR     where level 7 keeps its verdict between hooks. Default: <tmp>/jev-claude
 *   JEV_LEVEL_CONFIG  the level's config as JSON: gates for level 6, lines for level 7
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { JevClient } from "../src/core/client.ts";
import { validateQuestions, type Answer, type Questions, type State, type SystemOneUsage } from "../src/core/types.ts";

let client: JevClient | undefined;
/**
 * Inside the lab, Jev is reached through the lab's broker with a session token, so no key is ever in this process.
 * Anywhere else the provider and key resolve once, on first use: TypeSafe first, then OpenRouter.
 */
export const jev = () =>
  (client ??= process.env.JEV_PROXY_URL && process.env.JEV_PROXY_TOKEN
    ? new JevClient({ provider: "typesafe", apiKey: process.env.JEV_PROXY_TOKEN, baseUrl: process.env.JEV_PROXY_URL })
    : new JevClient());

const baseDir = () => process.env.JEV_STATE_DIR || join(tmpdir(), "jev-claude");
export const eventLogPath = () => process.env.JEV_EVENT_LOG || join(baseDir(), "events.jsonl");

/** The level config the lab passed in, JEV_LEVEL_CONFIG as JSON. */
export function levelConfig<T extends object>(fallback: T): T {
  try {
    const raw = process.env.JEV_LEVEL_CONFIG;
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function report(kind: string, payload: Record<string, unknown>): void {
  const path = eventLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ kind, at: Date.now(), ...payload }) + "\n");
  } catch {
    /* the log is a record, never a reason to fail a hook */
  }
}

export interface Decision {
  answers: Record<string, Answer>;
  usage: SystemOneUsage;
  model: string;
  ms: number;
}

/**
 * One Jev call from inside the harness. `source` names who asked, a hook or a tool, so the window
 * can label the row. `extra` must not use the keys the report already sets: source, state,
 * questions, answers, usage, model, ms.
 */
export async function decide(source: string, state: State, questions: Questions, extra: Record<string, unknown> = {}): Promise<Decision> {
  validateQuestions(questions);
  const started = performance.now();
  const result = await jev().systemOne(state, questions);
  const out: Decision = { answers: result.answers, usage: result.usage, model: result.model, ms: Math.round(performance.now() - started) };
  report("jev", { source, state, questions, answers: out.answers, usage: out.usage, model: out.model, ms: out.ms, ...extra });
  return out;
}

/** True when this file is the entry point, so a module can export helpers and still run as a hook. */
export const isMain = (moduleUrl: string) => process.argv[1] !== undefined && fileURLToPath(moduleUrl) === resolve(process.argv[1]);

/** A hook's stdin, parsed. */
export async function readHookInput(): Promise<Record<string, any>> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

/** Level 7's memory between hooks, keyed by the project directory. */
export interface CompactMemory {
  transcript_path?: string;
  /** The latest non silent tier message, waiting to ride on the next prompt. */
  pending_message?: string | null;
  pending_tier?: string | null;
  /** The agent's note to itself, folded into the next compaction. */
  note?: string | null;
  /** The agent asked for compaction; the lab runs it when the turn ends. */
  compact_requested?: boolean;
}

const memoryPath = (cwd: string) => join(baseDir(), `compact-${createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12)}.json`);

export function readMemory(cwd: string): CompactMemory {
  try {
    return JSON.parse(readFileSync(memoryPath(cwd), "utf8")) as CompactMemory;
  } catch {
    return {};
  }
}

export function writeMemory(cwd: string, patch: Partial<CompactMemory>): CompactMemory {
  const next = { ...readMemory(cwd), ...patch };
  try {
    mkdirSync(baseDir(), { recursive: true });
    writeFileSync(memoryPath(cwd), JSON.stringify(next));
  } catch {
    /* memory is a convenience; a missing file means a silent tier */
  }
  return next;
}
