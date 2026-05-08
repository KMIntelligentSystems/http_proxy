import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { createArtifactStore, type ArtifactStore } from "./artifacts.js";

const HOST_PORT = parseInt(process.env["HOST_PORT"] ?? "3100", 10);
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

// Browser WS clients connected to /ui/ws — receive SVG push messages.
const browserClients = new Set<WebSocket>();

// Browser WS clients connected to /ui/ws/agent — receive server-side runtime events.
const agentClients = new Set<WebSocket>();

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

type AgentWsMessage = {
  type: string;
  receivedAt?: string;
  [key: string]: unknown;
};

function toJsonable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((entry) => toJsonable(entry, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const jsonable = toJsonable(entry, seen);
      if (jsonable !== undefined) out[key] = jsonable;
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function sendAgentWsMessage(client: WebSocket, msg: AgentWsMessage) {
  if (client.readyState !== WebSocket.OPEN) return;
  try {
    client.send(JSON.stringify(toJsonable(msg)));
  } catch (err) {
    console.warn(`[host] Failed to send agent WS message: ${err instanceof Error ? err.message : String(err)}`);
    try { client.close(); } catch {}
  }
}

function broadcastAgentWsMessage(msg: AgentWsMessage) {
  for (const client of agentClients) {
    sendAgentWsMessage(client, msg);
  }
}

function closeWsPeer(peer: WebSocket, code?: number, reason?: Buffer) {
  if (peer.readyState !== WebSocket.OPEN && peer.readyState !== WebSocket.CONNECTING) return;
  const validCode = typeof code === "number" && code >= 1000 && code < 5000 && ![1005, 1006, 1015].includes(code);
  if (validCode) peer.close(code, reason?.toString());
  else peer.close();
}

// ─── UI paths and helpers ───────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const UI_DIR = path.resolve(PROJECT_ROOT, "src", "ui");
const DIST_DIR = path.resolve(PROJECT_ROOT, "dist");
const WEB_DIST_DIR = path.resolve(DIST_DIR, "web");

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

// ─── Host runtime API helpers ───────────────────────────────────────────────

export type HostContext = {
  runtime?: any;
  artifactStore?: ArtifactStore;
};

export type HostServer = {
  server: http.Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
};

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readRequestText(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const text = await readRequestText(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function getAgentState(ctx: HostContext) {
  const session = ctx.runtime?.session;
  const agent = session?.agent;
  const state = agent?.state;
  if (!session || !agent || !state) return null;

  let tools: string[] = [];
  try {
    const allTools = typeof session.getAllTools === "function" ? session.getAllTools() : state.tools;
    tools = (allTools ?? []).map((tool: any) => tool?.name ?? tool?.label ?? String(tool));
  } catch {
    tools = [];
  }

  return {
    sessionId: session.sessionId ?? null,
    sessionFile: session.sessionFile ?? null,
    sessionName: session.sessionName ?? null,
    cwd: ctx.runtime?.cwd ?? process.cwd(),
    model: session.model ?? state.model ?? null,
    thinkingLevel: session.thinkingLevel ?? state.thinkingLevel ?? null,
    messages: session.messages ?? state.messages ?? [],
    isStreaming: Boolean(session.isStreaming ?? state.isStreaming),
    tools,
    systemPrompt: state.systemPrompt ?? "",
  };
}

function attachAgentEventBridge(ctx: HostContext): () => void {
  let activeSession: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;

  function detachSession() {
    unsubscribe?.();
    unsubscribe = undefined;
    activeSession = undefined;
  }

  function attachSession(session: AgentSession) {
    if (session === activeSession) return;

    unsubscribe?.();
    activeSession = session;
    unsubscribe = session.subscribe((event) => {
      broadcastAgentWsMessage({
        type: "agent_event",
        sessionId: session.sessionId ?? null,
        event: toJsonable(event),
        receivedAt: new Date().toISOString(),
      });
    });

    broadcastAgentWsMessage({
      type: "agent_bridge_status",
      status: "attached",
      sessionId: session.sessionId ?? null,
      sessionFile: session.sessionFile ?? null,
      receivedAt: new Date().toISOString(),
    });

    const state = getAgentState(ctx);
    if (state) {
      broadcastAgentWsMessage({
        type: "agent_state",
        state,
        receivedAt: new Date().toISOString(),
      });
    }
  }

  function attachCurrentSession() {
    const session = ctx.runtime?.session;
    if (!session || typeof session.subscribe !== "function") {
      detachSession();
      broadcastAgentWsMessage({
        type: "agent_bridge_status",
        status: "no_runtime",
        receivedAt: new Date().toISOString(),
      });
      return;
    }

    attachSession(session as AgentSession);
  }

  attachCurrentSession();

  const runtime = ctx.runtime;
  if (runtime && !runtime.__hostAgentBridgeWrapped) {
    for (const methodName of ["newSession", "switchSession", "fork", "importFromJsonl"] as const) {
      const original = runtime[methodName];
      if (typeof original !== "function") continue;
      runtime[methodName] = async (...args: unknown[]) => {
        const result = await original.apply(runtime, args);
        if (!result || result.cancelled !== true) attachCurrentSession();
        return result;
      };
    }
    Object.defineProperty(runtime, "__hostAgentBridgeWrapped", { value: true, enumerable: false });
  }

  return detachSession;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

export function startHost(ctx: HostContext = {}): HostServer {
let promptInFlight = false;
const artifactStore = ctx.artifactStore ?? createArtifactStore(path.resolve(PROJECT_ROOT, "data", "artifacts"));
ctx.artifactStore = artifactStore;
const detachArtifactEvents = artifactStore.onCreated((artifact) => {
  broadcastAgentWsMessage({
    type: "artifact_created",
    sessionId: ctx.runtime?.session?.sessionId ?? artifact.sessionId ?? null,
    artifact,
    receivedAt: new Date().toISOString(),
  });
});
const detachAgentEventBridge = attachAgentEventBridge(ctx);
const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Requests tagged x-loopback arrived via proxy — serve real content
  if (req.headers["x-loopback"] === "1") {
    const requestUrl = new URL(req.url ?? "/", "http://host.local");
    const pathname = requestUrl.pathname;

    // Phase W2 web shell at /ui. If dist/web is not built yet, fall back to
    // the legacy portal so standalone dev:host remains useful.
    if (pathname === "/ui" || pathname === "/ui/") {
      const webIndexPath = path.resolve(WEB_DIST_DIR, "index.html");
      try {
        const html = fs.readFileSync(webIndexPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      } catch {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderPortalHtml());
      }
      return;
    }

    // Legacy portal remains available alongside the pi-web-ui shell.
    if (pathname === "/ui/portal") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPortalHtml());
      return;
    }

    // Vite-built web assets: dist/web/assets/* -> /ui/assets/*
    if (pathname.startsWith("/ui/assets/")) {
      const relativeName = decodeURIComponent(pathname.slice("/ui/".length));
      const filePath = path.resolve(WEB_DIST_DIR, relativeName);
      if (!relativeName || path.isAbsolute(relativeName) || !isInside(WEB_DIST_DIR, filePath)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid web asset path");
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("not a file");
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": getContentType(filePath), "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(data);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Web asset not found");
      }
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

    // Artifact listing/content for Phase W4. Artifacts are created by backend
    // tools and served through the authenticated /ui route.
    if (pathname === "/ui/api/artifacts" && req.method === "GET") {
      const state = getAgentState(ctx);
      const includeAll = requestUrl.searchParams.get("all") === "1";
      const sessionId = includeAll ? undefined : state?.sessionId ?? undefined;
      sendJson(res, 200, { artifacts: artifactStore.list(sessionId) });
      return;
    }

    const artifactMatch = pathname.match(/^\/ui\/api\/artifacts\/([^/]+)(?:\/metadata)?$/);
    if (artifactMatch && req.method === "GET") {
      const id = decodeURIComponent(artifactMatch[1]);
      const hit = artifactStore.get(id);
      if (!hit) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("Artifact not found");
        return;
      }
      if (pathname.endsWith("/metadata")) {
        sendJson(res, 200, hit.record);
        return;
      }
      const data = fs.readFileSync(hit.filePath);
      res.writeHead(200, {
        "Content-Type": hit.record.mimeType.includes("text") || hit.record.mimeType === "application/json"
          ? `${hit.record.mimeType}; charset=utf-8`
          : hit.record.mimeType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${hit.record.filename.replace(/["\\]/g, "_")}"`,
      });
      res.end(data);
      return;
    }

    // GET /ui/api/agent/state — expose current server-side agent state
    if (pathname === "/ui/api/agent/state" && req.method === "GET") {
      const state = getAgentState(ctx);
      if (!state) {
        sendJson(res, 503, { error: "Agent runtime is not available in this host process" });
        return;
      }
      sendJson(res, 200, state);
      return;
    }

    // GET /ui/api/system-prompt/effective — exact prompt from active runtime state
    if (pathname === "/ui/api/system-prompt/effective" && req.method === "GET") {
      const state = getAgentState(ctx);
      if (!state) {
        sendJson(res, 503, { error: "Agent runtime is not available in this host process" });
        return;
      }
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        cwd: state.cwd,
        systemPrompt: state.systemPrompt,
        tools: state.tools,
      });
      return;
    }

    // POST /ui/api/agent/prompt — send a user prompt into the active runtime
    if (pathname === "/ui/api/agent/prompt" && req.method === "POST") {
      if (!ctx.runtime?.session?.prompt) {
        sendJson(res, 503, { error: "Agent runtime is not available in this host process" });
        return;
      }
      readJsonBody(req)
        .then(async (body) => {
          const input = typeof body?.input === "string" ? body.input : typeof body?.prompt === "string" ? body.prompt : "";
          if (!input.trim()) {
            sendJson(res, 400, { error: "Missing non-empty input" });
            return;
          }
          if (promptInFlight || ctx.runtime.session.isStreaming) {
            sendJson(res, 409, { error: "Agent is already processing a prompt" });
            return;
          }

          const session = ctx.runtime.session;
          promptInFlight = true;
          void Promise.resolve()
            .then(() => session.prompt(input))
            .then(() => {
              broadcastAgentWsMessage({
                type: "agent_prompt_complete",
                sessionId: session.sessionId ?? null,
                state: getAgentState(ctx),
                receivedAt: new Date().toISOString(),
              });
            })
            .catch((err: unknown) => {
              console.error(`[agent prompt error] ${err instanceof Error ? err.message : String(err)}`);
              broadcastAgentWsMessage({
                type: "agent_prompt_error",
                sessionId: session.sessionId ?? null,
                error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
                receivedAt: new Date().toISOString(),
              });
            })
            .finally(() => {
              promptInFlight = false;
            });

          sendJson(res, 202, { ok: true, accepted: true, sessionId: session.sessionId ?? null });
        })
        .catch((err) => {
          console.error(`[agent prompt request error] ${err instanceof Error ? err.message : String(err)}`);
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }

    // POST /ui/api/agent/abort — abort the active agent turn if supported
    if (pathname === "/ui/api/agent/abort" && req.method === "POST") {
      const abort = ctx.runtime?.session?.abort;
      if (typeof abort !== "function") {
        sendJson(res, 503, { error: "Agent abort is not available" });
        return;
      }
      Promise.resolve(abort.call(ctx.runtime.session))
        .then(() => sendJson(res, 200, { ok: true }))
        .catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
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
  const wsPathname = new URL(req.url ?? "/", "http://host.local").pathname;
  console.log(`[${new Date().toISOString()}] WS ${clientId} ${req.url}`);

  // /ui/ws — browser SVG canvas client
  if (wsPathname === "/ui/ws") {
    browserClients.add(clientSocket);
    clientSocket.on("close", () => browserClients.delete(clientSocket));
    return;
  }

  // /ui/ws/agent — browser runtime event stream. Only serve the loopback-tagged
  // second hop that has passed through the proxy.
  if (wsPathname === "/ui/ws/agent" && req.headers["x-loopback"] === "1") {
    agentClients.add(clientSocket);
    clientSocket.on("close", () => agentClients.delete(clientSocket));
    sendAgentWsMessage(clientSocket, {
      type: "agent_bridge_ready",
      clientCount: agentClients.size,
      receivedAt: new Date().toISOString(),
    });
    const state = getAgentState(ctx);
    if (state) {
      sendAgentWsMessage(clientSocket, {
        type: "agent_state",
        state,
        receivedAt: new Date().toISOString(),
      });
    } else {
      sendAgentWsMessage(clientSocket, {
        type: "agent_bridge_status",
        status: "no_runtime",
        receivedAt: new Date().toISOString(),
      });
    }
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

  clientSocket.on("close", (code, reason) => closeWsPeer(loopSocket, code, reason));
  loopSocket.on("close", (code, reason) => closeWsPeer(clientSocket, code, reason));

  loopSocket.on("error", (err) => {
    console.error(`[${clientId}] loopback WS error: ${err.message}`);
    clientSocket.close(1011, "Loopback error");
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[host] FATAL: 127.0.0.1:${HOST_PORT} is already in use. Set HOST_PORT to another value.`);
  } else {
    console.error(`[host] FATAL: ${err.message}`);
  }
  process.exit(1);
});

server.listen(HOST_PORT, "127.0.0.1", () => {
  console.log(`Host listening on http://127.0.0.1:${HOST_PORT}`);
  console.log(`UI portal at   ${PROXY_URL}/ui`);
  console.log(`SVG canvas at  ${PROXY_URL}/ui/canvas`);
  console.log(`SVG push API   POST ${PROXY_URL}/ui/svg`);
});

return {
  server,
  wss,
  close: () => new Promise<void>((resolve, reject) => {
    detachAgentEventBridge();
    detachArtifactEvents();
    for (const client of [...browserClients, ...agentClients]) client.close();
    wss.close((wsErr) => {
      if (wsErr) {
        reject(wsErr);
        return;
      }
      server.close((serverErr) => {
        if (serverErr) reject(serverErr);
        else resolve();
      });
    });
  }),
};
}

if (isMainModule()) {
  startHost();
}
