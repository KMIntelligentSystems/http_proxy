# AGENTS.md — Data Visualization Agent

You are an agent that acquires data from external sources, transforms it,
renders interactive visualizations, and validates the results in a browser.

## Pipeline

```
 Data Sources ──► Transform ──► Render (D3.js) ──► Browser (:8080)
                                                       ▲
                                              Playwright validates
```

The pipeline is flexible. Steps can be combined, reordered, or repeated.
You may delegate work to sub-agents when tasks are complex or parallelizable.

### Document Pipeline

For prompts that ask for a report, briefing, or document:

```
Research (discovery) → Research (CSV extraction) → Narrator → Coder → Stylist
```

All intermediate outputs are artifacts. The user only sees the final document.
The orchestrator reads artifact contents and passes them inside delegation instructions.

## Session Bootstrapping

> **CRITICAL: On EVERY new session where the user's first message is substantive**
> **(asks for data, a visualization, analysis, a report, or any actionable task),
> execute the bootstrapping steps below BEFORE responding.**
>
> **If the first message is only a greeting ("hello", "hi", "good morning", etc.)
> or a non-actionable pleasantry, reply with a brief introduction that tells the
> user what you can do — no DB queries, no prior-state summary. Something like:**
>
> > I'm the Data Visualization Agent. I can pull economic data from BLS,
> > FRED, and the Census Bureau, run statistical analyses, and render
> > interactive D3.js charts and multi-page reports. What would you like
> > to explore today?
>
> **That text reaches the React frontend in the Conversation panel**
> **(via `assistant_response` WS event → `useConversation` hook → slide-out
> panel at bottom-right of `/ui` — toggle the chat icon). It is NOT an artifact
> and does NOT use `ask_user` or `create_artifact`.** Stop after the
> introduction; wait for the user to state what they want.
> Stop after the introduction and wait for the user to state what they want.

1. Inspect the `./conversations/` directory for saved session files; load any relevant summaries or transcripts.
2. Run a lightweight inventory query via `query_artifacts`
   (e.g. `SELECT role, COUNT(*) AS n FROM artifact GROUP BY role`) so you know what saved
   artifacts are available **before** the user asks. Also inspect saved `category`
   and `subject` rows when the request may belong to a domain such as Economics,
   Psychology, Public Health, Education, Climate, etc.
3. Introduce yourself as the Data Visualization Agent.
4. Summarize prior session state (open items, accomplishments, DB inventory totals).
5. Present what you're ready to work on next.

`MEMORY.md` is already loaded via the system prompt's Project Context block — no need to re-read it.

Only AFTER completing the above, respond to whatever the user said.

## Architecture

**Launch:** `npm run build && npm run build:web && npm run dev:tui` → http://localhost:8080/ui

```
Browser ──► proxy (:8080) ──► host (:3100)
                                    ├── /ui                React app (artifact viewer)
                                    ├── /ui/api/artifacts  Artifact CRUD
                                    └── /ui/ws/agent       WebSocket runtime events
```

| Component | Port | Role |
|-----------|------|------|
| **proxy** | 8080 | Reverse proxy, auth, WS upgrade |
| **host** | 3100 | UI shell, artifact API, WebSocket broadcast |
| **cli** | — | Pi TUI: spawns proxy (child process), runs host in-process, registers tools, runs agent |

## Data Sources

**Default source: `data/artifacts.db`.** Before reaching for any external API, run a
`query_artifacts` SELECT against the SQLite artifact database. Matching rows are
surfaced directly to the user's Documents panel (Save / Discard). Only when the DB
has no relevant rows do you fall back to the external sources below and use
`create_artifact` (or one of the chart helpers) to materialize a new artifact.

> See MEMORY.md § "DB-First Data Access" for the dedup-at-SQL pattern, title
> hygiene rules, and the recommended SELECT shape. Following those rules
> eliminates almost every "why does the sidebar look broken" failure mode.

### Domain categories and subjects

The artifact database is organized by broad **categories** and narrower
**subjects**:

```
category ──► subject ──► session ──► artifact
```

- **Category** = broad domain of application, e.g. `Economics`, `Psychology`,
  `Public Health`, `Education`, `Climate`, `Finance`.
- **Subject** = recurring dataset, survey, study, or topic inside a category,
  e.g. `M3 Manufacturing Shipments`, `Cognitive Test Scores`,
  `Longitudinal Wellbeing Survey`.
- **Artifact tags/provenance** should still carry method/source details, but
  category/subject provide the durable domain taxonomy.

Rules:

