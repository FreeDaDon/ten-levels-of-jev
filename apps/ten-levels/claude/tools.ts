/**
 * The Jev tools Claude Code can call, served over MCP by claude/mcp/server.ts.
 *
 *   L7  should_i_compact, compact_now
 *   L8  ask_jev_file_bool, ask_jev_file_choice, ask_jev_file_score
 *   L9  ask_jev_files, pick_first_file
 *   L10 ask_jev
 *
 * Each tool is a name, a description, a JSON Schema, and a handler. Handlers call the same decision
 * code under src/levels/ that the terminal runner and the tests use.
 */
import { exec } from "node:child_process";
import { decide, readMemory, report, writeMemory } from "./lib.ts";
import { configLines, evaluate } from "./compact-eval.ts";
import { BLOCK_NOTICE, gateBashCommand } from "../src/levels/level06/index.ts";
import { compactVerdict, type CompactAnswers } from "../src/levels/level07/index.ts";
import { askFileBool, askFileChoice, askFileScore, FileStateError } from "../src/levels/level08/index.ts";
import { askFiles, pickFirstFile } from "../src/levels/level09/index.ts";
import { ASK_JEV_DESCRIPTION, AskStateError, assembleState, parseQuestions, type CommandOutput } from "../src/levels/level10/index.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, any>): Promise<ToolResult>;
}

/** Where relative paths resolve. The lab sets JEV_CWD; Claude Code starts the server in the project. */
const cwd = () => process.env.JEV_CWD || process.cwd();

