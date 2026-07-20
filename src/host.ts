import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { createArtifactStore, type ArtifactStore, isUtf8ArtifactMime } from "./artifacts.js";
import { syncIndicatorHistory } from "./refresh-history-bridge.js";
import type { UserQuestionManager } from "./user-questions.js";
import { loadProjectEnv } from "./env.js";

// Load .env before reading process.env at module scope. ESM hoists all static
// imports before the importing module's body executes, so by the time cli.ts /
// web-main.ts call loadProjectEnv, host.ts has already read BASIC_AUTH_USERS.
// Calling loadProjectEnv here in host.ts's own module body runs after imports
// resolve but before the module-scope constants below, guaranteeing the env is
// populated regardless of which entry point loads this module.
loadProjectEnv(process.cwd());

const HOST_PORT = parseInt(process.env["HOST_PORT"] ?? "3100", 10);
const PROXY_URL = process.env["PROXY_URL"] ?? "http://localhost:8080";

// Basic Auth users for local loopback auth verification (shared with proxy.ts).
// Multi-user format: BASIC_AUTH_USERS=admin:pass1,user:pass2
const BASIC_AUTH_USERS_RAW = process.env["BASIC_AUTH_USERS"] ?? "";
function parseBasicUsers(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1));
  }
  // Legacy single-user fallback
  const bu = process.env["BASIC_AUTH_USER"];
  const bp = process.env["BASIC_AUTH_PASS"];
  if (bu && bp && map.size === 0) map.set(bu, bp);
  return map;
}
const BASIC_AUTH_USERS = parseBasicUsers(BASIC_AUTH_USERS_RAW);

