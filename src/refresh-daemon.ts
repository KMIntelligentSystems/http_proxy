/**
 * Target Refresh Daemon — the always-on service on the http_proxy side that
 * receives the source daemon's signed broadcasts and applies the leading
 * indicators through a contained Oracle + 4-verb airlock.
 *
 * P0 (this file, ingest): hardened HTTP ingest endpoint + durable storage in
 *   a dedicated data/refresh.db (NEVER artifacts.db, which stays human-write-only).
 * P1 (broker.ts + the job loop below): the 4-verb airlock + headless Oracle.
 *
 * Run:  node dist/refresh-daemon.js     (always-on; not the React app)
 * The source daemon POSTs to {DAEMON_MAIN_URL}/ui/api/daemon/broadcast, so set
 *   DAEMON_MAIN_URL=http://127.0.0.1:8792   (this service's port).
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyEnvelope, type BroadcastBody, type EnvelopeV2 } from "./refresh/crypto.js";
import { loadContracts } from "./refresh/broker.js";
import { loadProjectEnv } from "./env.js";

// Load .env (DAEMON_HMAC_KEY, OPENROUTER_API_KEY, etc.) like every other
// entrypoint — mirrors the source daemon's dotenvy::dotenv(). Must happen
// before the consts below read process.env.
loadProjectEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
// REFRESH_DB env override: lets tests/smoke-runs use a throwaway DB instead of
// the shared dev data/refresh.db (the test-contamination issue's minimal enabler).
const REFRESH_DB = process.env["REFRESH_DB"] ?? path.join(DATA_DIR, "refresh.db");
// Same override as the broker's — reads and writes must agree on the tree.
const RESULTS_DIR = process.env["REFRESH_RESULTS_DIR"] ?? path.join(DATA_DIR, "refresh-results");

const PORT = Number(process.env["PORT"] ?? process.env["REFRESH_PORT"] ?? 8792);
const DAEMON_URL = process.env["DAEMON_URL"] ?? "http://127.0.0.1:8791";
const KEY_ENV = "DAEMON_HMAC_KEY";
const DEV_KEY = "dev-insecure-hmac-key-change-me";

let warnedDevHmacKey = false;
function hmacKey(): string {
  const k = process.env[KEY_ENV];
  if (k && k !== DEV_KEY) return k;
  // M1: fail-closed in production; loud warning in dev.
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("[refresh-daemon] DAEMON_HMAC_KEY must be set to a non-dev value in production");
  }
  if (!warnedDevHmacKey) {
    console.warn("[refresh-daemon] WARNING: using the dev HMAC key — set DAEMON_HMAC_KEY for any real deployment");
    warnedDevHmacKey = true;
  }
  return DEV_KEY;
}
function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", hmacKey()).update(payload).digest("hex");
}
function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ── Durable operational tables (refresh.db; NOT artifacts.db) ───────────────
/*
const db = new DatabaseSync(`file:${REFRESH_DB}?nolock=1`);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS daemon_receipt (
      broadcast_id    TEXT PRIMARY KEY,

      WAL on CIFS is the risky bit
*/
function openDb(): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(REFRESH_DB);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS daemon_receipt (
      broadcast_id    TEXT PRIMARY KEY,
      dataset_id      TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      source          TEXT NOT NULL,
      target          TEXT NOT NULL,
      reference_month TEXT NOT NULL,
      emitted_at      TEXT NOT NULL,
      received_at     TEXT NOT NULL,
      decision        TEXT NOT NULL,
      reason          TEXT,
      key_id          TEXT
    );
    CREATE TABLE IF NOT EXISTS indicator_dataset (
      dataset_id      TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      target          TEXT NOT NULL,
      reference_month TEXT NOT NULL,
      release_date    TEXT NOT NULL,
      as_of           TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      received_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indicator_vintage (
      dataset_id      TEXT NOT NULL REFERENCES indicator_dataset(dataset_id),
      series_id       TEXT NOT NULL,
      reference_month TEXT NOT NULL,
      fetched_at      TEXT NOT NULL,
      source_hash     TEXT NOT NULL,
      is_preliminary  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (dataset_id, series_id)
    );
    -- Self-contained history: the target's OWN copy of every observation it has
    -- ever seen, built from ingested broadcasts (+ a one-time bootstrap). This
    -- decouples the target from the React host's filesystem — the YTD series the
    -- skill extends come from here, not from data/*.csv on a shared volume.
    CREATE TABLE IF NOT EXISTS indicator_history (
      series_id  TEXT NOT NULL,
      date       TEXT NOT NULL,
      value      REAL NOT NULL,
      is_preliminary INTEGER NOT NULL DEFAULT 0,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (series_id, date),
      -- Hard-enforce the canonical YYYY-MM month key so no writer (broadcast,
      -- bootstrap, CSV bridge) can reintroduce YYYY-MM-DD rows that dodge the
      -- (series_id, date) PK and duplicate a month. Binds on fresh DBs only
      -- (CREATE ... IF NOT EXISTS won't alter an existing table); the write-side
      -- .slice(0,7) normalization is what protects the already-live DB.
      CHECK (length(date) = 7)
    );
    CREATE TABLE IF NOT EXISTS refresh_job (
      id               TEXT PRIMARY KEY,
      contract_id      TEXT NOT NULL,
      target           TEXT NOT NULL,
      reference_month  TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      state            TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      lease_expires_at TEXT,
      UNIQUE(contract_id, input_fingerprint)
    );
  `);
  // M4 migration: refresh.db files created before the lease column existed.
  try { db.exec("ALTER TABLE refresh_job ADD COLUMN lease_expires_at TEXT"); } catch { /* column already present */ }
  return db;
}

