# BLS Multi-Survey Series Explorer — Architectural Blueprint

**Date:** 2026-05-03  
**Status:** Design Phase  
**Author:** Data Visualization Agent  

---

## 1. Vision

A unified web application that lets users interactively construct BLS Series IDs
across three major survey programs (OE, CE, LN), fetch time-series data from the
BLS API, and visualize results with D3.js — including side-by-side seasonally
adjusted vs. not-seasonally-adjusted comparisons.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER INTERFACE                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                         │
│  │  OE Tab  │  │  CE Tab  │  │  LN Tab  │   ← Survey selector     │
│  └──────────┘  └──────────┘  └──────────┘                         │
│                                                                     │
│  ┌─ Series Builder ──────────────────────────────────────────────┐  │
│  │  [Seasonal ▼] [Area ▼] [Industry ▼] [Occupation ▼] [Type ▼] │  │
│  │                                                               │  │
│  │  Constructed ID:  OEUN000000000000015121101                   │  │
│  │  Description:     National Software Developers, Total Emp     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Saved Series ────────────────────────────────────────────────┐  │
│  │  ☆ LNS14000000  Unemployment Rate (SA)          [Compare]    │  │
│  │  ☆ LNU14000000  Unemployment Rate (NSA)         [Compare]    │  │
│  │  ☆ CES0000000001 Total Nonfarm Employment (SA)  [Compare]    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ D3.js Chart ─────────────────────────────────────────────────┐  │
│  │              Time Series with SA / NSA overlay                │  │
│  │  $│                                                           │  │
│  │   │    ╱╲    ╱╲    ╱╲                                        │  │
│  │   │  ╱    ╲╱    ╲╱    ╲  ── SA (solid)                       │  │
│  │   │╱  ·  ·  ·  ·  ·  ·  ── NSA (dashed)                     │  │
│  │   └──────────────────────────────────                         │  │
│  │    2014  2016  2018  2020  2022  2024                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          AGENT PIPELINE                                  │
│                                                                          │
│  ┌─────────────┐    ┌─────────────────┐    ┌──────────────┐            │
│  │  Research    │───►│  Main Agent     │───►│  Validator   │            │
│  │  Agent       │    │  (Orchestrator) │    │  Agent       │            │
│  │  (haiku)     │    │  (sonnet)       │    │  (haiku)     │            │
│  └─────────────┘    └────────┬────────┘    └──────────────┘            │
│       │                      │                     │                    │
│       │ Writes mappings      │ Writes code         │ Screenshots +     │
│       │ to SQLite +          │ + HTML/JS            │ DOM assertions   │
│       │ memory/              │                      │                    │
│       ▼                      ▼                      ▼                    │
│  ┌─────────────┐    ┌─────────────────┐    ┌──────────────┐            │
│  │  SQLite DB  │    │  Static Files   │    │  Browser     │            │
│  │  data/      │    │  src/ui/        │    │  :8080/ui    │            │
│  │  bls.db     │    │                 │    │              │            │
│  └─────────────┘    └─────────────────┘    └──────────────┘            │
│       │                      │                     ▲                    │
│       └──────────────────────┼─────────────────────┘                    │
│              Served via proxy (:8080) ← host (:3000)                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Agent Responsibilities

| Agent | Role | Inputs | Outputs |
|-------|------|--------|---------|
| **Research** | Fetch BLS flat-file dictionaries, parse mapping tables, discover valid code combinations | BLS download URLs, `ln.txt`, `ce.txt`, `oe.txt` | SQLite tables, JSON mappings in `memory/` |
| **Main** | Orchestrate pipeline, write HTML/JS/CSS, build D3 charts, manage SQLite schema | Research outputs, user requests | `src/ui/bls-explorer.html`, `data/bls.db` |
| **Validator** | Screenshot the rendered page, assert DOM structure, verify data correctness | Rendered page at `:8080` | Pass/fail report with evidence |

---

## 3. Data Layer — SQLite

### Why SQLite (not just JSON)?

