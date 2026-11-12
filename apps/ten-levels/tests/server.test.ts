import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { allowedFor, checkRequest } from "../server/security.mjs";
import { createLabServer } from "../server/server.mjs";
import * as agents from "../server/agent-session.mjs";
import { agentEnv, guardSettings, secretPaths, splitTools } from "../server/agent-session.mjs";

const SANDBOX = fileURLToPath(new URL("../sandbox/", import.meta.url));

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request with any Host and Origin, which fetch will not let a test set. */
function send(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = createLabServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

// the request guard

test("Server: the guard names this server's hosts and origins for the port it bound", () => {
  const { hosts, origins } = allowedFor(4399, []);
  assert.deepEqual([...hosts].sort(), ["127.0.0.1:4399", "[::1]:4399", "localhost:4399"]);
  assert.ok(origins.has("http://localhost:4399"));
  const dev = allowedFor(4399, "http://localhost:5173, http://127.0.0.1:5173");
  assert.ok(dev.hosts.has("localhost:5173"));
  assert.ok(dev.origins.has("http://127.0.0.1:5173"));
});

test("Server: a request for another host is refused, so DNS rebinding gets nowhere", async () => {
  await withServer(async (port) => {
    const rebinding = await send(port, "GET", "/api/state", { headers: { host: `attacker.example:${port}` } });
    assert.equal(rebinding.status, 403);
    assert.match(rebinding.body, /host not allowed/);
    assert.equal((await send(port, "GET", "/api/state", { headers: { host: "127.0.0.1:1" } })).status, 403);
    assert.equal((await send(port, "GET", "/api/state")).status, 200);
    assert.equal((await send(port, "GET", "/api/state", { headers: { host: `localhost:${port}` } })).status, 200);
  });
});

test("Server: a cross site page cannot start an agent, whatever it puts in the body", async () => {
  await withServer(async (port) => {
    const body = JSON.stringify({ level: 6, option: "A" });
    const cross = await send(port, "POST", "/api/agent/start", { headers: { ...JSON_HEADERS, origin: "https://attacker.example" }, body });
    assert.equal(cross.status, 403);
    assert.match(cross.body, /origin not allowed/);
    const nullOrigin = await send(port, "POST", "/api/agent/start", { headers: { ...JSON_HEADERS, origin: "null" }, body });
    assert.equal(nullOrigin.status, 403);
    const simple = await send(port, "POST", "/api/agent/start", { headers: { "content-type": "text/plain" }, body });
    assert.equal(simple.status, 415);
    const form = await send(port, "POST", "/api/agent/start", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "level=6" });
    assert.equal(form.status, 415);
    assert.equal(agents.count(), 0, "no session was started by any of them");
  });
});

test("Server: no preflight is ever answered and no CORS header is ever sent", async () => {
  await withServer(async (port) => {
    const preflight = await send(port, "OPTIONS", "/api/agent/start", { headers: { origin: "https://attacker.example", "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 403);
    const ok = await send(port, "GET", "/api/state", { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], undefined);
  });
});

test("Server: the page itself can call its own API, and responses carry the anti framing headers", async () => {
  await withServer(async (port) => {
    const res = await send(port, "POST", "/api/run/1?option=A", {
      headers: { ...JSON_HEADERS, origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ input: { message: "Hi, can you help me update the billing address?" } }),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /event: decision/);
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
  });
});

test("Server: a body over the limit is refused, and bad JSON is a 400", async () => {
  await withServer(async (port) => {
    const big = await send(port, "POST", "/api/run/1?option=A", { headers: JSON_HEADERS, body: JSON.stringify({ input: { message: "x".repeat(70_000) } }) });
    assert.equal(big.status, 413);
    const bad = await send(port, "POST", "/api/run/1?option=A", { headers: JSON_HEADERS, body: "{not json" });
    assert.equal(bad.status, 400);
  });
});

test("Server: checkRequest alone: GET needs no content type, and an unlisted origin on GET is still refused", () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, headers: { host: "127.0.0.1:1", ...headers } });
  assert.equal(checkRequest(req("GET", {}), 1), null);
  assert.equal(checkRequest(req("GET", { origin: "https://x.example" }), 1)?.status, 403);
  assert.equal(checkRequest(req("POST", { "content-type": "application/json; charset=utf-8" }), 1), null);
  assert.equal(checkRequest(req("POST", {}), 1)?.status, 415);
});

// the broker

