import {
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
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createArtifactStore } from "./artifacts.js";
import { loadProjectEnv } from "./env.js";
import { startHost } from "./host.js";
import { createMcpTools } from "./mcp-tools.js";
import { createVisualizationTools } from "./visualization-tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

loadProjectEnv(process.cwd());

// ─── Process management ─────────────────────────────────────────────────────

let proxyProc: ChildProcess | null = null;
const logFile = fs.createWriteStream(path.join(PROJECT_ROOT, "proxy-host.log"), { flags: "a" });

function startProxy() {
  proxyProc?.kill();
  const hostPort = process.env["HOST_PORT"] ?? "3100";
  const proc = spawn(process.execPath, [path.join(PROJECT_ROOT, "dist", "proxy.js")], {
    env: {
      ...process.env,
      TARGET: process.env["TARGET"] ?? `http://127.0.0.1:${hostPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    logFile.write(`[proxy] ${text}`);
    // Surface the startup line in the foreground web-main terminal.
    if (text.includes("Proxy listening")) process.stdout.write(`[proxy] ${text}`);
  });
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    logFile.write(`[proxy] ${text}`);
    process.stderr.write(`[proxy] ${text}`);
  });
  proc.on("exit", (code) => {
    logFile.write(`[system] proxy exited (code ${code})\n`);
    if (code && code !== 0) {
      console.error(`[web-main] Proxy exited with code ${code}. Check PORT=${process.env["PORT"] ?? "8080"} for conflicts.`);
    }
    proxyProc = null;
  });

  proxyProc = proc;
}

function stopProxy() {
  proxyProc?.kill();
  proxyProc = null;
}

// ─── Custom tools ────────────────────────────────────────────────────────────

let activeRuntime: any;
const artifactStore = createArtifactStore(path.join(PROJECT_ROOT, "data", "artifacts"));

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

const visualizationTools = createVisualizationTools({
  artifactStore,
  cwd: process.cwd(),
  getSessionId: () => activeRuntime?.session?.sessionId,
});

const customTools = [...mcpTools, helloTool, pushSvgTool, ...visualizationTools];

// ─── Agent session runtime ───────────────────────────────────────────────────

const cwd = process.cwd();
const agentDir = getAgentDir();
const sessionManager = SessionManager.inMemory();
const sessionStartEvent: SessionStartEvent = { type: "session_start", reason: "startup" };

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      customTools,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
});
activeRuntime = runtime;

async function bindActiveSessionExtensions() {
  const bindExtensions = runtime.session?.bindExtensions;
  if (typeof bindExtensions === "function") {
    await bindExtensions.call(runtime.session, {});
  }
}

await bindActiveSessionExtensions();

const runtimeForExtensionRebind = runtime as any;
for (const methodName of ["newSession", "switchSession", "fork", "importFromJsonl"] as const) {
  const original = runtimeForExtensionRebind[methodName];
  if (typeof original !== "function") continue;
  runtimeForExtensionRebind[methodName] = async (...args: any[]) => {
    const result = await original.apply(runtime, args);
    if (!result || result.cancelled !== true) await bindActiveSessionExtensions();
    return result;
  };
}

const host = startHost({ runtime, artifactStore });
startProxy();

const proxyPort = process.env["PORT"] ?? "8080";
console.log("Web main running.");
console.log(`Open http://localhost:${proxyPort}/ui`);
console.log(`Agent state API: http://localhost:${proxyPort}/ui/api/agent/state`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopProxy();
  try { await host.close(); } catch {}
  try { await (mcpRuntime as any).close?.(); } catch {}
  logFile.end();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

await new Promise<void>(() => undefined);
