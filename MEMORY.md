# Project Memory

Loaded at session start. Non-generic, project-specific operational knowledge:
tool quirks, data file locations, BLS API gotchas, architecture decisions.

## Frontend rendering rules

The React UI (`/ui`, `src/react-app/src/App.tsx`) renders artifacts in an
`<iframe>`. The sidebar is now a **catalog tree** (`CatalogTree.tsx`) reading
from `GET /ui/api/catalog`, not a flat list of `artifact_created` events.

Key properties of the catalog path:

1. **Dedup happens in SQL, not in the React reducer.** Both `buildCatalog()`
   and `query_artifacts` should pivot off the `v_artifact_head` view (head
   of the `replaces_id` chain, with `role IN ('memory','catalog')`
   excluded). The legacy "near-random survivor" title-dedup bug is gone
   provided every read goes through that view.
2. **All roles are visible** in the catalog tree except `memory` and
   `catalog` (which are excluded by the view). CSVs, markdown, JSON,
   manifests, and HTML pages all surface under their bucket.
   **The agent controls what the sidebar shows** via `catalogFilter` —
   the sidebar tree is empty on startup and only populates when the agent
   sets a filter through `query_artifacts` (see AGENTS.md § "Prompt-Driven
   Catalog Filtering"). Without a filter, `buildCatalog()` returns
   `buckets: []`.
3. **The catalog is itself a persisted artifact** (`role: "catalog"`,
   `mimeType: application/json`) with a `replaces_id` chain. Each write
   diffs the structural payload before chaining — routine browse GETs do
   not churn the DB.
4. **The orchestrator maintains a document outline** (`role:
   "document-outline"`, `mimeType: text/markdown`) per active draft. See
   AGENTS.md § "Document outline" for the lifecycle.

**Always use the proxy URL** (`http://localhost:8080/ui/`), not the Vite dev
server at `:5173`. The `/ui/ws/agent` WebSocket requires the `x-loopback: 1`
header that only the proxy injects; via Vite the WS connection is a brittle
4-hop relay.

## Python execution: prefer write+bash over `execute_python`

`execute_python` has two failure modes that make it unreliable for anything beyond
a trivial one-liner:

1. **MCP protocol timeout (60s).** Every `execute_python` call goes through
   `mcporter → MCP SDK`, which enforces `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`
   at the protocol level. Serial API calls or any script running >60s will fail
   with `MCP error -32001: Request timed out`.
2. **`\n` in string literals.** Escaped newlines inside Python strings produce
   `SyntaxError: unterminated string literal`.

**Default: write+bash for everything except one-liners.** Write the script to a
temp file, execute directly, delete. Same Python venv — no MCP timeout, no `\n`
choking:
```bash
"C:\repos\codeGen-mcp-server\venv\Scripts\python.exe" data/_tmp.py && rm data/_tmp.py
```
Keep only the script's *output* (CSV, JSON) — the script itself is ephemeral. **Do not persist Python scripts** to `data/` or a `scripts/` directory. A stale fetch script is worse than useless: it misleads future runs into thinking it still works. When the CSV needs refreshing, write a new script.

## BLS API v2 — OEWS limitation

The BLS time series API v2 does **not** serve multi-year OEWS data. OE series IDs
in all tested formats return "Series does not exist" with 0 data points. Single-year
OEWS data (e.g. May 2024) is available via flat file download.

**Working BLS series patterns:**
- **CES:** State-level uses `SM` (SA) / `SMU` (NSA) prefix. e.g. `SMS48000000000000001`
- **CPS:** `LNS14000000` for national unemployment rate.

**Common FIPS codes:** 48 = Texas, 06 = California, 36 = New York.

## DB-First Data Access (`query_artifacts`)

**Before fetching from external APIs (BLS, FRED, Census, web-search, etc.), ALWAYS query
`data/artifacts.db` first** via the `query_artifacts` tool. Saved artifacts from prior
sessions (charts, CSVs, dataset metadata, document pages) frequently already contain
the data the user is asking for.

**Freshness guard for forecasts, nowcasts, and edge-of-data requests.** When the
task involves a forecast, nowcast, prediction, or the *latest available observation*
(e.g. "what's the most recent M3 figure?"), **do not trust a local CSV or DB artifact
blindly**. Local data snapshots are potentially stale vintages. Before using cached
data for a forward-looking task:

1. Check the artifact's `created_at` or provenance field — is it plausibly current?
2. If the data source publishes on a known schedule (e.g. Census M3 monthly),
   verify whether a newer release has dropped since the artifact was created.
3. When in doubt, **re-fetch a single recent observation from the live API**
   and compare against the cached value. If they differ, refresh the local data.

This guard prevented the April 2026 M3 staleness bug: the agent checked the local
CSV, found rows through March 2026, assumed April was unavailable, and never hit
`api.census.gov` — which *did* have April data.

The tool takes a single `sql` string (SELECT-only). It runs the query, then for each
matching row that has `content` + a renderable `mime_type`, it surfaces the row to the
user's Documents panel via `artifactStore.create()` (Save / Discard buttons appear).
**Do not also call `create_artifact` for rows surfaced this way** — the tool already
pushes them to the frontend.

### Schema

```
artifact(id, session_id, title, filename, mime_type, role, description,
         content, size_bytes, created_at, updated_at, model_id, replaces_id,
         provenance, tags)
session(id, subject_id, model_id, title, started_at, ended_at, prompt_count, created_at)
subject(id, category_id, name, description, tags, created_at, updated_at)
category(id, name, description, created_at, updated_at)
model(id, provider, display_name, created_at)
```

- `tags` is a JSON array stored as TEXT. For tag containment use `LIKE`:
  `tags LIKE '%"m3"%' AND tags LIKE '%"nsa"%'`.
- `provenance` is a JSON object stored as TEXT.
- `role` examples: `chart`, `dataset-csv`, `dataset-meta`, `section`, `page`,
  `document-manifest`, `memory`.
- `mime_type` values that render in the Documents iframe: `text/html`, `text/csv`,
  `text/markdown`, `application/json`, `image/svg+xml`.

### Rules for the SELECT

- Include at minimum: `id`, `title`, `filename`, `mime_type`, `content`.
- Recommended: `SELECT id, title, filename, mime_type, role, description, content, tags FROM artifact WHERE … ORDER BY created_at DESC`.
- Only `SELECT` is permitted. Any other statement is rejected.
- To inspect categories or subjects with `query_artifacts`, alias fields into the artifact-shaped columns the tool expects, e.g.:

```sql
SELECT id, name AS title, 'category.txt' AS filename,
       'text/plain' AS mime_type, description AS content
FROM category
ORDER BY name;
```

```sql
SELECT id, name AS title, 'subject.txt' AS filename,
       'text/plain' AS mime_type, description AS content, category_id
FROM subject
ORDER BY name;
```

### Recommended SELECT pattern (use `v_artifact_head`)

The canonical user-facing read pivots off the `v_artifact_head` view. It
gives you head-of-`replaces_id`-chain rows with `role IN ('memory',
'catalog')` already excluded — the same dedup the sidebar tree applies, so
the agent and the UI cannot disagree about the corpus.

```sql
SELECT id, title, filename, mime_type, role, description, content, tags
FROM v_artifact_head
WHERE tags LIKE '%"m3"%' AND tags LIKE '%"nsa"%'
ORDER BY created_at DESC;
```

Use `artifact_latest` (head-of-chain, no role exclusion) only when you need
to inspect `memory` or `catalog` rows directly. Use the raw `artifact`
table only when version history matters.

The view is created lazily on first DB open by `ArtifactStore.openDb()`;
older DBs upgrade automatically.

If the query returns 0 rows (or only rows that don't actually answer the question),
then and only then fall back to external APIs / web-search and write the result
with `create_artifact`.

### Concept-filtered SELECTs

Before running `query_artifacts`, extract concepts from the user prompt
and build targeted WHERE clauses. **Always pass `catalogFilter`** so the
sidebar catalog tree shows only matching entries:

**By dataset tag:**
```sql
SELECT id, title, filename, mime_type, role, description, content, tags
FROM v_artifact_head
WHERE tags LIKE '%"m3"%'
ORDER BY created_at DESC;
```
Pass: `catalogFilter: { tags: ["m3"] }`

**By category + role:**
```sql
SELECT a.id, a.title, a.filename, a.mime_type, a.role, a.description, a.content, a.tags
FROM v_artifact_head a
JOIN session s ON s.id = a.session_id
JOIN subject sub ON sub.id = s.subject_id
JOIN category c ON c.id = sub.category_id
WHERE c.name = 'Economics' AND a.role = 'chart'
ORDER BY a.created_at DESC;
```

**Multi-concept (AND logic):**
```sql
SELECT id, title, filename, mime_type, role, description, content, tags
FROM v_artifact_head
WHERE tags LIKE '%"m3"%' AND tags LIKE '%"nsa"%'
ORDER BY created_at DESC;
```

**Multi-concept (OR logic — related topics):**
```sql
WHERE tags LIKE '%"m3"%' OR tags LIKE '%"fred"%' OR tags LIKE '%"ipi"%'
```

If the concept mapping is ambiguous, ask the user to clarify before
running broad queries.

### Category / subject registry

The DB has a durable taxonomy layer:

```
category(id, name, description, created_at, updated_at)
subject(id, category_id, name, description, tags, created_at, updated_at)
session(id, subject_id, ...)
artifact(session_id, ...)
```

Current known registry state:

| Category | Subjects |
|----------|----------|
| Economics | `M3 Manufacturing Shipments`; `M3 Series Inventory` |

Operational rules:

1. **DB-first includes taxonomy.** For domain-specific requests, inspect
   `category` and `subject` before assuming the task belongs to Economics.
2. **Missing category.** If the user asks for a domain not in `category`
   (e.g. Psychology), ask whether to create/use that category before producing
   durable artifacts organized under it.
3. **Missing subject.** If the category exists but the dataset/study/survey does
   not, propose a concise subject name and ask for confirmation when the name
   affects future retrieval.
4. **Ambiguous domain.** Some topics cross categories (e.g. labor stress could be
   Economics, Psychology, or Public Health). Ask the user to choose the primary
   category when classification affects source choice, methods, or persistence.
5. **Artifacts still need tags.** Category/subject is not a substitute for tags
   like `"m3"`, `"nsa"`, `"x13"`, `"psychometrics"`, or source-specific codes.
6. **Skills remain method-level.** Add domain-specific statistical techniques as
   `.pi/skills/<method>/SKILL.md`; do not encode methods in category names.

Candidate future categories include Psychology, Public Health, Education,
Climate, Finance, Demography, and Sociology. Candidate Psychology subjects might
include `Cognitive Test Scores`, `Longitudinal Wellbeing Survey`,
`Psychometric Scale Validation`, or a named study/survey.

### Title hygiene

Every `text/html` artifact — whether created via `create_artifact` or persisted
in the DB — MUST have a globally unique, role-distinguishing title. Pattern:

  `"<dataset> - <view type> (<qualifier>)"`

Examples:
- `"M3 NSA Survey - Total Manufacturing Shipments (Monthly Line Chart)"`
- `"M3 NSA Survey - Series Inventory (codes, SA/NSA sources, caveats)"`
- `"M3 NSA Survey - Annual Totals Table"`

Bad: three rows all titled `"Total Manufacturing Shipments — NSA (Jan 2002 – Mar 2026)"`.
The sidebar will hide two of them and surface a near-random survivor.

### Agent clarification round-trip (`ask_user`)

The app supports a UI-backed clarification tool:

1. Agent calls `ask_user` with `prompt`, optional `choices`, optional
   `defaultChoice`, optional `timeoutMs`, and optional `allowFreeText`.
2. The host creates a pending question ID and broadcasts `user_question` over
   `/ui/ws/agent`.
3. React shows a modal and POSTs the answer to `/ui/api/agent/answer`.
4. The pending Promise resolves and the tool returns structured JSON:

```json
{
  "answered": true,
  "response": "Psychology",
  "reason": null,
  "id": "q_...",
  "prompt": "Which category should this use?",
  "createdAt": "...",
  "resolvedAt": "..."
}
```

Timeout/no-client returns `answered: false` with `reason` such as `timeout` or
`no_active_client`. Agents must not treat those strings as user answers.

### Discard/save asymmetry across browser tabs

`POST /ui/api/artifacts/<id>/save` and `/discard` only update the React state
of the client that initiated the call. There is no `artifact_removed` WS
broadcast yet. If you (or another agent) mutate the file store via Playwright
or a curl call, tell the user to **refresh their tab** to clear stale entries.

## Pre-Existing Data Files

Check these before fetching fresh data:

| File | Contents |
|------|----------|
| `dist/oe_national_2024.json` | 1403 OEWS occupation records (May 2024, national, cross-industry). |
| `dist/oe_histogram_density.json` | 12-bin PDF histogram (BLS wage intervals A–L). 772 occupations, 146.4M workers. |
| `dist/oe_histogram_density.html` | Standalone D3 histogram chart artifact. |
| `dist/tx_nonfarm.json` | Texas CES nonfarm payroll (SA + NSA), 120 monthly points each, 2014–2023. |
| `data/m3_total_mfg_shipments_nsa.csv` | NSA Total Manufacturing Shipments (MTM/VS), 291 obs, Jan 2002–Mar 2026. From Census M3 API. |
| `data/lookups/` | `oe_occupations.json`, `oe_areas.json`, `oe_datatypes.json`, `oe_industries.json`, `ln_concepts.json`, `surveys.json`, `m3_series.json`. |

## Statistical Methods Inventory

The statistician sub-agent is **method-agnostic**; specific techniques live as skills under `.pi/skills/`. Categories such as Economics or Psychology describe where a method is applied; they do not define the method. Index:

| Skill | Family | Status |
|-------|--------|--------|
| `oews-histogram` | Density estimation (interval-censored) | Complete |
| `industry-output-nowcast` | Time-series indicator-panel nowcasting | Complete |
| `seasonal-adjustment` | STL + X-13ARIMA-SEATS | Complete |
| `walk-forward-cv` | Time-series CV | Stub |
| `bootstrap-ci` | Non-parametric uncertainty | Stub |
| `regime-dummies` | Structural breaks / data hiatuses | Stub |

New technique = new skill folder under `.pi/skills/`. Do not put methods in the agent prompts.

Examples of future non-economic skills that would fit the same architecture:
`factor-analysis`, `item-response-theory`, `psychometric-reliability`,
`mixed-effects-longitudinal`, `mediation-analysis`, `survey-weighting`,
`clinical-trial-meta-analysis`.

## Data Hiatuses & Structural Breaks

Canonical catalog for any analysis touching these sources. Always disclose in `analysis.md` Caveats.

| Source | Break | Effective | Notes |
|--------|-------|-----------|-------|
| Census M3 | SA model & historical-revision freeze | 2026-01 → end-2026 (at least) | Published SA is stale post-freeze. Prefer NSA + own SA via `seasonal-adjustment` skill. Verbatim notice at <https://www.census.gov/manufacturing/m3/>. |
| Census M3 Advance | Nondurable detail added | 2025-07-25 release onward | Pre-2025-07 Advance vintages lack nondurable detail. Step dummy on Advance-vintage nondurable features. |
| All NAICS-indexed | NAICS-2017 → NAICS-2022 revision | 2022 onward | Use Census concordance; some NAICS-3 industries split/merged. |
| All | COVID outliers | 2020-Q2 (esp. 2020-04 to 2020-06) | Robust loss (Tukey biweight) or X-13 AO/LS detection — do not delete observations. |

## Census M3 EITS API

Endpoint: `https://api.census.gov/data/timeseries/eits/m3`

**Working query pattern:**
```
{BASE}?get=cell_value,data_type_code,time_slot_id,seasonally_adj,category_code
  &for=us:*
  &data_type_code=VS
  &category_code=MTM
  &seasonally_adj=no
  &time=2024
  &key={CENSUS_API_KEY}
```

**Gotchas (verified 2026-05-25):**

| Gotcha | Detail |
|--------|--------|
| `for=us:*` mandatory | Omitting → HTTP 400 "missing for argument". Not obvious from docs. |
| Duplicate columns in response | Header row has duplicate `data_type_code`, `category_code`, `seasonally_adj`. Time is at **index 8**, not 5. Parse by index, not by column name. |
| HTTP 204 = empty | No data for that filter combo returns 204 with empty body. Must check `len(raw) == 0` before `json.loads()`. |
| `time=YYYY` → monthly | A yearly `time` param returns all 12 monthly rows, not annual aggregate. |
| `seasonally_adj` values | Literal `"no"` or `"yes"`, not a code. |
| NSA not on FRED | FRED mirrors SA M3 but rarely NSA. Always use Census API for NSA. |
| Old lookup IDs wrong | The `VS41` / `NO41` notation from Census flat-file docs does **not** work in the API. Use `category_code` + `data_type_code` from `data/lookups/m3_series.json`. |
| No multi-year range param | `time=YYYY` returns 12 months for that year. No `time=2002-2026` or `time=FROM&time=TO` range. N years = N serial calls. |
| Serial fetches timeout | 25+ sequential API calls in Python MCP can exceed the 60s bash timeout. Check `data/` for pre-existing CSVs first (e.g., `data/m3_total_mfg_shipments_nsa.csv`). A single `curl` call for the latest year is ~200 ms. |

**Key category codes:** `MTM` = Total Mfg, `MDM` = Durable, `MNM` = Nondurable.
**Key data_type codes:** `VS` = Shipments, `NO` = New Orders, `UO` = Unfilled Orders, `TI` = Inventories, `IS` = I/S Ratio.

See `data/lookups/m3_series.json` (`_meta.census_api`) for the full taxonomy.

## Tooling: `parse_pdf` (in-process)

In-process visualization tool (`src/visualization-tools.ts`) for extracting text
from PDFs. Primary engine: `pdf-parse` v2 (which wraps a recent `pdfjs-dist`).
Fallback: shells out to the local `pdftotext` binary (poppler-utils) if the JS
engine returns empty text.

**Verified working (2026-06-05) on:**

- `data/oe_wage_intervals.pdf` — OEWS interval schema
- `data/OEWS Density Estimator.pdf` — BLS methodology paper
- Census M3 `sichist.pdf` (SIC-based code list, 10 pages) — fetched fresh from `www2.census.gov`
- Census M3 `naicshist.pdf` (NAICS-based code list, 7 pages) — same

**Important correction to earlier memory:** the prior session reported that the
Census M3 code-list PDFs were undecodable due to Type0/Identity-H fonts. That
was wrong — `pdf-parse` v2 handles them natively. No Playwright scraping needed
for M3 code extraction.

**Calling convention:**
```
parse_pdf({ filePath: "data/m3_sichist.pdf" })           // local file
parse_pdf({ url: "https://...sichist.pdf" })             // fetch + parse
parse_pdf({ filePath: "...", pages: "1-3" })             // page range
parse_pdf({ filePath: "...", saveAs: "m3_sichist.txt" }) // persist as artifact
parse_pdf({ filePath: "...", mode: "info" })             // metadata only
parse_pdf({ filePath: "...", engine: "pdftotext" })      // force fallback
```

Returns extracted text plus per-page character counts. If both engines return
empty, the tool surfaces a clear message recommending Playwright as a rescue
path.

The two Census M3 code-list PDFs are now cached locally as `data/m3_sichist.pdf`
and `data/m3_naicshist.pdf`, with extracted text in `data/m3_sichist.txt` and
`data/m3_naicshist.txt`. The NAICS-based file contains the full detailed
industry-code taxonomy (codes like `34A`, `34B`, ..., `11S`, `12A`, ..., `NXA`)
needed to extend `data/lookups/m3_series.json` with a detailed section.

## Tooling: X-13ARIMA-SEATS

- **Binary installed:** `C:\Program Files\x13as\x13as.exe` (Win32 build, gfortran runtime).
- **Docs (local PDFs):** `C:\Program Files\x13as\docs\docx13as.pdf` (reference manual), `qrefx13aspc.pdf` (quick ref).
- **Python wrapper:** `statsmodels.tsa.x13.x13_arima_analysis(...)`. Set `X13PATH=C:/Program Files/x13as` (or pass `x12path=...` — yes, kwarg name is historical).
- **Venv packages confirmed present (2026-05-24):** `numpy 2.3.4`, `pandas 2.3.3`, `scipy 1.16.3`, `scikit-learn 1.7.2`, `statsmodels 0.14.6`, `patsy 1.0.2`. STL and `x13_arima_analysis` both importable; X-13 binary resolves correctly with `X13PATH=C:/Program Files/x13as`.

## Catalog restructuring — mechanical notes

### Querying the DB directly (bypassing `query_artifacts`)

When you need full JOIN output that `query_artifacts` can't surface (e.g.
category/subject names, session columns, raw metadata without the `content`
requirement), query the DB directly via Node's built-in `node:sqlite`:

```bash
cd C:/repos/http_proxy && node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/artifacts.db');
const rows = db.prepare(\`SELECT ...\`).all();
console.log(JSON.stringify(rows, null, 2));
"
```

**Do NOT use `better-sqlite3`.** It lives under `node_modules/.ignored/` and
its native `.node` binding is unresolvable from a plain `node -e` eval. The
`node:sqlite` `DatabaseSync` is what `src/artifacts.ts` uses and it works
reliably. Note that Node prints an `ExperimentalWarning` about SQLite — ignore
it; it's harmless.

### `query_artifacts` requires `content` in SELECT

Without the `content` column, every row is silently skipped with the message
"row has no string content column (include `content` in SELECT)." This trips
you up when you only want metadata. Workaround: include `content` even if
you discard it, or bypass with a direct `node:sqlite` query.

### The catalog view: `v_artifact_head`

```sql
CREATE VIEW v_artifact_head AS
  SELECT a.*
  FROM artifact a
  LEFT JOIN artifact b ON b.replaces_id = a.id
  WHERE b.id IS NULL
    AND a.role NOT IN ('memory', 'catalog')
```

Heads are rows where no other artifact's `replaces_id` points back → the
terminal node of each chain. `memory` and `catalog` rows are excluded. This
view is the authoritative dedup for both the sidebar tree and the orchestrator.

### Subject/session/artifact chain

The taxonomy chain is `category → subject → session → artifact`. An artifact
inherits its category and subject **through its session's `subject_id`**. Two
key implications:

1. **A null `session.subject_id` → Uncategorized artifact** regardless of the
   artifact's own fields.
2. **To recategorize an artifact, update its session's `subject_id`** — not
   the artifact row.

### Catalog tree API

`GET /ui/api/catalog` returns:

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "buckets": [{ "id": "economics/m3-manufacturing-analysis", "category": "...",
                "subject": "...", "groups": [{ "role": "chart", "items": [...] }] }],
  "collections": []
}
```

Each call also side-effects `persistCatalogIfChanged()` — a new `role: "catalog"`
artifact is written if the structural payload differs from the head.

### WebSocket event mismatch (catalog refresh)

| Event type | Sent by | Listened by frontend? |
|---|---|---|
| `catalog_updated` | `persist_artifacts` tool, `POST /ui/api/artifacts/<id>/save`, collection POST/DELETE | **Yes** (agent-bridge.ts:660) |
| `catalog_persisted` | `GET /ui/api/catalog` when a new catalog row is persisted (host.ts) | **No** |
| `artifact_created` | `create_artifact` + `query_artifacts` (via `artifactStore.onCreated`) | **Yes** |

**`create_artifact` no longer broadcasts `catalog_updated`.** It writes to the
file store only — the catalog DB hasn't changed. `catalog_updated` is reserved
for SQLite persistence operations.

### Artifact persistence boundary

Two stores, one lifecycle rule:

- **File store** (`/ui/api/artifacts/<id>`, in-memory): written by
  `create_artifact`. Ephemeral — lost on host restart.
- **SQLite DB** (`data/artifacts.db`): written by the agent via
  `persist_artifacts`, **only on explicit user request** ("save",
  "persist").

The agent NEVER auto-persists after `create_artifact`. It presents a
pending-artifact tree and waits for the user to say "save." This is a
hard boundary: if the user moves on without saving, the artifacts
evaporate harmlessly.

See AGENTS.md § "Artifact Lifecycle: Create → Present → Persist" for
the full three-phase workflow.

### Better-sqlite3 is available but requires the right require path

The actual `.node` binary lives at:
```
node_modules/.ignored/better-sqlite3/build/Release/better_sqlite3.node
```
It can be required via absolute path: `require('C:/repos/http_proxy/node_modules/.ignored/better-sqlite3')`.
However, prefer `node:sqlite` `DatabaseSync` for one-off queries — it eliminates
the native-binding headache.

## Architecture

- **Python MCP venv:** `C:\repos\codeGen-mcp-server\venv\Scripts\python.exe`
- **BLS API key:** in `data/.env` as `BLS_API_KEY`
- **Census API key:** in `data/.env` as `CENSUS_API_KEY`
- **Artifact store:** `data/artifacts/` on disk, served at `/ui/api/artifacts/<id>`
- **React UI:** sidebar filter hides only `role === "memory"`. Any other role (or no role) is visible. Charts auto-selected, rendered in iframe.
- **Launch:** `npm run build && npm run build:web && npm run dev:tui`
