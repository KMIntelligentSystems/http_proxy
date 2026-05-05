import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const HOST_PORT = parseInt(process.env["HOST_PORT"] ?? "3000", 10);
const PROXY_URL = process.env["PROXY_URL"] ?? "http://localhost:8080";

// Load BLS API key from data/.env
let BLS_API_KEY = "";
try {
  const envPath = path.resolve(import.meta.dirname ?? ".", "..", "data", ".env");
  const envText = fs.readFileSync(envPath, "utf-8");
  const match = envText.match(/^BLS_API_KEY=(.+)$/m);
  if (match) BLS_API_KEY = match[1].trim().replace(/["']/g, "");
  if (BLS_API_KEY) console.log(`[host] BLS API key loaded (${BLS_API_KEY.slice(0, 6)}…)`);
  else console.warn(`[host] BLS_API_KEY not found in ${envPath}`);
} catch (e) {
  console.warn(`[host] Could not read data/.env for BLS key`);
}

// Browser WS clients connected to /ui/ws — receives SVG push messages
const browserClients = new Set<WebSocket>();

// Broadcast an SVG command to all browser clients
export function broadcastSvg(msg: SvgMessage) {
  const payload = JSON.stringify(msg);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export type SvgMessage =
  | { type: "clear" }
  | { type: "append"; svg: string }
  | { type: "replace"; id: string; svg: string }
  | { type: "remove"; id: string };

// ─── UI paths and helpers ───────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const UI_DIR = path.resolve(PROJECT_ROOT, "src", "ui");
const DIST_DIR = path.resolve(PROJECT_ROOT, "dist");

function isInside(baseDir: string, candidatePath: string): boolean {
  const relative = path.relative(baseDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "'": return "&#39;";
      case '"': return "&quot;";
      default: return ch;
    }
  });
}

type UiApp = {
  name: string;
  title: string;
  description: string;
  modifiedAt: string;
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function discoverUiApps(): UiApp[] {
  try {
    return fs.readdirSync(UI_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .map((entry) => {
        const name = entry.name.slice(0, -".html".length);
        if (!/^[a-z0-9-]+$/.test(name)) return undefined;

        const filePath = path.resolve(UI_DIR, entry.name);
        if (!isInside(UI_DIR, filePath)) return undefined;

        const html = fs.readFileSync(filePath, "utf-8");
        const stat = fs.statSync(filePath);
        const title = html.match(/<title>(.*?)<\/title>/is)?.[1]?.trim() || name;
        const description = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1]?.trim()
          || html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i)?.[1]?.trim()
          || "HTML application served through the Pi proxy.";

        return {
          name,
          title,
          description,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .filter((app): app is UiApp => Boolean(app))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.warn(`[host] Could not discover UI apps: ${(err as Error).message}`);
    return [];
  }
}

function renderPortalHtml(): string {
  const apps = discoverUiApps();
  const appCards = apps.map((app) => /* html */ `
    <a class="card app-card" href="/ui/app/${encodeURIComponent(app.name)}">
      <span class="kicker">HTML app</span>
      <strong>${escapeHtml(app.title)}</strong>
      <p>${escapeHtml(app.description)}</p>
      <code>/ui/app/${escapeHtml(app.name)}</code>
      <small>Modified ${escapeHtml(new Date(app.modifiedAt).toLocaleString())}</small>
    </a>
  `).join("\n");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Data Visualization Agent Portal</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --panel2:#0f1620; --line:#30363d; --text:#c9d1d9; --muted:#8b949e; --blue:#58a6ff; --green:#3fb950; --orange:#f78166; --violet:#d2a8ff; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family:"Segoe UI", system-ui, sans-serif; color:var(--text); background:radial-gradient(circle at 15% 10%, rgba(88,166,255,.16), transparent 30%), radial-gradient(circle at 85% 0%, rgba(210,168,255,.14), transparent 26%), linear-gradient(135deg,#080b10,#0d1117 55%,#07090d); }
    .shell { width:min(1180px, calc(100vw - 40px)); margin:0 auto; padding:36px 0 48px; }
    header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; margin-bottom:24px; }
    h1 { margin:0 0 10px; font-size:clamp(34px, 5vw, 60px); line-height:.95; letter-spacing:-.045em; }
    .lede { margin:0; max-width:760px; color:#aab6c4; font-size:17px; line-height:1.55; }
    .pill { display:inline-flex; align-items:center; gap:8px; border:1px solid rgba(63,185,80,.35); color:#aff5b4; background:rgba(63,185,80,.09); border-radius:999px; padding:8px 12px; font:700 12px/1 ui-monospace, SFMono-Regular, Consolas, monospace; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:minmax(0, 1.55fr) minmax(320px, .95fr); gap:18px; align-items:start; }
    section, .card { border:1px solid rgba(139,148,158,.22); background:linear-gradient(180deg, rgba(22,27,34,.9), rgba(13,17,23,.82)); border-radius:18px; box-shadow:0 18px 60px rgba(0,0,0,.30); }
    section { padding:18px; }
    h2 { margin:0 0 14px; font-size:18px; letter-spacing:-.01em; }
    .apps { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:14px; }
    .card { display:flex; flex-direction:column; min-height:190px; padding:16px; color:inherit; text-decoration:none; transition:transform .16s ease, border-color .16s ease, background .16s ease; }
    .card:hover { transform:translateY(-2px); border-color:rgba(88,166,255,.55); background:linear-gradient(180deg, rgba(30,41,56,.95), rgba(13,17,23,.9)); }
    .card strong { display:block; margin:8px 0; color:white; font-size:20px; line-height:1.18; }
    .card p { flex:1; margin:0 0 14px; color:var(--muted); line-height:1.45; }
    .card code { color:var(--blue); font:600 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap:anywhere; }
    .card small { margin-top:8px; color:#6e7681; }
    .kicker { color:var(--green); font:800 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing:.13em; text-transform:uppercase; }
    .status-list { display:grid; gap:10px; margin:0; padding:0; list-style:none; }
    .status-list li { display:flex; justify-content:space-between; gap:14px; padding:12px; border:1px solid rgba(139,148,158,.15); border-radius:12px; background:rgba(255,255,255,.03); }
    .status-list b { color:#f0f6fc; }
    .ok { color:var(--green); } .warn { color:var(--orange); }
    .prompt { margin-top:18px; }
    .prompt p { margin:0 0 14px; color:var(--muted); line-height:1.5; }
    .button-row { display:flex; flex-wrap:wrap; gap:10px; }
    .button { display:inline-flex; align-items:center; border:1px solid rgba(88,166,255,.38); background:rgba(88,166,255,.10); color:#cfe8ff; text-decoration:none; border-radius:12px; padding:10px 12px; font-weight:700; }
    .empty { color:var(--muted); border:1px dashed rgba(139,148,158,.28); border-radius:14px; padding:18px; }
    footer { margin-top:20px; color:#6e7681; font-size:12px; }
    @media (max-width: 850px) { header, .grid { grid-template-columns:1fr; display:grid; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Data Visualization Agent Portal</h1>
        <p class="lede">Launch generated HTML applications through the authenticated proxy path, inspect system status, and keep the legacy SVG canvas available for pushed visualizations.</p>
      </div>
      <span class="pill">proxy route /ui online</span>
    </header>

    <div class="grid">
      <section>
        <h2>Apps</h2>
        <div class="apps">
          ${appCards || `<div class="empty">No valid <code>src/ui/*.html</code> apps found. Use lowercase kebab-case file names.</div>`}
          <a class="card" href="/ui/canvas">
            <span class="kicker">Legacy</span>
            <strong>SVG Push Canvas</strong>
            <p>Open the WebSocket-backed canvas used by the <code>push_svg</code> tool.</p>
            <code>/ui/canvas</code>
            <small>${browserClients.size} connected WebSocket client${browserClients.size === 1 ? "" : "s"}</small>
          </a>
        </div>
      </section>

      <aside>
        <section>
          <h2>Details / Status</h2>
          <ul class="status-list">
            <li><span>Host</span><b class="ok">online :${HOST_PORT}</b></li>
            <li><span>Proxy entry</span><b class="ok">${escapeHtml(PROXY_URL)}</b></li>
            <li><span>BLS API key</span><b class="${BLS_API_KEY ? "ok" : "warn"}">${BLS_API_KEY ? "present" : "missing"}</b></li>
            <li><span>Discovered apps</span><b>${apps.length}</b></li>
            <li><span>WS canvas clients</span><b>${browserClients.size}</b></li>
          </ul>
        </section>

        <section class="prompt">
          <h2>Prompt</h2>
          <p>Source prompt viewing is planned for Phase 2C. Prompt changes will require <code>/reload</code> or a new session before they affect the running agent.</p>
          <div class="button-row">
            <a class="button" href="/ui/app/bls-explorer">Open BLS Explorer</a>
            <a class="button" href="/ui/canvas">Open SVG Canvas</a>
          </div>
        </section>
      </aside>
    </div>

    <footer>Apps are served from <code>src/ui/*.html</code>; route names must match <code>^[a-z0-9-]+$</code>.</footer>
  </main>
</body>
</html>`;
}

// ─── Legacy SVG canvas shell served at /ui/canvas ───────────────────────────

const UI_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>http-proxy canvas</title>
  <style>
    body { margin: 0; background: #0d1117; display: flex; justify-content: center; align-items: center; height: 100vh; }
    svg  { background: #161b22; border: 1px solid #30363d; border-radius: 6px; }
  </style>
</head>
<body>
  <svg id="canvas" width="800" height="600" xmlns="http://www.w3.org/2000/svg"></svg>
  <script>
    const canvas = document.getElementById("canvas");
    const wsUrl  = "ws://" + location.host + "/ui/ws";
    let   ws;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "clear") {
          canvas.innerHTML = "";
        } else if (msg.type === "append") {
          canvas.insertAdjacentHTML("beforeend", msg.svg);
        } else if (msg.type === "replace") {
          const el = document.getElementById(msg.id);
          if (el) el.outerHTML = msg.svg;
          else canvas.insertAdjacentHTML("beforeend", msg.svg);
        } else if (msg.type === "remove") {
          document.getElementById(msg.id)?.remove();
        }
      };

      ws.onclose = () => setTimeout(connect, 1500); // auto-reconnect
    }

    connect();
  </script>
</body>
</html>`;

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Requests tagged x-loopback arrived via proxy — serve real content
  if (req.headers["x-loopback"] === "1") {
    const requestUrl = new URL(req.url ?? "/", "http://host.local");
    const pathname = requestUrl.pathname;

    // Portal dashboard at /ui
    if (pathname === "/ui" || pathname === "/ui/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPortalHtml());
      return;
    }

    // Auto-discovered HTML apps: src/ui/*.html -> /ui/app/:name
    const appMatch = pathname.match(/^\/ui\/app\/([a-z0-9-]+)$/);
    if (appMatch) {
      const appName = appMatch[1];
      const appPath = path.resolve(UI_DIR, `${appName}.html`);
      if (!isInside(UI_DIR, appPath) || path.extname(appPath) !== ".html") {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid app path");
        return;
      }
      try {
        const html = fs.readFileSync(appPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("UI app not found");
      }
      return;
    }

    // Reject malformed app names explicitly rather than falling through silently.
    if (pathname.startsWith("/ui/app/")) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid app name. Use lowercase kebab-case: ^[a-z0-9-]+$");
      return;
    }

    // Serve data files under /ui/data/* from dist/ with traversal protection.
    if (pathname.startsWith("/ui/data/")) {
      const relativeName = decodeURIComponent(pathname.slice("/ui/data/".length));
      const filePath = path.resolve(DIST_DIR, relativeName);
      if (!relativeName || path.isAbsolute(relativeName) || !isInside(DIST_DIR, filePath)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid data path");
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("not a file");
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": getContentType(filePath), "Cache-Control": "public, max-age=3600" });
        res.end(data);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Data file not found");
      }
      return;
    }

    // Legacy SVG canvas at /ui/canvas
    if (pathname === "/ui/canvas") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(UI_HTML);
      return;
    }

    // POST /ui/api/bls — proxy BLS API requests to avoid CORS
    if (pathname === "/ui/api/bls" && req.method === "POST") {
      const body: Buffer[] = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        let parsed: any = {};
        try { parsed = JSON.parse(Buffer.concat(body).toString()); } catch {}
        // Inject API key if available and not already provided
        if (BLS_API_KEY && !parsed.registrationkey) {
          parsed.registrationkey = BLS_API_KEY;
        }
        const payload = Buffer.from(JSON.stringify(parsed));
        const blsReq = https.request(
          {
            hostname: "api.bls.gov",
            path: "/publicAPI/v2/timeseries/data/",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": payload.length,
            },
          },
          (blsRes) => {
            const chunks: Buffer[] = [];
            blsRes.on("data", (c) => chunks.push(c));
            blsRes.on("end", () => {
              const result = Buffer.concat(chunks);
              res.writeHead(blsRes.statusCode ?? 200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(result);
            });
          }
        );
        blsReq.on("error", (err) => {
          console.error(`[bls proxy error] ${err.message}`);
          res.writeHead(502);
          res.end(JSON.stringify({ status: "REQUEST_FAILED", message: [err.message] }));
        });
        blsReq.write(payload);
        blsReq.end();
      });
      return;
    }

    // POST /ui/svg — TUI or any local process can push SVG messages here
    if (pathname === "/ui/svg" && req.method === "POST") {
      const body: Buffer[] = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        try {
          const msg: SvgMessage = JSON.parse(Buffer.concat(body).toString());
          broadcastSvg(msg);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end("Bad JSON");
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // First hop — forward through the proxy (loopback)
  const body: Buffer[] = [];
  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    const proxyUrl = new URL(req.url ?? "/", PROXY_URL);
    const outReq = http.request(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: proxyUrl.pathname + proxyUrl.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: proxyUrl.host,
          "x-loopback": "1",
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    outReq.on("error", (err) => {
      console.error(`[loopback error] ${err.message}`);
      res.writeHead(502);
      res.end("Loopback error");
    });

    if (body.length) outReq.write(Buffer.concat(body));
    outReq.end();
  });
});

// ─── WebSocket server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (clientSocket, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[${new Date().toISOString()}] WS ${clientId} ${req.url}`);

  // /ui/ws — browser SVG canvas client
  if (req.url === "/ui/ws") {
    browserClients.add(clientSocket);
    clientSocket.on("close", () => browserClients.delete(clientSocket));
    return;
  }

  // Loopback echo (proxy health / internal)
  if (req.headers["x-loopback"] === "1") {
    clientSocket.on("message", (data, isBinary) => clientSocket.send(data, { binary: isBinary }));
    return;
  }

  // All other WS — forward through the proxy
  const wsProxyUrl = PROXY_URL.replace(/^http/, "ws");
  const loopSocket = new WebSocket(`${wsProxyUrl}${req.url ?? "/"}`, {
    headers: { "x-loopback": "1" },
  });

  clientSocket.on("message", (data, isBinary) => {
    if (loopSocket.readyState === WebSocket.OPEN) loopSocket.send(data, { binary: isBinary });
  });
  loopSocket.on("message", (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary });
  });

  clientSocket.on("close", (code, reason) => loopSocket.close(code, reason));
  loopSocket.on("close", (code, reason) => clientSocket.close(code, reason));

  loopSocket.on("error", (err) => {
    console.error(`[${clientId}] loopback WS error: ${err.message}`);
    clientSocket.close(1011, "Loopback error");
  });
});

server.listen(HOST_PORT, "127.0.0.1", () => {
  console.log(`Host listening on http://127.0.0.1:${HOST_PORT}`);
  console.log(`UI portal at   ${PROXY_URL}/ui`);
  console.log(`SVG canvas at  ${PROXY_URL}/ui/canvas`);
  console.log(`SVG push API   POST ${PROXY_URL}/ui/svg`);
});
