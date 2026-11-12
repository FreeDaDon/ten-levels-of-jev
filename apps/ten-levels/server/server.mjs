/**
 * Lab server. Zero dependencies, node:http only.
 *
 *   GET  /api/state           { provider, live, calls }
 *   GET  /api/level/:n        { n, options: [{ key, name, file, inputs: [setA, setB, setC], call, code }] }
 *   POST /api/run/:n?option=A body { input } -> SSE stream: option-start, then per Jev call
 *                             request (state + questions) and response (typed answers + meta),
 *                             per-option events (tick, beam-step, agent-*), decision, level-done
 *   POST /api/agent/start     body { level, option, config } -> { id, model }; starts a Claude Code session, one `claude -p` per prompt
 *   GET  /api/agent/:id/events SSE: every session event so far, then live (agent, tool, jev, hook, stats)
 *   POST /api/agent/:id/prompt body { message }
 *   POST /api/agent/:id/abort
 *   DELETE /api/agent/:id
 *   POST /jev/v1/systemone    the Jev broker: a session's hooks and tools call Jev here with a session token, so the
 *                             agent's environment never holds the real key. Counted and capped per session.
 *   GET  /*                   the built Vue app in ../web/dist (SPA fallback to index.html)
 *
 * Every request passes server/security.mjs first: Host, Origin, content type, body size.
 * Live by default when a TypeSafe or OpenRouter key is set; JEV_BACKEND=mock forces offline.
 */
// The demo opts into mock only when no live credentials exist. Otherwise the
// shared client chooses TypeSafe first, then OpenRouter, once on construction.
if (!process.env.JEV_BACKEND && !process.env.TYPESAFE_API_KEY?.trim() && !process.env.OPENROUTER_API_KEY?.trim()) {
  process.env.JEV_BACKEND = "mock";
}

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";
import { sharedJev } from "../src/core/client.ts";
import { QuestionValidationError } from "../src/core/types.ts";
import { LEVEL_HOOKS } from "../claude/config.ts";
import { SCENARIOS } from "./scenarios.mjs";
import * as agents from "./agent-session.mjs";
import { checkRequest, readJsonBody, SECURITY_HEADERS } from "./security.mjs";

