# Web UI Portal — Design Options

> Created: 2026-05-04  
> Status: Draft — awaiting decision  
> Context: The agent system has two HTML apps (`oe-drilldown.html`, `bls-explorer.html`) and a system prompt (`AGENTS.md`) that currently require manual navigation and file editing. This document proposes options for a web-based portal that provides:
> 1. **Prompt Editor** — view/edit `AGENTS.md` and sub-agent prompts via the browser
> 2. **HTML App Launcher** — navigate between UI pages served through the proxy

---

## How the System Prompt Works Today

The Pi SDK assembles the system prompt at session startup through a multi-layer pipeline:

### 1. Resource Loader Discovery

`DefaultResourceLoader` (in `pi-coding-agent/dist/core/resource-loader.js`) runs on `reload()`:

```
loadProjectContextFiles({ cwd, agentDir })
  ├── Scans agentDir (~/.pi/) for AGENTS.md or CLAUDE.md
  ├── Walks from cwd upward to filesystem root
  │   └── At each ancestor, looks for AGENTS.md or CLAUDE.md
  └── Returns array of { path, content } (deduplicated by path)
```

For this project, it finds `C:/repos/http_proxy/AGENTS.md` (159 lines).

### 2. System Prompt Assembly

`_rebuildSystemPrompt()` in `AgentSessionRuntime` calls `buildSystemPrompt()`:

```
buildSystemPrompt({
  cwd,                    ← "C:/repos/http_proxy"
  skills,                 ← loaded from .pi/skills/
  contextFiles,           ← AGENTS.md content from step 1
  customPrompt,           ← from resource loader (the SDK's base prompt)
  appendSystemPrompt,     ← optional appended prompt
  selectedTools,          ← ["read", "bash", "edit", "write", "push_svg", ...]
  toolSnippets,           ← one-line description per tool
  promptGuidelines,       ← from tool definitions
})
```

### 3. Final Prompt Structure

`buildSystemPrompt()` in `system-prompt.js` produces:

```
┌─────────────────────────────────────────────────┐
│ Base prompt (SDK boilerplate)                    │
│  "You are an expert coding assistant..."        │
│  Available tools: read, bash, edit, write, ...  │
│  Guidelines: ...                                │
├─────────────────────────────────────────────────┤
│ Pi documentation paths                           │
│  README.md, docs/, examples/                    │
├─────────────────────────────────────────────────┤
│ # Project Context                               │
│ ## C:\repos\http_proxy\AGENTS.md                │
│ (full content of AGENTS.md inlined here)        │
├─────────────────────────────────────────────────┤
│ Skills section                                  │
│  <available_skills>                             │
│    oews-histogram, web-search-mcp, etc.         │
│  </available_skills>                            │
├─────────────────────────────────────────────────┤
│ Current date: 2026-05-04                        │
│ Current working directory: C:/repos/http_proxy  │
└─────────────────────────────────────────────────┘
```

### Key Implications for Editing

- **AGENTS.md is read from disk** on session start and on `/reload` command. Edits take effect on next session or reload — not mid-conversation.
- **Sub-agent prompts** (`.pi/agents/*.md`) are read by the `delegate` tool's `discoverAgents()` at call time — changes are picked up immediately when the next delegate call happens.
- **Skills** (`.pi/skills/*/SKILL.md`) are discovered at startup and listed in the prompt, but their content is only read when the agent calls the `read` tool.
- The SDK does **not** watch files for changes. There is no hot-reload.

---

## How the Proxy Works Today

```
                  ┌──────────────┐
  Browser ──────► │ proxy :8080  │ ──────► host :3000
                  │  (auth gate) │           │
                  └──────────────┘           │
                        ▲                    │
                        │                    ▼
                  ┌─────┴────────────────────────────────┐
                  │            host :3000                 │
                  │                                      │
                  │  if x-loopback: 1  →  serve content  │
                  │  else              →  forward to     │
                  │                       proxy :8080    │
                  │                       with x-loopback│
                  └──────────────────────────────────────┘
```

### Request Flow

1. **Browser → proxy:8080**: Every request hits `proxy.ts` first
2. **proxy:8080 → host:3000**: `http-proxy` forwards to the target
3. **host:3000 receives**: Checks `x-loopback` header
   - **Has `x-loopback: 1`** → This request came through the proxy, serve real content
   - **No `x-loopback`** → First hop; re-forward through proxy:8080 with `x-loopback: 1` added (double-hop pattern for auth enforcement)

### Why the Double Hop?

The host listens on `127.0.0.1:3000` and is reachable directly (bypassing auth). The double-hop ensures that even if something hits the host directly without `x-loopback`, it gets routed through the proxy (which enforces auth). Only requests with `x-loopback: 1` are treated as authenticated.

### Internal Tool Access

