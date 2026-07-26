import http, { Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import httpProxy from "http-proxy";

const TARGET = process.env["TARGET"] ?? "http://127.0.0.1:3100";
const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const BIND = process.env["BIND"] ?? "127.0.0.1";
const AUTH_TOKEN = process.env["AUTH_TOKEN"];

// Basic Auth credentials (used by browsers — triggers a native login dialog)
// Multi-user Basic Auth: BASIC_AUTH_USERS=admin:pass1,user:pass2
// Also supports legacy single-user: BASIC_AUTH_USER + BASIC_AUTH_PASS
const BASIC_AUTH_USER = process.env["BASIC_AUTH_USER"];
const BASIC_AUTH_PASS = process.env["BASIC_AUTH_PASS"];
const BASIC_AUTH_USERS_RAW = process.env["BASIC_AUTH_USERS"] ?? "";
const REALM = process.env["AUTH_REALM"] ?? "DVA";

// Parse multi-user credential string into { username: password } map
function parseUsers(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1));
  }
  return map;
}

const BASIC_AUTH_USERS = parseUsers(BASIC_AUTH_USERS_RAW);
// Legacy single-user fallback
if (BASIC_AUTH_USER && BASIC_AUTH_PASS && BASIC_AUTH_USERS.size === 0) {
  BASIC_AUTH_USERS.set(BASIC_AUTH_USER, BASIC_AUTH_PASS);
}
const BASIC_AUTH_ENABLED = BASIC_AUTH_USERS.size > 0;

// Case-insensitive username lookup — returns the canonical (configured) casing
// so the forwarded x-authenticated-user header matches the host's identity checks.
function lookupBasicUser(name: string): { canonical: string; pass: string } | null {
  const exact = BASIC_AUTH_USERS.get(name);
  if (exact !== undefined) return { canonical: name, pass: exact };
  const lower = name.toLowerCase();
  for (const [k, v] of BASIC_AUTH_USERS) {
    if (k.toLowerCase() === lower) return { canonical: k, pass: v };
  }
  return null;
}

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

function isLoopback(addr: string): boolean {
  return LOOPBACK.includes(addr);
}

if (!isLoopback(BIND) && !AUTH_TOKEN && !BASIC_AUTH_ENABLED) {
  console.error(
    `[proxy] FATAL: BIND is set to "${BIND}" (non-loopback) but neither AUTH_TOKEN ` +
    `nor BASIC_AUTH_USER/BASIC_AUTH_PASS is set. Refusing to start without auth.`
  );
  process.exit(1);
}

// Constant-time string compare — prevents timing-attack leaks on the password.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Returns [true, username] if authenticated, [false, null] otherwise. */
function checkAuthWithUser(req: http.IncomingMessage): [boolean, string | null] {
  if (isLoopback(BIND)) return [true, "loopback"];
  const header = req.headers["authorization"] ?? "";

  // Bearer token path (for curl / CI / programmatic clients)
  if (AUTH_TOKEN && header === `Bearer ${AUTH_TOKEN}`) return [true, `bearer:${AUTH_TOKEN.slice(0, 8)}`];

  // Basic Auth path (for browsers — browser auto-attaches after first login)
  if (BASIC_AUTH_ENABLED && header.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    } catch {
      return [false, null];
    }
    const idx = decoded.indexOf(":");
    if (idx < 0) return [false, null];
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    const match = lookupBasicUser(user);
    if (match && safeEqual(pass, match.pass)) return [true, match.canonical];
  }

  return [false, null];
}

function checkAuth(req: http.IncomingMessage): boolean {
  return checkAuthWithUser(req)[0];
}

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  ws: true,
});

proxy.on("error", (err, req, res) => {
  console.error(`[proxy error] ${err.message}`);
  if (res instanceof http.ServerResponse) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway");
  }
});

const server: HttpServer = http.createServer((req, res) => {
  const [ok, username] = checkAuthWithUser(req);
  if (!ok) {
    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    // Send the Basic challenge so the browser pops a tu dialog.
    if (BASIC_AUTH_ENABLED) {
      headers["WWW-Authenticate"] = `Basic realm="${REALM}", charset="UTF-8"`;
    }
    res.writeHead(401, headers);
    res.end("Unauthorized");
    return;
  }
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  const loopbackHeaders: Record<string, string> = { "x-loopback": "1" };
  if (username) loopbackHeaders["x-authenticated-user"] = username;
  proxy.web(req, res, { headers: loopbackHeaders });
});

server.on("upgrade", (req, socket, head) => {
  const [ok, username] = checkAuthWithUser(req);
  if (!ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  console.log(`[${new Date().toISOString()}] WS UPGRADE ${req.url}`);
  const loopbackHeaders: Record<string, string> = { "x-loopback": "1" };
  if (username) loopbackHeaders["x-authenticated-user"] = username;
  proxy.ws(req, socket, head, { headers: loopbackHeaders });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[proxy] FATAL: ${BIND}:${PORT} is already in use. Set PORT or BIND to another value.`);
  } else {
    console.error(`[proxy] FATAL: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  console.log(`Proxy listening on http://${BIND}:${PORT} → ${TARGET}`);
  if (!isLoopback(BIND)) {
    const modes = [
      AUTH_TOKEN && "Bearer",
      BASIC_AUTH_ENABLED && "Basic",
    ].filter(Boolean).join(" + ") || "none";
    console.warn(`[proxy] WARNING: bound to non-loopback ${BIND} — auth enforced (${modes}).`);
  }
});