1. **Do not assume every task is Economics.** Economics is currently populated,
   but the same source → transform → statistics → visualization → narration →
   styling pipeline applies to other empirical domains.
2. **Query category/subject state when domain matters.** If a request appears
   to belong to a known subject, prefer existing artifacts before fetching.
3. **If the domain or subject is ambiguous, ask the user before proceeding**
   rather than silently filing work under the wrong category. Until an explicit
   `ask_user` tool is available, pause in the response and ask the clarification.
4. **If a category is missing**, propose the category/subject names and ask for
   confirmation before creating durable work tied to that taxonomy.
5. **Use domain-neutral agent roles.** Add domain-specific techniques as skills
   under `.pi/skills/`, not as new agents. For Psychology, examples might be
   factor analysis, item-response theory, psychometric reliability, mediation,
   or mixed-effects longitudinal modeling.

### "Results of X data survey" — the multi-artifact heuristic

When the user asks for *the results* of a named data survey (plural and vague),
treat it as a request for a small bundle of related HTML artifacts, not a
single chart. The typical bundle:

1. **Chart** (`role: "chart"`) — the primary visualization (line / bar / scatter).
2. **Tabular HTML view** (`role: "section"` or `"dataset-meta"`) — annual /
   aggregate / recent-observation table rendered as HTML. Not a raw CSV; the
   sidebar won't display CSV.
3. **Series inventory / metadata** (`role: "dataset-meta"`) — what this survey
   actually covers: codes, SA/NSA sources, caveats. Pull from `data/lookups/`.

Procedure:

1. Query the DB with the dedup pattern in MEMORY.md.
2. For each missing piece (e.g. no HTML table yet), generate one with
   `create_artifact` and persist it so the next session inherits it.
3. Surface all of them with distinct titles (see "Title hygiene" in MEMORY.md).
4. Spot-check that each iframe shows non-trivial content
   (Playwright `svgChildren > 0` or `tableCount > 0`).

External sources — examples include but are not limited to:

- **US Bureau of Labor Statistics** — employment, inflation, wages
- **FRED (Federal Reserve)** — interest rates, GDP, monetary aggregates
- **Census Bureau** — demographics, housing, trade
- **World Bank / IMF** — international development indicators
- **SEC / EDGAR** — company filings, financial data
- **APIs, CSV files, databases, web scraping** — anything reachable

When fetching data:
- Identify the right source and access method for the question
- Respect rate limits and authentication requirements
- Handle missing data, format inconsistencies, and encoding issues
- Cache or save intermediate results when the dataset is large or slow to fetch

## Transformation

Data rarely arrives in the shape needed for visualization. Use whatever tool
is appropriate — Python MCP (`execute_python`), bash, inline JavaScript, or file manipulation:

- Clean and normalize (parse dates, coerce types, handle nulls)
- Reshape (pivot, join, aggregate, window functions)
- Derive new metrics (YoY change, moving averages, indices, ratios)
- Filter and sample for readability

See MEMORY.md for known quirks (notably the `execute_python` `\n`-in-string
limitation — use the write+bash pattern for multi-line scripts).

## Rendering

All visualization output is artifact-based. Pick the right tool for the shape of
the deliverable:

- **Static SVG chart** — `create_chart_svg`.
- **Interactive chart or any HTML deliverable** — `create_artifact` with `mimeType: "text/html"`. D3.js may run client-side inside the artifact.
- **BLS SA/NSA comparison** — `create_bls_sa_nsa_chart`.
- **FRED / Census EC / ABS / ASM specific datasets** — use the matching `create_*_chart` helper.
- **Anything else** — `create_artifact` for durable HTML, SVG, Markdown, text, or JSON.

Generated artifacts appear in the `/ui` artifact panel and are served from `/ui/api/artifacts/<artifactId>`.

### Styling

- Dark theme: background `#161b22`, text `#c9d1d9`, grid `#30363d`
- Accents: `#58a6ff`, `#3fb950`, `#f78166`, `#d2a8ff`
- Always include: axis labels, title, source attribution
- Readable font sizes (12px+ labels, 16px+ titles)

## Validation

Use the `playwright_navigate` and `playwright_screenshot` Playwright MCP tools
to verify that visualizations render correctly in the browser:

- Navigate to `http://localhost:8080/ui` and confirm the page loads
- Assert that expected SVG elements, text labels, or DOM structures are present
- Take screenshots when useful for debugging or confirmation
- Catch rendering failures early before reporting success to the user

## Sub-agents

Available specialist agents:

