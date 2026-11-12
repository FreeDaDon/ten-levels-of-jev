---
description: Install 10 Levels of Jev — prerequisites, the web dependencies, the OpenRouter key, Claude Code sign-in for the agentic levels, and a first offline test run
---

# Install 10 Levels of Jev

## Purpose

Set up the 10 Levels of Jev lab for development. Checks the toolchain (Node 24, bun, just, Claude Code), installs the Vue lab's dependencies, confirms the Jev credential without displaying it, verifies the sandbox and the Claude Code hook and MCP config the agentic levels depend on, and runs the offline suite. This is an interactive, agentic process — ask the user when choices are needed.

## Variables

SOURCE_REPO: The directory this command is running from
APP_DIR: `apps/ten-levels`
WEB_DIR: `apps/ten-levels/web`
SANDBOX_DIR: `apps/ten-levels/sandbox`
CLAUDE_DIR: `apps/ten-levels/claude`
ENV_FILE: `.env` at the repo root (loaded by the justfile)
ENV_SAMPLE: `.env.sample`

## Codebase Structure

```
apps/ten-levels/
├── src/core/          # the Jev wire contract and client (mock, OpenRouter, TypeSafe)
├── src/levels/        # level01 .. level10, one file per option
├── claude/            # Claude Code hooks (L6, L7) and the MCP server (L7 to L10), plus config.ts
├── sandbox/           # the repo the agents work in
├── server/            # the API and the Claude Code session manager, node:http only
├── web/               # the Vue lab; bun installs its dependencies
└── tests/             # 251 offline tests on the mock, 10 live tests
justfile               # every recipe; loads .env
```

## Instructions

- Run every check via Bash — do not assume anything is installed.
- Show a status line immediately after each check (pass or fail).
- For auto-installable items (the web dependencies), install without asking.
- For items requiring user input (the API key), ask the user with sensible defaults.
- Do NOT read or display API key values — only confirm they are set.
- Never start `just web` or `just dev` from this command; only verify readiness.
- The app has no runtime dependencies. `npm ci` in `APP_DIR` installs dev tools only, and `web/` needs its own install.
- Levels 1 to 5 work offline on the mock. Levels 6 to 10 need Claude Code signed in with a subscription and an OpenRouter key; if either is missing, say so and continue, the rest of the lab still works.

## Workflow

### Step 1 — Check Prerequisites

Gate on the first two; stop and guide the user if either is missing.

1. **Node 24**: `command -v node && node --version`. The levels run as TypeScript natively, which needs Node 22 or later, and 24 is what the repo is tested on. Missing or older: install from https://nodejs.org or `nvm install 24`.
2. **just**: `command -v just`. Missing: `brew install just` or https://github.com/casey/just#installation.

Then the standard tools:

3. **bun**: `command -v bun`. Builds and serves the Vue lab. Missing: `curl -fsSL https://bun.sh/install | bash`.
4. **git**: `command -v git`. Each agent session initializes a git copy of the sandbox so `git diff` works inside it.
5. **Claude Code 2.1.295 or later, signed in with a subscription**: `command -v claude && claude --version`. Runs levels 6 to 10 on your login, never on `ANTHROPIC_API_KEY`. Missing: https://code.claude.com. Do not run a prompt to test the login. Not a gate; report it and continue.

### Step 2 — Check Environment

6. Check whether `OPENROUTER_API_KEY` is set in the shell or in `ENV_FILE`: `grep -q '^OPENROUTER_API_KEY=' .env 2>/dev/null || [ -n "$OPENROUTER_API_KEY" ]`. Report set or not set, never the value.
7. If not set, ask the user whether they have an OpenRouter key (https://openrouter.ai/keys). If yes, ask them to paste it into `ENV_FILE` themselves, or copy `ENV_SAMPLE` to `ENV_FILE` for them and tell them which line to fill. If no, say that levels 1 to 5 run offline on the mock and levels 6 to 10 stay unavailable until a key exists.
8. Optionally note `TYPESAFE_API_KEY` (direct TypeSafe backend, takes precedence over OpenRouter) and `JEV_AGENT_MODEL` (the Claude Code model for levels 6 to 10: `haiku` by default, `sonnet`, or a full model ID). Do not ask for them.

### Step 3 — Install Dependencies

9. Run `cd APP_DIR && npm ci` (typescript, @types/node, and oxlint: dev tools for `just check`; the levels have no runtime dependencies), then `cd WEB_DIR && bun install`. Report the package counts from each.

### Step 4 — Verify Configuration

10. `CLAUDE_DIR` contains `lib.ts`, `config.ts`, `tools.ts`, `transcript.ts`, `compact-eval.ts`, `hooks/guard.ts`, `hooks/compact.ts`, and `mcp/server.ts`. List any missing.
11. `node claude/config.ts 6 settings` and `node claude/config.ts 10 mcp` (run in `APP_DIR`) each print valid JSON. Do not display environment values.
12. `SANDBOX_DIR/src/domain/billing.ts` contains `Math.floor` on the prorate line. That is the failing test on purpose; if it reads `Math.round` someone fixed the pristine sandbox and levels 7, 9, and 10 lose their bug. Report it, do not change it.
13. `apps/ten-levels/web/public/heroes/` contains ten `level-N.svg` files; if not, note that `just heroes` regenerates them.

### Step 5 — Verify Readiness

14. Run `just check` from the repo root (typecheck, lint, tests). Expect 251 passing, 0 failures, and 10 live tests skipped; report the pass count. This uses the mock and needs no key.
15. Run `cd SANDBOX_DIR && npm test` and expect exactly one failure, the proration test. Report pass and fail counts.
16. Confirm `just --list` shows `web`, `dev`, `jev1` through `jev10`, `test`, `test-live`, `demo`, `heroes`, `lint`. Do not run `web` or `dev`.
17. If Claude Code is installed, confirm `claude --version` prints 2.1.295 or later. On Linux, also check `command -v bwrap && command -v socat`: they let the agent's Bash run in Claude Code's OS sandbox. If either is missing, say the lab will run with a warning and the agent's Bash unconfined, and offer `apt install bubblewrap socat`. Do not run it yourself.

### Step 6 — Report

Show a status table with one row per check above, pass or fail, and one line per item that needs the user's action. Then the ready count, for example `16 of 17 ready`.

Next steps, as commands the user can paste:

```bash
just web            # build and serve the lab on http://127.0.0.1:4399, opens the browser
just jev1           # one level in the terminal, jev1 through jev10; add a, b, or c for one option (just jev4 b)
just test-live      # 10 live tests against real Jev, needs OPENROUTER_API_KEY
just demo           # every level, every option, on the mock
```

If Claude Code or the key is missing, say which levels are unavailable and what to install to unlock them.