`push_svg` in `cli.ts` posts directly to `host:3000` with `x-loopback: 1`:
```typescript
fetch("http://localhost:3000/ui/svg", {
  headers: { "x-loopback": "1" },  // bypass proxy, trusted internal call
})
```

This is safe because the tool runs in the same process as the host.

---

## Where the Security Is

### Proxy Layer (`src/proxy.ts`)

| Control | Implementation |
|---------|---------------|
| **Bind address** | Default `127.0.0.1` (loopback only) — not reachable from network |
| **Non-loopback guard** | If `BIND` is non-loopback and `AUTH_TOKEN` is unset → **process.exit(1)** (hard fail) |
| **Auth check** | `checkAuth()` — if bound to loopback, all requests pass; if non-loopback, requires `Authorization: Bearer <AUTH_TOKEN>` |
| **WebSocket auth** | Same `checkAuth()` on `upgrade` event — unauthorized sockets get `401` and `destroy()` |

```typescript
// The critical guard:
if (!isLoopback(BIND) && !AUTH_TOKEN) {
  console.error("FATAL: non-loopback without AUTH_TOKEN");
  process.exit(1);
}
```

### Host Layer (`src/host.ts`)

| Control | Implementation |
|---------|---------------|
| **Loopback header** | Only serves content when `x-loopback: 1` is present |
| **No direct exposure** | Binds to `127.0.0.1:3000` — not reachable from network |
| **No auth of its own** | Relies entirely on the proxy for auth |
| **BLS API key** | Injected server-side from `data/.env` — never sent to browser |

### What's NOT Protected

| Gap | Risk | Mitigation |
|-----|------|-----------|
| `x-loopback` is a plain header | Any local process can forge it | Host binds to loopback only |
| No CSRF protection | Local scripts could POST to host | Same-origin policy + loopback binding |
| No rate limiting | Local abuse possible | Low risk on localhost |
| File serving has no path traversal guard | `req.url.replace("/ui/data/", "")` could be `../../etc/passwd` | Node's `path.resolve` prevents breakout from `dist/` but no explicit check |

### Security Implications for Prompt Editor

Adding a write endpoint for AGENTS.md means:
- **On loopback (default)**: Acceptable risk — same as the agent having `write` tool access
- **On non-loopback**: The `AUTH_TOKEN` bearer check protects it, but a prompt write endpoint is high-value (controls agent behavior). Should require the same auth.
- **Recommendation**: Guard write endpoints with `x-loopback: 1` check (same as existing content routes). If proxy is exposed non-loopback, the bearer token covers it.

---

## Current HTML Routing

```typescript
// host.ts — hardcoded single page
if (req.url === "/ui" || req.url === "/ui/") {
  const uiPath = path.resolve(__dirname, "..", "src", "ui", "oe-drilldown.html");
  // ... serve it, fallback to SVG canvas
}
```

**Problems:**
1. Only `oe-drilldown.html` is served. `bls-explorer.html` has no route.
2. Adding a new HTML file requires editing `host.ts` and rebuilding.
3. No index/navigation between apps.

---

## Option A: Minimal Portal Index + Read-Only Prompt Viewer

**Philosophy**: Smallest possible change. Auto-serve HTML files, read-only prompt inspection.

### Routes Added

| Route | Serves | Method |
|-------|--------|--------|
| `/ui` | Portal index (links to all apps) | GET |
| `/ui/app/:name` | Any `src/ui/{name}.html` | GET |
| `/ui/canvas` | Legacy SVG canvas (unchanged) | GET |
| `/ui/prompt` | Read-only rendered AGENTS.md + sub-agent prompts | GET |

### How It Works

- **App discovery**: `fs.readdirSync("src/ui/")` → filter `*.html` → generate card links
- **Prompt viewer**: Read `AGENTS.md` + `.pi/agents/*.md`, render as HTML with inline Markdown parser
- **No writes**: Zero new attack surface

### Pros/Cons

| ✅ Pros | ❌ Cons |
|---------|---------|
| ~50 LOC changes | No prompt editing |
| Zero dependencies | Must use text editor for AGENTS.md |
| No new security surface | No live preview |
| Auto-discovers HTML apps | |

---

## Option B: Full Portal with Rich Prompt Editor

**Philosophy**: Complete browser workspace. CodeMirror editor, live preview, system dashboard.

### Routes Added

| Route | Method | Purpose |
|-------|--------|---------|
| `/ui` | GET | Portal dashboard |
| `/ui/app/:name` | GET | Serve any HTML app |
| `/ui/canvas` | GET | Legacy SVG canvas |
| `/ui/prompt` | GET | Prompt editor page |
| `/ui/api/prompt` | GET | Read prompt file content |
| `/ui/api/prompt` | PUT | Write prompt file (with backup) |
| `/ui/api/apps` | GET | List available apps as JSON |