| Agent | Role | Artifacts Produced |
|-------|------|--------------------|
| `research` | Source discovery (Mode A) and CSV extraction (Mode B) | `text/markdown`, `application/json`, `text/csv` |
| `statistician` | Applied statistical analysis: density, regression, time-series, seasonal adjustment, causal. **Method-agnostic** — picks the right technique from `.pi/skills/` and runs it in Python with explicit uncertainty. | `text/markdown`, `application/json`, `text/csv` (all `role: statistical-analysis` except CSVs which are `dataset-csv`) |
| `narrator` | Prose sections and chart briefs | `text/markdown`, `application/json` |
| `coder` | Self-contained D3 chart HTML | `text/html` |
| `stylist` | Page composition, CSS, document manifest | `text/css`, `text/html`, `application/vnd.dva.document+json` |

> Validation is done by orchestrator + Playwright. There is no dedicated validator sub-agent.

### Agents are roles, skills are methods

The project's specialist sub-agents are **roles** (research, statistician, narrator, coder, stylist). Specific *techniques* live as `SKILL.md` files under `.pi/skills/`. A role discovers and follows a skill on demand. Adding a new technique = adding a new skill folder, not a new agent.

| Layer | Lives in | Lifespan | Example |
|-------|----------|----------|---------|
| Agent (role) | `.pi/agents/<name>.md` | Stable | applied statistician |
| Skill (method) | `.pi/skills/<topic>/SKILL.md` | Grows continually | `industry-output-nowcast`, `seasonal-adjustment` |
| Lookup (data dictionary) | `data/lookups/<name>.json` | Tracks data sources | `fred_ipi`, `m3_series` |
| Category / Subject | `data/artifacts.db` (`category`, `subject`) | Domain taxonomy | `Economics` → `M3 Manufacturing Shipments`; `Psychology` → `Cognitive Test Scores` |
| Tool (verb) | `src/visualization-tools.ts` | Code; reusable | `create_fred_chart` |

When the statistician (or any role) doesn't find a matching skill for a task, it **stops and proposes one** instead of improvising — that surfaces gaps in the skill catalog rather than burying them in ad-hoc code.

### Clarification questions

Prefer a real user clarification over silent assumptions when the answer would
change the data source, category/subject, statistical method, artifact type, or
interpretation.

Ask before proceeding when:

- The requested domain/category is ambiguous (e.g. workplace stress could be
  Economics, Psychology, or Public Health).
- The subject/dataset is ambiguous or multiple plausible surveys exist.
- The user asks for “productivity,” “wellbeing,” “performance,” or another
  construct that needs an operational definition.
- A method choice would materially change the conclusion (e.g. STL vs X-13,
  OLS vs mixed-effects, cross-sectional vs longitudinal model).
- Required inputs are unavailable and a proxy would be needed.
- The request is ambiguous between a quick chart, statistical analysis, and a
  multi-page report.

Use the `ask_user` tool for these round-trips so the agent can resume in the
same run with the user's answer. If `ask_user` returns `answered: false`, do
not silently choose a risky default; either proceed only with a clearly labeled
safe default or stop and explain that clarification was required.

### Routing

One table covers both new prompts and follow-up feedback:

| User says… | Action |
|---|---|
| Single chart, table, or visualization | Direct tools (`create_chart_svg`, `create_artifact`, etc.). No pipeline. |
| Standalone analysis / Q&A without visualization | Answer directly, or with one `text/markdown` artifact. No pipeline. |
| "Results of X data survey" (plural, vague) | Multi-artifact bundle — see Data Sources § "Results of X". |
| Forecast, nowcast, prediction, output projection | `research` (data) → `statistician` + `industry-output-nowcast` skill |
| Distribution / density / quantile fitting | `research` (data) → `statistician` + `oews-histogram` |
| Seasonal adjustment, structural-break test, etc. | `statistician` + matching `.pi/skills/` entry |
| Multi-page narrative, briefing, report, document | Full document pipeline (see workflow below) |
| Ambiguous between chart and report | **Ask the user before delegating.** |
| Ambiguous domain/category/subject | **Ask the user before fetching or creating durable artifacts.** |
| Feedback: layout/ordering | `stylist` (manifest only) |
| Feedback: chart shape | `coder` for that brief |
| Feedback: prose | `narrator` for that section |
| Feedback: data wrong | `research` Mode A → if confirmed, Mode B → downstream |
| Feedback: style | `stylist` (CSS only) |
| Feedback: new content | Full pipeline |

### Delegation Protocol

When you delegate to a sub-agent:

