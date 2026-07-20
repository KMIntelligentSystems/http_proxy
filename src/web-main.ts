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
import { pullIndicatorDataset } from "./daemon-tools.js";
import { syncIndicatorHistory } from "./refresh-history-bridge.js";
import { runSarima } from "./sarima-tools.js";
import { loadProjectEnv } from "./env.js";
import { applyModelSelection, startHost, type HostServer } from "./host.js";
import { createMcpTools } from "./mcp-tools.js";
import { createVisualizationTools } from "./visualization-tools.js";
import { UserQuestionManager } from "./user-questions.js";

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
const userQuestionManager = new UserQuestionManager();
// Mutable ref so visualizationTools can broadcast catalog_updated
// after the host is started (below).
const hostRef = { current: null as HostServer | null };

const MCP_PLAYWRIGHT_URL = process.env["MCP_PLAYWRIGHT_URL"] ?? "http://localhost:3000/mcp";
const MCP_SEARCH_URL = process.env["MCP_SEARCH_URL"] ?? "http://localhost:3004/mcp";
const MCP_CODEGEN_URL = process.env["MCP_CODEGEN_URL"] ?? "http://localhost:3003/mcp";
// Shared secret the codegen MCP server requires. Sending it as a Bearer header
// avoids the 401 that makes mcporter fall back to a (headless-incompatible) OAuth flow.
const MCP_CODEGEN_TOKEN = process.env["AUTH_TOKEN"];

const { tools: mcpTools, runtime: mcpRuntime } = await createMcpTools([
  {
    name: "codegen",
    url: MCP_CODEGEN_URL,
    ...(MCP_CODEGEN_TOKEN
      ? { headers: { Authorization: `Bearer ${MCP_CODEGEN_TOKEN}` } }
      : {}),
    skillPath: ".pi/skills/codegen-mcp/SKILL.md",
    promptGuidelines: [
      "Use these tools when asked to generate, scaffold, or transform code via the codegen service.",
    ],
  },
  {
    name: "playwright",
    url: MCP_PLAYWRIGHT_URL,
  },
  {
    name: "search",
    url: MCP_SEARCH_URL,
  },
]);

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
        sessionId: activeRuntime?.session?.sessionId ?? null,
        runId: _toolCallId ?? null,
      },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
    };
  },
});

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

const pullIndicatorDatasetTool = defineTool({
  name: "pull_indicator_dataset",
  label: "Pull Indicator Dataset",
  description:
    "Wake the nowcasting daemon to fetch leading-indicator data from FRED, " +
    "BLS, or Census for a given reference month.  Returns structured JSON " +
    "with series observations, units, and provenance.  Use when the user " +
    "asks for fresh economic data or when a nowcast needs updated indicators.",
  parameters: Type.Object({
    source: Type.String({ description: "Data source: 'fred', 'bls', or 'census'." }),
    month: Type.String({ description: "Reference month YYYY-MM." }),
    series: Type.Optional(Type.Array(Type.String(), { description: "Specific series IDs to fetch (optional; defaults to the source's configured set)." })),
    model: Type.Optional(Type.String({ description: "OpenRouter model override (optional)." })),
  }),
  execute: async (_toolCallId, params) => {
    const result = await pullIndicatorDataset({
      source: params.source,
      month: params.month,
      series: params.series,
      model: params.model,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
    };
  },
});

// Bridge trigger 3: the orchestrator can explicitly re-sync the refresh
// target's indicator_history from the persisted backbone CSVs (e.g. after
// loading updated index CSVs, or to reseed a fresh refresh.db).
const syncIndicatorHistoryTool = defineTool({
  name: "sync_indicator_history",
  label: "Sync Indicator History",
  description:
    "Push the validated backbone index CSVs persisted in artifacts.db to the " +
    "refresh-daemon's indicator_history table (HMAC-authed /refresh/bootstrap, " +
    "idempotent upsert keyed on series+month). Use after loading or updating " +
    "index CSVs, or when the refresh target needs reseeding. Set dryRun to " +
    "preview what would be sent without posting.",
  parameters: Type.Object({
    dryRun: Type.Optional(Type.Boolean({ description: "Build and report the payload without posting it (default false)." })),
  }),
  execute: async (_toolCallId, params) => {
    const report = await syncIndicatorHistory({ dryRun: params.dryRun, reason: "agent-tool" });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(report) }],
      details: report,
    };
  },
});

// Flow-1 SARIMA exploration: the agent sets the params, the human reviews
// the artifacts. The canonical output is freeze-ready — spec +
// residualQuantiles transcribe directly into a frozen pipeline contract.
const runSarimaTool = defineTool({
  name: "run_sarima",
  label: "Run SARIMA",
  description:
    "Fit a SARIMA(p,d,q)(P,D,Q)[s] model (statsmodels, local, deterministic) " +
    "to a backbone series or inline observations. Returns canonical JSON: " +
    "forecasts with prediction intervals, coefficients, diagnostics (AIC/BIC, " +
    "Ljung-Box, Jarque-Bera), residual quantiles, and the freeze-ready spec. " +
    "Use for interactive ARIMA exploration; freezing into a pipeline contract " +
    "is a separate, explicit step.",
  parameters: Type.Object({
    seriesId: Type.Optional(Type.String({ description: "Backbone series from data/series-map.json (e.g. 'm3_total_shipments_nsa'). Reads artifacts.db." })),
    observations: Type.Optional(Type.Array(Type.Object({ date: Type.String(), value: Type.Number() }), { description: "Inline observations [{date:'YYYY-MM', value}] — alternative to seriesId." })),
    order: Type.Tuple([Type.Integer(), Type.Integer(), Type.Integer()], { description: "[p, d, q]" }),
    seasonal_order: Type.Tuple([Type.Integer(), Type.Integer(), Type.Integer(), Type.Integer()], { description: "[P, D, Q, s] e.g. [1,1,0,12]" }),
    transformation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("log")], { description: "default 'none'" })),
    trend: Type.Optional(Type.Union([Type.Literal("n"), Type.Literal("c"), Type.Literal("drift")], { description: "'drift' = constant in the differenced model; default 'n'" })),
    horizon: Type.Optional(Type.Integer({ description: "forecast steps ahead; default 1" })),
    piLevels: Type.Optional(Type.Array(Type.Number(), { description: "prediction interval levels; default [0.8, 0.95]" })),
  }),
  execute: async (_toolCallId, params) => {
    const outcome = await runSarima({
      seriesId: params.seriesId,
      observations: params.observations,
      order: params.order as [number, number, number],
      seasonal_order: params.seasonal_order as [number, number, number, number],
      transformation: params.transformation,
      trend: params.trend,
      horizon: params.horizon,
      piLevels: params.piLevels,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome.ok ? outcome.result : outcome) }],
      details: outcome,
    };
  },
});

const visualizationTools = createVisualizationTools({
  artifactStore,
  cwd: process.cwd(),
  getSessionId: () => activeRuntime?.session?.sessionId,
  onCatalogChanged: () => hostRef.current?.broadcastCatalogUpdated(),
});

const customTools = [...mcpTools, askUserTool, helloTool, pullIndicatorDatasetTool, syncIndicatorHistoryTool, runSarimaTool, ...visualizationTools];

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

const host = startHost({ runtime, artifactStore, userQuestionManager });
hostRef.current = host;

const startupModel = process.env["MODEL"]?.trim();
if (startupModel) {
  const result = await applyModelSelection(runtime.session, startupModel);
  if (result.ok) console.log(`[web-main] ${result.message}`);
  else console.warn(`[web-main] MODEL=${startupModel}: ${result.message}`);
}

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
