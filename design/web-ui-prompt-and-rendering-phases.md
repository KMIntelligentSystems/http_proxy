# Web UI Prompt Provider + `/ui` HTML Rendering — Phased Design

> Created: 2026-05-04  
> Status: Draft design  
> Related: `conversations/2026-05-04-session-02.md`, `design/web-ui-portal-options.md`, `design/bls-series-explorer-architecture.md`

## Goal

Build a browser UI, served through the existing proxy, that:

1. **Provides the agent's system prompt** to the user:
   - source prompt files such as `AGENTS.md`
   - sub-agent prompts in `.pi/agents/*.md`
   - eventually the effective assembled runtime prompt used by the Pi SDK
2. **Renders `/ui` HTML applications created from user prompts**:
   - existing `src/ui/oe-drilldown.html`
   - completed Phase 1 `src/ui/bls-explorer.html`
   - future generated HTML artifacts
3. Preserves the existing proxy/security model:
   - browser enters at `http://localhost:8080`
   - proxy forwards to host `:3000`
   - host only serves real content on requests carrying `x-loopback: 1`

---

## Current Pipeline State

### Completed Phase 1: BLS Series Builder Foundation

Already completed in `conversations/2026-05-04-session-01.md`:

- `src/ui/bls-explorer.html` exists and works as a self-contained Phase 1 UI
- Static lookup data exists in:
  - `data/lookups/*.json`
  - `dist/lookups/*.json`
- Playwright validation passed for:
  - OE / CE / LN tabs
  - occupation search
  - series ID construction
  - SA/NSA pair generation
  - D3 chart rendering through existing BLS API proxy
- Constraint respected: **no `src/host.ts` or `src/proxy.ts` changes were made in Phase 1**

### Not Yet Completed

- `bls-explorer.html` is not routable through the live host yet
- `/ui` is hardcoded to serve `oe-drilldown.html`
- there is no portal/index page
- there is no browser UI for prompt inspection/editing
- SQLite/FTS endpoints are not implemented
- Ollama natural-language query layer is not implemented

---

## Existing Runtime Architecture

```
Browser
  │
  ▼
proxy :8080
  │  auth gate + websocket upgrade forwarding
  ▼
host :3000
  ├── /ui              currently hardcoded to oe-drilldown.html
  ├── /ui/canvas       legacy SVG canvas
  ├── /ui/ws           WebSocket for SVG push canvas
  ├── /ui/svg          POST endpoint for push_svg
  ├── /ui/data/*       static JSON/data from dist/
  └── /ui/api/bls      BLS API proxy
```

### Proxy Use

All browser traffic should enter through:

```
http://localhost:8080/...
```

not directly through `:3000`.

The proxy forwards to the host and the host serves real content only when it sees:

```
x-loopback: 1
```

Direct host requests without that header are routed back through the proxy, preserving the auth gate.

---

## System Prompt Handling

### Source Prompt Files

The primary project instruction file is:

```
AGENTS.md
```

Sub-agent prompts live under:

```
.pi/agents/research.md
.pi/agents/statistician.md
.pi/agents/validator.md
```

### Effective Runtime Prompt

The Pi SDK builds the actual system prompt by combining:

```
SDK base prompt
  + active tool descriptions
  + tool guidelines
  + project context files such as AGENTS.md
  + available skills list
  + current date
  + current working directory
```

Important consequence:

- a host-only endpoint can easily show the **source prompt files**
- showing the **exact effective runtime prompt** requires coordination with the running CLI agent session, because `host.ts` is a separate child process and does not currently hold the `AgentSessionRuntime` object

Therefore prompt support should be phased:

1. Phase 2: source prompt viewer/editor
2. Phase 3: effective runtime prompt snapshot exported by CLI to host-readable JSON
3. Later: live prompt reload/notification workflow

---

# Design Phases

## Phase 1 — Completed: Static BLS Explorer Foundation

**Status: complete**

This is the already-finished phase from the prior session.

### Deliverables

- `src/ui/bls-explorer.html`
- `data/lookups/*.json`
- `dist/lookups/*.json`
- `scripts/gen-lookups.cjs`

### What Phase 1 deliberately did not do

- no server routes
- no portal
- no prompt UI
- no SQLite endpoint
- no natural language search

---

## Phase 2 — Proxy-Served Web UI Portal + Source Prompt Provider

**Purpose**: Make existing and future HTML UIs routable through the proxy, and provide browser access to source prompt files.

### Phase 2A: `/ui` Portal Shell

Replace the current hardcoded `/ui → oe-drilldown.html` behavior with a portal shell.

