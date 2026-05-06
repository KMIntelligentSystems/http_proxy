import http, { Server as HttpServer } from "node:http";
import httpProxy from "http-proxy";

const TARGET = process.env["TARGET"] ?? "http://127.0.0.1:3100";
const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const BIND = process.env["BIND"] ?? "127.0.0.1";
const AUTH_TOKEN = process.env["AUTH_TOKEN"];

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

function isLoopback(addr: string): boolean {
  return LOOPBACK.includes(addr);
}

if (!isLoopback(BIND) && !AUTH_TOKEN) {
  console.error(
    `[proxy] FATAL: BIND is set to "${BIND}" (non-loopback) but AUTH_TOKEN is not set. ` +
    `Refusing to start without auth. Set AUTH_TOKEN or bind to 127.0.0.1.`
  );
  process.exit(1);
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (isLoopback(BIND)) return true;
  const header = req.headers["authorization"] ?? "";
  return header === `Bearer ${AUTH_TOKEN}`;
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
    res.writeHead(401, { "Content-Type": "text/plain" });
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
    console.warn(`[proxy] WARNING: bound to non-loopback address ${BIND} — auth is enforced.`);
  }
});
