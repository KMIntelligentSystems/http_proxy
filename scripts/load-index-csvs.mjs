/**
 * load-index-csvs.mjs — validating, idempotent, versioned loader for the
 * backbone index CSVs into artifacts.db.
 *
 * WHY THIS EXISTS
 * The refresh-daemon's indicator_history needs a durable backbone (2002→present)
 * that survives deploys. data/*.csv is gitignored (not shipped to Railway), so
 * artifacts.db is the durable home. This script is the ONE deterministic write
 * path for those files. The downstream bridge (artifacts.db → /refresh/bootstrap)
 * reads what this script writes, via the artifact_latest view — NOT
 * v_artifact_head, which deliberately hides dataset-csv rows from the UI.
 *
 * GUARANTEES
 * - Byte-exact storage: content is the raw file text; sha256 covers raw bytes.
 * - Strict validation, fail-loud: header, row shape, date/value formats,
 *   duplicates, sort order, finite values, domain value-range, min obs, size cap.
 *   A failed file aborts the whole run non-zero (never a partial silent load).
 * - Idempotent: head content-hash equal → skip. Changed → INSERT a new version
 *   with replaces_id → prior head (audit chain; never UPDATE in place).
 * - Guard-by-construction: role 'dataset-csv' + mime 'text/csv' EXACTLY, which
 *   v_artifact_head and buildCatalog() exclude — persisted CSVs are invisible
 *   in the React sidebar/catalog by schema, not by convention.
 *
 * USAGE
 *   node scripts/load-index-csvs.mjs            # validate + load (idempotent)
 *   node scripts/load-index-csvs.mjs --dry-run  # validate + report only
 *
 * Exit 0 = all series loaded/skipped cleanly. Exit 1 = validation or DB failure.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DRY_RUN = process.argv.includes("--dry-run");
const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "artifacts.db");
const MAP_PATH = path.join(DATA_DIR, "series-map.json");
const MAX_BYTES = 1_000_000; // sanity cap — backbone index series are ~5-8KB

const CATEGORY = { id: "cat-econ-001", name: "Economics" };
const SUBJECT = { id: "sub-indicator-backbone", name: "Indicator Backbone Series" };
const SESSION_ID = "bootstrap-loader"; // reserved session, mirrors the "catalog" pattern

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const artifactId = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

// ── Validation ──────────────────────────────────────────────────────────────
const DATE_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

function validateCsv(seriesId, spec, raw) {
  const errors = [];
  const warnings = [];
  // Strip a UTF-8 BOM for PARSING only — the stored content stays byte-exact.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) errors.push(`${seriesId}: file has <2 lines`);
  if (lines[0].trim() !== spec.header) {
    errors.push(`${seriesId}: header must be exactly "${spec.header}", got "${lines[0]}"`);
  }
  const seen = new Set();
  let prevKey = null;
  let firstDate = null;
  let lastDate = null;
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const cols = line.split(",");
    if (cols.length !== 2) { errors.push(`${seriesId}:${i + 1}: expected 2 columns, got ${cols.length}`); continue; }
    const [ds, vs] = cols.map((c) => c.trim());
    const dm = DATE_RE.exec(ds);
    if (!dm) { errors.push(`${seriesId}:${i + 1}: bad date "${ds}"`); continue; }
    const month = Number(dm[2]);
    if (month < 1 || month > 12) { errors.push(`${seriesId}:${i + 1}: month out of range in "${ds}"`); continue; }
    const key = ds.slice(0, 7);
    if (seen.has(key)) { errors.push(`${seriesId}:${i + 1}: duplicate month ${key}`); continue; }
    seen.add(key);
    if (prevKey && key <= prevKey) errors.push(`${seriesId}:${i + 1}: dates not strictly ascending at ${key}`);
    prevKey = key;
    if (vs === "" || !Number.isFinite(Number(vs))) { errors.push(`${seriesId}:${i + 1}: non-numeric value "${vs}"`); continue; }
    const v = Number(vs);
    if (v < spec.valueRange[0] || v > spec.valueRange[1]) {
      errors.push(`${seriesId}:${i + 1}: value ${v} outside domain range [${spec.valueRange}] (${key})`);
      continue;
    }
    firstDate ??= ds;
    lastDate = ds;
    n++;
  }
  if (n < spec.minObs) errors.push(`${seriesId}: only ${n} valid obs (< minObs ${spec.minObs})`);
  // Cadence gap check (warn-only — a late series start is legitimate).
  if (firstDate && lastDate && n > 1) {
    const [fy, fm] = firstDate.slice(0, 7).split("-").map(Number);
    const [ly, lm] = lastDate.slice(0, 7).split("-").map(Number);
    const expected = (ly - fy) * 12 + (lm - fm) + 1;
    if (expected !== n) warnings.push(`${seriesId}: ${expected - n} interior month gap(s) between ${firstDate} and ${lastDate}`);
  }
  return { errors, warnings, obs: n, firstDate, lastDate };
}

// ── Main ────────────────────────────────────────────────────────────────────
const map = JSON.parse(fs.readFileSync(MAP_PATH, "utf-8"));
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

const now = new Date().toISOString();
const results = [];
let failed = false;

for (const [seriesId, spec] of Object.entries(map.series)) {
  const filePath = path.join(DATA_DIR, spec.canonicalFile);
  if (!fs.existsSync(filePath)) {
    console.error(`✗ ${seriesId}: canonical file missing: ${spec.canonicalFile}`);
    failed = true;
    continue;
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length > MAX_BYTES) {
    console.error(`✗ ${seriesId}: ${buf.length} bytes exceeds the ${MAX_BYTES}-byte backbone cap`);
    failed = true;
    continue;
  }
  const raw = buf.toString("utf-8");
  const v = validateCsv(seriesId, spec, raw);
  for (const w of v.warnings) console.warn(`  ! ${w}`);
  if (v.errors.length) {
    for (const e of v.errors) console.error(`✗ ${e}`);
    failed = true;
    continue;
  }
  const hash = sha256(buf);

  // Head-of-chain for THIS series (artifact_latest has no role/mime exclusions —
  // v_artifact_head would hide these rows by design). Match on the seriesId tag.
  const head = db.prepare(
    `SELECT a.id, a.provenance FROM artifact a
     LEFT JOIN artifact b ON b.replaces_id = a.id
     WHERE b.id IS NULL AND a.role = 'dataset-csv' AND a.tags LIKE ?`
  ).all(`%"${seriesId}"%`)[0];
  const headHash = head ? (JSON.parse(head.provenance)?.sha256 ?? null) : null;

  if (head && headHash === hash) {
    results.push({ seriesId, file: spec.canonicalFile, obs: v.obs, range: `${v.firstDate} → ${v.lastDate}`, action: "skipped (unchanged)", id: head.id });
    continue;
  }

  const id = artifactId();
  const description = `${v.obs} monthly obs, ${v.firstDate} → ${v.lastDate}. ${spec.units}; ${spec.seasonalAdjustment}. Backbone history for refresh.db indicator_history. Hidden from the catalog by the dataset-csv/text-csv guard.`;
  const provenance = JSON.stringify({
    loader: "scripts/load-index-csvs.mjs",
    canonicalFile: spec.canonicalFile,
    sha256: hash,
    source: spec.source,
    units: spec.units,
    seasonalAdjustment: spec.seasonalAdjustment,
    observations: v.obs,
    range: [v.firstDate, v.lastDate],
    loadedAt: now,
  });
  const tags = JSON.stringify(["dataset-csv", "backbone", "refresh-input", seriesId, spec.source.split(" ")[0].toLowerCase()]);

  if (!DRY_RUN) {
    db.prepare("INSERT OR IGNORE INTO category (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(CATEGORY.id, CATEGORY.name, now, now);
    db.prepare("INSERT OR IGNORE INTO subject (id, category_id, name, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(SUBJECT.id, CATEGORY.id, SUBJECT.name, JSON.stringify(["backbone", "refresh-input"]), now, now);
    db.prepare("INSERT OR IGNORE INTO session (id, subject_id, model_id, user_id, title, started_at, prompt_count) VALUES (?, ?, NULL, NULL, ?, ?, 0)")
      .run(SESSION_ID, SUBJECT.id, "Backbone index CSV loads", now);
    db.prepare(
      `INSERT INTO artifact
         (id, session_id, title, filename, mime_type, role, description, content,
          size_bytes, created_at, updated_at, replaces_id, provenance, tags)
       VALUES (?, ?, ?, ?, 'text/csv', 'dataset-csv', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, SESSION_ID,
      `${seriesId} — Backbone History (${v.firstDate.slice(0, 7)}–${v.lastDate.slice(0, 7)})`,
      spec.canonicalFile, description, raw, buf.length, now, now,
      head?.id ?? null, provenance, tags,
    );
  }
  results.push({
    seriesId, file: spec.canonicalFile, obs: v.obs, range: `${v.firstDate} → ${v.lastDate}`,
    action: DRY_RUN ? "would insert (dry-run)" : (head ? `inserted v-new (replaces ${head.id})` : "inserted v1"), id,
  });
}

console.log("\nseries                      file                          obs   range                     action");
console.log("─".repeat(110));
for (const r of results) {
  console.log(`${r.seriesId.padEnd(27)} ${r.file.padEnd(29)} ${String(r.obs).padEnd(5)} ${r.range.padEnd(25)} ${r.action}`);
}
if (failed) { console.error("\n✗ validation failures — nothing was loaded for the failed series"); process.exit(1); }
console.log(DRY_RUN ? "\ndry-run OK — no writes" : "\nOK — artifacts.db backbone load complete");
