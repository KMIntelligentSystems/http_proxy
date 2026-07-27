# Project Memory

Loaded at session start. Non-generic, project-specific operational knowledge:
tool quirks, data file locations, BLS API gotchas, architecture decisions.

**The browser is the primary interaction surface**, not the TUI. This file
documents the browser path in detail; the TUI is a developer fallback. See
AGENTS.md § "Primary interaction surface: the browser" for the policy
framing.

## Frontend rendering rules

The React UI (`/ui`, `src/react-app/src/App.tsx`) renders artifacts in an
`<iframe>`. The sidebar is now a **catalog tree** (`CatalogTree.tsx`) reading
from `GET /ui/api/catalog`, not a flat list of `artifact_created` events.

Key properties of the catalog path:

1. **Dedup happens in SQL, not in the React reducer.** Both `buildCatalog()`
   and `query_artifacts` should pivot off the `v_artifact_head` view (head
   of the `replaces_id` chain, with `memory`/`catalog`/`dataset-csv` roles
   and `application/json`/`text/csv` mime excluded). The legacy
   "near-random survivor" title-dedup bug is gone
   provided every read goes through that view.
2. **Only renderable content roles are visible** in the catalog tree.
   The `v_artifact_head` view excludes `memory`, `catalog`, `dataset-csv`
   roles AND `application/json` / `text/csv` mime types; `buildCatalog()`
   re-applies the same exclusions. Markdown, manifests, and HTML pages
   surface under their bucket; **CSVs and JSON do not** — they live in the
   raw `artifact` table / `artifact_latest` view only (see § "Catalog
   restructuring"). Querying `v_artifact_head` for a CSV returns zero rows
   even when CSVs are persisted — this has already caused one false
   "no CSVs in the db" report (2026-07-20).
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

**Always use the proxy URL**, not the Vite dev server directly. In local dev,
load `http://localhost:5173/ui/` (Vite serves the app and proxies `/ui/api`,
`/ui/ws`, `/ui/data` to the proxy at `:8080`). In production (Railway only),
Vite is not running — the built `dist/web` is served by the host and accessed
*through* the proxy at Railway's assigned `PORT` env var (the `:8080` in code is
just the local default). The `/ui/ws/agent` WebSocket requires the
`x-loopback: 1` header that only the proxy injects; going directly to the host
`:3100` or to Vite's own WS relay is a brittle path.

## Auth & login (BASIC_AUTH_USERS)

Credentials come from `BASIC_AUTH_USERS` (format `admin:pass1,user:pass2`) in
`.env`; legacy `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` is the single-user fallback.
**Username matching is case-insensitive** (fixed 2026-07-26): a shared
`lookupBasicUser()` helper in both `host.ts` and `proxy.ts` tries exact match,
then a case-folded scan, and returns the **canonical configured casing**. That
canonical name is what gets validated at all four credential checkpoints —
`POST /ui/api/auth/login`, the request-handler Basic-Auth fallback that sets
`currentUser`, the `/ui/ws/agent` `?user=&pass=` check, and the proxy's Basic
Auth — and it is what flows into `x-authenticated-user`, the `user` DB row,
role assignment (`=== "admin"`), and multi-tenant artifact scoping. Passwords
remain case-sensitive (constant-time compare in the proxy). Gotcha: the host
**forwards any request lacking `x-loopback: 1` to PROXY_URL** — direct curl
tests against the host port silently test the *proxy's* host, not the one you
started. Pass `-H "x-loopback: 1"` when exercising host routes directly.

## Browser event contract (`agent-bridge.ts`)

The React app opens a WebSocket to `/ui/ws/agent` at module load and
discards the raw `agent_event` stream into four named UI panels (Thinking,
Conversation, Documents, Sidebar — see AGENTS.md § "Browser UX surfaces").
The agent's output flows through this contract; knowing it lets you reason
about what the user is actually seeing while you work.

### WS message types handled by the frontend

