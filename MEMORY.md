# Project Memory

Loaded at session start. Non-generic, project-specific operational knowledge:
tool quirks, data file locations, BLS API gotchas, architecture decisions.

## Frontend rendering rules

The React UI (`/ui`, `src/react-app/src/App.tsx`) shows artifacts in an `<iframe>`.
Two filters in `App.tsx` (lines ~28–31) determine what's reachable from the sidebar:

1. **HTML-only:** the sidebar lists only `mimeType === "text/html"`. CSV / markdown /
   JSON / SVG rows are written to the file store but invisible in the sidebar —
   they only render if the user navigates directly to `/ui/api/artifacts/<id>`.
2. **Title-dedup:** rows with identical titles collapse to one entry. Because
   the WebSocket reducer prepends each new `artifact_created` event, the
   surviving entry is whichever event arrived **last** — NOT necessarily the
   most recent vintage. See "DB-First Data Access" below for the dedup-at-SQL
   pattern that avoids this.

**Always use the proxy URL** (`http://localhost:8080/ui/`), not the Vite dev
server at `:5173`. The `/ui/ws/agent` WebSocket requires the `x-loopback: 1`
header that only the proxy injects; via Vite the WS connection is a brittle
4-hop relay.

## Python MCP: `\n` in print strings

`execute_python` chokes on escaped newlines inside string literals — produces
`SyntaxError: unterminated string literal`.

**Workaround for any non-trivial script:** write to a temp file with `write`,
execute via `bash`, delete immediately.
```bash
"C:\repos\codeGen-mcp-server\venv\Scripts\python.exe" data/_tmp.py && rm data/_tmp.py
```
Keep only the script's *output* (CSV, JSON) — the script itself is ephemeral.

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

### Recommended SELECT pattern (dedup + HTML-only)

The raw `ORDER BY created_at DESC` pattern surfaces ALL matching rows, including
stale vintages with duplicate titles — which the sidebar's title-dedup then
collapses to a near-random survivor (often the broken oldest one). Use this
instead:

```sql
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY filename, mime_type
    ORDER BY created_at DESC
  ) AS rn
  FROM artifact
  WHERE tags LIKE '%"m3"%' AND tags LIKE '%"nsa"%'
)
SELECT id, title, filename, mime_type, role, description, content
FROM ranked
WHERE rn = 1
  AND mime_type = 'text/html'
ORDER BY title;
```

This guarantees one row per `(filename, mime_type)`, drops older vintages, and
only surfaces rows the sidebar will actually display.

If the query returns 0 rows (or only rows that don't actually answer the question),
then and only then fall back to external APIs / web-search and write the result
with `create_artifact`.

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

The statistician sub-agent is **method-agnostic**; specific techniques live as skills under `.pi/skills/`. Index:

| Skill | Family | Status |
|-------|--------|--------|
| `oews-histogram` | Density estimation (interval-censored) | Complete |
| `industry-output-nowcast` | Time-series indicator-panel nowcasting | Complete |
| `seasonal-adjustment` | STL + X-13ARIMA-SEATS | Complete |
| `walk-forward-cv` | Time-series CV | Stub |
| `bootstrap-ci` | Non-parametric uncertainty | Stub |
| `regime-dummies` | Structural breaks / data hiatuses | Stub |

New technique = new skill folder under `.pi/skills/`. Do not put methods in the agent prompts.

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

## Tooling: X-13ARIMA-SEATS

- **Binary installed:** `C:\Program Files\x13as\x13as.exe` (Win32 build, gfortran runtime).
- **Docs (local PDFs):** `C:\Program Files\x13as\docs\docx13as.pdf` (reference manual), `qrefx13aspc.pdf` (quick ref).
- **Python wrapper:** `statsmodels.tsa.x13.x13_arima_analysis(...)`. Set `X13PATH=C:/Program Files/x13as` (or pass `x12path=...` — yes, kwarg name is historical).
- **Venv packages confirmed present (2026-05-24):** `numpy 2.3.4`, `pandas 2.3.3`, `scipy 1.16.3`, `scikit-learn 1.7.2`, `statsmodels 0.14.6`, `patsy 1.0.2`. STL and `x13_arima_analysis` both importable; X-13 binary resolves correctly with `X13PATH=C:/Program Files/x13as`.

## Architecture

- **Python MCP venv:** `C:\repos\codeGen-mcp-server\venv\Scripts\python.exe`
- **BLS API key:** in `data/.env` as `BLS_API_KEY`
- **Census API key:** in `data/.env` as `CENSUS_API_KEY`
- **Artifact store:** `data/artifacts/` on disk, served at `/ui/api/artifacts/<id>`
- **React UI:** sidebar filter hides only `role === "memory"`. Any other role (or no role) is visible. Charts auto-selected, rendered in iframe.
- **Launch:** `npm run build && npm run build:web && npm run dev:tui`