- **Queryable**: `SELECT * FROM oe_datatype WHERE code IN ('01','03','04')` vs. scanning JSON
- **Joinable**: Build human-readable descriptions by joining code tables
- **Extensible**: Add new surveys or code tables without restructuring
- **Persistent**: Survives sessions; research agent writes once, UI reads forever
- **Searchable**: Full-text search on occupation titles, industry names
- **Lightweight**: Single file at `data/bls.db`, no server process

### Schema

```sql
-- ═══════════════════════════════════════════════════════
-- CORE: Survey registry
-- ═══════════════════════════════════════════════════════
CREATE TABLE surveys (
    survey_code   TEXT PRIMARY KEY,   -- 'OE', 'CE', 'LN'
    name          TEXT NOT NULL,
    series_length INTEGER NOT NULL,   -- 25, 20, 12
    frequency     TEXT NOT NULL,      -- 'annual', 'monthly'
    description   TEXT,
    bls_url       TEXT                -- https://www.bls.gov/oes/
);

-- ═══════════════════════════════════════════════════════
-- FIELD DEFINITIONS: Positional layout per survey
-- ═══════════════════════════════════════════════════════
CREATE TABLE series_fields (
    survey_code   TEXT NOT NULL REFERENCES surveys(survey_code),
    field_name    TEXT NOT NULL,       -- 'seasonal_adjustment', 'area_code', etc.
    position_start INTEGER NOT NULL,  -- 1-indexed char position
    position_end   INTEGER NOT NULL,
    field_type    TEXT NOT NULL,       -- 'fixed', 'lookup', 'freetext'
    is_required   INTEGER DEFAULT 1,
    display_order INTEGER NOT NULL,
    description   TEXT,
    PRIMARY KEY (survey_code, field_name)
);

-- ═══════════════════════════════════════════════════════
-- CODE LOOKUPS: All valid codes per field per survey
-- ═══════════════════════════════════════════════════════
CREATE TABLE code_lookups (
    survey_code   TEXT NOT NULL,
    field_name    TEXT NOT NULL,
    code          TEXT NOT NULL,
    label         TEXT NOT NULL,       -- Human-readable label
    description   TEXT,                -- Longer description
    sort_order    INTEGER DEFAULT 0,
    PRIMARY KEY (survey_code, field_name, code),
    FOREIGN KEY (survey_code, field_name) REFERENCES series_fields(survey_code, field_name)
);

-- ═══════════════════════════════════════════════════════
-- OE-SPECIFIC: Occupation codes (SOC)
-- ═══════════════════════════════════════════════════════
CREATE TABLE oe_occupations (
    occ_code      TEXT PRIMARY KEY,   -- '15-1211'
    occ_title     TEXT NOT NULL,
    occ_group     TEXT NOT NULL,       -- 'major', 'minor', 'broad', 'detailed'
    major_code    TEXT,                -- '15-0000'
    soc_6digit    TEXT NOT NULL        -- '151211' (no hyphen, for series ID)
);

-- ═══════════════════════════════════════════════════════
-- OE-SPECIFIC: Industry codes (NAICS)
-- ═══════════════════════════════════════════════════════
CREATE TABLE oe_industries (
    industry_code TEXT PRIMARY KEY,   -- '000000', '510000', etc.
    industry_name TEXT NOT NULL,
    naics_level   TEXT                -- 'cross-industry', 'sector', 'subsector'
);

-- ═══════════════════════════════════════════════════════
-- OE-SPECIFIC: Area codes
-- ═══════════════════════════════════════════════════════
CREATE TABLE oe_areas (
    area_type     TEXT NOT NULL,       -- 'N', 'S', 'M'
    area_code     TEXT NOT NULL,       -- '0000000', '0600000'
    area_name     TEXT NOT NULL,       -- 'National', 'California'
    PRIMARY KEY (area_type, area_code)
);

-- ═══════════════════════════════════════════════════════
-- CE-SPECIFIC: State FIPS codes
-- ═══════════════════════════════════════════════════════
CREATE TABLE ce_states (
    fips_code     TEXT PRIMARY KEY,   -- '00000', '06000'
    state_name    TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════
-- LN-SPECIFIC: Demographics
-- ═══════════════════════════════════════════════════════
CREATE TABLE ln_demographics (
    demo_code     TEXT PRIMARY KEY,   -- '0000', '0100'
    description   TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════
-- USER DATA: Saved/bookmarked series
-- ═══════════════════════════════════════════════════════
CREATE TABLE saved_series (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id     TEXT NOT NULL UNIQUE,
    survey_code   TEXT NOT NULL REFERENCES surveys(survey_code),
    label         TEXT,                -- User-assigned label
    created_at    TEXT DEFAULT (datetime('now')),
    last_fetched  TEXT,
    is_favorite   INTEGER DEFAULT 0
);

-- ═══════════════════════════════════════════════════════
-- CACHE: BLS API responses
-- ═══════════════════════════════════════════════════════
CREATE TABLE api_cache (
    series_id     TEXT NOT NULL,
    year          INTEGER NOT NULL,
    period        TEXT NOT NULL,       -- 'M01', 'M13', 'A01'
    value         REAL,
    footnotes     TEXT,
    fetched_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (series_id, year, period)
);

-- ═══════════════════════════════════════════════════════
-- INDEXES for UI performance
-- ═══════════════════════════════════════════════════════
CREATE INDEX idx_code_lookups_survey ON code_lookups(survey_code, field_name);
CREATE INDEX idx_oe_occ_group ON oe_occupations(occ_group);
CREATE INDEX idx_oe_occ_title ON oe_occupations(occ_title);
CREATE INDEX idx_api_cache_series ON api_cache(series_id);
CREATE INDEX idx_saved_series_survey ON saved_series(survey_code);

-- Full-text search for occupation titles
CREATE VIRTUAL TABLE oe_occupations_fts USING fts5(
    occ_code, occ_title, content=oe_occupations
);
```