| `type` | Sent by | Frontend action |
|---|---|---|
| `heartbeat` | host (every 30s) | liveness tick only; resets client watchdog |
| `agent_event` | `session.subscribe()` via `attachAgentEventBridge` | `handleAgentEvent()` → Thinking Panel entry (text/reasoning/tool_call/tool_result/lifecycle) |
| `artifact_created` | `create_artifact` + `query_artifacts` via `artifactStore.onCreated` | `useAgent` prepends to artifacts state; auto-selects newest |
| `assistant_response` | host on `agent_prompt_complete` (derived from latest assistant message) | `useConversation` adds a Conversation Panel bubble |
| `user_question` | `ask_user` tool via `UserQuestionManager` | App shows a modal; user answer POSTs to `/ui/api/agent/answer` |
| `user_question_resolved` | host when answer received or timeout | App removes the modal from the queue |
| `agent_state` | host on attach + model switch | `ModelSelector` updates current model display |
| `catalog_updated` | `persist_artifacts`, `POST .../save`, collection mutations | `useAgent` re-fetches `GET /ui/api/catalog` |
| `catalog_persisted` | `GET /ui/api/catalog` side-effect | **Not listened** by the frontend — harmless |
| `agent_prompt_complete` | host when `session.prompt()` resolves | `setWorking(false)`; dispatches `assistant_response`; finalizes thinking |
| `agent_prompt_error` | host on `session.prompt()` rejection or abort | `setWorking(false)`; surfaces error in Conversation + Thinking |
| `agent_prompt_stalled` | host stall watchdog (240s silence) | `setWorking(false)`; surfaces stall error |
| `agent_empty_turn_nudge` | host when a turn ended with no text + no tool calls | Thinking Panel status row; the host auto-sends a nudge prompt |
| `agent_bridge_status` | host on session attach/detach | logged; not user-visible |

### Stall watchdogs (defensive)

Two independent watchdogs protect against hung turns. Neither forcibly aborts
the session; they just release the `working` guard so the UI un-spins.

| Watchdog | Where | Threshold | Fires on |
|---|---|---|---|
| Client liveness | `agent-bridge.ts` | 75s no inbound WS bytes | half-open socket (edge idle timeout) |
| Client turn stall | `agent-bridge.ts` | 180s no `agent_event` while `working` | model provider hung the stream |
| Server turn stall | `host.ts` | 240s no `agent_event` | same, server-side |

If you ever see `agent_prompt_stalled` arrive, the turn was released — the
user can Submit again. Do not loop trying to "finish" a stalled turn.

### Partial reply + error surfacing

If the assistant streamed *some* text before a provider failure or tool
exception, `agent-bridge` surfaces **both** the partial reply and the error
as Conversation bubbles. Do not be surprised to see your earlier text
appear alongside an error — this is intentional, not a duplicate.

### Cross-tab / discard-save asymmetry

`POST /ui/api/artifacts/<id>/save` and `/discard` update **only the calling
tab's** React state. There is no `artifact_removed` WS broadcast. If you
(or another agent) mutate the file store via Playwright or curl, tell the
user to **refresh their tab** to clear stale entries.

## Cataloguing artifacts: the file-store vs DB distinction

The single most common cataloguing failure is conflating **file-store
artifacts** (from `create_artifact`) with **SQLite DB artifacts**. They are
different stores and `query_artifacts` only reads one of them.

### The two stores, explicitly

| Store | Written by | Read by `query_artifacts`? | In sidebar tree? |
|---|---|---|---|
| **File store** (in-memory, `/ui/api/artifacts/<id>`) | `create_artifact`, `create_*_chart` | **No** — `query_artifacts` queries SQLite only | No (pushed to Documents panel momentarily via `artifact_created` WS, then gone unless re-selected) |
| **SQLite DB** (`data/artifacts.db`) | `persist_artifacts` (user says "save") | **Yes** — pivot off `v_artifact_head` | HTML yes; CSV/JSON no (excluded by mime_type) |

### Failure mode this session (2026-07-02 productivity run)