Recommended routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/ui` | GET | Portal dashboard/index |
| `/ui/app/oe-drilldown` | GET | Render `src/ui/oe-drilldown.html` |
| `/ui/app/bls-explorer` | GET | Render `src/ui/bls-explorer.html` |
| `/ui/canvas` | GET | Legacy SVG push canvas |
| `/ui/data/*` | GET | Existing static data route |
| `/ui/api/bls` | POST | Existing BLS proxy route |

### Portal UI Sections

```
┌───────────────────────────────────────────────────────────────┐
│ Data Visualization Agent Portal                               │
├───────────────────────┬───────────────────────────────────────┤
│ Apps                  │ Details / Status                       │
│ - OEWS Drilldown      │ - proxy online                         │
│ - BLS Explorer        │ - host online                          │
│ - SVG Canvas          │ - BLS key present/missing              │
│                       │ - websocket clients                    │
├───────────────────────┴───────────────────────────────────────┤
│ Prompt                                                        │
│ - View AGENTS.md                                              │
│ - View sub-agent prompts                                      │
│ - Prompt changes require /reload or new session               │
└───────────────────────────────────────────────────────────────┘
```

### Phase 2B: Auto-Discover HTML Apps

Instead of adding a route for every file manually:

```
src/ui/*.html  →  /ui/app/:name
```

Examples:

| File | Route |
|------|-------|
| `src/ui/oe-drilldown.html` | `/ui/app/oe-drilldown` |
| `src/ui/bls-explorer.html` | `/ui/app/bls-explorer` |
| `src/ui/new-chart.html` | `/ui/app/new-chart` |

Security rule:

- `:name` must match `^[a-z0-9-]+$`
- resolved file path must remain inside `src/ui/`
- only `.html` files are served from this route

### Phase 2C: Source Prompt Viewer

Add a browser view for prompt source files.

Routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/ui/prompt` | GET | Prompt viewer/editor shell |
| `/ui/api/prompt/files` | GET | List allowed prompt files |
| `/ui/api/prompt?file=AGENTS.md` | GET | Return file content |

Allowed files:

```
AGENTS.md
.pi/agents/*.md
```

Initial Phase 2 recommendation: **read-only viewer first**.

Reason:

- lowest security risk
- proves routing and prompt discovery
- avoids write endpoint while the portal is new

### Phase 2D: Optional Source Prompt Editing

Once read-only prompt view is validated, add editing.

Route:

| Route | Method | Purpose |
|-------|--------|---------|
| `/ui/api/prompt?file=AGENTS.md` | PUT | Save prompt source file |

Mandatory safeguards:

1. request must have `x-loopback: 1`
2. file must be allowlisted
3. resolved path must remain inside project root
4. write must create timestamped backup first
5. UI must warn: `AGENTS.md changes take effect after /reload or next session`

Backup directory:

```
data/prompt-backups/
```

### Phase 2 Acceptance Criteria

- `http://localhost:8080/ui` loads portal
- portal lists `oe-drilldown` and `bls-explorer`
- clicking app cards renders the HTML through proxy
- `/ui/app/bls-explorer` loads successfully and fetches lookup JSONs through `/ui/data/lookups/*`
- `/ui/prompt` shows `AGENTS.md`
- Playwright validates app routing and prompt viewer

---

## Phase 3 — Effective Runtime Prompt Snapshot

**Purpose**: Show the actual assembled prompt the running agent session is using, not just source prompt files.

### Why this is separate

`host.ts` is a separate process. It can read files, but it cannot directly access:

```
runtime.session.systemPrompt
```

from `src/cli.ts` unless the CLI exports it somewhere.

### Proposed Mechanism

After `createAgentSessionRuntime()` completes in `src/cli.ts`, write a snapshot:

```
dist/runtime/system-prompt.json
```

Example shape:

```json
{
  "generatedAt": "2026-05-04T18:30:00Z",
  "cwd": "C:/repos/http_proxy",
  "sourceFiles": ["AGENTS.md"],
  "activeTools": ["read", "bash", "edit", "write", "push_svg", "playwright_navigate"],
  "systemPrompt": "...full assembled runtime prompt..."
}
```

Host route:

| Route | Method | Purpose |
|-------|--------|---------|
| `/ui/api/system-prompt/effective` | GET | Return snapshot JSON |

Portal UI adds:

- Source prompt tab
- Effective prompt tab
- Diff: source prompt vs effective prompt sections
- Timestamp showing when snapshot was generated

### Phase 3 Acceptance Criteria

- portal shows exact effective runtime prompt snapshot
- timestamp matches current session startup
- active tools list is visible
- UI warns if snapshot is stale after source prompt edit

---

## Phase 4 — Prompt Reload + Agent Coordination

**Purpose**: Close the loop between browser prompt edits and the running TUI/agent.

### Problem

Editing `AGENTS.md` does not change the current session's prompt automatically.

### Possible Solutions

#### Option 4A: User-Initiated Reload Notice

Prompt UI shows:

```
Saved. Run /reload in the TUI or start a new session for changes to take effect.
```

Lowest complexity.

#### Option 4B: Browser → Host → CLI Notification

Add a lightweight status channel:

- host records `promptChanged: true`
- portal shows status
- future TUI extension can show a banner

#### Option 4C: Programmatic Runtime Reload

Expose a controlled local endpoint or extension command that calls the runtime reload mechanism.

This is highest risk and should be delayed until the basic portal is stable.

### Recommendation

Phase 4A first. Avoid programmatic reload until there is a clear need.

---

## Phase 5 — SQLite / FTS Data API Enrichment

**Purpose**: Continue the BLS pipeline beyond Phase 1.

This corresponds to the Phase 2 items in `design/bls-series-explorer-architecture.md`.

### New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ui/api/codes?survey=OE&field=datatype` | GET | Dynamic code lookup |
| `/ui/api/occupations?q=software` | GET | FTS occupation search |
| `/ui/api/series/validate/:id` | GET | Validate series ID format |

### Portal Role

The portal becomes the launch point for:

- BLS Explorer
- OEWS Drilldown
- data diagnostics
- API status/health

### Acceptance Criteria

- BLS Explorer can use server-side search instead of only static JSON
- occupation and industry search works from SQLite/FTS
- app still functions if SQLite endpoint is unavailable by falling back to static JSON

---

## Phase 6 — Natural Language / Ollama Query Layer

**Purpose**: Add natural-language discovery over series, prompts, docs, and saved conversations.

### Examples

```
"Show me software developer wages"
"Find unemployment series, seasonally adjusted and unadjusted"
"What does the system prompt say about Playwright validation?"
```

### Components

- Ollama embeddings
- vector index over:
  - BLS series metadata
  - lookup tables
  - conversations
  - `AGENTS.md`
  - `.pi/agents/*.md`
- natural language query box in portal

### Acceptance Criteria

- natural-language search returns candidate series IDs
- user can launch candidate into `bls-explorer.html`
- prompt/documentation search links back to source prompt sections

---

## Phase 7 — Generated Artifact Rendering from User Prompts

**Purpose**: Make the portal the standard render target for HTML artifacts generated by the agent in response to user prompts.

### Workflow

```
User prompt
  ↓
Agent creates or updates src/ui/<artifact>.html
  ↓
Portal auto-discovers file
  ↓
Browser renders /ui/app/<artifact>
  ↓
Playwright validates via proxy
```

### Requirements

- naming convention for generated HTML files:
  - lowercase kebab-case
  - `.html` only
- portal refresh/rescan button
- app metadata extraction:
  - title from `<title>`
  - description from `<meta name="description">`
  - modified timestamp from filesystem
- Playwright validation must always use:

```
http://localhost:8080/ui/app/<artifact>
```

not `file://` and not direct `:3000`.

---

## Design Breakdown by Component

## 1. Host Routing

Modify `src/host.ts` behind the existing `x-loopback` branch.

New responsibilities:

- portal HTML rendering
- app discovery
- safe app file serving
- prompt file API
- optional prompt backups
- optional effective prompt snapshot serving

Do not move auth into host. Keep auth in `src/proxy.ts`.

## 2. Proxy

`src/proxy.ts` mostly remains unchanged.

Responsibilities remain:

- bind to `127.0.0.1` by default
- require `AUTH_TOKEN` if exposed on non-loopback
- forward HTTP and WebSocket traffic to host

Optional later hardening:

- add security headers
- optionally block unsafe methods unless authenticated

## 3. Prompt Provider

Two prompt layers:

### Source Prompt Provider

Reads files directly:

- `AGENTS.md`
- `.pi/agents/*.md`

### Effective Prompt Provider

Reads snapshot generated by CLI:

- `dist/runtime/system-prompt.json`

## 4. Web UI Portal

Recommended as dependency-free HTML generated by host or stored at:

```
src/ui/portal.html
```

Sections:

- apps
- prompt files
- effective prompt snapshot
- system status
- security/status notes

## 5. Security

Minimum safeguards:

- all browser access through proxy `:8080`
- keep host bound to `127.0.0.1`
- require `x-loopback: 1` for real content routes
- validate app names with strict regex
- prevent path traversal with `path.resolve()` and prefix checks
- prompt editing only for allowlisted files
- backup before write
- never expose API keys in prompt/status responses

---

## Recommended Immediate Next Step

Implement Phase 2 in two sub-steps:

1. **Phase 2A/2B**: Portal + safe `/ui/app/:name` rendering
2. **Phase 2C**: Read-only source prompt viewer

Defer prompt editing, effective runtime prompt snapshots, SQLite endpoints, and Ollama until after proxy-served routing is validated.