### Why Not Ollama Embeddings?

For this use case, SQLite with FTS5 full-text search is the right choice:

| Consideration | SQLite + FTS5 | Ollama Embeddings |
|---------------|---------------|-------------------|
| **Lookup precision** | Exact match on codes → 100% | Semantic similarity → approximate |
| **Latency** | <1ms per query | ~50-200ms per embedding |
| **Dependencies** | Zero (built into Python/Node) | Requires Ollama server running |
| **Data size** | ~5,000 codes total → trivial | Overkill for structured lookups |
| **Search type** | Code lookups + text search | Better for natural language queries |

**Recommendation:** Use SQLite for all structured mappings. Reserve Ollama embeddings
for a *future* natural-language query layer (e.g., "show me tech worker wages in California"
→ semantic search → series ID construction). This is Phase 2.

---

## 4. Research Agent Pipeline

The research agent populates SQLite by fetching BLS flat-file dictionaries.

```
Research Agent Workflow
═══════════════════════

Step 1: Fetch BLS Flat Files
  ├── https://download.bls.gov/pub/time.series/oe/oe.datatype
  ├── https://download.bls.gov/pub/time.series/oe/oe.area
  ├── https://download.bls.gov/pub/time.series/oe/oe.industry
  ├── https://download.bls.gov/pub/time.series/oe/oe.occupation
  ├── https://download.bls.gov/pub/time.series/ce/ce.datatype
  ├── https://download.bls.gov/pub/time.series/ce/ce.supersector
  ├── https://download.bls.gov/pub/time.series/ce/ce.series
  ├── https://download.bls.gov/pub/time.series/ln/ln.series
  └── https://download.bls.gov/pub/time.series/ln/ln.demographics (if exists)

Step 2: Parse TSV → Python dicts
  └── Tab-delimited files, first row is header

Step 3: Write to SQLite
  └── data/bls.db (single file, ~2-5MB)

Step 4: Write summary to memory/
  └── memory/2026-05-03-series-id-research.md (already done)
```