After `create_artifact` produced 5 new artifacts, I ran a `query_artifacts`
SELECT against `v_artifact_head` to "catalogue" them. The query returned
**pre-existing M3/STL/nowcast DB artifacts** (created by prior sessions) —
NOT my 5 new file-store artifacts. I then printed a pending-artifact tree
listing the 5 new ones as if catalogued, which was false: the actual query
had surfaced the old DB rows. I then compounded it by calling
`persist_artifacts` on the word "catalogue" — auto-saving without the user
saying "save".

**Root causes:** (1) `query_artifacts` cannot surface file-store artifacts;
they are pushed to the frontend only at creation time via the
`artifact_created` WS event. (2) "Catalogue" is NOT a persist trigger — only
"save"/"persist" is.

### Two senses of "catalogue" (do not conflate)

| Sense | Context | Action |
|---|---|---|
| **Catalogue existing DB artifacts** | "Show me / catalogue the STL artifacts" (surfacing saved work) | `query_artifacts` + `catalogFilter` (reads SQLite) |
| **Catalogue newly-created artifacts** | "Catalogue the resulting artifacts in the panel" (after a build/forecast) | Do nothing extra — `create_artifact` already pushed them via `artifact_created` WS and they appear in the Documents panel automatically. Present the pending tree as text. Do NOT query. Do NOT persist. |

### Correct two-turn flow (create turn → save turn)

**Turn 1 — Create (the build/forecast turn):**

1. `create_artifact` produces file-store artifacts. They appear in the
   Documents panel **automatically** via the `artifact_created` WS event at
   creation time — no query needed.
2. Present the pending-artifact tree as a **text summary** in the
   conversation response. This is prose you write, NOT a `query_artifacts`
   result. Do NOT run `query_artifacts` here — it reads SQLite and will
   return old DB rows, not your new file-store artifacts.
3. **Finish the turn. STOP.** Do not persist. The user now reviews the
   displayed artifacts.

**Turn 2 — User-initiated follow-up (only when the user speaks):**

- If the user says "modify" / "change" / feedback on the output → revision
  (re-run the relevant step, replace via `create_artifact`).
- If the user says "save" / "persist" / "add to catalog" → `persist_artifacts`.
  This writes to SQLite and broadcasts `catalog_updated`. Then verify with a
  scoped `query_artifacts` and tell the user to refresh.

**Never auto-persist.** Persistence is user-initiated only. The word
"catalogue" in a build prompt means *display in the panel*, not *save to DB*.

### Rule of thumb

> **`query_artifacts` is a SQLite read, not a file-store listing.** It can
> only return what has been `persist_artifacts`'d. File-store artifacts are
> ephemeral and pushed to the UI only at creation time. Never run
> `query_artifacts` expecting it to surface `create_artifact` output that
> hasn't been persisted yet. And never `persist_artifacts` unless the user
> explicitly says "save" — "catalogue" is a display verb, not a save verb.

## Operating discipline: stop reading, start writing

A recurring failure mode in long multi-step tasks (data fetch → construct →
forecast → catalogue) is **over-reading**: the agent re-reads files it
already has, re-verifies alignment it already confirmed, and burns turns
on forensics instead of producing artifacts. Symptoms:

- Re-`read`-ing a CSV that was already loaded into a Python dict in the
  same turn.
- Re-running `query_artifacts` to "check" what was just created.
- Re-confirming date alignment that was verified two steps ago.
- Reading the same lookup JSON multiple times across turns.

### Discipline rules

1. **Once loaded into a Python script's memory, the data is in hand.** Do
   not re-read the source file in a follow-up script unless the script needs
   a fresh copy.
2. **Verification has a budget.** One alignment check per dataset join, not
   one per downstream step. If you verified "242 common months, Apr 2026
   present" once, trust it for the construction and the forecast.
3. **When the user aborts mid-bog, do not restart from scratch.** The
   artifacts and scripts already produced are still valid; resume from the
   last incomplete step, not step 1.
4. **Prefer producing an artifact over reading one more file.** If you have
   enough to write the CSV / HTML / analysis, write it. The marginal value
   of one more `read` is almost always below the marginal value of one more
   `create_artifact`.
5. **Track state mentally, not by re-querying.** After `create_artifact`
   returns an ID, hold that ID in the conversation; do not `query_artifacts`
   to rediscover it.

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

