import {
  TUI,
  ProcessTerminal,
  Text,
  Editor,
  Spacer,
  type EditorTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..");

// ─── Types ───────────────────────────────────────────────────────────────────

type ProcName = "proxy" | "host";
type ProcStatus = "stopped" | "running" | "crashed";

interface ProcState {
  status: ProcStatus;
  pid: number | undefined;
  restarts: number;
  proc: ChildProcess | null;
}

// ─── State ───────────────────────────────────────────────────────────────────

const procs: Record<ProcName, ProcState> = {
  proxy: { status: "stopped", pid: undefined, restarts: 0, proc: null },
  host:  { status: "stopped", pid: undefined, restarts: 0, proc: null },
};

const MAX_LOG_LINES = 300;
const logLines: string[] = [];

// ─── TUI setup ───────────────────────────────────────────────────────────────

const terminal = new ProcessTerminal();
const tui = new TUI(terminal, true);

// Log pane — fills available space above the input
const logText = new Text("", 1, 0);
tui.addChild(logText);

tui.addChild(new Spacer(1));

// Status bar — single line showing process states
const statusText = new Text("", 1, 0);
tui.addChild(statusText);

tui.addChild(new Spacer(1));

// Editor theme
const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.blue(s),
  selectList: {
    selectedPrefix: (s) => chalk.green(s),
    selectedText:   (s) => chalk.inverse(s),
    description:    (s) => chalk.gray(s),
    scrollInfo:     (s) => chalk.dim(s),
    noMatch:        (s) => chalk.red(s),
  },
};

const editor = new Editor(tui, editorTheme, { paddingX: 1 });
editor.onSubmit = (cmd) => {
  editor.setText("");
  handleCommand(cmd);
};
tui.addChild(editor);

// ─── Rendering helpers ───────────────────────────────────────────────────────

function sourceColor(source: ProcName | "system"): (s: string) => string {
  if (source === "proxy")  return chalk.cyan;
  if (source === "host")   return chalk.yellow;
  return chalk.gray;
}

function statusColor(s: ProcStatus): (str: string) => string {
  if (s === "running") return chalk.green;
  if (s === "crashed") return chalk.red;
  return chalk.gray;
}

function addLog(source: ProcName | "system", text: string) {
  const prefix = sourceColor(source)(`[${source}]`);
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    logLines.push(`${prefix} ${trimmed}`);
  }
  while (logLines.length > MAX_LOG_LINES) logLines.shift();
  logText.setText(logLines.join("\n"));
  renderStatus();
  tui.requestRender();
}

function renderStatus() {
  const parts = (["proxy", "host"] as ProcName[]).map((name) => {
    const p = procs[name];
    const col = statusColor(p.status);
    return `${chalk.bold(name)} ${col(p.status)} pid:${p.pid ?? "—"} restarts:${p.restarts}`;
  });
  statusText.setText(parts.join("   │   "));
}

// ─── Process management ───────────────────────────────────────────────────────

function startProc(name: ProcName) {
  const state = procs[name];
  if (state.proc) {
    state.proc.kill();
    state.proc = null;
  }

  addLog("system", `Starting ${name}…`);

  const proc = spawn(process.execPath, [path.join(DIST, `dist/${name}.js`)], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onData = (data: Buffer) => addLog(name, data.toString());
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  proc.on("exit", (code) => {
    procs[name].proc = null;
    procs[name].pid = undefined;
    procs[name].status = code === 0 ? "stopped" : "crashed";
    addLog("system", `${name} exited (code ${code})${code !== 0 ? chalk.red(" — port may already be in use, run: npx kill-port 8080 3000") : ""}`);
  });

  procs[name].proc = proc;
  procs[name].pid = proc.pid;
  procs[name].status = "running";
  procs[name].restarts += 1;
  renderStatus();
  tui.requestRender();
}

function stopProc(name: ProcName) {
  const state = procs[name];
  if (!state.proc) {
    addLog("system", `${name} is not running`);
    return;
  }
  state.proc.kill();
  state.proc = null;
  state.pid = undefined;
  state.status = "stopped";
  addLog("system", `Stopped ${name}`);
}

// ─── Command handler ─────────────────────────────────────────────────────────

const HELP = [
  chalk.bold("Commands:"),
  "  start   proxy|host",
  "  stop    proxy|host",
  "  restart proxy|host",
  "  clear",
  "  quit",
].join("\n");

function handleCommand(cmd: string) {
  const [verb, target] = cmd.trim().split(/\s+/);

  switch (verb) {
    case "start":
      if (target === "proxy" || target === "host") startProc(target);
      else addLog("system", "Usage: start proxy|host");
      break;

    case "stop":
      if (target === "proxy" || target === "host") stopProc(target);
      else addLog("system", "Usage: stop proxy|host");
      break;

    case "restart":
      if (target === "proxy" || target === "host") {
        stopProc(target);
        setTimeout(() => startProc(target as ProcName), 300);
      } else {
        addLog("system", "Usage: restart proxy|host");
      }
      break;

    case "clear":
      logLines.length = 0;
      logText.setText("");
      tui.requestRender();
      break;

    case "quit":
    case "exit":
      stopProc("proxy");
      stopProc("host");
      tui.stop();
      process.exit(0);

    case "help":
    case "":
      addLog("system", HELP);
      break;

    default:
      addLog("system", `Unknown command: ${chalk.red(cmd)}  — type help`);
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

addLog("system", chalk.bold("http-proxy TUI") + "  —  type help for commands");
renderStatus();

startProc("proxy");
startProc("host");

tui.start();
tui.setFocus(editor);

// Graceful shutdown on Ctrl+C
process.on("SIGINT", () => {
  stopProc("proxy");
  stopProc("host");
  tui.stop();
  process.exit(0);
});
