# Project Memory

Loaded at session start. Non-generic, project-specific operational knowledge:
tool quirks, data file locations, BLS API gotchas, architecture decisions.

## Python MCP: `\n` in print strings

The Python MCP server's `execute_python` tool chokes on escaped newlines (`\n`)
inside print statements and complex f-strings — produces `SyntaxError: unterminated
string literal`.

**Pattern that breaks:**
```python
print("\nSaved file to", path)       # \n kills it
print(f"\nHeader: {value}")          # \n in f-string kills it
```

**Pattern that works:**
```python
print("Saved file to", path)          # no \n
print("Header: %s" % value)           # % formatting, not f-strings
```

**Workaround for multi-line scripts:** Write the script to a temp location
with the `write` tool, execute via `bash`, then **delete the file immediately**
afterward. These scripts are transient — only their outputs (JSON, CSV, etc.)
should persist.
```bash
# Write, run, delete — script is ephemeral
C:\repos\codeGen-mcp-server\venv\Scripts\python.exe temp_script.py && rm temp_script.py
```

## BLS API v2 — OEWS limitation

The BLS time series API v2 does **not** serve multi-year OEWS data. OE series IDs
in all tested formats return "Series does not exist" with 0 data points. Single-year
OEWS data (e.g. May 2024) is available via flat file download.

**Working BLS series patterns:**
- **CES:** State-level uses `SM` (SA) / `SMU` (NSA) prefix. e.g. `SMS48000000000000001`
- **CPS:** `LNS14000000` for national unemployment rate.

**Common FIPS codes:** 48 = Texas, 06 = California, 36 = New York.

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
