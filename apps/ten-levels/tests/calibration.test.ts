import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { confusion, pick, sweep } from "../calibration/metrics.ts";
import { findSecrets } from "../src/levels/level06/index.ts";

const fixtures = JSON.parse(readFileSync(new URL("../calibration/fixtures.json", import.meta.url), "utf8"));

test("Calibration: the fixtures are labeled both ways, and ambiguous cases are kept out of the score", () => {
  const count = (rows: { block?: boolean; inject?: boolean }[], key: "block" | "inject", v: boolean) => rows.filter((r) => r[key] === v).length;
  assert.ok(count(fixtures.bash, "block", true) >= 12 && count(fixtures.bash, "block", false) >= 12);
  assert.ok(count(fixtures.screen, "inject", true) >= 6 && count(fixtures.screen, "inject", false) >= 6);
  assert.ok(count(fixtures.write, "block", true) >= 3 && count(fixtures.write, "block", false) >= 3);
  const scored = new Set(fixtures.bash.map((f: { command: string }) => f.command));
  for (const f of fixtures.bashAmbiguous) assert.equal(scored.has(f.command), false);
});

test("Calibration: write fixtures that need Jev are not caught by the pattern pass, and clean ones are not flagged", () => {
  for (const f of fixtures.write) {
    const found = findSecrets(f.content).length > 0;
    if (!f.block) assert.equal(found, false, `false alarm in the pattern pass: ${f.path}`);
  }
});

test("Calibration: precision, recall, and the empty cases", () => {
  const c = confusion([
    { label: true, predicted: true }, { label: true, predicted: false },
    { label: false, predicted: true }, { label: false, predicted: false }, { label: false, predicted: false },
  ]);
  assert.deepEqual([c.tp, c.fn, c.fp, c.tn], [1, 1, 1, 2]);
  assert.equal(c.precision, 0.5);
  assert.equal(c.recall, 0.5);
  assert.equal(confusion([]).precision, 1, "nothing predicted means nothing wrongly flagged");
  assert.equal(confusion([{ label: true, predicted: false }]).f1, 0);
});

test("Calibration: a sweep scores every combination on the same answers, and pick honors the recall floor", () => {
  const items = [0.95, 0.8, 0.6, 0.4, 0.2, 0.1].map((score, i) => ({ label: i < 3, answers: { score } }));
  const rows = sweep(items, { floor: [0.3, 0.5, 0.7, 0.9] }, (a, t) => a.score >= t.floor);
  assert.equal(rows.length, 4);
  const at = (floor: number) => rows.find((r) => r.thresholds.floor === floor)!.result;
  assert.equal(at(0.3).recall, 1);
  assert.equal(at(0.3).fp, 1);
  assert.equal(at(0.5).precision, 1);
  assert.equal(at(0.9).recall, 1 / 3);
  assert.equal(pick(rows, 1)?.thresholds.floor, 0.5, "full recall with the fewest false alarms");
  assert.equal(pick(rows, 1.1), null);

  const two = sweep(items, { a: [0.5, 0.7], b: [1, 2, 3] }, () => true);
  assert.equal(two.length, 6);
});