## Provider quirk: Moonshot/Kimi rejects tuple-form tool schemas

Moonshot's tool-schema validator requires every `items` to be an **object**.
TypeBox `Type.Tuple([...])` emits draft-07 tuple form (`items: [ {...}, ... ]`),
so any tool using it makes **every** provider request fail with
`400 ... 'properties.<name>.items': items must be an object` — regardless of the
prompt, since all tool schemas ride on every call. OpenAI accepts tuple form, so
this only bites on Kimi models. **Rule: never use `Type.Tuple` in pi tool
parameters; use `Type.Array(T, { minItems: n, maxItems: n })` for fixed-length
arrays.** (Fixed 2026-07-25 in `run_sarima`, `src/web-main.ts`.)

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
gives you head-of-`replaces_id`-chain rows with `memory`/`catalog`/
`dataset-csv` roles and `application/json`/`text/csv` mime already
excluded — the same dedup the sidebar tree applies, so
the agent and the UI cannot disagree about the corpus. (For CSV/JSON/
memory rows, use `artifact_latest` — see § "Catalog restructuring".)

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
| Economics | `M3 Manufacturing Analysis`; `M3 Forecasts`; `M3 STL Seasonal Adjustment`; `M3 Output Nowcast`; `Manufacturing Productivity Proxy`; `Indicator Backbone Series` |

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

## Pre-Existing Data Files

Check these before fetching fresh data:

| File | Contents |
|------|----------|
| `dist/oe_national_2024.json` | 1403 OEWS occupation records (May 2024, national, cross-industry). |
| `dist/oe_histogram_density.json` | 12-bin PDF histogram (BLS wage intervals A–L). 772 occupations, 146.4M workers. |
| `dist/oe_histogram_density.html` | Standalone D3 histogram chart artifact. |
| `dist/tx_nonfarm.json` | Texas CES nonfarm payroll (SA + NSA), 120 monthly points each, 2014–2023. |
| `data/_archive/` (2026-07-23) | Retired duplicates (`m3_total_mfg_shipments_nsa.csv` — byte-identical to canonical; `m3_shipments_nsa_apr2026.csv`) + derived nowcast outputs (`m3_features`, `nowcast_history`, `nowcast_residuals`, `productivity_proxy_monthly`, `stl_m3_sa_series`). Not referenced by any live code. |
| `data/series-map.json` | Checked-in backbone registry: canonical CSV → seriesId, validation bounds, consumers. Drives `load-index-csvs.mjs` + the refresh-history bridge. |
| Backbone CSVs (`m3_nsa_total_mfg.csv`, `fred_ipman.csv`, `ces_mfg_employment_sa.csv`, `ces_mfg_hours_sa.csv`) | Canonical index series. Persisted to artifacts.db ONLY via `npm run data:load-index-csvs` (the sanctioned writer) — never ad-hoc `persist_artifacts`. |
| `data/nowcast_indicator_panel.csv` | LASSO nowcast fitting panel (gitignored, local-only) — needed to freeze `m3-leading-indicator-nowcast` weights. |
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

### The catalog views: `v_artifact_head` vs `artifact_latest`

```sql
CREATE VIEW v_artifact_head AS           -- UI-facing dedup (hides plumbing)
  SELECT a.*
  FROM artifact a
  LEFT JOIN artifact b ON b.replaces_id = a.id
  WHERE b.id IS NULL
    AND a.role NOT IN ('memory', 'catalog', 'dataset-csv')
    AND a.mime_type NOT IN ('application/json', 'text/csv');

CREATE VIEW artifact_latest AS           -- head-of-chain, NO exclusions
  SELECT a.* FROM artifact a
  LEFT JOIN artifact b ON b.replaces_id = a.id WHERE b.id IS NULL;
```