const ok = (payload: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const failure = (err: any, prefix = "error"): ToolResult =>
  fail(err instanceof FileStateError || err instanceof AskStateError ? err.message : `${prefix}: ${err?.message ?? err}`);

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

const WHEN =
  "Use this for a judgment about what a file does or contains, without reading it into your context. " +
  "Write the question against `content`, which is the file's text. Use the Read tool instead when you need the code itself, to edit or quote it. " +
  "Exact lookups, does this string appear, how many lines, belong to grep, not here.";

export const QUESTION_SCHEMA =
  'questions_json is a JSON object keyed by question id. Three types. ' +
  'noul: {"type":"noul","instructions":"Does `content` ...?","criteria":{"true":"...","false":"..."}} returns a probability of yes. ' +
  'choice: {"type":"choice","instructions":"Which ... is `content`?","criteria":{"option_a":"when it applies","option_b":"...","other":"none of the above"}} returns one of your keys plus confidence, up to 255 options. ' +
  'score: {"type":"score","instructions":"How ... is `content`?","criteria":["lowest situation","...","highest situation"]} returns a position on your levels, two to ten of them. ' +
  "Write every question against `content`, the file's text; `path` is also in the state. Ask every question you might need in one block, it is one call per file either way.";

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;

/** Run a command for the state. The output is captured, never streamed to the agent. */
function runCommand(command: string, dir: string): Promise<CommandOutput> {
  return new Promise((resolve) => {
    exec(command, { cwd: dir, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_CHARS * 4, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? null : 0;
      resolve({ command, exit_code: code, stdout: String(stdout).slice(0, MAX_OUTPUT_CHARS), stderr: String(stderr).slice(0, MAX_OUTPUT_CHARS) });
    });
  });
}

const EMPTY_ANSWERS = {
  switched_gears: { type: "noul", noul: 0 }, at_boundary: { type: "noul", noul: 0 },
  needs_history: { type: "score", score: 2 }, mid_operation: { type: "noul", noul: 0 },
} as unknown as CompactAnswers;

export const TOOLS: Tool[] = [
  {
    name: "should_i_compact",
    description:
      "Ask whether now is a good moment to compact the conversation. Returns should_compact, a tier " +
      "(silent, notice, recommend, request), the reason, and the context growth in tokens. Cheap, call it freely.",
    inputSchema: obj({}),
    async run() {
      try {
        const memory = readMemory(cwd());
        if (!memory.transcript_path) return fail("should_i_compact needs the level 7 hooks. Run `node claude/config.ts 7` and pass its output to claude --settings.");
        const ev = await evaluate(memory.transcript_path, "", "should_i_compact");
        const { lines } = configLines();
        return ok(compactVerdict(ev.decision, ev.answers ?? EMPTY_ANSWERS, ev.usage, lines));
      } catch (err) { return failure(err, "should_i_compact error"); }
    },
  },
  {
    name: "compact_now",
    description:
      "Ask for the conversation to be compacted when this turn ends. Pass a short note_to_self: what you were doing, what is done, what is next. " +
      "The note is kept at the top of the summary so you can pick up where you left off. You cannot compact in the middle of a turn: finish the request, and tell the user compaction is queued.",
    inputSchema: obj({ note_to_self: str("Two to five lines: state of the work, next step.") }, ["note_to_self"]),
    async run(args) {
      const note = String(args.note_to_self ?? "").trim();
      if (!note) return fail("compact_now needs a note_to_self.");
      writeMemory(cwd(), { note, compact_requested: true, pending_message: null, pending_tier: null });
      report("compact", { note });
      return { content: [{ type: "text", text: "Compaction is queued for the end of this turn. Your note will lead the summary. Continue with the current request." }] };
    },
  },
  {
    name: "ask_jev_file_bool",
    description: `Yes or no about one file. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. ${WHEN}`,
    inputSchema: obj({
      path: str("File path, relative to the repo"),
      question: str("A yes or no question about `content`, for example: Does `content` validate authentication tokens?"),
      yes: str("What counts as yes"),
      no: str("What counts as no"),
    }, ["path", "question"]),
    async run(p) {
      try {
        return ok(await askFileBool(p.path, p.question, cwd(), { yes: p.yes, no: p.no }, (s, q) => decide("ask_jev_file_bool", s, q, { path: p.path })));
      } catch (err) { return failure(err); }
    },
  },
  {
    name: "ask_jev_file_choice",
    description: `Pick one option about one file. Returns { path, choice, confidence, probabilities }. The choice is always one of your options; an "other" option is added if you leave none. ${WHEN}`,
    inputSchema: obj({
      path: str("File path, relative to the repo"),
      question: str("The question, for example: Which layer is `content`?"),
      options: { type: "object", description: "Option name to a one line description of when it applies. Up to 255.", additionalProperties: { type: "string" } },
    }, ["path", "question", "options"]),
    async run(p) {
      try {
        return ok(await askFileChoice(p.path, p.question, p.options, cwd(), (s, q) => decide("ask_jev_file_choice", s, q, { path: p.path })));
      } catch (err) { return failure(err); }
    },
  },
  {
    name: "ask_jev_file_score",
    description: `A position on a scale you define, about one file. Returns { path, score, top, nearest, confidence, legend }. Levels are ordered low to high, two to ten of them, each a described situation. ${WHEN}`,
    inputSchema: obj({
      path: str("File path, relative to the repo"),
      question: str("The question, for example: How risky is a refactor of `content`?"),
      levels: { type: "array", items: { type: "string" }, description: "Ordered low to high, each level a situation, for example: Isolated and well tested" },
    }, ["path", "question", "levels"]),
    async run(p) {
      try {
        return ok(await askFileScore(p.path, p.question, p.levels, cwd(), (s, q) => decide("ask_jev_file_score", s, q, { path: p.path })));
      } catch (err) { return failure(err); }
    },
  },
  {
    name: "ask_jev_files",
    description:
      "Ask the same typed questions of many files at once without reading any of them. Code expands globs and directories, " +
      "drops node_modules, .git, binaries, and files over the budget, caps the list at 255, then makes one Jev call per file in parallel. " +
      "Returns { results: [{ path, answers }], skipped: [{ path, reason }], calls }. " + QUESTION_SCHEMA +
      " Use Read when you need a file's code; use Grep for exact strings.",
    inputSchema: obj({
      paths_or_globs: { type: "array", items: { type: "string" }, description: 'Files, directories, or globs, relative to the repo, for example ["src/**/*.ts"] or ["src/http"]' },
      questions_json: str("The question block as a JSON string"),
      recursive: { type: "boolean", description: "For directories: include every file below them. Default false." },
    }, ["paths_or_globs", "questions_json"]),
    async run(p) {
      try {
        return ok(await askFiles(p.paths_or_globs, p.questions_json, cwd(), {
          recursive: p.recursive ?? false,
          decide: (s, q) => decide("ask_jev_files", s, q, { path: (s as any).path }),
        }));
      } catch (err) { return failure(err); }
    },
  },
  {
    name: "pick_first_file",
    description:
      "After ask_jev_files, choose which of a list of files to open first for a goal. One Choice keyed by path, so the pick is always a real file. " +
      "Returns { path | null, confidence, probabilities }. Pass a short note per path if you have one, for example the answers you already got.",
    inputSchema: obj({
      question: str("The goal, for example: Which file should I open first to fix the proration bug?"),
      candidates: { type: "array", description: "Paths, with an optional one line note each", items: obj({ path: { type: "string" }, note: { type: "string" } }, ["path"]) },
    }, ["question", "candidates"]),
    async run(p) {
      try {
        return ok(await pickFirstFile(p.question, p.candidates, (s, q) => decide("pick_first_file", s, q)));
      } catch (err) { return failure(err); }
    },
  },
  {
    name: "ask_jev",
    description: ASK_JEV_DESCRIPTION,
    inputSchema: obj({
      questions_json: str("The question block, a JSON object keyed by question id"),
      state: str("Your own state: plain text, or a JSON object as a string. Short. Not for pasting files or output."),
      paths: { type: "array", items: { type: "string" }, description: 'Files or globs for code to read into files["path"]. Up to 20 files.' },
      command: str("A command for code to run in the repo; its result goes into output. Runs through the bash gate."),
    }, ["questions_json"]),
    async run(p) {
      try {
        const questions = parseQuestions(p.questions_json);
        const run = async (command: string, dir: string) => {
          const gate = await gateBashCommand(command, dir, (s, q) => decide("ask_jev command gate", s, q));
          report("hook", { hook: "ask_jev command", tool: "bash", command, block: gate.block, reason: gate.reason });
          if (gate.block) throw new AskStateError(`ask_jev: the command was refused by the bash gate: ${gate.reason}. ${BLOCK_NOTICE} ask_jev commands should only read.`);
          return runCommand(command, dir);
        };
        const { state, summary } = await assembleState({ state: p.state, paths: p.paths, command: p.command }, cwd(), run);
        const result = await decide("ask_jev", state, questions, { summary });
        return ok({ answers: result.answers, state_summary: summary, usage: result.usage, model: result.model });
      } catch (err) {
        const text = err instanceof AskStateError ? err.message : `ask_jev error: ${(err as Error)?.message ?? err}`;
        report("error", { hook: "ask_jev", message: text });
        return fail(text);
      }
    },
  },
];

/** What the model reads once, in its system prompt, about the tools this server exposes. */
export const NUDGE =
  "You have ask_jev. When you need a classification, a risk score, or a yes or no with a confidence, " +
  "prefer it over reasoning it out yourself. Give it paths or a command instead of pasting content. " +
  "It answers in 300 ms and costs almost nothing.";
