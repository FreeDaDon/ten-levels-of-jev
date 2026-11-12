# 10 Levels of Jev — a tested codebase

Concrete use cases for [Jev](https://typesafe.ai), TypeSafe AI's System One model, arranged from one
smart `if` statement to a coding agent that **authors its own choice blocks at runtime**.

Every level ships **three options** — three different concrete builds of the same idea — and every
option is covered by tests. 251 offline tests, zero runtime dependencies (typescript, @types/node and oxlint are dev tools), Node 22+ (Node 24 runs the TypeScript
natively, no build step for the levels).

```
npm test     # 251 tests across core + all 10 levels (offline, deterministic mock backend)
npm run demo # print every level's three options running end to end
```

## The live lab

```sh
npm run web   # → http://127.0.0.1:4399
```

Ten level pages. Levels 1 to 5 run one call: edit the state, **Run live**, and read the request,
the typed answers as probability bars, the response body, and a cost table against six chat models.
Levels 6 to 10 open an **agent window**: a real Claude Code session on your subscription in a copy of `sandbox/`, with the
level's hooks and MCP tools loaded and an explicit tool allowlist. You prompt it, the box locks, Go becomes
Stop, and every tool call, hook decision, and Jev call lands as one line. Click a line for the
details. The footer shows the model, the LLM cost, the Jev cost, and the context bar.

| Level | What the agent window shows |
|---|---|
| 6 Guardrail hooks | the agent window: each tool call, and the hook that blocked or allowed it, one line each |
| 7 Should I compact | the agent window: every turn's four answers and the tier, silent to request |
| 8 Cheap reads | the agent window: ask_jev_file calls with the file never appearing |
| 9 Files at scale | the agent window: one Jev row per file, in parallel, then the pick |
| 10 Agentic Jev | the agent window: ask_jev calls the agent chose to make, and the spend ledger |

Live against OpenRouter when `OPENROUTER_API_KEY` is set (`JEV_BACKEND=mock` forces the offline
mock for levels 1 to 5). The agent model defaults to `haiku`; override with `JEV_AGENT_MODEL`
(`sonnet`, or a full model ID). The lab never forwards `ANTHROPIC_API_KEY`, so the agent runs on
your Claude Code login. Hooks and tools append every decision to an event log the server tails.

Tests: **251 offline** (`npm test`, mock backend) + **10 live** (`npm run test:live`, one per level).

## The ladder

| Level | Idea | Options |
|---|---|---|
| 01 Single decisions | the smart if-statement | prompt injection gate · urgency gate · ticket classifier |
| 02 Multiple choice | pick one declared option, several questions per call | support triage · resume screening · sponsor-form qualification |
| 03 Composite scoring | one judgment per dimension, weights in code | ticket priority · code-review risk · startup-idea verdict |
| 04 Confidence-gated routing | the answer says what, confidence says whether | bash tool gate · account actions · citation check |
| 05 Intent & model routing | Jev in front of expensive things | agent router · intent router · model router |
| 06 Guardrail hooks | Jev in the tool_call and tool_result hooks | bash gate · write gate · result screen |
| 07 Should I compact | four questions after every turn, four tiers back | turn end hook · on demand tool · pick the cut point |
| 08 Cheap reads | a judgment about a file, never the file | ask_jev_file_bool · ask_jev_file_choice · ask_jev_file_score |
| 09 Files at scale | many files, one call each, in parallel | several paths · a glob · recursive then pick first |
| 10 Agentic Jev | ask_jev on anything the agent holds | triage a failure · judge a diff · classify a request |

## Mock vs live

With no backend selected, every call runs against `src/core/mock.ts` — a deterministic, offline
stand-in that mimics the exact wire contract (typed answers, distributions that sum to 1, legends,
confidence). It stands in for **shape**, not intelligence: it decides by token overlap, so rubric
wording matters more than it would live. `npm test` always runs the mock.

Live runs go through **OpenRouter's decision endpoint** — no TypeSafe key needed (the transport
pattern verified in the [jev-use-cases lab](https://openrouter.ai/~typesafe/jev-latest)):

```sh
export OPENROUTER_API_KEY=...
npm run demo:live   # every level against real Jev: POST openrouter.ai/api/alpha/decisions, ~typesafe/jev-latest
npm run test:live   # 10 live tests, one per level
```

Live responses pass a strict contract check before they reach your code (distributions cover every
declared option and sum to ~1, choices are declared options). A direct TypeSafe backend exists too
(`JEV_BACKEND=typesafe` + `TYPESAFE_API_KEY`) but is untested without a key.

## Where things live

```
src/core/     types.ts (wire contract + validation), client.ts, mock.ts, helpers.ts (noul/choice/score)
src/levels/   level01/ .. level10/ — one file per option (A, B, C), questions and thresholds in that file
src/demo.ts   runs all 10 levels
tests/        core.test.ts + one test file per level, plus claude, hardening, server, calibration and starter-sync
calibration/  labeled fixtures and the threshold sweep behind `npm run calibrate`
claude/       hooks, the MCP server, and the config printer for Claude Code (levels 6 to 10)
server/       the lab API, the Jev broker, the request guard, the Claude Code session manager
```

## The rules this codebase follows (from the TypeSafe docs and field reports)

1. **One snap judgment per question.** "Does this convey urgency?" — not "analyze and decide the best action."
2. **Fan out.** Ask every question you might need in one request, including speculative ones; code decides which answers to use.
3. **Numbers, dates, and counting stay in code.** Jev picks a card from the deck; it doesn't name one. Filter candidates first, let Jev choose.
4. **Confidence is a second axis.** Floor (route to human), bar (auto-execute destructive), and the middle confirms.
5. **Give the model an exit.** An `other` / `none_of_the_above` option whenever the list might not cover every input.
6. **Describe situations, not degrees.** "Blocking issue; no workaround exists" — not "moderately severe."
7. **Questions and thresholds in one reviewable file per level.** The part a human audits.
8. **Isolate the state.** If you're classifying a passage, don't send the whole document — context rot is real.
9. **Second requests only for real dependencies.** If the next question's options depend on the first answer, that's a second request; otherwise fan out.
10. **The 255-option Choice cap is a feature.** Dynamic blocks prune in code before they build — `buildChoiceBlock` enforces it.

## Levels 6 to 10 in one paragraph

Levels 1 to 5 call Jev from code. Levels 6 to 10 put Jev inside Claude Code, and each step gives
the agent more say over the questions. Level 6 is two hooks the agent never sees: `PreToolUse` blocks
irreversible commands and credential writes, `PostToolUse` flags injected instructions. Level 7 is
the `Stop` hook asking four questions after every turn, with the numbers in code and the agent
hearing nothing, a notice, a recommendation, or a request. Level 8 is three flat tools, one file
each, where code reads the file and the agent gets a typed answer, never the content. Level 9 is
one tool over globs, one call per file in parallel, capped at 255 in code. Level 10 is `ask_jev`
on anything the agent holds, with a description that carries the schema and prompts that say what
to ask. Hooks and tools live in `claude/`, the decision code they import lives in `src/levels/`, and the
sandbox they work in lives in `sandbox/`.
