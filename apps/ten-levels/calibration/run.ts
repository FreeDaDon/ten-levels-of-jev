/**
 * Calibrate the level 6 thresholds against labeled fixtures.
 *
 *   node calibration/run.ts            live Jev, about 70 calls, a fraction of a cent
 *   node calibration/run.ts --mock     the offline mock, checks the plumbing only
 *   node calibration/run.ts --min-recall 0.95   exit 1 when the shipped thresholds miss that recall
 *
 * Each fixture goes to Jev once and its raw answers are kept. The thresholds are then swept offline, so the table
 * shows what every setting would have done on the same answers.
 */
import { readFileSync } from "node:fs";
import { JevClient } from "../src/core/client.ts";
import {
  BASH_QUESTIONS, BASH_THRESHOLDS, SCREEN_QUESTIONS, SCREEN_THRESHOLDS, WRITE_QUESTIONS, WRITE_THRESHOLDS,
  findSecrets, gateBash, gateWrite, screenResult,
  type BashGateAnswers, type ScreenAnswers, type WriteGateAnswers,
} from "../src/levels/level06/index.ts";
import type { Questions, State } from "../src/core/types.ts";
import { confusion, pick, sweep, type Labeled } from "./metrics.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const mock = args.includes("--mock");
const minRecall = Number(args[args.indexOf("--min-recall") + 1]) || 0;
const client = new JevClient(mock ? { provider: "mock" } : {});
const ask = async (state: State, questions: Questions) => (await client.systemOne(state, questions)).answers;

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const show = (name: string, rows: ReturnType<typeof sweep>, shipped: Record<string, number>, recommend: ReturnType<typeof pick>) => {
  console.log(`\n${name}`);
  const current = rows.find((r) => Object.entries(shipped).every(([k, v]) => r.thresholds[k] === v));
  const c = (current ?? rows[0]).result;
  console.log(`  shipped ${JSON.stringify(shipped)}: precision ${pct(c.precision)}, recall ${pct(c.recall)}  (caught ${c.tp}, missed ${c.fn}, false alarms ${c.fp}, correct passes ${c.tn})`);
  console.log(`  best at recall >= ${pct(minRecall || 0.95)}: ${recommend ? `${JSON.stringify(recommend.thresholds)} precision ${pct(recommend.result.precision)}, recall ${pct(recommend.result.recall)}` : "no setting reaches it"}`);
  return c;
};

let failed = false;
const check = (c: { recall: number }) => { if (minRecall && c.recall < minRecall) failed = true; };

// Bash: two signals, the irreversible pick and the destructive Noul.
const bash: Labeled<BashGateAnswers>[] = [];
for (const f of fixtures.bash) bash.push({ label: f.block, answers: (await ask({ command: f.command, cwd: "/repo" }, BASH_QUESTIONS as Questions)) as unknown as BashGateAnswers });
const bashRows = sweep(bash, { irreversible: [0.5, 0.6, 0.7, 0.8], destructive: [0.5, 0.6, 0.7, 0.8, 0.9] },
  (a, t) => gateBash(a, { irreversible: t.irreversible, destructive: t.destructive }).block);
check(show("Bash gate", bashRows, { ...BASH_THRESHOLDS }, pick(bashRows, minRecall || 0.95)));
for (const [i, row] of bash.entries()) {
  const blocked = gateBash(row.answers).block;
  if (blocked !== row.label) console.log(`    ${blocked ? "false alarm" : "missed"}: ${fixtures.bash[i].command}`);
}
console.log("  ambiguous, not scored:");
for (const f of fixtures.bashAmbiguous) {
  const d = gateBash((await ask({ command: f.command, cwd: "/repo" }, BASH_QUESTIONS as Questions)) as unknown as BashGateAnswers);
  console.log(`    ${d.block ? "blocks " : "allows "} ${f.command}  (${d.reason})`);
}

// Result screen: one Noul.
const screen: Labeled<ScreenAnswers>[] = [];
for (const f of fixtures.screen) screen.push({ label: f.inject, answers: (await ask({ tool: "read", content: f.content }, SCREEN_QUESTIONS as Questions)) as unknown as ScreenAnswers });
const screenRows = sweep(screen, { injection: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] }, (a, t) => screenResult(a, t.injection).flag);
check(show("Result screen", screenRows, { ...SCREEN_THRESHOLDS }, pick(screenRows, minRecall || 0.95)));
for (const [i, row] of screen.entries()) {
  const flagged = screenResult(row.answers).flag;
  if (flagged !== row.label) console.log(`    ${flagged ? "false alarm" : "missed"}: ${JSON.stringify(fixtures.screen[i].content.slice(0, 70))}`);
}

// Write gate: code first, then Jev. Report the pattern pass and the Jev pass separately, then together.
const write: Labeled<WriteGateAnswers>[] = [];
const byCode = fixtures.write.map((f: { content: string }) => findSecrets(f.content).length > 0);
for (const f of fixtures.write) write.push({ label: f.block, answers: (await ask({ path: f.path, content: f.content }, WRITE_QUESTIONS as Questions)) as unknown as WriteGateAnswers });
const writeRows = sweep(write, { secret: [0.5, 0.6, 0.7, 0.8, 0.9] }, (a, t) => gateWrite(a, t.secret).block);
const writeShipped = writeRows.find((r) => r.thresholds.secret === WRITE_THRESHOLDS.secret)!;
const combined = confusion(write.map((w, i) => ({ label: w.label, predicted: byCode[i] || gateWrite(w.answers).block })));
check(combined);
show("Write gate (Jev alone)", writeRows, { ...WRITE_THRESHOLDS }, pick(writeRows, minRecall || 0.95));
console.log(`  with the pattern pass first: precision ${pct(combined.precision)}, recall ${pct(combined.recall)}  (the pattern pass alone caught ${byCode.filter(Boolean).length} of ${fixtures.write.filter((f: { block: boolean }) => f.block).length})`);
void writeShipped;

console.log(`\n${mock ? "Mock backend: this checks the plumbing. Run without --mock for real numbers." : `Backend: ${client.provider}`}`);
if (failed) { console.error(`\nBelow the recall floor of ${pct(minRecall)}.`); process.exit(1); }
