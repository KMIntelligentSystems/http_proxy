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
import { UserQuestionManager } from "./user-questions.js";

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

// ─── Artifact store + visualization tools ─────────────────────────────────
// The query_artifacts tool now lives in visualization-tools.ts so it can
// share the artifactStore closure and surface DB rows to the frontend via
// the artifact_created WebSocket broadcast.

const PROJECT_ROOT = path.resolve(__dirname, "..");
const artifactStore = createArtifactStore(path.join(PROJECT_ROOT, "data", "artifacts"));
const userQuestionManager = new UserQuestionManager();

// Mutable ref so visualizationTools can resolve the session ID
// after the runtime is created (below).
const sessionIdRef = { current: (): string | null => null };

const visualizationTools = createVisualizationTools({
  artifactStore,
  getSessionId: () => sessionIdRef.current(),
  cwd: process.cwd(),
});

const askUserTool = defineTool({
  name: "ask_user",
  label: "Ask User",
  description: "Ask the user a clarification question in the UI and wait for their answer. Use when a missing choice would change the data source, category/subject, statistical method, artifact type, or interpretation. Returns structured JSON with answered/response/reason.",
  parameters: Type.Object({
    prompt: Type.String({ description: "Concise question to show the user." }),
    choices: Type.Optional(Type.Array(Type.String(), { description: "Optional list of answer choices to render as quick options." })),
    defaultChoice: Type.Optional(Type.String({ description: "Optional default choice to prefill or highlight." })),
    timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 300000; clamped to 5000–1800000." })),
    allowFreeText: Type.Optional(Type.Boolean({ description: "Whether the user can type a custom response. Defaults to true." })),
  }),
  execute: async (_toolCallId, params) => {
    const result = await userQuestionManager.ask(
      {
        prompt: params.prompt,
        choices: params.choices,
        defaultChoice: params.defaultChoice,
        timeoutMs: params.timeoutMs,
        allowFreeText: params.allowFreeText,
      },
      {
        sessionId: sessionIdRef.current(),
        runId: _toolCallId ?? null,
      },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
    };
  },
});

const customTools = [...mcpTools, askUserTool, ...visualizationTools];

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
const host = startHost({ runtime, artifactStore, userQuestionManager });

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