test("Broker: hooks hold a session token, never the key: unknown tokens are refused, a real one is served and counted", async () => {
  await withServer(async (port) => {
    const url = `http://127.0.0.1:${port}/jev/v1/systemone`;
    const session = agents.start({ level: 6, option: "A", tools: ["read"], cwd: SANDBOX, config: {}, brokerUrl: url });
    const call = { state: "The export button crashes in Safari.", questions: { urgent: { type: "noul", instructions: "Is this urgent?" } } };
    const post = (token: string | null, body: unknown = call) =>
      send(port, "POST", "/jev/v1/systemone", { headers: { ...JSON_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    try {
      assert.equal((await post(null)).status, 401);
      assert.equal((await post("not-a-token")).status, 401);
      const browser = await send(port, "POST", "/jev/v1/systemone", {
        headers: { ...JSON_HEADERS, origin: "https://attacker.example", authorization: `Bearer ${session.token}` }, body: JSON.stringify(call),
      });
      assert.equal(browser.status, 403, "a page cannot ride a leaked token");

      const ok = await post(session.token);
      assert.equal(ok.status, 200);
      assert.equal(JSON.parse(ok.body).answers.urgent.type, "noul");
      assert.equal(session.ledger.calls, 1);
      assert.equal(session.ledger.questions, 1);

      assert.equal((await post(session.token, { state: "x", questions: {} })).status, 400, "a malformed call is the caller's error");

      session.callCap = 1;
      const capped = await post(session.token);
      assert.equal(capped.status, 402);
      assert.match(capped.body, /session limit reached/);
    } finally {
      session.close();
    }
    assert.equal((await post(session.token)).status, 401, "a token dies with its session");
  });
});

test("Broker: the agent environment carries the broker and a token, and neither Jev key nor Anthropic key", () => {
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: "/home/x", OPENROUTER_API_KEY: "or-key", TYPESAFE_API_KEY: "ts-key", ANTHROPIC_API_KEY: "sk-ant", AWS_SECRET: "nope" });
  try {
    const env = agentEnv({ dir: "/d", cwd: "/c", eventLog: "/d/e.jsonl" }, { gates: ["A"] }, { url: "http://127.0.0.1:9/jev/v1/systemone", token: "tok" });
    assert.equal(env.HOME, "/home/x");
    assert.equal(env.JEV_PROXY_URL, "http://127.0.0.1:9/jev/v1/systemone");
    assert.equal(env.JEV_PROXY_TOKEN, "tok");
    for (const name of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET"]) assert.equal(env[name], undefined, name);
    assert.equal(Object.values(env).some((v) => String(v).includes("or-key") || String(v).includes("ts-key")), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("Sessions: ids are unguessable, and the lab refuses more than its limit", async () => {
  await withServer(async (port) => {
    const ids: string[] = [];
    const start = () => send(port, "POST", "/api/agent/start", { headers: JSON_HEADERS, body: JSON.stringify({ level: 8, option: "A" }) });
    try {
      for (let i = 0; i < agents.MAX_SESSIONS; i++) {
        const r = await start();
        assert.equal(r.status, 200);
        ids.push(JSON.parse(r.body).id);
      }
      for (const id of ids) assert.match(id, /^[a-f0-9]{32}$/);
      assert.equal(new Set(ids).size, ids.length);
      const over = await start();
      assert.equal(over.status, 429);
    } finally {
      for (const id of ids) agents.getSession(id)?.close();
    }
  });
});

// permissions and the OS sandbox

test("Lab: built in tools are allowed only inside the project, never as bare Read, Edit, or Write", () => {
  const { allow } = splitTools(["read", "bash", "edit", "write", "ask_jev"]);
  assert.deepEqual(allow, ["Read(/**)", "Bash", "Edit(/**)", "Write(/**)"]);
});

test("Lab: the secret paths cover your logins, the lab's session files, and the repo's .env", () => {
  const paths = secretPaths("/home/u");
  for (const p of ["/home/u/.claude", "/home/u/.claude.json", "/home/u/.ssh", "/home/u/.aws", "/home/u/.netrc"]) assert.ok(paths.includes(p), p);
  assert.ok(paths.some((p) => p.endsWith("/.sessions")));
  assert.ok(paths.some((p) => p.endsWith("/.env")));
});

test("Lab: deny rules hold on every platform, the OS sandbox follows the mode", () => {
  const secrets = ["/home/u/.ssh", "/home/u/.claude"];
  const on = guardSettings("on", secrets, false);
  assert.equal(on.sandboxed, true);
  assert.equal(on.settings.sandbox.failIfUnavailable, true, "on refuses to run without the sandbox");
  assert.equal(on.settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(on.settings.sandbox.network.allowedDomains, []);
  assert.deepEqual(on.settings.sandbox.filesystem.denyRead, secrets);
  assert.ok(on.settings.permissions.deny.includes("Read(//home/u/.ssh/**)"));
  assert.ok(on.settings.permissions.deny.includes("Edit(//home/u/.claude)"));

  const auto = guardSettings("auto", secrets, true);
  assert.equal(auto.sandboxed, true);
  assert.equal(auto.settings.sandbox.failIfUnavailable, false);
  assert.equal(auto.warning, null);

  const missing = guardSettings("auto", secrets, false);
  assert.equal(missing.sandboxed, false);
  assert.equal(missing.settings.sandbox, undefined);
  assert.ok(missing.settings.permissions.deny.length > 0, "file rules still apply");
  assert.match(String(missing.warning), /bubblewrap and socat/);

  const off = guardSettings("off", secrets, false);
  assert.equal(off.sandboxed, false);
  assert.equal(off.warning, null);
});