Heads are rows where no other artifact's `replaces_id` points back → the
terminal node of each chain. `v_artifact_head` is the authoritative dedup
for the sidebar tree and user-facing queries. **`artifact_latest` is the
read-path for hidden rows** — persisted CSVs (`dataset-csv`), JSON model
cards (`statistical-analysis`), memory, catalog. The refresh-history bridge
and `run_sarima`'s backbone reader query `artifact_latest`; anything hunting
for CSV/JSON content must too. Use the raw `artifact` table only when
version history matters.

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

The full WS message table now lives in § "Browser event contract" above.
Two rows matter for catalog work specifically:

| Event type | Sent by | Listened by frontend? |
|---|---|---|
| `catalog_updated` | `persist_artifacts` tool, `POST /ui/api/artifacts/<id>/save`, collection POST/DELETE | **Yes** (re-fetches `GET /ui/api/catalog`) |
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

## Refresh data plane (flow 2)

The unattended refresh architecture (AGENTS.md § "Refresh architecture
(flow 2)") has its own operational state, separate from artifacts.db.

**Stores and dirs:**

- `data/refresh.db` — the refresh-daemon's SQLite: `daemon_receipt`,
  `indicator_dataset`, `indicator_vintage`, `indicator_history` (backbone +
  every ingested observation, keyed `(series_id, date)`, YYYY-MM), and
  `refresh_job` (waiting-inputs → running → candidate | abstained | failed |
  rejected; M4 leases requeue expired `running`).
- `data/refresh-results/<subject>/<month>/` — signed candidates:
  `refresh_result.json` (point, PIs, hash quadruple + signature),
  `analysis.md`, `forecast.csv`. Last-writer-wins per (subject, month).
- `data/contracts/*.contract.json` — frozen contracts; `pipelineDigest`
  pins the skill entrypoint (self-contained rule — the digest covers ONLY
  the entrypoint file). `pipelines/<name>@<ver>/` holds the skills.

**Backbone path (deterministic):** `data/series-map.json` (checked-in
registry + closed allowlist) → `npm run data:load-index-csvs`
(validation, sha256-idempotent, `replaces_id` versioning; reserved session
`bootstrap-loader`, subject "Indicator Backbone Series") → artifacts.db
`dataset-csv` rows (hidden from the UI; read via `artifact_latest`) →
`src/refresh-history-bridge.ts` triggers (host boot, artifact-save hook,
`sync_indicator_history` tool) → `POST /refresh/bootstrap` (HMAC) →
`indicator_history`. Dates normalize to YYYY-MM at the bridge so CSV and
broadcast observations collide on the same upsert key.

**On-demand refresh:** `POST /refresh/run` (HMAC) synthesizes a
deterministic dataset from the history tail (no volatile fields in the
hashed payload → same history = same hash = deduped re-run) and enqueues
jobs for contracts whose required series are present in history. The
`run_refresh` agent tool wraps trigger + poll + collection (signed results
+ 120-month history — the coder hand-off payload). Read endpoints:
`GET /refresh/results`, `/refresh/result`, `/refresh/prior-state`,
`/refresh/jobs`.

**Hermetic testing:** `REFRESH_DB` and `REFRESH_RESULTS_DIR` env overrides
redirect daemon + broker to throwaway state. Smoke suite:
`npm run test:bridge-smoke`, `test:sarima-skill`, `test:run-refresh`
(temp-dir hermetic). Legacy p2/p3/e2e tests share the dev DB (see
contamination below).

**Caveats (as of 2026-07-20):**

- ~~The dev `data/refresh.db` is contaminated~~ **RESOLVED 2026-07-20**:
  wiped and reseeded via the bridge — 4 series, 1,120 real obs, YYYY-MM
  keys, zero jobs/datasets/receipts; `data/refresh-results/` purged of the
  dummy-data candidates. (Historical note: `fred_ipman`, `bls_ces_*` held
  genHistory dummy values; the legacy p2/p3/e2e tests share the dev DB and
  will re-contaminate it if run without the `REFRESH_DB` override — prefer
  the hermetic smokes.)
- `m3-leading-indicator-nowcast` is a scaffold (exit 3) — jobs fail closed
  until `weights.json` is frozen (needs `data/nowcast_indicator_panel.csv`,
  gitignored/local-only).
- `piWideningFactor` (contracts) and `delta.revision` (skills) are inert.
- SARIMA skill: residual Ljung-Box shows autocorrelation (lag-12 p≈2e-11)
  — PIs may be optimistic. AIC differs from the May 2026 card (−1110.3 vs
  −1056.0; the original ad-hoc fit's options are unknowable) while the
  forecasts reproduce within 0.02%.
- Skills run on the `py` launcher (`PYTHON_BIN` env) — NOT the codeGen MCP
  venv. Same packages (statsmodels 0.14.6), different interpreter.

**Dev scheduling (added 2026-07-23):** the browser CONFIGURES, the OS
EXECUTES. React `SchedulerPanel` (calendar toggle, bottom-right) →
dev-guarded host endpoints `/ui/api/scheduler/*` (`src/scheduler-api.ts`;
win32 + `NODE_ENV != production` only — prod uses Railway cron or the
source daemon's own `[schedule]` loop in `C:\repos\daemon\daemon\airlock\config.toml`)
→ Windows Scheduled Tasks (`DVA-*`) whose action is the checked-in runner
`scripts/scheduled-indicator-run.mjs` (signed RunRequest → source `/run`
→ pull dataset → mirror to `/refresh/bootstrap` → optional `/refresh/run`;
logs to `data/scheduler-logs/*.json`; exit code = Task Scheduler "Last Run
Result"). Series allowlist: `data/lookups/scheduler_series.json` (mirror of
the source config's 15 `[[series]]` + release-aware suggested schedules).
Gotchas: schtasks `/sd` is SYSTEM-LOCALE dependent (detect
via `(Get-Culture).DateTimeFormat.ShortDatePattern`, cached); Git-bash
mangles `/create`-style args (MSYS path conversion) — execFile from Node is
unaffected; task slugs must be sanitized (series ids carry underscores).

**`targets` ≠ series ids (fixed 2026-07-26).** A RunRequest's `targets` are
validated against a CLOSED set — `KNOWN_TARGETS` in
`daemon/airlock/src/service.rs`: `m3_new_orders`, `m3_unfilled_orders`,
`m3_shipments`, `mfg_capacity`. The runner previously sent `targets:
[seriesIds[0]]`, so it 400'd ("unknown target") for every FRED and BLS
request and only ever worked for Census M3. Each catalog entry now carries a
`daemonTarget` field (FRED/BLS → `mfg_capacity`) which the runner de-dupes
into `targets`. If you add a series, set its `daemonTarget`.

**`bls_ces_mfg_employment` is now daemon-fetchable (2026-07-26),**
superseding the 2026-07-23 human-maintained-CSV decision. Added as
`[[series]]` in the source `config.toml` (`CES3000000001`, Thousands of
Persons, SA, `reference_lag_months = 1`, range 10000–17000) and mirrored
into `scheduler_series.json` (day 8, with the hours series). `fetch_bls` is
generic over `provider_series_id` — no Rust change was needed. Verified
end-to-end: live fetch → mirror → `indicator_history` 2026-06 = 12598, and
re-running is idempotent (one row per `(series_id, date)`). The canonical
CSV path (`series-map.json` → `ces_mfg_employment_sa.csv` → loader →
bridge) still works and remains the fallback; both converge on
`indicator_history`. It no longer gates the productivity contract's
common-latest-month rule when scheduled.

## Architecture

- **Python MCP venv:** `C:\repos\codeGen-mcp-server\venv\Scripts\python.exe`
- **BLS API key:** in `data/.env` as `BLS_API_KEY`
- **Census API key:** in `data/.env` as `CENSUS_API_KEY`
- **Artifact store:** `data/artifacts/` on disk, served at `/ui/api/artifacts/<id>`
- **React UI:** the sidebar/catalog shows only renderable content roles — `memory`, `catalog`, `dataset-csv` roles and `application/json`/`text/csv` mime are excluded at the `v_artifact_head` view level (re-filtered in `buildCatalog()`). Charts auto-selected, rendered in iframe.
- **Launch:** `npm run build && npm run build:web && npm run dev:tui`
