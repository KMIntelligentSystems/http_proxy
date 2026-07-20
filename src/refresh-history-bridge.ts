/**
 * Refresh History Bridge — the deterministic artifacts.db → refresh.db path.
 *
 * Reads the validated backbone index CSVs persisted in artifacts.db (written by
 * the ONE sanctioned writer, scripts/load-index-csvs.mjs) and pushes them to
 * the refresh-daemon's /refresh/bootstrap endpoint (HMAC-authed), which upserts
 * into indicator_history keyed on (series_id, date).
 *
 * WHY THIS MODULE EXISTS
 * The architecture forbids the refresh-daemon from touching artifacts.db
 * (human-write-only invariant). The host MAY read it and push — this module is
 * that push, mirroring the daemon-tools.ts mirrorIndicatorsToHistory pattern.
 *
 * DETERMINISM GUARANTEES
 * - Reads `artifact_latest` (head-of-chain, NO role/mime exclusions) — never
 *   `v_artifact_head`, which deliberately hides dataset-csv rows from the UI.
 * - Closed allowlist: only seriesIds in data/series-map.json are eligible.
 * - Dates are normalized to YYYY-MM (the broadcast key format) BEFORE posting,
 *   so a CSV-sourced month and a broadcast-sourced month collide on the same
 *   (series_id, date) upsert key instead of coexisting as duplicates.
 * - Idempotent by construction: the daemon's INSERT OR REPLACE converges to
 *   the same state no matter how many times the same content is pushed.
 *
 * TRIGGER POINTS
 *   1. host boot (seed-on-start; best-effort — never blocks or crashes the host)
 *   2. POST /ui/api/artifacts/<id>/save when the saved artifact is a dataset CSV
 *   3. the `sync_indicator_history` agent tool (web-main.ts)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.resolve(process.cwd(), "data");
const ARTIFACTS_DB = path.join(DATA_DIR, "artifacts.db");
const SERIES_MAP_PATH = path.join(DATA_DIR, "series-map.json");
const REFRESH_DAEMON_URL = process.env["REFRESH_DAEMON_URL"] ?? "http://127.0.0.1:8792";
const HMAC_KEY = process.env["DAEMON_HMAC_KEY"] ?? "dev-insecure-hmac-key-change-me";

function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
}

export interface SeriesSyncEntry {
  seriesId: string;
  status: "sent" | "would-send" | "missing" | "invalid";
  artifactId?: string;
  observations?: number;
  range?: [string, string];
  warning?: string;
  error?: string;
}

export interface SyncReport {
  ok: boolean;
  dryRun: boolean;
  reason: string;
  daemonUrl: string;
  series: SeriesSyncEntry[];
  daemon?: { httpStatus?: number; seeded?: number; error?: string };
}

interface SeriesMap {
  series: Record<string, { canonicalFile: string; header: string; valueRange: [number, number]; minObs: number }>;
}

export function loadSeriesMap(): SeriesMap {
  return JSON.parse(fs.readFileSync(SERIES_MAP_PATH, "utf-8")) as SeriesMap;
}

/** Strict re-validation (defense in depth — the writer validated at load, but
 *  the bridge is the last gate before the refresh target). Normalizes dates to
 *  YYYY-MM (see header). Returns null + errors when invalid. */
function parseBackboneCsv(
  seriesId: string,
  spec: SeriesMap["series"][string],
  content: string,
): { observations: { date: string; value: number }[]; errors: string[] } {
  const errors: string[] = [];
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) errors.push(`${seriesId}: <2 lines`);
  else if (lines[0].trim() !== spec.header) errors.push(`${seriesId}: header "${lines[0]}" != "${spec.header}"`);
  const seen = new Set<string>();
  const observations: { date: string; value: number }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length !== 2) { errors.push(`${seriesId}:${i + 1}: ${cols.length} columns`); continue; }
    const ds = cols[0].trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(ds)) { errors.push(`${seriesId}:${i + 1}: bad date "${ds}"`); continue; }
    const month = ds.slice(0, 7); // ← the YYYY-MM normalization
    if (seen.has(month)) { errors.push(`${seriesId}:${i + 1}: duplicate month ${month}`); continue; }
    seen.add(month);
    const v = Number(cols[1].trim());
    if (!Number.isFinite(v)) { errors.push(`${seriesId}:${i + 1}: non-numeric "${cols[1]}"`); continue; }
    if (v < spec.valueRange[0] || v > spec.valueRange[1]) { errors.push(`${seriesId}:${i + 1}: ${v} outside [${spec.valueRange}]`); continue; }
    observations.push({ date: month, value: v });
  }
  if (observations.length < spec.minObs) errors.push(`${seriesId}: ${observations.length} obs < minObs ${spec.minObs}`);
  observations.sort((a, b) => a.date.localeCompare(b.date));
  return { observations, errors };
}

