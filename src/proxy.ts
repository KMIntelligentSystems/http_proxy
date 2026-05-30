import http, { Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import httpProxy from "http-proxy";

const TARGET = process.env["TARGET"] ?? "http://127.0.0.1:3100";
const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const BIND = process.env["BIND"] ?? "127.0.0.1";
const AUTH_TOKEN = process.env["AUTH_TOKEN"];

// Basic Auth credentials (used by browsers — triggers a native login dialog)
const BASIC_AUTH_USER = process.env["BASIC_AUTH_USER"];
const BASIC_AUTH_PASS = process.env["BASIC_AUTH_PASS"];
const REALM = process.env["AUTH_REALM"] ?? "DVA";
const BASIC_AUTH_ENABLED = !!(BASIC_AUTH_USER && BASIC_AUTH_PASS);

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

function checkAuth(req: http.IncomingMessage): boolean {
  if (isLoopback(BIND)) return true;
  const header = req.headers["authorization"] ?? "";

  // Bearer token path (for curl / CI / programmatic clients)
  if (AUTH_TOKEN && header === `Bearer ${AUTH_TOKEN}`) return true;

  // Basic Auth path (for browsers — browser auto-attaches after first login)
  if (BASIC_AUTH_ENABLED && header.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    } catch {
      return false;
    }
    const idx = decoded.indexOf(":");
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    return safeEqual(user, BASIC_AUTH_USER!) && safeEqual(pass, BASIC_AUTH_PASS!);
  }

  return false;
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
  if (!checkAuth(req)) {
    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    // Send the Basic challenge so the browser pops a login dialog.
    if (BASIC_AUTH_ENABLED) {
      headers["WWW-Authenticate"] = `Basic realm="${REALM}", charset="UTF-8"`;
    }
    res.writeHead(401, headers);
    res.end("Unauthorized");
    return;
  }
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  proxy.web(req, res, { headers: { "x-loopback": "1" } });
});

server.on("upgrade", (req, socket, head) => {
  if (!checkAuth(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  console.log(`[${new Date().toISOString()}] WS UPGRADE ${req.url}`);
  proxy.ws(req, socket, head, { headers: { "x-loopback": "1" } });
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