### Data Flow

```
BLS Download Server          Research Agent           SQLite
      │                           │                     │
      │  GET oe.datatype          │                     │
      │◄──────────────────────────│                     │
      │  TSV response             │                     │
      │──────────────────────────►│                     │
      │                           │  INSERT INTO        │
      │                           │  code_lookups       │
      │                           │────────────────────►│
      │                           │                     │
      │  GET oe.occupation        │                     │
      │◄──────────────────────────│                     │
      │  TSV response             │                     │
      │──────────────────────────►│                     │
      │                           │  INSERT INTO        │
      │                           │  oe_occupations     │
      │                           │────────────────────►│
      │                           │                     │
      ...  (repeat for all files) ...
```

---

## 5. UI Architecture

### File Structure

```
src/ui/
├── bls-explorer.html          ← Main application (single-page)
├── oe-drilldown.html          ← Existing OEWS drilldown (keep as-is)
├── data/
│   ├── oe_national_2024.json  ← Existing OEWS data
│   └── bls.db                 ← SQLite (served as static file? No — see below)
└── api/
    └── bls                    ← Existing proxy endpoint to BLS API
```

### Client-Server Split

The SQLite database cannot be queried directly from the browser. We need a thin
API layer on the host server (:3000) to serve lookups.

```
Browser (D3.js + vanilla JS)          Host (:3000)              SQLite
         │                                 │                       │
         │  GET /ui/api/codes?             │                       │
         │    survey=OE&field=datatype     │                       │
         │────────────────────────────────►│  SELECT * FROM        │
         │                                 │  code_lookups         │
         │                                 │  WHERE survey='OE'    │
         │                                 │  AND field='datatype' │
         │                                 │──────────────────────►│
         │                                 │  [{code,label}, ...]  │
         │                                 │◄──────────────────────│
         │  JSON [{code,label}, ...]       │                       │
         │◄────────────────────────────────│                       │
         │                                 │                       │
         │  GET /ui/api/occupations?       │                       │
         │    q=software&group=detailed    │                       │
         │────────────────────────────────►│  SELECT * FROM        │
         │                                 │  oe_occupations_fts   │
         │                                 │  WHERE title MATCH    │
         │                                 │──────────────────────►│
         │                                 │                       │
         │  POST /ui/api/bls              │  (existing endpoint)   │
         │    {seriesid: [...]}            │──► BLS API ──►        │
         │────────────────────────────────►│  Cache in api_cache   │
         │                                 │                       │
```

### Alternative: Pre-export to JSON

To avoid adding SQLite bindings to the host server, we can **pre-export** all
lookup tables to static JSON files during the research phase:

```
data/lookups/
├── surveys.json               ← [{survey_code, name, ...}]
├── oe_datatypes.json          ← [{code: "01", label: "Total employment"}, ...]
├── oe_areas.json              ← [{area_type, area_code, area_name}, ...]
├── oe_occupations.json        ← [{occ_code, occ_title, occ_group, soc_6digit}, ...]
├── oe_industries.json         ← [{industry_code, industry_name}, ...]
├── ce_datatypes.json
├── ce_supersectors.json
├── ce_states.json
├── ln_series_codes.json
└── ln_demographics.json
```

**Pros:** Zero server changes, browser fetches JSON directly  
**Cons:** No server-side search, larger payload (~1MB for occupations)  
**Verdict:** Use JSON export for Phase 1, add SQLite API for Phase 2 if needed.

---

## 6. UI Components

### 6.1 Survey Tab Bar

```html
<div class="tab-bar">
  <div class="tab active" data-survey="OE">OEWS</div>
  <div class="tab" data-survey="CE">CES</div>
  <div class="tab" data-survey="LN">CPS/LN</div>
</div>
```

Each tab loads a different set of dropdowns based on the survey's `series_fields`.

### 6.2 Series Builder (Dynamic Dropdowns)

For each field in `series_fields` (ordered by `display_order`):
- Render a `<select>` populated from `code_lookups`
- As user selects values, construct the Series ID in real-time
- Show the human-readable description below

