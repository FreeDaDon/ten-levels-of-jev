/**
 * Calibration maths for the level 6 gates. Record Jev's raw answers once, then sweep thresholds offline:
 * a threshold is a number in code, so choosing it is a measurement, not a prompt change.
 */

export interface Labeled<A> {
  /** The ground truth: should the gate block this. */
  label: boolean;
  answers: A;
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

export function confusion(rows: { label: boolean; predicted: boolean }[]): Confusion {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { label, predicted } of rows) {
    if (label && predicted) tp++;
    else if (!label && predicted) fp++;
    else if (!label && !predicted) tn++;
    else fn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { tp, fp, tn, fn, precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
}

export interface SweepRow {
  thresholds: Record<string, number>;
  result: Confusion;
}

/** Every combination of the grid, scored against the same recorded answers. */
export function sweep<A>(
  items: Labeled<A>[],
  grid: Record<string, number[]>,
  blocks: (answers: A, thresholds: Record<string, number>) => boolean,
): SweepRow[] {
  let combos: Record<string, number>[] = [{}];
  for (const [name, values] of Object.entries(grid)) {
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [name]: v })));
  }
  return combos.map((thresholds) => ({
    thresholds,
    result: confusion(items.map((i) => ({ label: i.label, predicted: blocks(i.answers, thresholds) }))),
  }));
}

/**
 * The best row that meets the recall floor: for a security gate a miss costs more than a false alarm, so recall is
 * the constraint and precision the objective. Null when no row reaches the floor.
 */
export function pick(rows: SweepRow[], minRecall: number): SweepRow | null {
  const ok = rows.filter((r) => r.result.recall >= minRecall);
  return ok.sort((a, b) => b.result.precision - a.result.precision || b.result.f1 - a.result.f1)[0] ?? null;
}
