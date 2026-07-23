/**
 * Scheduler API — host endpoints behind the React Scheduler panel.
 *
 * The browser CONFIGURES; the OS EXECUTES. These endpoints translate a
 * validated form submission into a Windows Scheduled Task (dev) whose action
 * is the checked-in deterministic runner scripts/scheduled-indicator-run.mjs.
 * No LLM, no ad-hoc commands: every schtasks invocation is built from a
 * closed allowlist (data/lookups/scheduler_series.json) and execFile'd as an
 * argv array — no shell string interpolation of user input.
 *
 * GUARDS (all endpoints): Windows-only, NODE_ENV !== 'production'. The host is
 * already loopback-only (127.0.0.1) and sits behind the proxy's auth, so the
 * remaining risk is the agent or a page script calling these — acceptable in
 * dev, hence the hard production guard. In production the panel hides and the
 * same runner script is driven by Railway cron (or the source daemon's own
 * [schedule] loop).
 *
 *   GET    /ui/api/scheduler/catalog   series allowlist + suggested schedules
 *   GET    /ui/api/scheduler/tasks     DVA-* tasks (name, next run, status)
 *   POST   /ui/api/scheduler/tasks     create/overwrite a task   {source, series?, month?|"latest", recurrence{kind,time,dayOfMonth?,dayOfWeek?,date?}, withRefresh?}
 *   DELETE /ui/api/scheduler/tasks/:name
 *   POST   /ui/api/scheduler/run       run once, inline (no task): same body minus recurrence
 *   GET    /ui/api/scheduler/logs      recent data/scheduler-logs/*.json
 *   POST   /ui/api/scheduler/open      launch taskschd.msc
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TASK_RE = /^DVA-[a-z0-9-]{1,48}$/;
const DAYS = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

interface CatalogSeries {
  id: string; source: string; label: string; unit: string;
  seasonalAdjustment: string; referenceLagMonths: number;
  suggestedSchedule: { kind: string; dayOfMonth: number; time: string; note: string };
}
interface Catalog { sources: { id: string; label: string }[]; series: CatalogSeries[]; }

const ENABLED = process.platform === "win32" && process.env["NODE_ENV"] !== "production";

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function execFileText(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function loadCatalog(projectRoot: string): Catalog {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, "data", "lookups", "scheduler_series.json"), "utf-8")) as Catalog;
}

/** Validate a create/run body against the catalog. Returns runner args or an error string. */
function buildRunnerArgs(body: any, catalog: Catalog): { args: string[]; label: string } | { error: string } {
  const source = String(body?.source ?? "");
  if (!catalog.sources.some((s) => s.id === source)) return { error: `unknown source "${source}"` };
  const byId = new Map(catalog.series.map((s) => [s.id, s]));
  const sourceSeries = catalog.series.filter((s) => s.source === source);
  let seriesIds: string[];
  if (Array.isArray(body?.series) && body.series.length > 0) {
    seriesIds = body.series.map(String);
    const bad = seriesIds.filter((id) => byId.get(id)?.source !== source);
    if (bad.length) return { error: `series not in source '${source}': ${bad.join(", ")}` };
  } else {
    seriesIds = sourceSeries.map((s) => s.id);
  }
  const month = body?.month === "latest" || body?.month === undefined ? null : String(body.month);
  if (month && !MONTH_RE.test(month)) return { error: `month must be "latest" or YYYY-MM, got "${month}"` };
  const args = ["--source", source, "--series", seriesIds.join(",")];
  if (month) args.push("--month", month); else args.push("--latest");
  if (body?.withRefresh === true) args.push("--refresh");
  return { args, label: `${source}:${seriesIds.join(",")}@${month ?? "latest"}` };
}

/** schtasks /sd uses the SYSTEM LOCALE's short-date order. Detect it once
 *  via the .NET culture (d/MM/yyyy vs M/d/yyyy) and cache; default month-first. */