const db = openDb();

interface BroadcastResponse {
  schemaVersion: number;
  broadcastId: string;
  decision: "accept" | "reject";
  reason: string | null;
}

function respond(res: http.ServerResponse, code: number, body: BroadcastResponse | { error: string }) {
  const json = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

// ── Freshness / schema checks ───────────────────────────────────────────────
const FRESHNESS_MIN = 10 * 60 * 1000; // 10 min
function checkFreshness(emittedAt: string): boolean {
  const t = Date.parse(emittedAt);
  if (Number.isNaN(t)) return false;
  return Math.abs(Date.now() - t) <= FRESHNESS_MIN;
}
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const ID_RE = /^(bc|ds)-[0-9a-f-]+$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function validateBody(body: BroadcastBody): string | null {
  if (!ID_RE.test(body.broadcastId)) return "schema_mismatch";
  if (!ID_RE.test(body.datasetId)) return "schema_mismatch";
  if (!MONTH_RE.test(body.referenceMonth)) return "schema_mismatch";
  if (!HASH_RE.test(body.contentHash)) return "schema_mismatch";
  if (!body.target || !body.source) return "schema_mismatch";
  if (!Array.isArray(body.seriesIncluded) || body.seriesIncluded.length === 0) return "schema_mismatch";
  return null;
}

// ── Pull the dataset from the source daemon + re-check the content hash ─────
async function pullDataset(datasetId: string, expectedHash: string): Promise<{ ok: true; buf: Buffer; dataset: any } | { ok: false; reason: string }> {
  const sig = hmacSign(datasetId);
  let resp: Response;
  try {
    resp = await fetch(`${DAEMON_URL}/datasets/${encodeURIComponent(datasetId)}`, {
      headers: { "X-Daemon-Sig": sig },
    });
  } catch (err) {
    return { ok: false, reason: `pull transport: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!resp.ok) return { ok: false, reason: `pull HTTP ${resp.status}` };
  const buf = Buffer.from(await resp.arrayBuffer());
  if (sha256Hex(buf) !== expectedHash) return { ok: false, reason: "content_hash_mismatch" };
  let dataset: any;
  try { dataset = JSON.parse(buf.toString("utf8")); } catch { return { ok: false, reason: "schema_mismatch" }; }
  if (!dataset?.indicators || !Array.isArray(dataset.indicators)) return { ok: false, reason: "schema_mismatch" };
  return { ok: true, buf, dataset };
}

// ── Ingest endpoint ─────────────────────────────────────────────────────────
async function handleBroadcast(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Size cap.
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > 1_000_000) { respond(res, 413, { error: "payload too large" }); return; }
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (Buffer.concat(chunks).length > 1_000_000) { respond(res, 413, { error: "payload too large" }); return; }
  }
  const raw = Buffer.concat(chunks);
  let env: EnvelopeV2;
  try { env = JSON.parse(raw.toString("utf8")); } catch { respond(res, 400, { error: "invalid JSON" }); return; }

  // 1. Verify signature (constant-time) — over the exact bodyB64 bytes.
  let body: BroadcastBody;
  try { body = verifyEnvelope(env); }
  catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).includes("HMAC") ? "bad_signature" : "schema_mismatch";
    respond(res, 401, { schemaVersion: 2, broadcastId: env?.bodyB64 ? "?" : "?", decision: "reject", reason });
    return;
  }

  // 2. Schema + freshness.
  const schemaReason = validateBody(body);
  if (schemaReason) {
    respond(res, 422, { schemaVersion: 2, broadcastId: body.broadcastId, decision: "reject", reason: schemaReason });
    return;
  }
  if (!checkFreshness(body.emittedAt)) {
    respond(res, 401, { schemaVersion: 2, broadcastId: body.broadcastId, decision: "reject", reason: "out_of_window" });
    return;
  }

  // 3. Replay dedup (broadcastId is the PK).
  const existing = db.prepare("SELECT 1 FROM daemon_receipt WHERE broadcast_id = ?").get(body.broadcastId);
  if (existing) {
    respond(res, 200, { schemaVersion: 2, broadcastId: body.broadcastId, decision: "reject", reason: "duplicate" });
    return;
  }

  // 4. Pull the dataset + re-check the content hash over exact bytes.
  const pulled = await pullDataset(body.datasetId, body.contentHash);
  if (!pulled.ok) {
    // Record the receipt as a rejection for the audit trail.
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO daemon_receipt (broadcast_id, dataset_id, content_hash, source, target, reference_month, emitted_at, received_at, decision, reason, key_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(body.broadcastId, body.datasetId, body.contentHash, body.source, body.target, body.referenceMonth, body.emittedAt, now, "reject", pulled.reason, env.signature.keyId);
    respond(res, 422, { schemaVersion: 2, broadcastId: body.broadcastId, decision: "reject", reason: pulled.reason as any });
    return;
  }

  // 5. Atomic durable ingest: receipt + dataset + vintages in one transaction.
  const now = new Date().toISOString();
  const tx = db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO daemon_receipt (broadcast_id, dataset_id, content_hash, source, target, reference_month, emitted_at, received_at, decision, reason, key_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(body.broadcastId, body.datasetId, body.contentHash, body.source, body.target, body.referenceMonth, body.emittedAt, now, "accept", null, env.signature.keyId);
    db.prepare(
      "INSERT OR IGNORE INTO indicator_dataset (dataset_id, source, target, reference_month, release_date, as_of, content_hash, payload_json, received_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(body.datasetId, body.source, body.target, body.referenceMonth, pulled.dataset.releaseDate ?? "", pulled.dataset.asOf ?? now, body.contentHash, pulled.buf.toString("utf8"), now);
    const vstmt = db.prepare(
      "INSERT OR REPLACE INTO indicator_vintage (dataset_id, series_id, reference_month, fetched_at, source_hash, is_preliminary) VALUES (?,?,?,?,?,?)"
    );
    const hstmt = db.prepare(
      "INSERT OR REPLACE INTO indicator_history (series_id, date, value, is_preliminary, observed_at) VALUES (?,?,?,?,?)"
    );
    for (const ind of pulled.dataset.indicators ?? []) {
      vstmt.run(body.datasetId, ind.seriesId, body.referenceMonth, pulled.dataset.provenance?.fetchedAt ?? now, pulled.dataset.provenance?.sourceHash ?? "", ind.isPreliminary ? 1 : 0);
      for (const obs of ind.observations ?? []) {
        // Normalize to YYYY-MM. indicator_history is keyed (series_id, date) and
        // is written by THREE paths (this broadcast ingest, /refresh/bootstrap, and
        // the CSV backbone bridge). If they disagree on date format the PK doesn't
        // collide and months duplicate. YYYY-MM is the canonical key — enforce it
        // here at the DB boundary so no caller's format can leak through.
        hstmt.run(ind.seriesId, String(obs.date).slice(0, 7), obs.value, obs.isPreliminary ? 1 : 0, now);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    respond(res, 500, { schemaVersion: 2, broadcastId: body.broadcastId, decision: "reject", reason: "storage_error" });
    return;
  }

  console.log(`[refresh-daemon] INGESTED broadcast=${body.broadcastId} dataset=${body.datasetId} target=${body.target} month=${body.referenceMonth}`);

  // 6. Enqueue a refresh job (P1 planner). P0: just record the job as waiting.
  enqueueRefreshJob(body);

  respond(res, 200, { schemaVersion: 2, broadcastId: body.broadcastId, decision: "accept", reason: null });
}

/** P1 hook: build the input fingerprint and enqueue one job per CONSUMING
 *  contract. A single M3-shipments broadcast feeds the STL, SARIMA, and
 *  productivity contracts — this is a dependency graph, not a 1:1 callback
 *  (glm design §2.10). Each contract gets its own job keyed by (contract,
 *  fingerprint) so they refresh independently. */
function enqueueRefreshJob(body: BroadcastBody): void {
  const fp = body.contentHash;
  const now = new Date().toISOString();
  const contracts = loadContracts();
  let n = 0;
  for (const c of contracts) {
    // A contract consumes this broadcast if any of its required series are in
    // the broadcast's seriesIncluded. (Full readiness — all required series
    // present across the accumulated history — is checked by the runner.)
    const consumes = c.requiredSeries.some((s: string) => body.seriesIncluded.includes(s));
    if (!consumes) continue;
    try {
      db.prepare(
        "INSERT OR IGNORE INTO refresh_job (id, contract_id, target, reference_month, input_fingerprint, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(`job-${c.contractId}-${body.datasetId}`, c.contractId, body.target, body.referenceMonth, fp, "waiting-inputs", now, now);
      n++;
    } catch (err) { console.error("[refresh-daemon] enqueue job failed:", err instanceof Error ? err.message : String(err)); }
  }
  if (n) console.log(`[refresh-daemon] enqueued ${n} refresh job(s) for broadcast ${body.broadcastId}`);
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    respond(res, 200, { ok: true } as any);
    return;
  }
  if (req.method === "POST" && (url.pathname === "/ui/api/daemon/broadcast" || url.pathname === "/broadcast")) {
    handleBroadcast(req, res);
    return;
  }
  // ── React-facing read endpoints (P3 consumes these at boot over HTTP, not a
  //    shared-filesystem dir scan). The React host is a separate process/service.
  if (req.method === "GET" && url.pathname === "/refresh/results") {
    // List all signed refresh results across subjects/months.
    const out: any[] = [];
    const subjects = listResultDirs();
    for (const subjectId of subjects) {
      for (const month of listResultDirs(subjectId)) {
        const p = path.join(RESULTS_DIR, subjectId, month, "refresh_result.json");
        if (fs.existsSync(p)) {
          const r = JSON.parse(fs.readFileSync(p, "utf8"));
          out.push({ subjectId, referenceMonth: r.referenceMonth, target: r.target, point: r.point, outputHash: r.outputHash, signature: r.signature });
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: out }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/refresh/result") {
    const subjectId = url.searchParams.get("subjectId") ?? "";
    const month = url.searchParams.get("month") ?? "";
    const p = path.join(RESULTS_DIR, subjectId, month, "refresh_result.json");
    if (!subjectId || !month || !fs.existsSync(p)) { res.writeHead(404); res.end(JSON.stringify({ error: "not found" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fs.readFileSync(p, "utf8"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/refresh/prior-state") {
    // The self-contained YTD history for a subject's series (read from the
    // target's OWN indicator_history table, not the React host's CSVs).
    const subjectId = url.searchParams.get("subjectId") ?? "";
    const series = url.searchParams.getAll("series");
    const out: Record<string, any[]> = {};
    for (const s of series) {
      out[s] = db.prepare("SELECT date, value, is_preliminary FROM indicator_history WHERE series_id = ? ORDER BY date ASC").all(s);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ subjectId, history: out }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/refresh/run") {
    // On-demand refresh: enqueue jobs for contracts whose required series are
    // present in indicator_history, keyed by a deterministic synthetic dataset
    // built from the history tail. Same history → same content hash → INSERT OR
    // IGNORE dedups (rerun-on-change only). This is the interactive path's
    // trigger (the orchestrator's run_refresh tool); broadcasts remain the
    // unattended path. HMAC-authed like /refresh/bootstrap.
    return handleRefreshRun(req, res);
  }
  if (req.method === "GET" && url.pathname === "/refresh/jobs") {
    const rows = db.prepare("SELECT id, contract_id, reference_month, state, created_at, updated_at FROM refresh_job ORDER BY updated_at DESC LIMIT 50").all();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobs: rows }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/refresh/bootstrap") {
    // One-time seed of pre-broadcast history so the target is self-contained
    // on a fresh deploy (the gitignored data/*.csv do not ship in the image).
    // Body: { "series": [{ "seriesId": "...", "observations": [{date,value}] }] }.
    // Auth-gated by the same HMAC key (caller signs the body). P2 will wire this
    // to pull full history from the source daemon automatically.
    return handleBootstrap(req, res);
  }
  if (req.method === "POST" && url.pathname === "/refresh/export-panel") {
    // Deterministic panel export for the interactive persona (the azure
    // orchestrator's read_indicator_panel tool). HMAC-authed like
    // /refresh/bootstrap — full-history exports are NOT open routes.
    // Body: { subject?: string; series: string[] }. Read-only; deterministic
    // ordering + content hash for provenance.
    return handleExportPanel(req, res);
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

/** POST /refresh/run — see route comment. Body: { contractId?, referenceMonth? }. */
async function handleRefreshRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const provided = req.headers["x-daemon-sig"] as string | undefined;
  if (!provided || !constantTimeHexEqualStr(hmacSign(raw.toString("utf8")), provided)) {
    res.writeHead(401); res.end(JSON.stringify({ error: "bad run sig" })); return;
  }
  let body: any; try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { res.writeHead(400); res.end(JSON.stringify({ error: "bad json" })); return; }
  const now = new Date().toISOString();
  const contracts = loadContracts().filter((c) => !body.contractId || c.contractId === body.contractId);
  const outcomes: any[] = [];
  for (const c of contracts) {
    // Readiness: every required series has at least one observation.
    const missing = c.requiredSeries.filter((s: string) => !db.prepare("SELECT 1 FROM indicator_history WHERE series_id = ? LIMIT 1").get(s));
    if (missing.length) { outcomes.push({ contractId: c.contractId, enqueued: false, reason: `series missing from history: ${missing.join(", ")}` }); continue; }
    // Reference month: the latest month common to all required series (so the
    // skill's broadcast-append is a no-op and it forecasts the FOLLOWING month).
    let refMonth = body.referenceMonth as string | undefined;
    if (!refMonth) {
      const maxes = c.requiredSeries.map((s: string) => (db.prepare("SELECT MAX(date) m FROM indicator_history WHERE series_id = ?").get(s) as any)?.m as string);
      refMonth = maxes.sort()[0];
    }
    // Deterministic synthetic dataset from the history tail at refMonth.
    const indicators = c.requiredSeries.map((s: string) => {
      const row = db.prepare("SELECT value FROM indicator_history WHERE series_id = ? AND date = ?").get(s, refMonth) as any;
      return { seriesId: s, observations: [{ date: refMonth, value: row?.value ?? 0 }] };
    });
    // NO volatile fields (timestamps) in the hashed payload — the content hash
    // must be a pure function of the history state so re-runs dedup.
    const dataset: any = {
      schemaVersion: 1, datasetId: "", referenceMonth: refMonth, target: c.target, source: "ondemand",
      releaseDate: "", asOf: refMonth, indicators,
      provenance: { fetchedAt: "", sourceHost: "indicator_history", sourceHash: "" },
    };
    const contentHash = sha256Hex(Buffer.from(JSON.stringify(dataset)));
    dataset.datasetId = `ds-ondemand-${contentHash.slice(0, 12)}`;
    db.prepare(
      "INSERT OR IGNORE INTO indicator_dataset (dataset_id, source, target, reference_month, release_date, as_of, content_hash, payload_json, received_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(dataset.datasetId, "ondemand", c.target, refMonth, "", now, contentHash, JSON.stringify(dataset), now);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO refresh_job (id, contract_id, target, reference_month, input_fingerprint, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(`job-${c.contractId}-${dataset.datasetId}`, c.contractId, c.target, refMonth, contentHash, "waiting-inputs", now, now);
    outcomes.push({ contractId: c.contractId, enqueued: ins.changes > 0, datasetId: dataset.datasetId, referenceMonth: refMonth, reason: ins.changes > 0 ? null : "already ran for this history state" });
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, results: outcomes }));
}

function listResultDirs(sub?: string): string[] {
  const base = sub ? path.join(RESULTS_DIR, sub) : RESULTS_DIR;
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

async function handleBootstrap(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  // HMAC auth over the raw body (same key as broadcast).
  const provided = req.headers["x-daemon-sig"] as string | undefined;
  if (!provided || !constantTimeHexEqualStr(hmacSign(raw.toString("utf8")), provided)) {
    res.writeHead(401); res.end(JSON.stringify({ error: "bad bootstrap sig" })); return;
  }
  let body: any; try { body = JSON.parse(raw.toString("utf8")); } catch { res.writeHead(400); res.end(JSON.stringify({ error: "bad json" })); return; }
  const now = new Date().toISOString();
  const hstmt = db.prepare("INSERT OR REPLACE INTO indicator_history (series_id, date, value, is_preliminary, observed_at) VALUES (?,?,?,?,?)");
  let n = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of body.series ?? []) {
      // Normalize to YYYY-MM at the DB boundary (see broadcast-ingest note) so the
      // (series_id, date) key is canonical regardless of what the caller sends.
      for (const o of s.observations ?? []) { hstmt.run(s.seriesId, String(o.date).slice(0, 7), o.value, o.isPreliminary ? 1 : 0, now); n++; }
    }
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); res.writeHead(500); res.end(JSON.stringify({ error: "storage_error" })); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, seeded: n }));
}

/** POST /refresh/export-panel — see route comment. Body: { subject?, series[] }. */
async function handleExportPanel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const provided = req.headers["x-daemon-sig"] as string | undefined;
  if (!provided || !constantTimeHexEqualStr(hmacSign(raw.toString("utf8")), provided)) {
    res.writeHead(401); res.end(JSON.stringify({ error: "bad export sig" })); return;
  }
  let body: any;
  try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { res.writeHead(400); res.end(JSON.stringify({ error: "bad json" })); return; }
  const series: string[] = Array.isArray(body.series) ? body.series.map(String) : [];
  if (series.length === 0) {
    res.writeHead(400); res.end(JSON.stringify({ error: "series required" })); return;
  }
  const stmt = db.prepare("SELECT date, value, is_preliminary FROM indicator_history WHERE series_id = ? ORDER BY date ASC");
  const rows = series.map((s) => ({ seriesId: s, observations: stmt.all(s) }));
  // Deterministic content hash over canonical rows — provenance handle.
  const panelHash = sha256Hex(Buffer.from(JSON.stringify(rows)));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ subjectId: body.subject ?? null, series, rows, panelHash }));
}

function constantTimeHexEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[refresh-daemon] listening on http://0.0.0.0:${PORT}`);
  console.log(`[refresh-daemon] ingest: POST /ui/api/daemon/broadcast | reads: GET /refresh/results,/result,/prior-state | seed: POST /refresh/bootstrap`);
  console.log(`[refresh-daemon] source daemon: ${DAEMON_URL}`);
});

// P1: start the job runner (broker + Oracle) for waiting jobs.
startJobRunner().catch((err) => console.error("[refresh-daemon] job runner failed:", err));

// ── P1: job runner (4-verb airlock + Oracle) — stubbed for the compute verb ──
async function startJobRunner(): Promise<void> {
  // Poll for waiting jobs and drive each through the Oracle. In P1 the real
  // frozen skills (P2) are not yet packaged, so run_nowcast_skill runs a
  // placeholder. read_indicator_dataset / read_prior_forecast /
  // write_forecast_artifact are real.
  // (Implemented in src/refresh/broker.ts; invoked here.)
  const { runWaitingJobs } = await import("./refresh/broker.js");
  setInterval(() => { runWaitingJobs(db, DAEMON_URL).catch(() => {}); }, 10_000);
}