### Security for Write Endpoint

```typescript
// Only serve writes on loopback requests (came through proxy)
if (req.url === "/ui/api/prompt" && req.method === "PUT") {
  if (req.headers["x-loopback"] !== "1") { res.writeHead(403); return; }
  // Validate file against allowlist
  // Create backup before write
  // Write file
}
```

**File allowlist** (regex + explicit list):
```typescript
const ALLOWED = ["AGENTS.md"];
const ALLOWED_PATTERN = /^\.pi\/agents\/[a-z0-9-]+\.md$/;
```

### Pros/Cons

| ✅ Pros | ❌ Cons |
|---------|---------|
| Full browser workflow | ~200 LOC + 2 HTML files |
| Live Markdown preview | CodeMirror CDN dependency |
| Backup on every save | Write endpoint = security surface |
| System status dashboard | More to maintain |

---

## Option C: Hybrid — Auto-Serve + Textarea Editor (Recommended)

**Philosophy**: Middle ground. Auto-discover apps, simple prompt editor, zero dependencies.

### Routes Added

| Route | Method | Purpose |
|-------|--------|---------|
| `/ui` | GET | Portal index with app cards |
| `/ui/app/:name` | GET | Serve any `src/ui/{name}.html` |
| `/ui/canvas` | GET | Legacy SVG canvas |
| `/ui/prompt` | GET | Textarea-based prompt editor |
| `/ui/api/prompt` | GET/PUT | Read/write prompt files |

### Implementation Sketch

```typescript
// App auto-discovery
if (req.url?.match(/^\/ui\/app\/([a-z0-9-]+)\/?$/)) {
  const name = RegExp.$1;
  const filePath = path.resolve(uiDir, `${name}.html`);
  // Validate: must be in src/ui/, must exist, no path traversal
  if (!filePath.startsWith(uiDir) || !fs.existsSync(filePath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(fs.readFileSync(filePath, "utf-8"));
  return;
}

// Prompt API with path traversal protection
if (req.url?.startsWith("/ui/api/prompt")) {
  const file = new URL(req.url, "http://x").searchParams.get("file") ?? "AGENTS.md";
  if (!isAllowedPromptFile(file)) { res.writeHead(403); res.end(); return; }
  const absPath = path.resolve(projectRoot, file);
  if (!absPath.startsWith(projectRoot)) { res.writeHead(403); res.end(); return; }
  // ... read or write
}
```

### Backup Strategy

```
data/prompt-backups/
  AGENTS.md-2026-05-04T14-30-00.bak
  .pi-agents-research.md-2026-05-04T14-35-00.bak
```

On PUT: backup current → write new → return 200. Keep last 20 per file.

### Pros/Cons

| ✅ Pros | ❌ Cons |
|---------|---------|
| ~120 LOC changes | Textarea (no syntax highlighting) |
| Zero external dependencies | Basic Markdown preview |
| Auto-discovers HTML apps | |
| Prompt editing with backups | |
| Path traversal protection | |
| Matches project's no-framework pattern | |

---

## Comparison Matrix

| Feature | A: Minimal | B: Full | C: Hybrid |
|---------|-----------|---------|-----------|
| Auto-discover HTML apps | ✅ | ✅ | ✅ |
| Navigate between apps | ✅ | ✅ | ✅ |
| View system prompt | ✅ read-only | ✅ rich editor | ✅ textarea |
| Edit system prompt | ❌ | ✅ CodeMirror | ✅ textarea |
| Live Markdown preview | ❌ | ✅ split-pane | ✅ toggle |
| Prompt backups | n/a | ✅ | ✅ |
| External dependencies | None | CodeMirror CDN | None |
| host.ts changes | ~50 LOC | ~200 LOC | ~120 LOC |
| New HTML files | 0 | 2 | 0 (inline) |
| Path traversal protection | n/a | ✅ | ✅ |
| Security surface change | None | Write API | Write API |
| Effort | 1–2 hours | 4–6 hours | 2–3 hours |

---

## Recommendation

**Option C** — matches the project's zero-dependency, self-contained HTML pattern while enabling prompt editing with safety rails.

---

## Open Questions

1. **Portal URL**: Should `/ui` become the portal (moving drilldown to `/ui/app/oe-drilldown`), or should the portal live at `/ui/portal`?
   - Portal at `/ui` is cleaner but breaks existing bookmarks

2. **Reload notification**: Should prompt edits trigger a WebSocket message to the TUI?
   - SDK doesn't hot-reload AGENTS.md — changes take effect on `/reload` or next session
   - A "prompt changed on disk" indicator could be useful

3. **When do prompt edits take effect?**
   - AGENTS.md: next session start or `/reload` command
   - `.pi/agents/*.md`: next `delegate` tool call (read on demand)
   - Should the editor UI explain this to the user?
