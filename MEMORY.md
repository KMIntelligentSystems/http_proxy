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
| `data/lookups/` | `oe_occupations.json`, `oe_areas.json`, `oe_datatypes.json`, `oe_industries.json`, `ln_concepts.json`, `surveys.json`. |

## Architecture

- **Python MCP venv:** `C:\repos\codeGen-mcp-server\venv\Scripts\python.exe`
- **BLS API key:** in `data/.env` as `BLS_API_KEY`
- **Artifact store:** `data/artifacts/` on disk, served at `/ui/api/artifacts/<id>`
- **React UI:** all non-memory artifacts appear in sidebar. Charts auto-selected, rendered in iframe.
- **Launch:** `npm run build && npm run build:web && npm run dev:tui`