/** Pull the head-of-chain dataset-csv row for one seriesId from artifacts.db. */
function readBackboneRow(seriesId: string): { id: string; content: string; warning?: string } | null {
  if (!fs.existsSync(ARTIFACTS_DB)) return null;
  const db = new DatabaseSync(ARTIFACTS_DB, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT a.id, a.content, a.created_at FROM artifact a
       LEFT JOIN artifact b ON b.replaces_id = a.id
       WHERE b.id IS NULL AND a.role = 'dataset-csv' AND a.tags LIKE ?
       ORDER BY a.created_at DESC`
    ).all(`%"${seriesId}"%`) as { id: string; content: string; created_at: string }[];
    if (rows.length === 0) return null;
    const warning = rows.length > 1
      ? `${rows.length} heads carry the "${seriesId}" tag — using the newest (${rows[0].id}); curate the others`
      : undefined;
    return { id: rows[0].id, content: rows[0].content, warning };
  } finally {
    db.close();
  }
}

/** Read one backbone series' observations from artifacts.db (validated,
 *  YYYY-MM-normalized). Returns null when the series isn't in the map or has
 *  no persisted head. Shared by the bridge and by flow-1 stat tools
 *  (run_sarima) that fit against backbone data. */
export function readBackboneObservations(
  seriesId: string,
): { observations: { date: string; value: number }[]; artifactId: string; range: [string, string] } | null {
  let map: SeriesMap;
  try { map = loadSeriesMap(); } catch { return null; }
  const spec = map.series[seriesId];
  if (!spec) return null;
  const row = readBackboneRow(seriesId);
  if (!row) return null;
  const parsed = parseBackboneCsv(seriesId, spec, row.content);
  if (parsed.errors.length || parsed.observations.length === 0) return null;
  const obs = parsed.observations;
  return { observations: obs, artifactId: row.id, range: [obs[0].date, obs[obs.length - 1].date] };
}

/**
 * The one sync entry point. dryRun builds and reports without POSTing.
 * Never throws — failures land in the report (the host hooks are best-effort).
 */
export async function syncIndicatorHistory(opts: { dryRun?: boolean; reason?: string } = {}): Promise<SyncReport> {
  const report: SyncReport = {
    ok: true,
    dryRun: opts.dryRun ?? false,
    reason: opts.reason ?? "manual",
    daemonUrl: REFRESH_DAEMON_URL,
    series: [],
  };
  let map: SeriesMap;
  try {
    map = loadSeriesMap();
  } catch (err) {
    report.ok = false;
    report.daemon = { error: `series-map unreadable: ${err instanceof Error ? err.message : String(err)}` };
    return report;
  }

  const payloadSeries: { seriesId: string; observations: { date: string; value: number }[] }[] = [];
  for (const [seriesId, spec] of Object.entries(map.series)) {
    const row = readBackboneRow(seriesId);
    if (!row) {
      report.series.push({ seriesId, status: "missing", error: "no dataset-csv head in artifacts.db — run scripts/load-index-csvs.mjs" });
      continue;
    }
    const parsed = parseBackboneCsv(seriesId, spec, row.content);
    const base = {
      seriesId,
      artifactId: row.id,
      observations: parsed.observations.length,
      ...(parsed.observations.length ? { range: [parsed.observations[0].date, parsed.observations[parsed.observations.length - 1].date] as [string, string] } : {}),
      ...(row.warning ? { warning: row.warning } : {}),
    };
    if (parsed.errors.length) {
      report.ok = false;
      report.series.push({ ...base, status: "invalid", error: parsed.errors.slice(0, 5).join("; ") });
      continue;
    }
    report.series.push({ ...base, status: report.dryRun ? "would-send" : "sent" });
    payloadSeries.push({ seriesId, observations: parsed.observations });
  }

  // A series that fails validation is NOT posted (closed surface); the rest go.
  if (report.dryRun) return report;

  const body = JSON.stringify({ series: payloadSeries });
  try {
    const resp = await fetch(`${REFRESH_DAEMON_URL}/refresh/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Daemon-Sig": hmacSign(body) },
      body,
    });
    const json = (await resp.json().catch(() => ({}))) as { seeded?: number; error?: string };
    report.daemon = { httpStatus: resp.status, seeded: json.seeded, ...(json.error ? { error: json.error } : {}) };
    if (!resp.ok) report.ok = false;
  } catch (err) {
    report.ok = false;
    report.daemon = { error: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  return report;
}
