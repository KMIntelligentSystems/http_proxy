import {
  createAgentSession,
  InteractiveMode,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  getAgentDir,
  type CreateAgentSessionRuntimeFactory,
  type SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

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

// ─── Agent session factory ────────────────────────────────────────────────────

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

const mode = new InteractiveMode(runtime);
await mode.run();

// mode.run() only returns on clean shutdown (Ctrl+D)
stopAll();