const DIST = fileURLToPath(new URL("../web/dist/", import.meta.url));
const SANDBOX = fileURLToPath(new URL("../sandbox/", import.meta.url));
const LEVELS_DIR = fileURLToPath(new URL("../src/levels/", import.meta.url));
/** The broker accepts bigger bodies than the API: a state can be most of a 64k token budget. */
const BROKER_BODY_BYTES = 1_000_000;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** The page shows the real source, minus comments: block comments, full-line comments, and 3+ blank lines collapsed. */
function stripComments(source) {
  return source
    .replace(/^[ \t]*\/\*\*[\s\S]*?\*\/\n?/gm, "")
    .replace(/^[ \t]*\/\/[^\n]*\n/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

async function runOption(client, option, level, input, res) {
  sse(res, "option-start", { level, option: option.key, name: option.name });
  const off = client.on((e) => sse(res, e.kind, e));
  try {
    const emit = (e) => sse(res, e.kind, e);
    const output = await option.run(input, { emit });
    sse(res, "decision", { level, option: option.key, name: option.name, input, output });
  } catch (err) {
    sse(res, "option-error", { level, option: option.key, error: String(err?.message ?? err) });
  } finally {
    off();
  }
  sse(res, "level-done", { level });
}

/** The Jev broker. Hooks and tools hold a session token, never the key; the server calls Jev and keeps the books. */
async function broker(client, req, res) {
  const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
  const session = token ? agents.getByToken(token) : undefined;
  if (!session) return json(res, 401, { error: "unknown session token" });
  const over = session.overBudget();
  if (over) return json(res, 402, { error: over });
  let body;
  try {
    body = await readJsonBody(req, BROKER_BODY_BYTES);
  } catch (err) {
    return json(res, err.status ?? 400, { error: err.message });
  }
  try {
    // The model is the server's choice. A caller cannot pick a pricier one.
    const result = await client.systemOne(body.state, body.questions);
    session.charge(result.usage, Object.keys(result.answers).length);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(result.raw.responseText);
  } catch (err) {
    return json(res, err instanceof QuestionValidationError ? 400 : 502, { error: String(err?.message ?? err) });
  }
}

export function createLabServer() {
  const client = sharedJev();
  const port = () => /** @type {import("node:net").AddressInfo} */ (server.address())?.port ?? 0;

  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    const refused = checkRequest(req, port());
    if (refused) return json(res, refused.status, { error: refused.error });

    if (url.pathname === "/jev/v1/systemone" && req.method === "POST") return broker(client, req, res);

    if (url.pathname === "/api/state") {
      return json(res, 200, { provider: client.provider, live: client.isLive, calls: client.calls });
    }

    // Agent sessions: one Claude Code conversation per run, one claude -p per prompt.
    if (url.pathname === "/api/agent/start" && req.method === "POST") {
      let body;
      try { body = await readJsonBody(req); } catch (err) { return json(res, err.status ?? 400, { error: err.message }); }
      const scenario = SCENARIOS[Number(body.level)];
      const option = scenario?.options.find((o) => o.key === (body.option || "A"));
      if (!scenario?.agent || !option) return json(res, 404, { error: "not an agent level or unknown option" });
      if (agents.count() >= agents.MAX_SESSIONS) return json(res, 429, { error: `at most ${agents.MAX_SESSIONS} sessions at once; close one first` });
      const session = agents.start({
        level: Number(body.level), option: option.key,
        tools: option.tools, cwd: SANDBOX,
        config: body.config ?? {},
        brokerUrl: `http://127.0.0.1:${port()}/jev/v1/systemone`,
      });
      return json(res, 200, { id: session.id, model: session.model });
    }
    const agentMatch = url.pathname.match(/^\/api\/agent\/([a-f0-9]+)(?:\/(events|prompt|abort))?$/);
    if (agentMatch) {
      const session = agents.getSession(agentMatch[1]);
      if (!session) return json(res, 404, { error: "no such session" });
      const action = agentMatch[2];
      if (action === "events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const off = session.subscribe((item) => sse(res, "item", item));
        req.on("close", off);
        return;
      }
      try {
        if (action === "prompt" && req.method === "POST") {
          const body = await readJsonBody(req);
          await session.prompt(String(body.message ?? ""));
        } else if (action === "abort" && req.method === "POST") {
          await session.abort();
        } else if (!action && req.method === "DELETE") {
          session.close();
        } else {
          res.writeHead(405); return res.end();
        }
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, err.status ?? 409, { error: String(err?.message ?? err) });
      }
    }

    const levelMatch = url.pathname.match(/^\/api\/level\/(\d+)$/);
    if (levelMatch && SCENARIOS[Number(levelMatch[1])]) {
      const n = Number(levelMatch[1]);
      const options = await Promise.all(SCENARIOS[n].options.map(async (o) => ({
        key: o.key, name: o.name, file: `src/levels/${o.file}`, inputs: o.inputs, call: o.call,
        hooks: LEVEL_HOOKS[n], tools: o.tools,
        code: stripComments(await readFile(join(LEVELS_DIR, o.file), "utf8")),
      })));
      return json(res, 200, { n, agent: !!SCENARIOS[n].agent, options });
    }

    const runMatch = url.pathname.match(/^\/api\/run\/(\d+)$/);
    if (runMatch && req.method === "POST") {
      const n = Number(runMatch[1]);
      const scenario = SCENARIOS[n];
      const option = scenario?.options.find((o) => o.key === (url.searchParams.get("option") || "A"));
      if (!option) return json(res, 404, { error: "unknown level or option" });
      let input = option.inputs[0];
      try {
        const body = await readJsonBody(req);
        if (body && typeof body.input === "object" && body.input) input = body.input;
      } catch (err) {
        return json(res, err.status ?? 400, { error: "body must be JSON { input }" });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      await runOption(client, option, n, input, res);
      return res.end();
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/jev/")) return json(res, 404, { error: "not found" });

    // Static: the built Vue app, with SPA fallback for client routes.
    const path = normalize(url.pathname);
    if (path.includes("..")) { res.writeHead(403); return res.end(); }
    const candidates = [join(DIST, path), join(DIST, "index.html")];
    // A hard refresh (shift reload) sends Cache-Control: no-cache; a normal reload sends max-age=0.
    // The page reads the mark and starts with every level hidden again.
    const hardReload = /no-cache/.test(req.headers["cache-control"] ?? "") || /no-cache/.test(req.headers.pragma ?? "");
    for (const file of candidates) {
      try {
        let data = await readFile(file);
        if (hardReload && file.endsWith("index.html")) {
          data = data.toString().replace("</head>", "<script>window.__JEV_HARD_RELOAD__=true</script></head>");
        }
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
        return res.end(data);
      } catch { /* next candidate */ }
    }
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No build found. Run `just web` (builds web/dist, then starts this server).");
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  agents.cleanStale();
  const server = createLabServer();
  server.listen(Number(process.env.PORT || 4399), "127.0.0.1", () => {
    console.log(`10 Levels of Jev lab → http://127.0.0.1:${server.address().port} (backend: ${sharedJev().provider})`);
  });
}
