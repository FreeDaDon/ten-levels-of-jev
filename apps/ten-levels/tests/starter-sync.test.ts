import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as app from "../src/core/types.ts";

/**
 * The hyper-jev skill ships its own copy of the core so it works with nothing else installed. The two are separate
 * codebases with separate examples, so they are not byte for byte equal, but the parts that speak to Jev must not
 * drift: the transport and the builders are identical, and the wire contract (limits and validation) agrees.
 */
const STARTER = new URL("../../../.claude/skills/hyper-jev/templates/starter/src/core/", import.meta.url);
const read = (dir: URL, file: string) => readFileSync(fileURLToPath(new URL(file, dir)), "utf8");
const APP = new URL("../src/core/", import.meta.url);

test("Starter: the client and the builders are the same files as the app's", () => {
  for (const file of ["client.ts", "helpers.ts"]) {
    assert.equal(read(STARTER, file), read(APP, file), `${file} drifted: copy src/core/${file} into the starter, or the other way`);
  }
});

test("Starter: the wire contract agrees on limits and on what a valid question is", async () => {
  const starter = await import(fileURLToPath(new URL("types.ts", STARTER)));
  assert.deepEqual(starter.LIMITS, app.LIMITS);

  const cases: [string, unknown][] = [
    ["noul", { q: { type: "noul", instructions: "Is it?" } }],
    ["choice", { q: { type: "choice", instructions: "Which?", criteria: { a: "x", b: null } } }],
    ["score", { q: { type: "score", instructions: "How?", criteria: ["low", "high"] } }],
    ["no options", { q: { type: "choice", instructions: "Which?", criteria: {} } }],
    ["one level", { q: { type: "score", instructions: "How?", criteria: ["only"] } }],
    ["blank", { q: { type: "noul", instructions: "  " } }],
    ["unknown type", { q: { type: "ranking", instructions: "x" } }],
    ["empty", {}],
    ["too many options", { q: { type: "choice", instructions: "x", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } }],
  ];
  const verdict = (validate: (q: unknown) => void, q: unknown) => { try { validate(q); return "valid"; } catch (e) { return (e as Error).name; } };
  for (const [name, questions] of cases) {
    assert.equal(verdict(starter.validateQuestions, questions), verdict(app.validateQuestions, questions), name);
  }
});