```
┌─ OE Series Builder ─────────────────────────────────────────────┐
│                                                                  │
│  Seasonal     Area Type    Area           Industry               │
│  [Unadj ▼]   [National▼]  [0000000   ▼]  [Cross-industry ▼]   │
│                                                                  │
│  Occupation                          Data Type                   │
│  [🔍 Software Developers (15-1211)] [Total Employment ▼]        │
│                                                                  │
│  Series ID: OEUN000000000000015121101                           │
│  ═══════════════════════════════════                             │
│  OE│U│N│0000000│000000│151211│01                                │
│  ──│─│─│───────│──────│──────│──                                │
│  Survey│Adj│Area│ Area │Indust│Occ │Type                        │
│                                                                  │
│  [★ Save] [📋 Copy ID] [⚡ Fetch Data] [↕ Compare SA/NSA]      │
└──────────────────────────────────────────────────────────────────┘
```

### 6.3 SA vs NSA Comparison (Key Feature)

For CE and LN surveys, automatically generate both variants:

```javascript
// User selects "Unemployment Rate, Total, 16+"
const baseFields = { series: '020', demo: '0000', reserved: '00' };

const SA  = 'LNS' + baseFields.series + baseFields.demo + baseFields.reserved;
// → LNS0200000000
const NSA = 'LNU' + baseFields.series + baseFields.demo + baseFields.reserved;
// → LNU0200000000

// Fetch both, overlay on same chart
fetchBLS([SA, NSA], '2014', '2024');
```

### 6.4 D3.js Multi-Series Chart

```
   Unemployment Rate — SA vs NSA (2014–2024)
  %│
 14│                    ╱╲
   │                   ╱  ╲         ·· NSA (raw monthly)
 10│              ··╱·╱····╲··      ── SA  (smoothed)
   │           ··╱··        ╲··
  6│     ─────╱──            ──╲────────
   │  ────                        ──────
  3│
   └──────────────────────────────────────
    2014  2016  2018  2020  2022  2024

   Source: BLS Current Population Survey
```

Features:
- Dual y-axis support (e.g., employment count + wage rate)
- Brushable zoom on x-axis
- Tooltip with both SA and NSA values at cursor position
- Shaded difference band between SA and NSA
- Recession bars (NBER dates) as background shading

### 6.5 Saved Series Manager