// BLS API key — prefer process.env (set by Railway or loadProjectEnv), fall back to data/.env
let BLS_API_KEY = process.env["BLS_API_KEY"]?.trim().replace(/["']/g, "") ?? "";
if (!BLS_API_KEY) {
  try {
    const envPath = path.resolve(import.meta.dirname ?? ".", "..", "data", ".env");
    const envText = fs.readFileSync(envPath, "utf-8");
    const match = envText.match(/^BLS_API_KEY=(.+)$/m);
    if (match) BLS_API_KEY = match[1].trim().replace(/["']/g, "");
  } catch {
    // No data/.env (e.g. Railway) — process.env was the only chance
  }
}
if (BLS_API_KEY) console.log(`[host] BLS API key loaded (${BLS_API_KEY.slice(0, 6)}…)`);
else console.warn(`[host] BLS_API_KEY not set in env or data/.env`);

// Browser WS clients connected to /ui/ws/agent — receive server-side runtime events.
const agentClients = new Set<WebSocket>();

// Per-client liveness tracking for the keepalive loop. The `isAlive` flag is
// set on each pong; if it's still false at the next interval tick the socket
// is presumed dead and terminated so the browser can reconnect.
const agentClientLiveness = new WeakMap<WebSocket, boolean>();

// Keepalive cadence. Railway/Cloudflare-style edge proxies idle WebSockets out
// at ~60s–100s of no traffic; 30s is the conventional safe choice.
const WS_KEEPALIVE_INTERVAL_MS = 30_000;

// ─── Server-side per-prompt stall watchdog ─────────────────────────────────
//
// If no agent_event has been broadcast for PROMPT_STALL_MS while a prompt is
// in flight, we presume the agent loop is stuck (model provider hung the
// stream, tool wrapper blocked indefinitely, host bug, etc.) and emit a
// synthetic agent_prompt_stalled event so the React UI can un-spin.
//
// We do NOT forcibly abort the underlying session — the user has a manual
// Abort button — because doing so could race with a turn that's actually
// about to make progress. We just inform the client.
//
// State is at module scope because attachAgentEventBridge() (also module
// scope) needs to update lastAgentEventAt on every broadcast.
const PROMPT_STALL_MS = 240_000; // 4 minutes of agent silence ⇒ declare stalled
let promptInFlight = false;
let lastAgentEventAt = 0;
let promptStartedAt = 0;
let promptStallTimer: ReturnType<typeof setInterval> | null = null;
let lastStallSessionId: string | null = null;

// ─── Daemon broadcast bridge ───────────────────────────────────────────────
// The active agent session, exposed so the broadcast endpoint can inject
// notification prompts into the orchestrator when new data arrives.
let activeAgentSession: AgentSession | undefined;

const DAEMON_URL = process.env["DAEMON_URL"] ?? "http://127.0.0.1:8791";
const DAEMON_HMAC_KEY = process.env["DAEMON_HMAC_KEY"] ?? "dev-insecure-hmac-key-change-me";

function daemonHmacSign(payload: string): string {
  return crypto.createHmac("sha256", DAEMON_HMAC_KEY).update(payload).digest("hex");
}

// ─── Empty-turn auto-nudge ─────────────────────────────────────────────────
//
// Some lesser models complete a turn after emitting only reasoning text:
// they describe a plan in the thinking channel, then stop without ever
// calling a tool or producing assistant text. From the user's perspective
// the UI shows "Turn completed — no assistant text" and nothing happened.
//
// We detect this server-side by counting, per prompt, how many assistant
// text characters were streamed and how many tool calls were dispatched.
// If session.prompt() resolves with both counters at zero we send ONE
// follow-up nudge prompt ("Your previous turn produced no output. Continue
// with the next tool call from your plan.") and continue the same
// agent_prompt lifecycle. Cap at one nudge so a permanently empty model
// can't enter an infinite nudge loop.
const NUDGE_TEXT =
  "Your previous turn produced no assistant message and no tool calls. " +
  "If you described a plan, continue by actually executing the next step " +
  "as a tool call. If the task is done, send a brief summary message. " +
  "Do not end another turn with empty output.";
let turnAssistantTextChars = 0;
let turnToolCalls = 0;
let turnNudgedOnce = false;

function resetTurnCounters(): void {
  turnAssistantTextChars = 0;
  turnToolCalls = 0;
}

// Inspect a session.subscribe event and update the empty-turn counters.
// Mirrors the event shape consumed by src/react-app/src/lib/agent-bridge.ts
// (message_update with assistantMessageEvent.type in text_*, plus
// tool_execution_start). Defensive about unknown shapes — anything we don't
// recognise is silently ignored.
function observeTurnActivity(event: unknown): void {
  if (!event || typeof event !== "object") return;
  const ev = event as { type?: unknown; assistantMessageEvent?: any };
  if (ev.type === "tool_execution_start") {
    turnToolCalls += 1;
    return;
  }
  if (ev.type !== "message_update") return;
  const ame = ev.assistantMessageEvent;
  if (!ame || typeof ame !== "object") return;
  const ameType = (ame as { type?: unknown }).type;
  if (ameType === "text_delta") {
    // Cheap approximation: each delta event represents some streamed text.
    // We don't have to be exact — non-zero is all the empty-turn check
    // cares about. Read `partial` length if available, fall back to 1.
    const partial = (ame as { partial?: unknown }).partial;
    const idx = (ame as { contentIndex?: unknown }).contentIndex;
    if (Array.isArray(partial) && typeof idx === "number") {
      const block = partial[idx];
      const text = block && typeof block === "object" && typeof (block as any).text === "string"
        ? (block as any).text
        : "";
      turnAssistantTextChars += text.length || 1;
    } else {
      turnAssistantTextChars += 1;
    }
    return;
  }
  if (ameType === "text_end") {
    const content = (ame as { content?: unknown }).content;
    if (typeof content === "string") turnAssistantTextChars += content.length;
    return;
  }
}

function clearPromptStallTimer(): void {
  if (promptStallTimer) {
    clearInterval(promptStallTimer);
    promptStallTimer = null;
  }
}

function startPromptStallTimer(sessionId: string | null): void {
  clearPromptStallTimer();
  promptStartedAt = Date.now();
  lastAgentEventAt = Date.now();
  lastStallSessionId = sessionId;
  resetTurnCounters();
  turnNudgedOnce = false;
  const handle = setInterval(() => {
    if (!promptInFlight) {
      clearPromptStallTimer();
      return;
    }
    const silentMs = Date.now() - lastAgentEventAt;
    if (silentMs > PROMPT_STALL_MS) {
      const totalMs = Date.now() - promptStartedAt;
      const reason = `No agent activity for ${Math.round(silentMs / 1000)}s (turn age ${Math.round(totalMs / 1000)}s). Server-side stall watchdog fired.`;
      console.error(`[agent prompt stalled] sessionId=${lastStallSessionId} ${reason}`);
      clearPromptStallTimer();
      // Release the prompt-in-flight guard — the model provider hung and
      // the user must be able to retry. The underlying session.prompt()
      // promise may still be dangling, but its .finally() is harmless.
      promptInFlight = false;
      broadcastAgentWsMessage({
        type: "agent_prompt_stalled",
        sessionId: lastStallSessionId,
        reason,
        silentMs,
        turnAgeMs: totalMs,
        receivedAt: new Date().toISOString(),
      });
    }
  }, 15_000);
  if (typeof (handle as any).unref === "function") (handle as any).unref();
  promptStallTimer = handle;
}

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
        <p class="lede">Launch generated HTML applications through the authenticated proxy path and inspect system status.</p>
      </div>
      <span class="pill">proxy route /ui online</span>
    </header>

    <div class="grid">
      <section>
        <h2>Apps</h2>
        <div class="apps">
          ${appCards || `<div class="empty">No valid <code>src/ui/*.html</code> apps found. Use lowercase kebab-case file names.</div>`}
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
          </ul>
        </section>

        <section class="prompt">
          <h2>Prompt</h2>
          <p>Source prompt viewing is planned for Phase 2C. Prompt changes will require <code>/reload</code> or a new session before they affect the running agent.</p>
          <div class="button-row">
            <a class="button" href="/ui/app/bls-explorer">Open BLS Explorer</a>
          </div>
        </section>
      </aside>
    </div>

    <footer>Apps are served from <code>src/ui/*.html</code>; route names must match <code>^[a-z0-9-]+$</code>.</footer>
  </main>
</body>
</html>`;
}

// ─── Host runtime API helpers ───────────────────────────────────────────────

export type HostContext = {
  runtime?: any;
  artifactStore?: ArtifactStore;
  userQuestionManager?: UserQuestionManager;
};

export type HostServer = {
  server: http.Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
  /** Broadcast catalog_updated to all connected WebSocket clients. */
  broadcastCatalogUpdated: () => void;
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
  let unsubscribe: (() => void) | undefined;

  function detachSession() {
    unsubscribe?.();
    unsubscribe = undefined;
    activeAgentSession = undefined;
  }

  function attachSession(session: AgentSession) {
    if (session === activeAgentSession) return;

    unsubscribe?.();
    activeAgentSession = session;
    unsubscribe = session.subscribe((event) => {
      // Stall-watchdog liveness: any event proves the agent loop is making
      // forward progress, so reset the silence timer.
      lastAgentEventAt = Date.now();
      // Empty-turn detection: count assistant text + tool calls in this turn.
      observeTurnActivity(event);
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

interface ModelCommandResult {
  ok: boolean;
  changed: boolean;
  message: string;
  current?: { provider: string; id: string; name: string };
  matches?: Array<{ provider: string; id: string; name: string }>;
  available?: Array<{ provider: string; id: string; name: string }>;
}

function summarizeModel(m: { provider: string; id: string; name: string }) {
  return { provider: m.provider, id: m.id, name: m.name };
}

export async function applyModelSelection(
  session: AgentSession,
  query: string,
): Promise<ModelCommandResult> {
  const registry = session.modelRegistry;
  const available = registry.getAvailable();
  const explicit = query.includes(":") ? query.split(":", 2) : null;

  let candidates = available;
  if (explicit) {
    const [prov, id] = explicit;
    candidates = available.filter(
      (m) => m.provider.toLowerCase() === prov.toLowerCase() && m.id.toLowerCase() === id.toLowerCase(),
    );
  } else {
    const lower = query.toLowerCase();
    const exact = available.filter((m) => m.id.toLowerCase() === lower);
    candidates = exact.length > 0
      ? exact
      : available.filter((m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower));
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      changed: false,
      message: `No model matches "${query}". Use /m alone to list available models.`,
      available: available.map(summarizeModel),
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      changed: false,
      message: `Multiple models match "${query}". Disambiguate with provider:id.`,
      matches: candidates.map(summarizeModel),
    };
  }

  const target = candidates[0];
  await session.setModel(target);
  return {
    ok: true,
    changed: true,
    message: `Model switched to ${target.provider}:${target.id} (${target.name}).`,
    current: summarizeModel(target),
  };
}

async function handleModelSlashCommand(input: string, session: AgentSession): Promise<ModelCommandResult> {
  const arg = input.slice(2).trim();
  // Reload models.json so edits since session start (e.g. newly added models)
  // appear without a host restart — mirrors the TUI /model picker, which calls
  // modelRegistry.refresh() every time it opens.
  try {
    session.modelRegistry.refresh();
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: `Failed to reload models.json: ${err instanceof Error ? err.message : String(err)}`,
      current: session.model ? summarizeModel(session.model) : undefined,
    };
  }
  const loadError = session.modelRegistry.getError();
  if (loadError) {
    return {
      ok: false,
      changed: false,
      message: `models.json error: ${loadError}`,
      current: session.model ? summarizeModel(session.model) : undefined,
    };
  }
  const current = session.model;
  const currentSummary = current ? summarizeModel(current) : undefined;

  if (!arg) {
    const available = session.modelRegistry.getAvailable().map(summarizeModel);
    return {
      ok: true,
      changed: false,
      message: currentSummary
        ? `Current model: ${currentSummary.provider}:${currentSummary.id} (${currentSummary.name}). ${available.length} models available.`
        : `No model selected. ${available.length} models available.`,
      current: currentSummary,
      available,
    };
  }

  try {
    return await applyModelSelection(session, arg);
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: `Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
      current: currentSummary,
    };
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

// ─── Daemon broadcast handler ──────────────────────────────────────────
// Receives a signed AvailabilityBroadcast from the daemon, verifies it,
// pulls the dataset, stores it as an artifact, and notifies the orchestrator.

interface BroadcastBody {
  schemaVersion: number;
  broadcastId: string;
  datasetId: string;
  referenceMonth: string;
  target: string;
  source: string;
  seriesIncluded: string[];
  releaseDate: string;
  contentHash: string;
  emittedAt: string;
}

async function handleDaemonBroadcast(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HostContext,
): Promise<void> {
  // 1. Parse and verify HMAC signature
  let payload: any;
  try {
    const text = await readRequestText(req);
    payload = JSON.parse(text);
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const broadcastBody: BroadcastBody = payload;
  const signature = payload?.signature?.value as string | undefined;
  if (!signature || !broadcastBody?.datasetId) {
    sendJson(res, 400, { error: "missing broadcast body or signature" });
    return;
  }

  const signable = JSON.stringify(broadcastBody);
  const expectedSig = daemonHmacSign(signable);
  if (signature !== expectedSig) {
    sendJson(res, 401, { error: "HMAC verification failed" });
    return;
  }

  const { datasetId, referenceMonth, target, source, seriesIncluded, contentHash } = broadcastBody;
  console.log(`[daemon broadcast] verified source=${source} target=${target} month=${referenceMonth} dataset=${datasetId} series=${seriesIncluded.join(",")}`);

  // 2. Pull dataset from daemon
  let dataset: any;
  try {
    const pullSig = daemonHmacSign(datasetId);
    const pullResp = await fetch(`${DAEMON_URL}/datasets/${datasetId}`, {
      headers: { "X-Daemon-Sig": pullSig },
    });
    if (!pullResp.ok) {
      sendJson(res, 502, { error: `daemon pull failed: HTTP ${pullResp.status}` });
      return;
    }
    dataset = await pullResp.json();
  } catch (err) {
    sendJson(res, 502, { error: `daemon pull failed: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  // 3. Verify content hash
  const datasetJson = JSON.stringify(dataset);
  const actualHash = crypto.createHash("sha256").update(datasetJson).digest("hex");
  if (actualHash !== contentHash) {
    sendJson(res, 422, { error: `content hash mismatch: expected ${contentHash}, got ${actualHash}` });
    return;
  }

  // 4. Store as artifact (file store — visible in Documents panel, Savable)
  const artifactStore = ctx.artifactStore;
  if (!artifactStore) {
    sendJson(res, 500, { error: "artifact store not available" });
    return;
  }

  const title = `[Daemon] ${target} — ${source} — ${referenceMonth}`;
  let artifactId: string;
  try {
    const record = await artifactStore.create({
      title,
      filename: `daemon-${datasetId}.json`,
      mimeType: "application/json",
      role: "dataset-meta",
      description: `Leading indicators from daemon ${source} for reference month ${referenceMonth}. Series: ${seriesIncluded.join(", ")}. Target: ${target}.`,
      content: datasetJson,
    });
    artifactId = record.id;
  } catch (err) {
    sendJson(res, 500, { error: `artifact store failed: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  console.log(`[daemon broadcast] stored artifact ${artifactId}`);

  // 5. Broadcast WebSocket event to UI panels
  broadcastAgentWsMessage({
    type: "daemon_dataset_available",
    datasetId,
    referenceMonth,
    target,
    source,
    seriesIncluded,
    artifactId,
    receivedAt: new Date().toISOString(),
  });

  // 6. The broadcast no longer reaches the interactive orchestrator. The
  // target refresh-daemon (src/refresh-daemon.ts) is the receiver that applies
  // the leading indicators through a contained Oracle + 4-verb airlock. The
  // React host only emits an informational WS event — never a prompt() — so
  // untrusted broadcast-derived content cannot reach a capability-bearing LLM.
  // (This legacy handler is retained only for dev back-compat; in the two-daemon
  // architecture broadcasts are POSTed to the refresh-daemon, not here.)

  // Respond. (No prompt() is ever called; the agent turn is not involved.)
  sendJson(res, 200, { ok: true, artifactId, note: "stored (broadcast handler is legacy; refresh-daemon is the receiver)" });
}

export function startHost(ctx: HostContext = {}): HostServer {
const artifactStore = ctx.artifactStore ?? createArtifactStore(path.resolve(PROJECT_ROOT, "data", "artifacts"));
ctx.artifactStore = artifactStore;
ctx.userQuestionManager?.setTransport({
  broadcast: (event) => broadcastAgentWsMessage({
    ...event,
    receivedAt: new Date().toISOString(),
  }),
  getClientCount: () => agentClients.size,
});
const detachArtifactEvents = artifactStore.onCreated((artifact) => {
  broadcastAgentWsMessage({
    type: "artifact_created",
    sessionId: ctx.runtime?.session?.sessionId ?? artifact.sessionId ?? null,
    artifact,
    receivedAt: new Date().toISOString(),
  });
  // catalog_updated is NOT broadcast here — the catalog DB hasn't changed.
  // It is broadcast only by persistence operations that INSERT into SQLite
  // (save endpoint, persist_artifacts tool, collection mutations).
});
const detachAgentEventBridge = attachAgentEventBridge(ctx);
const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Requests tagged x-loopback arrived via proxy — serve real content
  if (req.headers["x-loopback"] === "1") {
    const requestUrl = new URL(req.url ?? "/", "http://host.local");
    const pathname = requestUrl.pathname;

    // Extract authenticated user from proxy header (multi-tenant scoping).
    // Loopback requests from the TUI (no proxy) won't have this header.
    const authUser = req.headers["x-authenticated-user"];
    let currentUser = typeof authUser === "string" && authUser.trim() ? authUser.trim() : null;

    // When the proxy runs on loopback, auth is skipped and x-authenticated-user is
    // set to "loopback". In that case, check for a direct Basic Auth header (sent by
    // the React login form) and validate it against the known users list.
    if (currentUser === "loopback") {
      const authHeader = req.headers["authorization"] ?? "";
      if (authHeader.startsWith("Basic ")) {
        try {
          const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
          const idx = decoded.indexOf(":");
          if (idx >= 0) {
            const user = decoded.slice(0, idx);
            const pass = decoded.slice(idx + 1);
            const expectedPass = BASIC_AUTH_USERS.get(user);
            if (expectedPass && pass === expectedPass) {
              currentUser = user;
            }
          }
        } catch { /* keep loopback */ }
      }
    }

    ctx.artifactStore!.currentUserId = currentUser;
    if (currentUser) {
      try {
        const sqldb = new DatabaseSync(path.resolve(PROJECT_ROOT, "data", "artifacts.db"));
        sqldb.prepare("INSERT OR IGNORE INTO user (id, display_name, created_at) VALUES (?, ?, ?)")
          .run(currentUser, currentUser, new Date().toISOString());
        sqldb.close();
      } catch { /* user table may not exist yet — schema migration runs on next restart */ }
    }

    // The app lives under /ui. Redirect the bare root so visiting the public
    // URL lands on the app instead of the "Invalid static path" fallthrough.
    if (pathname === "/" || pathname === "") {
      res.writeHead(302, { Location: "/ui/" });
      res.end();
      return;
    }

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

    // ── GET /ui/api/auth/me — return current user from x-authenticated-user header ──
    if (pathname === "/ui/api/auth/me" && req.method === "GET") {
      if (currentUser && currentUser !== "loopback") {
        sendJson(res, 200, { username: currentUser, role: currentUser === "admin" ? "admin" : "user" });
      } else {
        // On loopback (dev), return null — the proxy skips auth.
        sendJson(res, 200, { username: null, role: null });
      }
      return;
    }

    // ── POST /ui/api/auth/login — verify credentials for the React login form ──
    if (pathname === "/ui/api/auth/login" && req.method === "POST") {
      readJsonBody(req)
        .then((body) => {
          const username = typeof body?.username === "string" ? body.username.trim() : "";
          const password = typeof body?.password === "string" ? body.password : "";
          if (!username || !password) {
            sendJson(res, 400, { error: "Username and password are required." });
            return;
          }
          const expectedPass = BASIC_AUTH_USERS.get(username);
          if (!expectedPass || password !== expectedPass) {
            sendJson(res, 401, { error: "Invalid credentials." });
            return;
          }
          // Ensure the user row exists in the DB.
          try {
            const sqldb = new DatabaseSync(path.resolve(PROJECT_ROOT, "data", "artifacts.db"));
            sqldb.prepare("INSERT OR IGNORE INTO user (id, display_name, created_at) VALUES (?, ?, ?)")
              .run(username, username, new Date().toISOString());
            sqldb.close();
          } catch { /* schema may not exist yet — harmless */ }
          sendJson(res, 200, { ok: true, username, role: username === "admin" ? "admin" : "user" });
        })
        .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // Artifact listing — file store only (current-session artifacts).
    // DB artifacts are queried on-demand via query_artifacts and re-surfaced via create_artifact.
    if (pathname === "/ui/api/artifacts" && req.method === "GET") {
      const state = getAgentState(ctx);
      const includeAll = requestUrl.searchParams.get("all") === "1";
      const sessionId = includeAll ? undefined : state?.sessionId ?? undefined;
      sendJson(res, 200, { artifacts: artifactStore.list(sessionId) });
      return;
    }

    // POST /ui/api/artifacts/<id>/save — persist from file store to DB, then delete file.
    // Accepts optional taxonomy fields (categoryId, categoryName, subjectId,
    // subjectName, tags, provenance) in the JSON body so saved artifacts don't
    // land in "Uncategorized".
    const saveMatch = pathname.match(/^\/ui\/api\/artifacts\/([^/]+)\/save$/);
    if (saveMatch && req.method === "POST") {
      const id = decodeURIComponent(saveMatch[1]);
      const hit = artifactStore.get(id);
      if (!hit) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Artifact not found");
        return;
      }

      readJsonBody(req)
        .then((taxBody) => {
          const sqldb = new DatabaseSync(path.resolve(PROJECT_ROOT, "data", "artifacts.db"));
          try {
            const record = hit.record;
            const content = fs.readFileSync(hit.filePath, "utf-8");
            const now = new Date().toISOString();
            const role = record.role || "chart";
            const catId = typeof taxBody?.categoryId === "string" ? taxBody.categoryId : null;
            const catName = typeof taxBody?.categoryName === "string" ? taxBody.categoryName : null;
            const subId = typeof taxBody?.subjectId === "string" ? taxBody.subjectId : null;
            const subName = typeof taxBody?.subjectName === "string" ? taxBody.subjectName : null;
            const taxTags = Array.isArray(taxBody?.tags) ? taxBody.tags.filter((t: unknown) => typeof t === "string") : [];
            const provenance = typeof taxBody?.provenance === "string" ? taxBody.provenance : "{}";
            const artifactTags = taxTags.length > 0 ? JSON.stringify(taxTags) : JSON.stringify(record.role ? [record.role] : []);

            // Create taxonomy chain if provided.
            let subjectIdForSession: string | null = null;
            if (catId && catName) {
              sqldb.prepare(
                "INSERT OR IGNORE INTO category (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)"
              ).run(catId, catName, now, now);
            }
            if (subId && subName && catId) {
              sqldb.prepare(
                "INSERT OR IGNORE INTO subject (id, category_id, name, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
              ).run(subId, catId, subName, JSON.stringify(taxTags), now, now);
              subjectIdForSession = subId;
            }

            // Ensure session exists with subject_id and user_id (parameterized)
            sqldb.prepare(
              "INSERT OR IGNORE INTO session (id, subject_id, model_id, user_id, title, started_at, prompt_count) VALUES (?, ?, NULL, ?, ?, ?, 1)"
            ).run(record.sessionId, subjectIdForSession, currentUser, record.title, record.createdAt);

            // Insert artifact (parameterized — no SQL injection via content)
            sqldb.prepare(
              "INSERT OR REPLACE INTO artifact (id, session_id, title, filename, mime_type, role, description, content, size_bytes, created_at, updated_at, provenance, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).run(
              record.id, record.sessionId, record.title, record.filename,
              record.mimeType, role, record.description ?? null, content,
              record.size, record.createdAt, now, provenance, artifactTags,
            );

            artifactStore.delete(id);

            // Catalog changed — tell the frontend to refresh the sidebar tree.
            broadcastAgentWsMessage({
              type: "catalog_updated",
              receivedAt: new Date().toISOString(),
            });

            // Bridge trigger 2: a dataset CSV was just persisted — re-sync the
            // refresh-daemon's indicator_history. Best-effort, fire-and-forget.
            if (record.mimeType === "text/csv" || role === "dataset-csv") {
              syncIndicatorHistory({ reason: `save:${id}` })
                .then((r) => console.log(`[host] refresh-history bridge (save ${id}): ok=${r.ok} seeded=${r.daemon?.seeded ?? "?"}`))
                .catch(() => { /* target down — the next boot seed or agent sync converges */ });
            }

            sendJson(res, 200, { ok: true, id });
          } finally {
            sqldb.close();
          }
        })
        .catch((err) => {
          console.error(`[host] artifact save error: ${err instanceof Error ? err.message : String(err)}`);
          sendJson(res, 500, { error: err instanceof Error ? err.message : "Save failed" });
        });
      return;
    }

    // POST /ui/api/artifacts/<id>/discard — delete from file store
    const discardMatch = pathname.match(/^\/ui\/api\/artifacts\/([^/]+)\/discard$/);
    if (discardMatch && req.method === "POST") {
      const id = decodeURIComponent(discardMatch[1]);
      const deleted = artifactStore.delete(id);
      if (!deleted) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Artifact not found");
        return;
      }
      sendJson(res, 200, { ok: true, id });
      return;
    }

    // GET /ui/api/catalog — build and return the catalog tree.
    //
    // Side-effect: persistCatalogIfChanged() writes a new role='catalog'
    // artifact (with replaces_id pointing at the previous head) whenever the
    // structural payload — buckets[] + collections[] — has actually changed.
    // No-ops when the catalog is byte-identical to the head, so routine
    // browse-mode GETs stay cheap.
    if (pathname === "/ui/api/catalog" && req.method === "GET") {
      try {
        const catalog = ctx.artifactStore!.buildCatalog();
        const newId = ctx.artifactStore!.persistCatalogIfChanged(catalog);
        if (newId) {
          broadcastAgentWsMessage({
            type: "catalog_persisted",
            artifactId: newId,
            receivedAt: new Date().toISOString(),
          });
        }
        sendJson(res, 200, catalog);
      } catch (err) {
        console.error(`[host] catalog error: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { error: "Failed to build catalog" });
      }
      return;
    }

    // POST /ui/api/catalog/collections — upsert a collection on the latest
    // catalog head and persist a new catalog row (chained via replaces_id).
    if (pathname === "/ui/api/catalog/collections" && req.method === "POST") {
      readJsonBody(req)
        .then((body) => {
          const name = typeof body?.name === "string" ? body.name : "";
          const summary = typeof body?.summary === "string" ? body.summary : "";
          const memberIds = Array.isArray(body?.memberIds) ? body.memberIds : [];
          const id = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : undefined;
          try {
            const catalog = ctx.artifactStore!.saveCollection({ id, name, summary, memberIds });
            // Refresh the React side via the same nudge we already use.
            broadcastAgentWsMessage({ type: "catalog_updated", receivedAt: new Date().toISOString() });
            sendJson(res, 200, catalog);
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // DELETE /ui/api/catalog/collections/<id> — remove a saved collection.
    const colDeleteMatch = pathname.match(/^\/ui\/api\/catalog\/collections\/([^/]+)$/);
    if (colDeleteMatch && req.method === "DELETE") {
      const id = decodeURIComponent(colDeleteMatch[1]);
      try {
        const catalog = ctx.artifactStore!.deleteCollection(id);
        broadcastAgentWsMessage({ type: "catalog_updated", receivedAt: new Date().toISOString() });
        sendJson(res, 200, catalog);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // POST /ui/api/catalog/compose — ask the orchestrator to compose a
    // document out of a typed-slot bundle (or, for now, a flat member list).
    // We do not invent template slot mappings server-side; we synthesize a
    // user-style prompt that the existing document pipeline can consume.
    if (pathname === "/ui/api/catalog/compose" && req.method === "POST") {
      if (!ctx.runtime?.session?.prompt) {
        sendJson(res, 503, { error: "Agent runtime is not available in this host process" });
        return;
      }
      readJsonBody(req)
        .then(async (body) => {
          const memberIds: string[] = Array.isArray(body?.memberIds)
            ? body.memberIds.filter((m: unknown) => typeof m === "string" && m.length > 0)
            : [];
          const collectionId = typeof body?.collectionId === "string" ? body.collectionId : undefined;
          const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : undefined;
          if (memberIds.length === 0) {
            sendJson(res, 400, { error: "memberIds must be a non-empty string array" });
            return;
          }
          if (promptInFlight || ctx.runtime.session.isStreaming) {
            sendJson(res, 409, { error: "Agent is already processing a prompt" });
            return;
          }

          // Resolve each member's title/role from the DB so the prompt is
          // self-describing — the orchestrator doesn't need to JOIN again.
          const lines: string[] = [];
          for (const memberId of memberIds) {
            const hit = ctx.artifactStore!.dbGet(memberId);
            if (hit) {
              lines.push(`  - ${memberId} — [${hit.record.role || "other"}] ${hit.record.title}`);
            } else {
              lines.push(`  - ${memberId} — (artifact not found in DB)`);
            }
          }
          const heading = name || (collectionId ? `Collection ${collectionId}` : "User-selected artifact bundle");
          const promptText = [
            `Compose a multi-page document from the following selected artifacts.`,
            ``,
            `Bundle: ${heading}`,
            `Members:`,
            ...lines,
            ``,
            `Use the document pipeline: hand off to narrator (for prose sections and chart`,
            `briefs around these artifacts), then stylist (to compose pages and write the`,
            `document manifest). Do not re-generate charts that already exist — reuse the`,
            `listed artifact ids verbatim. Surface the final document manifest artifact at`,
            `the end.`,
          ].join("\n");

          const session = ctx.runtime.session;
          promptInFlight = true;
          startPromptStallTimer(session.sessionId ?? null);
          void Promise.resolve(session.prompt(promptText))
            .then(() => {
              let state: unknown = null;
              try { state = getAgentState(ctx); } catch {}
              broadcastAgentWsMessage({
                type: "agent_prompt_complete",
                sessionId: session.sessionId ?? null,
                state,
                receivedAt: new Date().toISOString(),
              });
            })
            .catch((err: unknown) => {
              console.error(`[catalog compose error] ${err instanceof Error ? err.message : String(err)}`);
              broadcastAgentWsMessage({
                type: "agent_prompt_error",
                sessionId: session.sessionId ?? null,
                error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
                receivedAt: new Date().toISOString(),
              });
            })
            .finally(() => {
              promptInFlight = false;
              clearPromptStallTimer();
            });
          sendJson(res, 202, { ok: true, accepted: true, memberCount: memberIds.length });
        })
        .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // GET /ui/api/artifacts/db — list all artifacts persisted in SQLite
    if (pathname === "/ui/api/artifacts/db" && req.method === "GET") {
      try {
        const category = requestUrl.searchParams.get("category")?.trim() ?? undefined;
        const subject = requestUrl.searchParams.get("subject")?.trim() ?? undefined;
        const role = requestUrl.searchParams.get("role")?.trim() ?? undefined;
        let records = artifactStore.dbList(currentUser ?? undefined);
        if (category) {
          records = records.filter((r) => r.category === category);
        }
        if (subject) {
          records = records.filter((r) => r.subject === subject);
        }
        if (role) {
          records = records.filter((r) => r.role === role);
        }
        sendJson(res, 200, { artifacts: records });
      } catch (err) {
        console.error(`[host] db artifact list error: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { error: "Failed to list DB artifacts" });
      }
      return;
    }

    const artifactMatch = pathname.match(/^\/ui\/api\/artifacts\/([^/]+)(?:\/metadata)?$/);
    if (artifactMatch && req.method === "GET") {
      const id = decodeURIComponent(artifactMatch[1]);
      // DB first, file store as fallback
      const dbHit = artifactStore.dbGet(id, currentUser ?? undefined);
      if (dbHit) {
        if (pathname.endsWith("/metadata")) {
          sendJson(res, 200, dbHit.record);
          return;
        }
        const mime = dbHit.record.mimeType;
        res.writeHead(200, {
          "Content-Type": isUtf8ArtifactMime(mime) ? `${mime}; charset=utf-8` : mime,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `inline; filename="${dbHit.record.filename.replace(/["\\]/g, "_")}"`,
        });
        res.end(dbHit.content);
        return;
      }
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
        "Content-Type": isUtf8ArtifactMime(hit.record.mimeType)
          ? `${hit.record.mimeType}; charset=utf-8`
          : hit.record.mimeType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${hit.record.filename.replace(/["\\]/g, "_")}"`,
      });
      res.end(data);
      return;
    }

    // GET /ui/api/agent/models — list available models and current selection
    if (pathname === "/ui/api/agent/models" && req.method === "GET") {
      try {
        const session = ctx.runtime?.session;
        const registry = session?.modelRegistry;
        if (!registry) {
          sendJson(res, 503, { error: "Model registry not available" });
          return;
        }
        // Reload models.json so newly added models appear without a restart,
        // matching the TUI /model picker behavior.
        try {
          registry.refresh();
        } catch (err) {
          sendJson(res, 500, { error: `Failed to reload models.json: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        const loadError = registry.getError();
        if (loadError) {
          sendJson(res, 500, { error: `models.json error: ${loadError}` });
          return;
        }
        const available = registry.getAvailable().map(summarizeModel);
        const current = session.model ? summarizeModel(session.model) : null;
        sendJson(res, 200, { current, available });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
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

          const session = ctx.runtime.session;

          // Intercept /m model-switch slash command (mirrors TUI /m UX)
          const trimmed = input.trim();
          if (trimmed === "/m" || trimmed.startsWith("/m ")) {
            const result = await handleModelSlashCommand(trimmed, session as AgentSession);
            if (result.changed) {
              const state = getAgentState(ctx);
              if (state) {
                broadcastAgentWsMessage({
                  type: "agent_state",
                  state,
                  receivedAt: new Date().toISOString(),
                });
              }
            }
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }

          if (promptInFlight || ctx.runtime.session.isStreaming) {
            sendJson(res, 409, { error: "Agent is already processing a prompt" });
            return;
          }
          promptInFlight = true;
          startPromptStallTimer(session.sessionId ?? null);

          // Run session.prompt(input). If it resolves with an empty turn
          // (no assistant text, no tool calls) and we haven't nudged yet,
          // send ONE follow-up nudge prompt and await that instead before
          // declaring the turn complete. See NUDGE_TEXT above.
          const runWithEmptyTurnNudge = async (): Promise<void> => {
            await session.prompt(input);
            if (
              turnAssistantTextChars === 0 &&
              turnToolCalls === 0 &&
              !turnNudgedOnce
            ) {
              turnNudgedOnce = true;
              const detail = `assistantTextChars=${turnAssistantTextChars} toolCalls=${turnToolCalls}`;
              console.warn(
                `[agent prompt empty-turn nudge] sessionId=${session.sessionId ?? null} ${detail} — sending follow-up nudge`,
              );
              broadcastAgentWsMessage({
                type: "agent_empty_turn_nudge",
                sessionId: session.sessionId ?? null,
                detail,
                nudgeText: NUDGE_TEXT,
                receivedAt: new Date().toISOString(),
              });
              // Reset counters so the nudged turn is evaluated independently,
              // but leave turnNudgedOnce = true so a second empty completion
              // falls through to the normal terminal event.
              resetTurnCounters();
              // Keep the stall watchdog alive across the nudge —
              // lastAgentEventAt is updated by the subscribe callback as
              // soon as the second prompt produces any event.
              lastAgentEventAt = Date.now();
              await session.prompt(NUDGE_TEXT);
            }
          };

          void runWithEmptyTurnNudge()
            .then(() => {
              // Defensive: getAgentState can in principle throw if the runtime
              // is torn down mid-turn. Capture state best-effort and ALWAYS
              // emit a terminal event so the client un-spins.
              let state: unknown = null;
              try { state = getAgentState(ctx); } catch (e) {
                console.error(`[agent state snapshot failed] ${e instanceof Error ? e.message : String(e)}`);
              }
              broadcastAgentWsMessage({
                type: "agent_prompt_complete",
                sessionId: session.sessionId ?? null,
                state,
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
              clearPromptStallTimer();
            });

          sendJson(res, 202, { ok: true, accepted: true, sessionId: session.sessionId ?? null });
        })
        .catch((err) => {
          console.error(`[agent prompt request error] ${err instanceof Error ? err.message : String(err)}`);
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }

    // POST /ui/api/agent/answer — answer a pending ask_user question
    if (pathname === "/ui/api/agent/answer" && req.method === "POST") {
      if (!ctx.userQuestionManager) {
        sendJson(res, 503, { error: "User-question manager is not available" });
        return;
      }
      readJsonBody(req)
        .then((body) => {
          const id = typeof body?.id === "string" ? body.id : "";
          const response = typeof body?.response === "string" ? body.response : "";
          const result = ctx.userQuestionManager!.answer(id, response);
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, { ok: true, result: result.result });
        })
        .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // POST /ui/api/agent/abort — abort the active agent turn if supported
    if (pathname === "/ui/api/agent/abort" && req.method === "POST") {
      const abort = ctx.runtime?.session?.abort;
      if (typeof abort !== "function") {
        sendJson(res, 503, { error: "Agent abort is not available" });
        return;
      }
      // Reset the prompt-in-flight guard immediately — the user explicitly
      // asked to stop, so they should be able to start a new prompt right
      // away. The underlying session.prompt() will settle on its own (its
      // .finally() is a no-op after this).
      promptInFlight = false;
      clearPromptStallTimer();
      ctx.userQuestionManager?.cancelAll("agent_aborted");
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

    // ── POST /ui/api/daemon/broadcast — receive a signed AvailabilityBroadcast ───
    // The daemon POSTs here after fetching and storing data.  We verify the HMAC,
    // pull the dataset, hash-verify it, store it as an artifact, and notify the
    // orchestrator (if an agent session is active).
    if (pathname === "/ui/api/daemon/broadcast" && req.method === "POST") {
      handleDaemonBroadcast(req, res, ctx);
      return;
    }

    // Serve other static files from dist/web/ (publicDir artifacts like lookups-config.json, lookups/*.json)
    // Matches /ui/lookups/*, /ui/*.json, etc. that aren't already handled by a more specific route above.
    if (pathname !== "/ui/" && !pathname.startsWith("/ui/assets/") && !pathname.startsWith("/ui/data/") && !pathname.startsWith("/ui/app/") && !pathname.startsWith("/ui/api/") && pathname !== "/ui/portal") {
      const relativeName = decodeURIComponent(pathname.slice("/ui/".length));
      const filePath = path.resolve(WEB_DIST_DIR, relativeName);
      if (!relativeName || path.isAbsolute(relativeName) || !isInside(WEB_DIST_DIR, filePath)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid static path");
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
        res.end("Static file not found");
      }
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

// Keepalive loop for /ui/ws/agent clients.
//
// On every tick:
//   1. Drop any client that failed to respond to the previous ping (isAlive
//      is still false). This is our backstop against half-open TCP sockets.
//   2. For survivors, mark them not-yet-alive and emit BOTH a WS ping frame
//      (cheap, browser auto-pongs without app code) AND a JSON heartbeat
//      message (guarantees application-layer bytes cross any edge proxy
//      that doesn't relay control frames as "activity").
const keepaliveTimer = setInterval(() => {
  if (agentClients.size === 0) return;
  const now = new Date().toISOString();
  for (const client of agentClients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (agentClientLiveness.get(client) === false) {
      // Missed the previous round-trip — assume the connection is gone.
      try { client.terminate(); } catch {}
      continue;
    }
    agentClientLiveness.set(client, false);
    try { client.ping(); } catch {}
    sendAgentWsMessage(client, { type: "heartbeat", receivedAt: now });
  }
}, WS_KEEPALIVE_INTERVAL_MS);
// Don't keep the Node event loop alive solely for the keepalive timer; the
// HTTP/WS servers are the real liveness anchors.
if (typeof keepaliveTimer.unref === "function") keepaliveTimer.unref();

wss.on("connection", (clientSocket, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  const wsPathname = new URL(req.url ?? "/", "http://host.local").pathname;
  console.log(`[${new Date().toISOString()}] WS ${clientId} ${req.url}`);

  // /ui/ws/agent — browser runtime event stream. Only serve the loopback-tagged
  // second hop that has passed through the proxy.
  if (wsPathname === "/ui/ws/agent" && req.headers["x-loopback"] === "1") {
    // Extract user identity for loopback WS connections.
    // The proxy sets x-authenticated-user. For loopback (no auth enforced),
    // check query params sent by the React login form.
    let wsUser = req.headers["x-authenticated-user"] as string | undefined;
    if (!wsUser || wsUser === "loopback") {
      const wsUrl = new URL(req.url ?? "/", "http://host.local");
      const qUser = wsUrl.searchParams.get("user");
      const qPass = wsUrl.searchParams.get("pass");
      if (qUser && qPass) {
        const expectedPass = BASIC_AUTH_USERS.get(qUser);
        if (expectedPass && qPass === expectedPass) {
          wsUser = qUser;
        }
      }
    }
    // Store resolved user on the socket for use by broadcast/event handlers.
    (clientSocket as any)._dvaUser = wsUser && wsUser !== "loopback" ? wsUser : null;
    agentClients.add(clientSocket);
    agentClientLiveness.set(clientSocket, true);
    clientSocket.on("pong", () => {
      agentClientLiveness.set(clientSocket, true);
    });
    clientSocket.on("close", () => {
      agentClients.delete(clientSocket);
      agentClientLiveness.delete(clientSocket);
    });
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
    }
    for (const question of ctx.userQuestionManager?.getPending() ?? []) {
      sendAgentWsMessage(clientSocket, {
        ...question,
        receivedAt: new Date().toISOString(),
      });
    }
    if (!state) {
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
  // Bridge trigger 1: seed-on-start. Push the persisted backbone CSVs to the
  // refresh-daemon's indicator_history. Best-effort — a down daemon never
  // blocks or crashes the host; the report line says what happened.
  syncIndicatorHistory({ reason: "host-boot" })
    .then((r) => {
      const sent = r.series.filter((s) => s.status === "sent").length;
      const total = r.series.length;
      if (r.ok) console.log(`[host] refresh-history bridge: seeded ${sent}/${total} backbone series (${r.daemon?.seeded ?? "?"} obs upserted)`);
      else console.warn(`[host] refresh-history bridge: partial/failed — ${JSON.stringify(r.daemon ?? {})} ${r.series.filter((s) => s.error).map((s) => `${s.seriesId}: ${s.error}`).join(" | ")}`);
    })
    .catch((err) => console.warn(`[host] refresh-history bridge skipped: ${err instanceof Error ? err.message : String(err)}`));
});

return {
  server,
  wss,
  broadcastCatalogUpdated: () => {
    broadcastAgentWsMessage({
      type: "catalog_updated",
      receivedAt: new Date().toISOString(),
    });
  },
  close: () => new Promise<void>((resolve, reject) => {
    clearInterval(keepaliveTimer);
    detachAgentEventBridge();
    detachArtifactEvents();
    ctx.userQuestionManager?.cancelAll("server_shutdown");
    for (const client of agentClients) client.close();
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
