/**
 * Who may talk to the lab server.
 *
 * The lab can start an agent with a shell, so the server is a local attack surface: any web page open in your
 * browser can send requests to 127.0.0.1, and a hostile DNS name can point at it. Four checks close that:
 *
 *   Host      must name this server (127.0.0.1, localhost, [::1], on this port). Defeats DNS rebinding, where an
 *             attacker's domain resolves to 127.0.0.1 and the browser treats the lab as same-origin to it.
 *   Origin    when a browser sends one, it must be this server. Defeats cross-site form posts and fetches.
 *   Type      a POST must declare application/json. A page cannot send that cross-origin without a CORS
 *             preflight, and the server never answers a preflight, so the browser refuses before sending.
 *   Size      a body is read up to a limit and no further.
 *
 * No CORS header is ever sent. To serve the Vite dev page from another port, name its origin in
 * JEV_ALLOWED_ORIGINS, comma separated, for example http://localhost:5173.
 */

export const MAX_BODY_BYTES = 64 * 1024;

/** The origins and hosts a request may carry, for the port the server actually bound. */
export function allowedFor(port, extraOrigins = (process.env.JEV_ALLOWED_ORIGINS ?? "")) {
  const extras = (Array.isArray(extraOrigins) ? extraOrigins : extraOrigins.split(",")).map((o) => o.trim()).filter(Boolean);
  const own = ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${port}`);
  const origins = new Set([...own.map((h) => `http://${h}`), ...extras]);
  const hosts = new Set(own);
  for (const origin of extras) {
    try { hosts.add(new URL(origin).host); } catch { /* ignored: not a URL */ }
  }
  return { origins, hosts };
}

/**
 * Returns null when the request may proceed, or { status, error } when it may not.
 * `needsJson` is true for a POST that carries a body the handler will parse.
 */
export function checkRequest(req, port, { needsJson = req.method === "POST" } = {}) {
  const { origins, hosts } = allowedFor(port);
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!hosts.has(host)) return { status: 403, error: "host not allowed" };
  if (req.method === "OPTIONS") return { status: 403, error: "no cross origin access" };
  const origin = req.headers.origin;
  // A browser always sends Origin on a cross-origin request and on any POST. No Origin means a command line client.
  if (origin !== undefined && !origins.has(String(origin).toLowerCase())) return { status: 403, error: "origin not allowed" };
  if (needsJson && !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
    return { status: 415, error: "content type must be application/json" };
  }
  return null;
}

/** Read a JSON body up to the limit. Throws a status carrying error past it, or on bad JSON. */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("body must be JSON"), { status: 400 });
  }
}

/** Headers for every response: no framing the lab page, no content sniffing, never cached as shared. */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};
