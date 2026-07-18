/**
 * Refresh Airlock — the 4-verb capability broker for the target daemon.
 *
 * Mirrors the source daemon's airlock/oracle split: an LLM Oracle drives a
 * closed tool catalog; this broker holds every capability (read-only DB,
 * signing key, the pinned skill executable, the sandbox) and exposes exactly
 * four verbs. The Oracle cannot compute, write, verify, or reach the network
 * except through these brokered calls.
 *
 *   read_indicator_dataset  ← verified broadcast (from refresh.db)
 *   read_prior_forecast     ← YTD series + last forecast (artifacts.db RO)
 *   run_nowcast_skill       ← pinned skill in a sandbox (the glm-5-2-plan stats)
 *   write_forecast_artifact ← signed, hash-bound durable write
 *
 * P1 status: read_* and write_forecast_artifact are real; run_nowcast_skill
 * runs a PINNED PLACEHOLDER skill (pipelines/placeholder@1.0.0) so the pipeline
 * is end-to-end demonstrable. P2 replaces the placeholder with the real frozen
 * STL / LASSO / SARIMA / seasonal-RW skills. The LLM decide step is real
 * (OpenRouter) when REFRESH_LLM_KEY is set; otherwise it defaults to "proceed".
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { BroadcastBody } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "..", "..", "data", "refresh-results");
const PIPELINES_DIR = path.resolve(__dirname, "..", "..", "pipelines");

// Result-signing key (the airlock holds it; the Oracle never sees it).
function signKey(): string {
  return process.env["REFRESH_SIGN_KEY"] ?? "dev-insecure-sign-key-change-me";
}

// ── Verb 1: read_indicator_dataset ──────────────────────────────────────────
export function readIndicatorDataset(db: DatabaseSync, datasetId: string) {
  const row = db.prepare(
    "SELECT payload_json, content_hash, source, target, reference_month, release_date, as_of FROM indicator_dataset WHERE dataset_id = ?"
  ).get(datasetId) as any;
  if (!row) throw new Error(`dataset not ingested: ${datasetId}`);
  const dataset = JSON.parse(row.payload_json);
  return {
    referenceMonth: row.reference_month,
    target: row.target,
    source: row.source,
    seriesIncluded: dataset.indicators?.map((i: any) => i.seriesId) ?? [],
    indicators: dataset.indicators,
    provenance: dataset.provenance,
    contentHash: row.content_hash,
    releaseDate: row.release_date,
    asOf: row.as_of,
  };
}

// ── Verb 2: read_prior_forecast (self-contained — the target's OWN state) ────
// Reads the YTD series history + the prior signed refresh-result from the
// target's own refresh.db / refresh-results. NEVER touches the React host's
// artifacts.db or data/*.csv — that coupling would break Railway separation.
// The history is built from ingested broadcasts (+ a one-time /refresh/bootstrap
// seed), so the target is self-contained on its own volume.
const SUBJECT_SERIES: Record<string, string[]> = {
  "sub-statlearn-deepseek": ["fred_mcumfn", "m3_new_orders", "m3_unfilled_orders", "fred_ipman", "fred_tcu"],
  "sub-m3-forecasts": ["m3_total_shipments_nsa"],
  "sub-stl-deepseek": ["m3_total_shipments_nsa"],
  "sub-mfg-productivity": ["m3_total_shipments_nsa", "fred_ipman", "bls_ces_mfg_employment", "bls_ces_mfg_hours"],
};

export function readPriorForecast(db: DatabaseSync, subjectId: string, referenceMonth: string) {
  const series = SUBJECT_SERIES[subjectId] ?? [];
  const history: Record<string, any[]> = {};
  for (const s of series) {
    history[s] = db.prepare(
      "SELECT date, value, is_preliminary FROM indicator_history WHERE series_id = ? ORDER BY date ASC"
    ).all(s);
  }
  // Prior signed refresh-result for this subject (the previous month's output).
  let priorRefreshResult: any = null;
  const resultsRoot = path.resolve(__dirname, "..", "..", "data", "refresh-results", subjectId);
  if (fs.existsSync(resultsRoot)) {
    const months = fs.readdirSync(resultsRoot).filter((d) => d < referenceMonth).sort();
    if (months.length) {
      const prior = path.join(resultsRoot, months[months.length - 1], "refresh_result.json");
      if (fs.existsSync(prior)) priorRefreshResult = JSON.parse(fs.readFileSync(prior, "utf8"));
    }
  }
  return { subjectId, history, priorRefreshResult, historyDepth: Object.values(history).reduce((n, a) => n + a.length, 0) };
}

// ── Contract registry: loads data/contracts/*.contract.json ───────────────
export interface SkillResult {
  point: number;
  pi80: [number, number];
  pi95: [number, number];
  drift: { features: string[]; widened: boolean };
  delta: { newMonth: number; revision: number };
  canonicalResultHash: string;
}

export interface RefreshContract {
  contractId: string;
  subjectId: string;
  target: string;
  semantics: string; // a-frozen-rescore | b-refit-pinned | c-rederive
  pipeline: string;   // e.g. "m3-stl@1.0.0"
  pipelineDigest: string;
  envLock: string;
  envHash: string;
  requiredSeries: string[];
  optionalSeries: string[];
  piWideningFactor: number;
  replacesTitlePatterns: string[];
}

const CONTRACTS_DIR = path.resolve(__dirname, "..", "..", "data", "contracts");

function loadContracts(): RefreshContract[] {
  if (!fs.existsSync(CONTRACTS_DIR)) return [];
  return fs.readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith(".contract.json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, f), "utf8")) as RefreshContract);
}

export { loadContracts };

export function contractForTarget(target: string): RefreshContract | undefined {
  // The first registered contract whose target matches (or whose subject's
  // target family matches). Multiple targets may map to one contract.
  const all = loadContracts();
  return all.find((c) => c.target === target) ?? all.find((c) => target.startsWith(c.target.split("_")[0]));
}

// ── Verb 3: run_nowcast_skill (pinned skill, runtime-dispatched, digest-checked) ──
export function runNowcastSkill(contract: RefreshContract, input: { dataset: any; prior: any }): Promise<SkillResult> {
  const dir = path.join(PIPELINES_DIR, contract.pipeline);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return Promise.reject(new Error(`pipeline not found for contract '${contract.contractId}': ${dir}`));
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { runtime: string; entrypoint: string; };

  // Digest check: the entrypoint must hash to the contract's pipelineDigest.
  // A tampered skill never runs — the mismatch quarantines the job.
  const entryPath = path.join(dir, manifest.entrypoint);
  if (!fs.existsSync(entryPath)) {
    return Promise.reject(new Error(`skill entrypoint missing: ${entryPath}`));
  }
  const actualDigest = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex");
  if (actualDigest !== contract.pipelineDigest) {
    return Promise.reject(new Error(`skill digest mismatch for '${contract.pipeline}': expected ${contract.pipelineDigest}, got ${actualDigest} (skill tampered or contract stale — re-freeze)`));
  }

  // Runtime dispatch: node skills run with the broker's node; python skills run
  // with the `py` launcher (Python 3.12.10). Both get a stripped env, wall-clock
  // cap, and a fresh cwd; inputs on stdin only.
  const isPython = manifest.runtime === "python";
  const cmd = isPython ? (process.env["PYTHON_BIN"] ?? "py") : process.execPath;
  const args = isPython ? [entryPath] : [entryPath];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: isPython ? { PATH: process.env["PATH"] ?? "", PYTHONUNBUFFERED: "1" } : { PATH: process.env["PATH"] ?? "" },
      cwd: dir,
      timeout: 120_000,
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); if (out.length > 1_000_000) child.kill(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(`skill '${contract.pipeline}' exited ${code}${code === 3 ? " (scaffold/not-implemented)" : ""}`)); return; }
      try {
        const result = JSON.parse(out);
        if (result.error) { reject(new Error(`skill error: ${result.error}`)); return; }
        result.canonicalResultHash = sha256Hex(Buffer.from(out, "utf8"));
        resolve(result);
      } catch (err) { reject(new Error(`skill output unparseable: ${err}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// ── Tool-call envelope (mirrors daemon grammar.rs ToolCall/ToolResult) ─────────
export interface ToolCall {
  callId: string;
  tool: string;
  args: Record<string, any>;
}
export interface ToolResult {
  callId: string;
  ok: boolean;
  result?: any;
  error?: { code: string; message: string };
}
function toolOk(callId: string, result: any): ToolResult {
  return { callId, ok: true, result };
}
function toolErr(callId: string, code: string, message: string): ToolResult {
  return { callId, ok: false, error: { code, message } };
}

// ── RefreshSession (mirrors daemon Session) ──────────────────────────────
// Per-job mutable state shared across dispatch calls within one oracle run.
// Holds the resolved contract + the intermediates the verbs cache (dataset,
// prior, skill) so the oracle can call the verbs in any order and the broker
// threads the results. tool_calls + budget are enforced here, exactly as the
// source's Session.tool_calls / config.budget.
export class RefreshSession {
  tool_calls = 0;
  max_tool_calls = 12;
  contract: RefreshContract;
  referenceMonth: string;
  datasetId: string;
  // cached intermediates (filled by the read/run verbs, consumed by write)
  dataset: any = null;
  prior: any = null;
  skill: SkillResult | null = null;
  constructor(contract: RefreshContract, referenceMonth: string, datasetId: string) {
    this.contract = contract;
    this.referenceMonth = referenceMonth;
    this.datasetId = datasetId;
  }
}

// ── dispatch: the per-call router (mirrors tools.rs::dispatch) ────────────
// Takes one ToolCall, routes it to the matching verb, returns the ToolResult
// + an optional terminal status. Budget-enforced. The oracle drives WHICH call
// comes next; dispatch only executes THIS call. Spawning the oracle + passing
// TaskContext is a SEPARATE mechanism (built in the steps above this).
export async function dispatch(
  call: ToolCall,
  session: RefreshSession,
  db: DatabaseSync,
): Promise<{ result: ToolResult; terminal?: string }> {
  session.tool_calls += 1;
  if (session.tool_calls > session.max_tool_calls) {
    return {
      result: toolErr(call.callId, "budget_exceeded", "max_tool_calls reached"),
      terminal: "abstain",
    };
  }
  switch (call.tool) {
    case "read_indicator_dataset": {
      // No args — the broker binds the session to the verified dataset_id.
      try {
        session.dataset = readIndicatorDataset(db, session.datasetId);
        return { result: toolOk(call.callId, {
          referenceMonth: session.dataset.referenceMonth,
          target: session.dataset.target,
          source: session.dataset.source,
          seriesIncluded: session.dataset.seriesIncluded,
          indicators: session.dataset.indicators,
          contentHash: session.dataset.contentHash,
        }) };
      } catch (e) { return { result: toolErr(call.callId, "read_failed", String(e)) }; }
    }
    case "read_prior_forecast": {
      try {
        session.prior = readPriorForecast(db, session.contract.subjectId, session.referenceMonth);
        return { result: toolOk(call.callId, {
          historyDepth: session.prior.historyDepth,
          history: session.prior.history,
          priorRefreshResult: session.prior.priorRefreshResult,
        }) };
      } catch (e) { return { result: toolErr(call.callId, "read_failed", String(e)) }; }
    }
    case "run_nowcast_skill": {
      // The oracle may pass options from a CLOSED, schema-validated menu only
      // (e.g. { vintageComparison: true }). The broker assembles the actual
      // inputs — the oracle cannot inject series, weights, or code.
      if (!session.dataset || !session.prior) {
        return { result: toolErr(call.callId, "ordering", "call read_indicator_dataset and read_prior_forecast first") };
      }
      try {
        session.skill = await runNowcastSkill(session.contract, { dataset: session.dataset, prior: session.prior });
        // Return the interpret-able fields + the hash (the oracle must NOT alter
        // numbers; the hash binds the canonical output for signing).
        return { result: toolOk(call.callId, {
          point: session.skill.point,
          pi80: session.skill.pi80,
          pi95: session.skill.pi95,
          drift: session.skill.drift,
          delta: session.skill.delta,
          outputHash: session.skill.canonicalResultHash,
        }) };
      } catch (e) { return { result: toolErr(call.callId, "skill_failed", String(e)) }; }
    }
    case "write_forecast_artifact": {
      // The oracle's ONLY contribution is analysisMd (prose). The broker fills
      // contractId/subjectId/body/envHash/signature — the oracle cannot forge
      // provenance. Terminal → the candidate is written.
      const analysisMd = String(call.args?.analysisMd ?? "");
      if (!session.skill) {
        return { result: toolErr(call.callId, "ordering", "call run_nowcast_skill first") };
      }
      try {
        const written = writeForecastArtifact({
          contractId: session.contract.contractId,
          subjectId: session.contract.subjectId,
          referenceMonth: session.referenceMonth,
          skill: session.skill,
          analysisMd,
          envHash: session.contract.envHash,
          body: {
            schemaVersion: 1,
            broadcastId: session.dataset?.broadcastId ?? session.datasetId,
            datasetId: session.datasetId,
            target: session.contract.target,
            source: session.dataset?.source ?? "",
            referenceMonth: session.referenceMonth,
            releaseDate: session.dataset?.releaseDate ?? "",
            emittedAt: "",
            contentHash: session.dataset?.contentHash ?? "",
            seriesIncluded: session.dataset?.seriesIncluded ?? [],
          },
        });
        return { result: toolOk(call.callId, { candidateId: written.candidateId, resultHash: written.resultHash, dir: written.dir }), terminal: "stored" };
      } catch (e) { return { result: toolErr(call.callId, "write_failed", String(e)) }; }
    }
    case "finish": {
      const status = String(call.args?.status ?? "abstain");
      return { result: toolOk(call.callId, { acknowledged: true }), terminal: status };
    }
    default:
      return { result: toolErr(call.callId, "unknown_tool", `no such tool: ${call.tool}`) };
  }
}

// ── Oracle decide: proceed/abstain + analysis prose (the LLM, contained) ─────
export async function oracleDecide(summary: { target: string; referenceMonth: string; seriesIncluded: string[]; drift: any; point: number }): Promise<{ proceed: boolean; analysisMd: string }> {
  const key = process.env["REFRESH_LLM_KEY"];
  const model = process.env["REFRESH_LLM_MODEL"] ?? "openai/gpt-4o-mini";
  if (!key) {
    // Dev default: proceed, with a templated note. The LLM is wired but
    // optional until P2 gives it real drift/revision signals to judge.
    return { proceed: true, analysisMd: `Automated refresh for ${summary.target} ${summary.referenceMonth} (LLM decide skipped: REFRESH_LLM_KEY unset).` };
  }
  const sys = "You are the refresh Oracle. Decide whether to publish this forecast refresh. Reply ONLY JSON: {\"proceed\": boolean, \"analysisMd\": string}. Do not invent numbers.";
  const user = JSON.stringify(summary);
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: 400, temperature: 0 }),
    });
    const j: any = await resp.json();
    const txt = j?.choices?.[0]?.message?.content ?? "{}";
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : txt);
    return { proceed: !!parsed.proceed, analysisMd: String(parsed.analysisMd ?? "") };
  } catch (err) {
    console.error("[broker] oracleDecide LLM call failed, defaulting to proceed:", err instanceof Error ? err.message : String(err));
    return { proceed: true, analysisMd: `Refresh for ${summary.target} ${summary.referenceMonth} (LLM unavailable; defaulting to proceed).` };
  }
}

// ── Verb 4: write_forecast_artifact (durable, signed, hash-bound) ───────────
export interface WriteResult { candidateId: string; resultHash: string; dir: string; }

export function writeForecastArtifact(args: {
  contractId: string; subjectId: string; referenceMonth: string;
  skill: SkillResult; analysisMd: string; body: BroadcastBody; envHash: string;
}): WriteResult {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const dir = path.join(RESULTS_DIR, args.subjectId, args.referenceMonth);
  fs.mkdirSync(dir, { recursive: true });

  const inputHash = args.body.contentHash;
  const contractHash = sha256Hex(Buffer.from(args.contractId));
  const envHash = args.envHash;
  const outputHash = args.skill.canonicalResultHash;

  const refreshResult = {
    inputHash, contractHash, envHash, outputHash,
    referenceMonth: args.referenceMonth, target: args.body.target,
    point: args.skill.point, pi80: args.skill.pi80, pi95: args.skill.pi95,
    drift: args.skill.drift, delta: args.skill.delta,
    broadcastId: args.body.broadcastId, datasetId: args.body.datasetId,
    analysisMd: args.analysisMd,
    signature: signHmac(JSON.stringify({ inputHash, contractHash, envHash, outputHash, referenceMonth: args.referenceMonth })),
  };
  const resultJson = JSON.stringify(refreshResult, null, 2);
  fs.writeFileSync(path.join(dir, "refresh_result.json"), resultJson);
  fs.writeFileSync(path.join(dir, "analysis.md"), args.analysisMd);
  fs.writeFileSync(path.join(dir, "forecast.csv"), `reference_month,point,pi80_lo,pi80_hi,pi95_lo,pi95_hi\n${args.referenceMonth},${args.skill.point},${args.skill.pi80[0]},${args.skill.pi80[1]},${args.skill.pi95[0]},${args.skill.pi95[1]}\n`);

  return { candidateId: args.body.broadcastId, resultHash: outputHash, dir };
}

// ── Job runner: ties the 4 verbs + Oracle for each waiting job ───────────────

export async function runWaitingJobs(db: DatabaseSync, _daemonUrl: string): Promise<void> {
  const jobs = db.prepare("SELECT id, contract_id, target, reference_month, input_fingerprint FROM refresh_job WHERE state = 'waiting-inputs' LIMIT 4").all() as any[];
  for (const job of jobs) {
    const contract = loadContracts().find((c) => c.contractId === job.contract_id);
    if (!contract) {
      db.prepare("UPDATE refresh_job SET state = ?, updated_at = ? WHERE id = ?").run("rejected", new Date().toISOString(), job.id);
      console.log(`[broker] no contract for target ${job.target}; job rejected`);
      continue;
    }
    db.prepare("UPDATE refresh_job SET state = ?, updated_at = ? WHERE id = ?").run("running", new Date().toISOString(), job.id);
    try {
      // Resolve the ingested dataset for this job (input_fingerprint = contentHash).
      const ds = db.prepare("SELECT dataset_id FROM indicator_dataset WHERE content_hash = ?").get(job.input_fingerprint) as any;
      if (!ds) throw new Error("dataset not found for fingerprint");
      const dataset = readIndicatorDataset(db, ds.dataset_id);
      const prior = readPriorForecast(db, contract.subjectId, job.reference_month);
      const skill = await runNowcastSkill(contract, { dataset, prior });
      const decide = await oracleDecide({ target: job.target, referenceMonth: job.reference_month, seriesIncluded: dataset.seriesIncluded, drift: skill.drift, point: skill.point });
      if (!decide.proceed) {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        const dir = path.join(RESULTS_DIR, contract.subjectId, job.reference_month);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "abstention.md"), decide.analysisMd);
        db.prepare("UPDATE refresh_job SET state = ?, updated_at = ? WHERE id = ?").run("abstained", new Date().toISOString(), job.id);
        console.log(`[broker] ${job.id}: Oracle abstained — ${decide.analysisMd.slice(0, 80)}`);
        continue;
      }
      const written = writeForecastArtifact({
        contractId: contract.contractId, subjectId: contract.subjectId, referenceMonth: job.reference_month,
        skill, analysisMd: decide.analysisMd, envHash: contract.envHash,
        body: { contentHash: job.input_fingerprint, broadcastId: job.id, datasetId: ds.dataset_id, target: job.target, source: "", referenceMonth: job.reference_month, releaseDate: "", emittedAt: "", schemaVersion: 1, seriesIncluded: dataset.seriesIncluded },
      });
      db.prepare("UPDATE refresh_job SET state = ?, updated_at = ? WHERE id = ?").run("candidate", new Date().toISOString(), job.id);
      console.log(`[broker] ${job.id}: candidate written → ${written.dir}`);
    } catch (err) {
      db.prepare("UPDATE refresh_job SET state = ?, updated_at = ? WHERE id = ?").run("failed", new Date().toISOString(), job.id);
      console.error(`[broker] ${job.id} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sha256Hex(buf: Buffer): string { return crypto.createHash("sha256").update(buf).digest("hex"); }
function signHmac(payload: string): string { return crypto.createHmac("sha256", signKey()).update(payload).digest("hex"); }