let dayFirstCache: boolean | null = null;
async function isDayFirstLocale(): Promise<boolean> {
  if (dayFirstCache !== null) return dayFirstCache;
  const r = await execFileText("powershell", ["-NoProfile", "-Command", "(Get-Culture).DateTimeFormat.ShortDatePattern"]);
  const pattern = r.code === 0 ? r.stdout.trim() : "M/d/yyyy";
  dayFirstCache = pattern.indexOf("d") < pattern.indexOf("M");
  return dayFirstCache;
}

/** Translate a validated recurrence into schtasks trigger args. */
async function buildTriggerArgs(rec: any): Promise<string[] | { error: string }> {
  const kind = String(rec?.kind ?? "");
  const time = String(rec?.time ?? "");
  if (!TIME_RE.test(time)) return { error: `time must be HH:MM 24h, got "${time}"` };
  switch (kind) {
    case "once": {
      const date = String(rec?.date ?? "");
      if (!DATE_RE.test(date)) return { error: `once requires date YYYY-MM-DD, got "${date}"` };
      const [y, m, d] = date.split("-");
      const sd = (await isDayFirstLocale()) ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
      return ["/sc", "once", "/sd", sd, "/st", time];
    }
    case "daily":
      return ["/sc", "daily", "/st", time];
    case "weekly": {
      const dow = String(rec?.dayOfWeek ?? "").toUpperCase();
      if (!DAYS.has(dow)) return { error: `weekly requires dayOfWeek MON..SUN, got "${dow}"` };
      return ["/sc", "weekly", "/d", dow, "/st", time];
    }
    case "monthly": {
      const dom = Number(rec?.dayOfMonth);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { error: `monthly requires dayOfMonth 1-31, got "${rec?.dayOfMonth}"` };
      return ["/sc", "monthly", "/d", String(dom), "/st", time];
    }
    default:
      return { error: `recurrence.kind must be once|daily|weekly|monthly, got "${kind}"` };
  }
}

/** Parse `schtasks /query /fo csv /nh` output, keeping only DVA-* tasks. */
function parseTasksCsv(csv: string): { name: string; nextRun: string; status: string }[] {
  const out: { name: string; nextRun: string; status: string }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    // CSV row: "TaskName","Next Run Time","Status" — task names have no commas here.
    const m = line.match(/^"([^"]+)","([^"]*)","([^"]*)"/);
    if (!m) continue;
    const name = m[1].replace(/^\\/, "");
    if (!name.startsWith("DVA-")) continue;
    out.push({ name, nextRun: m[2], status: m[3] });
  }
  return out;
}

