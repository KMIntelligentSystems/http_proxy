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
  // Add more MCP servers here as needed:
  // { name: "playwright", url: "http://localhost:3000/mcp", skillPath: ".pi/skills/playwright/SKILL.md" },
]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..");

// ─── Proxy / Host process management ─────────────────────────────────────────

type ProcName = "proxy" | "host";

const procs: Record<ProcName, ChildProcess | null> = {
  proxy: null,
  host: null,
};

const logFile = fs.createWriteStream(path.join(DIST, "proxy-host.log"), { flags: "a" });

function startProc(name: ProcName) {
  if (procs[name]) procs[name]!.kill();

  const proc = spawn(process.execPath, [path.join(DIST, `dist/${name}.js`)], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onData = (data: Buffer) =>
    logFile.write(`[${name}] ${data.toString()}`);

  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code) => {
    logFile.write(`[system] ${name} exited (code ${code})\n`);
    procs[name] = null;
  });

  procs[name] = proc;
}

function stopAll() {
  for (const name of Object.keys(procs) as ProcName[]) {
    procs[name]?.kill();
    procs[name] = null;
  }
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
  description: "Push an SVG fragment to the browser canvas at http://localhost:8080/ui. Supports actions: clear, append, replace, remove.",
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

      const res = await fetch("http://localhost:3000/ui/svg", {
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

const customTools = [...mcpTools, helloTool, pushSvgTool];

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

// Start proxy and host silently — logs go to proxy-host.log
startProc("proxy");
startProc("host");

process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});

// Build the agent session runtime then hand control to InteractiveMode.
// InteractiveMode owns the terminal from here — it creates its own TUI,
// enters an input loop, and passes each submission to the agent.
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
});
const allTools = runtime.session.getAllTools()
console.log('ALL TOOLS', allTools)
const mode = new InteractiveMode(runtime);
await mode.run();

// mode.run() only returns on clean shutdown (Ctrl+D)
stopAll();