```
┌─ My Series ──────────────────────────────────────────────────┐
│  ★ LNS14000000   Unemployment Rate (SA)        ✓ Compare    │
│  ★ LNU14000000   Unemployment Rate (NSA)       ✓ Compare    │
│  ☆ CES000000001  Total Nonfarm Payroll (SA)    ○ Compare    │
│  ☆ OEUN00000000000015121101  SW Dev Emp        ○ Compare    │
│                                                               │
│  [Fetch Selected (2)] [Clear Cache] [Export CSV]             │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Implementation Phases

### Phase 1: Foundation (Current Sprint)

```
Week 1:
  ├── [Research Agent] Fetch BLS flat files → export to data/lookups/*.json
  ├── [Main Agent] Create data/bls.db SQLite schema + populate from JSON schema
  ├── [Main Agent] Build src/ui/bls-explorer.html with Series Builder UI
  ├── [Main Agent] Wire up dynamic dropdowns from static JSON lookups
  └── [Validator] Verify page loads, dropdowns populate, Series ID constructs

Week 2:
  ├── [Main Agent] Integrate BLS API fetch (reuse existing /ui/api/bls proxy)
  ├── [Main Agent] Build D3.js time-series chart with SA/NSA overlay
  ├── [Main Agent] Add saved series manager (localStorage)
  └── [Validator] End-to-end test: select → construct → fetch → render
```

### Phase 2: Enrichment

```
  ├── [Research Agent] Fetch full occupation/industry/area code tables from BLS
  ├── [Main Agent] Add SQLite API endpoints to host server (:3000)
  ├── [Main Agent] Add occupation/industry search with autocomplete
  ├── [Main Agent] Add recession shading, annotations, comparison mode
  └── [Main Agent] Integrate with existing oe-drilldown.html (cross-linking)
```

### Phase 3: Intelligence (Future)

```
  ├── [Research Agent] Use Ollama embeddings for natural-language series lookup
  │   └── "Show me tech worker wages" → semantic search → relevant series IDs
  ├── [Main Agent] Add natural language query bar
  └── [Main Agent] Add anomaly detection / trend highlighting
```

---

## 8. File Manifest

| File | Purpose | Owner |
|------|---------|-------|
| `design/bls-series-explorer-architecture.md` | This document | Main Agent |
| `data/bls_series_schema.json` | Structured schema (exists) | Research Agent |
| `data/bls.db` | SQLite database (to create) | Research → Main |
| `data/lookups/*.json` | Pre-exported lookup tables | Research Agent |
| `src/ui/bls-explorer.html` | Main application | Main Agent |
| `src/ui/oe-drilldown.html` | Existing OEWS drilldown | (existing) |
| `memory/2026-05-03-series-id-research.md` | Research notes (exists) | Research Agent |
| `src/host.ts` | May need `/ui/api/codes` endpoint | Main Agent |

---

## 9. API Endpoints

### Existing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /ui/api/bls` | POST | Proxy to BLS API (exists in host) |

### New (Phase 1 — static JSON approach, no server changes)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /ui/data/lookups/oe_datatypes.json` | GET | Static file serve |
| `GET /ui/data/lookups/oe_occupations.json` | GET | Static file serve |
| `GET /ui/data/lookups/*.json` | GET | All lookup tables |

### New (Phase 2 — SQLite API)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /ui/api/codes?survey=OE&field=datatype` | GET | Dynamic code lookup |
| `GET /ui/api/occupations?q=software&group=detailed` | GET | FTS search |
| `GET /ui/api/series/validate/:id` | GET | Validate series ID format |

---

## 10. Technology Choices

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **UI** | Vanilla JS + D3.js v7 | Consistent with oe-drilldown.html |
| **Styling** | CSS custom properties | Dark theme tokens already defined |
| **Storage** | SQLite + JSON export | Queryable, persistent, zero-dep for Phase 1 |
| **API proxy** | Existing host (:3000) | Reuse `/ui/api/bls` endpoint |
| **Search** | FTS5 (Phase 2) / client filter (Phase 1) | Progressive enhancement |
| **Embeddings** | Ollama (Phase 3) | Natural language queries |
| **Validation** | Playwright | Automated screenshot + DOM checks |

---

## 11. Key Design Decisions

### D1: SQLite as primary store, JSON as delivery format
- Research agent writes to SQLite (structured, queryable, persistent)
- Export to JSON for Phase 1 browser consumption (zero server changes)
- Phase 2 adds server-side SQLite queries for search/autocomplete

### D2: Static JSON over Ollama embeddings for Phase 1
- BLS codes are **structured and finite** — not free-text
- Exact match lookups don't benefit from semantic similarity
- Ollama embeddings add latency + infrastructure dependency
- Reserve embeddings for Phase 3 natural-language query layer

### D3: Single-page HTML (not React/Vue)
- Consistent with existing `oe-drilldown.html`
- D3.js works best with direct DOM manipulation
- No build step required
- Can be served as static file through existing host

### D4: SA/NSA comparison as first-class feature
- Two of three surveys (CE, LN) publish both SA and NSA variants
- The third (OE) is always unadjusted
- Overlay chart is the most valuable analytical view
- Auto-generate paired series IDs from user selection

---

## 12. Next Steps

1. **Research Agent**: Fetch actual BLS flat files and export to `data/lookups/*.json`
2. **Main Agent**: Create SQLite database with schema above
3. **Main Agent**: Build `src/ui/bls-explorer.html` with Series Builder UI
4. **Main Agent**: Wire up BLS API fetch and D3.js chart
5. **Validator**: Run validation suite on completed page