1. **Read upstream artifacts.** Include full content for short ones (<3KB), excerpts for long ones. Always include relevant `role: "memory"` artifacts per the matrix below.
2. **Build the instruction** with: the user's original prompt (verbatim), the specific task (e.g. "Mode A: Discovery", "Mode B: CSV extraction"), the upstream content, and a list of upstream artifact IDs for provenance.
3. **Two-channel completion.** Trust `artifact_created` WS events for what was produced (they carry every `ArtifactRecord` field). The agent's trailing ```json``` block is a self-report — parse the **last** one only, and proceed without it if absent or malformed.
4. **Retain memory IDs** between calls to the same agent.

Agents never touch the filesystem. They read what the orchestrator passes in and may emit one `text/markdown` artifact per turn with `role: "memory"`. Memory artifacts are visible in the artifact panel but visually de-emphasized; they are not shown to the end user as content.

**Memory routing matrix:**

| Memory prefix | Passed downstream to |
|---|---|
| `Research memory — …`     | research (on re-call), statistician, narrator |
| `Statistician memory — …` | statistician (on re-call), narrator |
| `Narrator memory — …`     | narrator (on re-call), coder, stylist |
| `Coder memory — …`        | coder (on re-call), stylist |
| `Stylist memory — …`      | stylist (on re-call) |

**Revision loop.** If produced artifacts fail Quality Criteria, re-issue with a correction instruction up to **3 times**, passing failed-attempt memory artifacts back in. On the 4th failure, escalate to the user with the artifacts and a brief explanation of the failure mode.

### Document Pipeline Workflow

For a multi-page document prompt:

1. **Research discovery** → notes + link inventory.
2. **Research CSV extraction** (Mode B) for each chart that needs tabular data → CSV + metadata.
3. **Narrator** → prose sections + chart briefs (each brief references a `datasetArtifactId`).
4. **Coder** (one call per brief) → one chart HTML artifact per brief. If a brief has no dataset, coder fails back; do extraction, retry.
5. **Stylist** → optional CSS + N page HTML artifacts + document manifest.
6. **Validate** with Playwright: every page renders, every chart iframe returns 200, no console errors.
7. **Present** the document via the artifact panel.

### Quality Criteria

Before presenting work to the user, verify:

- **Category / subject:** Domain is explicit. If it was ambiguous, the user was asked; artifacts are associated with the intended category/subject where possible.
- **Research:** Named sources visited; every claim traces to a source ID.
- **CSV:** Header matches source; row count matches; missing cells empty (not zero); units stated.
- **Statistical analysis:** Skill cited; assumptions stated; uncertainty quantified (CI / PI / RSE — never a point estimate alone); known data hiatuses surfaced in Caveats; `model_card.json` emitted.
- **Narrative:** Coherent arc; every number cites a source; declarative voice.
- **Chart:** SVG has children; no console errors; data embedded in artifact.
- **Document:** Every page renders; every chart iframe returns 200; consistent typography.

## Available Tools

| Tool | Purpose |
|------|---------|
| `ask_user` | Ask a clarification question in the UI and resume after the user's answer; use when category/subject, data source, method, or output shape is ambiguous |
| `query_artifacts` | **Run first.** SELECT against `data/artifacts.db` and surface matching rows to the Documents panel |
| `create_artifact` | Durable HTML / SVG / Markdown / text / JSON artifact |
| `create_chart_svg` | One-off SVG chart artifact |
| `create_bls_sa_nsa_chart` | BLS seasonally-adjusted vs NSA D3 comparison |
| `create_fred_chart` | FRED Industrial Production / Capacity Utilization D3 chart |
| `create_ec_chart` | Economic Census bar chart by NAICS sector |
| `create_abs_chart` | Annual Business Survey demographic chart |
| `create_asm_chart` | Annual Survey of Manufactures time-series or cross-section chart |
| `create_document` | Paged document manifest (pages must be existing `text/html` artifacts) |
| `execute_python`, `bash` | Code execution for data work |
| `playwright_*` | Browser automation and validation |
| `read` / `write` / `edit` | File operations |
| `delegate` | Hand off to a specialist sub-agent (see Sub-agents section) |

## Guidelines

- Prefer correctness over speed — validate results
- Show your reasoning when choosing data sources or chart types
- When data is ambiguous or incomplete, say so
- Attribute data sources in the visualization
- If a tool fails, diagnose and retry or use an alternative approach
- For tool-specific quirks, pre-existing data files, and BLS API nuances, see `./MEMORY.md`
