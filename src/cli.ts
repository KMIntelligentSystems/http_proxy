import {
  InteractiveMode,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  getAgentDir,
  defineTool,
  type CreateAgentSessionRuntimeFactory,
  type SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { createMcpTools } from "./mcp-tools.js";
import { loadProjectEnv } from "./env.js";
import { createArtifactStore } from "./artifacts.js";
import { createVisualizationTools } from "./visualization-tools.js";
import { startHost } from "./host.js";

loadProjectEnv(process.cwd());

// ─── MCP tool bridge ──────────────────────────────────────────────────────────

const { tools: mcpTools, runtime: mcpRuntime } = await createMcpTools([
  {
    name: "codegen",
    url: "http://localhost:3003/mcp",
    skillPath: ".pi/skills/codegen-mcp/SKILL.md",
    promptGuidelines: [
      "Use these tools when asked to generate, scaffold, or transform code via the codegen service.",
    ],
  },
  {
    name: "playwright",
    url: "http://localhost:3000/mcp",
  },
  {
    name: "search",
    url: "http://localhost:3004/mcp",
  },
]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..");

// ─── Proxy process management ────────────────────────────────────────────
// The host runs in-process via startHost() so it shares the artifact store
// and the agent runtime. Only the proxy is spawned as a child process.

let proxyProc: ChildProcess | null = null;

const logFile = fs.createWriteStream(path.join(DIST, "proxy-host.log"), { flags: "a" });

function startProxy() {
  if (proxyProc) proxyProc.kill();

  const proc = spawn(process.execPath, [path.join(DIST, "dist/proxy.js")], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onData = (data: Buffer) =>
    logFile.write(`[proxy] ${data.toString()}`);

  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code) => {
    logFile.write(`[system] proxy exited (code ${code})\n`);
    proxyProc = null;
  });

  proxyProc = proc;
}

function stopProxy() {
  proxyProc?.kill();
  proxyProc = null;
}

// ─── Custom tools ─────────────────────────────────────────────────────────────

const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool. Returns a greeting for the given name.",
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text" as const, text: `Hello, ${params.name}! 👋` }],
    details: {},
  }),
});

const pushSvgTool = defineTool({
  name: "push_svg",
  label: "Push SVG",
  description: "Push an SVG fragment to the browser canvas at http://localhost:8080/ui/canvas. Supports actions: clear, append, replace, remove.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("clear"),
      Type.Literal("append"),
      Type.Literal("replace"),
      Type.Literal("remove"),
    ], { description: "SVG action type" }),
    svg: Type.Optional(Type.String({ description: "SVG markup (for append/replace)" })),
    id: Type.Optional(Type.String({ description: "Element ID (for replace/remove)" })),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const body: Record<string, string> = { type: params.action };
      if (params.svg) body.svg = params.svg;
      if (params.id) body.id = params.id;

      const hostPort = process.env["HOST_PORT"] ?? "3100";
      const res = await fetch(`http://localhost:${hostPort}/ui/svg`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-loopback": "1" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Host returned ${res.status}`);

      return {
        content: [{ type: "text" as const, text: `SVG ${params.action} sent to canvas.` }],
        details: {},
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        details: {},
        isError: true,
      };
    }
  },
});

// ─── Artifact store + visualization tools ─────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, "..");
const artifactStore = createArtifactStore(path.join(PROJECT_ROOT, "data", "artifacts"));

// Mutable ref so visualizationTools can resolve the session ID
// after the runtime is created (below).
const sessionIdRef = { current: (): string | null => null };

const visualizationTools = createVisualizationTools({
  artifactStore,
  getSessionId: () => sessionIdRef.current(),
  cwd: process.cwd(),
});

const customTools = [...mcpTools, helloTool, pushSvgTool, ...visualizationTools];

// ─── Agent session factory ────────────────────────────────────────────────────

const cwd = process.cwd();
const agentDir = getAgentDir();
const sessionManager = SessionManager.inMemory();
const sessionStartEvent: SessionStartEvent = { type: "session_start", reason: "startup" };

//Create the initial runtime from a runtime factory and initial session target.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd });////Create cwd-bound runtime services. returns Promise<AgentSessionServices>
  return {
    ...(await createAgentSessionFromServices({//Create an AgentSession from previously created services.
      services,
      sessionManager,
      sessionStartEvent,
      customTools,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Build the agent session runtime first — the host needs it.
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
});

// Wire the live session ID through the mutable ref.
sessionIdRef.current = () => runtime.session?.sessionId ?? null;

// Start the host in-process so it shares the artifact store.
// artifact_created events are broadcast to browser WebSocket clients
// via artifactStore.onCreated() inside startHost().
const host = startHost({ runtime, artifactStore });

// Start the proxy as a child process.
startProxy();

console.log("Open http://localhost:" + (process.env["PORT"] ?? "8080") + "/ui");

process.on("SIGINT", async () => {
  stopProxy();
  try { await host.close(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  stopProxy();
  try { await host.close(); } catch {}
  process.exit(0);
});

const allTools = runtime.session.getAllTools();
console.log('ALL TOOLS', allTools)
const mode = new InteractiveMode(runtime);
await mode.run();

// mode.run() only returns on clean shutdown (Ctrl+D)
stopProxy();
try { await host.close(); } catch {}