export async function handleSchedulerRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  projectRoot: string,
): Promise<void> {
  if (!ENABLED) {
    sendJson(res, 403, { error: "scheduler endpoints are dev-only (Windows, NODE_ENV != production). In production use Railway cron with scripts/scheduled-indicator-run.mjs." });
    return;
  }
  const runner = path.join(projectRoot, "scripts", "scheduled-indicator-run.mjs");
  const sub = pathname.slice("/ui/api/scheduler".length) || "/";

  // ── GET /catalog ──────────────────────────────────────────────────────────
  if (sub === "/catalog" && req.method === "GET") {
    const catalog = loadCatalog(projectRoot);
    sendJson(res, 200, { ...catalog, runnerPath: runner, runnerExists: fs.existsSync(runner) });
    return;
  }

  // ── GET /tasks ────────────────────────────────────────────────────────────
  if (sub === "/tasks" && req.method === "GET") {
    const r = await execFileText("schtasks", ["/query", "/fo", "csv", "/nh"]);
    if (r.code !== 0 && !r.stdout) { sendJson(res, 200, { tasks: [], warning: r.stderr.trim() || "schtasks query failed" }); return; }
    sendJson(res, 200, { tasks: parseTasksCsv(r.stdout) });
    return;
  }

  // ── POST /tasks (create/overwrite) ───────────────────────────────────────
  if (sub === "/tasks" && req.method === "POST") {
    let body: any; try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: "invalid JSON body" }); return; }
    const catalog = loadCatalog(projectRoot);
    const built = buildRunnerArgs(body, catalog);
    if ("error" in built) { sendJson(res, 422, { error: built.error }); return; }
    const trigger = await buildTriggerArgs(body?.recurrence);
    if (!Array.isArray(trigger)) { sendJson(res, 422, { error: trigger.error }); return; }
    // Task name: sanitized (series ids carry underscores → dashes), prefix-enforced.
    const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const slug = `${body.source}-${sanitize(String(body?.name ?? "")) || sanitize(built.args[3].split(",")[0])}`.slice(0, 44);
    const taskName = `DVA-${slug}`;
    if (!TASK_RE.test(taskName)) { sendJson(res, 422, { error: `bad task name "${taskName}"` }); return; }
    const tr = `"${process.execPath}" "${runner}" ${built.args.join(" ")}`;
    const create = await execFileText("schtasks", ["/create", "/f", "/tn", taskName, "/tr", tr, ...trigger]);
    if (create.code !== 0) { sendJson(res, 500, { error: `schtasks /create failed: ${create.stderr.trim() || create.stdout.trim()}` }); return; }
    sendJson(res, 200, { ok: true, task: taskName, command: tr, trigger });
    return;
  }

  // ── DELETE /tasks/:name ──────────────────────────────────────────────────
  const delMatch = sub.match(/^\/tasks\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    const name = decodeURIComponent(delMatch[1]);
    if (!TASK_RE.test(name)) { sendJson(res, 422, { error: "task name must match DVA-<slug>" }); return; }
    const del = await execFileText("schtasks", ["/delete", "/f", "/tn", name]);
    if (del.code !== 0) { sendJson(res, 500, { error: `schtasks /delete failed: ${del.stderr.trim() || del.stdout.trim()}` }); return; }
    sendJson(res, 200, { ok: true, deleted: name });
    return;
  }

  // ── POST /run (inline, no task) ──────────────────────────────────────────
  if (sub === "/run" && req.method === "POST") {
    let body: any; try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: "invalid JSON body" }); return; }
    const catalog = loadCatalog(projectRoot);
    const built = buildRunnerArgs(body, catalog);
    if ("error" in built) { sendJson(res, 422, { error: built.error }); return; }
    const r = await execFileText(process.execPath, [runner, ...built.args]);
    // Surface the runner's log file (it always writes one).
    const logDir = path.join(projectRoot, "data", "scheduler-logs");
    let logFile: string | null = null;
    try {
      const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".json")).sort();
      logFile = files.length ? files[files.length - 1] : null;
    } catch { /* no logs yet */ }
    const log = logFile ? JSON.parse(fs.readFileSync(path.join(logDir, logFile), "utf-8")) : null;
    sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, exitCode: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim(), log });
    return;
  }

  // ── GET /logs ────────────────────────────────────────────────────────────
  if (sub === "/logs" && req.method === "GET") {
    const logDir = path.join(projectRoot, "data", "scheduler-logs");
    const logs: any[] = [];
    try {
      for (const f of fs.readdirSync(logDir).filter((f) => f.endsWith(".json")).sort().slice(-20).reverse()) {
        try { logs.push({ file: f, ...JSON.parse(fs.readFileSync(path.join(logDir, f), "utf-8")) }); } catch { /* skip corrupt */ }
      }
    } catch { /* no dir yet */ }
    sendJson(res, 200, { logs });
    return;
  }

  // ── POST /open — launch Task Scheduler ───────────────────────────────────
  if (sub === "/open" && req.method === "POST") {
    const r = await execFileText("cmd", ["/c", "start", "", "taskschd.msc"]);
    sendJson(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, ...(r.code !== 0 ? { error: r.stderr.trim() } : {}) });
    return;
  }

  sendJson(res, 404, { error: `no scheduler route: ${req.method} ${pathname}` });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
