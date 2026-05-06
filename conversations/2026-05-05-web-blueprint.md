 Do not blindly mix with the local pi-web-ui version I saw in C:/repos/pi-mono/pi-mono/packages/web-ui, which is 0.57.1.

 Use a compatible release set, for example:

 ```json
   {
     "@mariozechner/pi-web-ui": "<matching version>",
     "@mariozechner/pi-agent-core": "<same compatible release>",
     "@mariozechner/pi-ai": "<same compatible release>",
     "@mariozechner/mini-lit": "^0.2.0",
     "lit": "^3.3.1",
     "vite": "^7"
   }
 ```

 If the published package versions are not aligned, use the local pi-mono workspace package temporarily, but pin all pi packages together.

 ────────────────────────────────────────────────────────────────────────────────

 Web UI Build Structure

 Recommended new structure:

 ```text
   src/web/
     index.html
     vite.config.ts
     src/
       main.ts
       app.css
       remote-agent.ts
       agent-event-types.ts
       artifact-client.ts
       prompt-client.ts
       data-client.ts
 ```

 Build output:

 ```text
   dist/web/
     index.html
     assets/*
 ```

 Host route:

 ```text
   GET /ui
   GET /ui/assets/*
 ```

 serve from:

 ```text
   dist/web/
 ```

 Existing standalone apps remain available:

 ```text
   /ui/app/bls-explorer
   /ui/app/oe-drilldown
 ```

 But the main /ui becomes the pi-web-ui agent interface.

 ────────────────────────────────────────────────────────────────────────────────

 Browser UI Architecture

 pi-web-ui expects an Agent-like object with:

 - state
 - subscribe()
 - prompt()
 - abort()
 - setModel()
 - setThinkingLevel()
 - possibly setTools()

 Because our real agent should live on the server, create a client-side adapter:

 ```text
   RemoteAgent
     implements enough of pi-agent-core Agent interface
     mirrors server-side AgentSessionRuntime state
     sends prompts/control messages to host
     receives events over WebSocket or SSE
 ```

 Example:

 ```ts
   class RemoteAgent {
     state: AgentState;

     subscribe(listener) {
       this.listeners.add(listener);
       return () => this.listeners.delete(listener);
     }

     async prompt(input) {
       await fetch("/ui/api/agent/prompt", {
         method: "POST",
         body: JSON.stringify({ input }),
       });
     }

     async abort() {
       await fetch("/ui/api/agent/abort", { method: "POST" });
     }

     connectEvents() {
       const ws = new WebSocket(`${wsProtocol}//${location.host}/ui/ws/agent`);
       ws.onmessage = (event) => {
         const ev = JSON.parse(event.data);
         this.applyServerEvent(ev);
         this.emit(ev);
       };
     }
   }
 ```

 Then:

 ```ts
   const remoteAgent = new RemoteAgent();
   await remoteAgent.connect();

   const chatPanel = new ChatPanel();
   await chatPanel.setAgent(remoteAgent as any, {
     // Browser does not own API keys/tools in backend-owned mode.
   });

   document.body.appendChild(chatPanel);
 ```

 This uses pi-web-ui for presentation while the backend owns the real runtime.

 ────────────────────────────────────────────────────────────────────────────────

 Host Agent API

 Add routes to src/host.ts.

 State

 ```text
   GET /ui/api/agent/state
 ```

 Returns current server-side state:

 ```json
   {
     "sessionId": "...",
     "cwd": "C:/repos/http_proxy",
     "model": {...},
     "thinkingLevel": "off",
     "messages": [...],
     "isStreaming": false,
     "tools": ["read", "bash", "edit", "write", "delegate", "..."],
     "systemPrompt": "..."
   }
 ```

 Prompt

 ```text
   POST /ui/api/agent/prompt
 ```

 Body:

 ```json
   {
     "input": "Research wage data requirements for software developers and show a chart."
   }
 ```

 Server calls:

 ```ts
   await runtime.session.prompt(input);
 ```

 Abort

 ```text
   POST /ui/api/agent/abort
 ```

 Server calls:

 ```ts
   runtime.session.agent.abort();
 ```

 or the appropriate session-level abort API if exposed.

 Steering/follow-up

 ```text
   POST /ui/api/agent/steer
   POST /ui/api/agent/follow-up
 ```

 Server calls:

 ```ts
   await runtime.session.steer(text);
   await runtime.session.followUp(text);
 ```

 Runtime prompt

 ```text
   GET /ui/api/system-prompt/effective
 ```

 Returns:

 ```json
   {
     "generatedAt": "...",
     "cwd": "...",
     "systemPrompt": runtime.session.agent.state.systemPrompt,
     "tools": runtime.session.agent.state.tools.map(t => t.name)
   }
 ```

 Source prompt files

 ```text
   GET /ui/api/prompt/files
   GET /ui/api/prompt?file=AGENTS.md
 ```

 Allowed:

 ```text
   AGENTS.md
   .pi/agents/*.md
 ```

 ────────────────────────────────────────────────────────────────────────────────

 Streaming Event Bridge

 Host subscribes to the active session:

 ```ts
   let unsubscribe = runtime.session.subscribe((event) => {
     agentWebSocketHub.broadcast(normalizeAgentEvent(event));
   });
 ```

 Important from Pi SDK docs:

 │ runtime.session changes after newSession(), switchSession(), fork(), etc. Re-subscribe after replacement.

 So add:

 ```ts
   function attachSession(session: AgentSession) {
     unsubscribe?.();
     unsubscribe = session.subscribe(...);
   }
 ```

 When runtime changes sessions:

 ```ts
   attachSession(runtime.session);
 ```

 Browser receives events:

 ```text
   WS /ui/ws/agent
 ```

 Event types to forward:

 ```text
   agent_start
   agent_end
   turn_start
   turn_end
   message_start
   message_update
   message_end
   tool_execution_start
   tool_execution_update
   tool_execution_end
   queue_update
   compaction_start
   compaction_end
   auto_retry_start
   auto_retry_end
 ```

 Browser RemoteAgent maps them into pi-web-ui-compatible updates.

 ────────────────────────────────────────────────────────────────────────────────

 Delegate Extension Integration

 Current project has:

 ```text
   .pi/extensions/subagents/index.ts
 ```

 It registers:

 ```ts
   delegate({ agent, task })
 ```

 and emits:

 ```ts
   pi.events.emit("subagent:started", ...)
   pi.events.emit("subagent:completed", ...)
   pi.events.emit("subagent:failed", ...)
 ```

 Long-term, we want this exact delegate flow available to the web main agent.

 Requirement

 The backend runtime must load project extensions.

 That means web-main.ts should continue to use:

 ```ts
   createAgentSessionServices({ cwd })
   createAgentSessionFromServices(...)
   createAgentSessionRuntime(...)
 ```

 instead of creating a bare browser-side Agent.

 That preserves extension loading.

 Sub-agent event display

 Create a tiny extension-to-web bridge.

 Option A: modify .pi/extensions/subagents/index.ts to also call a registered host bridge if present.

 Option B: host listens to pi.events.

 Docs show:

 ```ts
   pi.events.on("my:event", ...)
   pi.events.emit("my:event", ...)
 ```

 If host can access the same extension event bus through services/runtime, subscribe to:

 ```ts
   pi.events.on("subagent:started", ...)
   pi.events.on("subagent:completed", ...)
   pi.events.on("subagent:failed", ...)
 ```

 If not directly accessible, add another project extension:

 ```text
   .pi/extensions/web-event-bridge/index.ts
 ```

 That listens to subagent events and writes them to a local event sink exposed by the host process.

 Simpler early version: rely on normal tool execution events. The delegate tool call and result will already appear as:

 ```text
   tool_execution_start: delegate
   tool_execution_update: delegate
   tool_execution_end: delegate
 ```

 But for a good UI, expose richer subagent lifecycle events.

 Desired browser display:

 ```text
   Research agent started
     task: Find BLS/OEWS wage data requirements...

   Research agent completed
     sources found: ...
     required data: ...
 ```

 In pi-web-ui, render these either as:

 - custom messages
 - tool execution cards
 - a side status panel

 ────────────────────────────────────────────────────────────────────────────────

 Main Agent Research/Data Workflow

 The main system prompt should explicitly instruct the agent:

 When user requests a data visualization:

 1. Identify the data requirement.
 2. If source/schema/methodology is uncertain, use:

 ```ts
   delegate({
     agent: "research",
     task: "Research data requirements for: <user request> ..."
   })
 ```

 3. Use returned research to select sources.
 4. Fetch/transform data.
 5. Render the graphical result as an artifact in the web UI.
 6. Validate if needed.

 Example policy text in AGENTS.md or web runtime prompt:

 ```text
   For user requests that require external data, first determine whether the data source,
   schema, units, methodology, or transformations are ambiguous. If they are, call the
   delegate tool with agent="research" to produce a data requirements brief. Use that
   brief before fetching or visualizing data.
 ```

 ────────────────────────────────────────────────────────────────────────────────

 Graphical Display in Same Web UI

 There are two complementary mechanisms.

 1. pi-web-ui ArtifactsPanel

 This should be the primary mechanism.

 Add a backend tool:

 ```text
   create_artifact
 ```

 or:

 ```text
   render_visualization
 ```

 Parameters:

 ```json
   {
     "title": "Software Developer Employment and Wages",
     "filename": "software-developer-wages.html",
     "mimeType": "text/html",
     "content": "<!DOCTYPE html>..."
   }
 ```

 or:

 ```json
   {
     "title": "Unemployment Rate Trend",
     "filename": "unemployment-rate.svg",
     "mimeType": "image/svg+xml",
     "content": "<svg>...</svg>"
   }
 ```

 Server behavior:

 1. Validate filename.
 2. Save to:

 ```text
   data/artifacts/<session-id>/<artifact-id>/
 ```

 3. Return:

 ```json
   {
     "artifactId": "...",
     "url": "/ui/api/artifacts/<artifactId>",
     "mimeType": "text/html",
     "title": "..."
   }
 ```

 4. Broadcast:

 ```json
   {
     "type": "artifact_created",
     "artifact": {
       "id": "...",
       "title": "...",
       "filename": "...",
       "mimeType": "...",
       "url": "..."
     }
   }
 ```

 Browser inserts this into pi-web-ui’s artifact model or renders it in a custom artifact panel.

 2. Existing /ui/app/:name

 Keep this for durable standalone apps:

 ```text
   /ui/app/bls-explorer
   /ui/app/oe-drilldown
   /ui/app/new-generated-dashboard
 ```

 The web agent can link to or embed these.

 But for prompt-driven one-off graphics, use artifacts.

 ────────────────────────────────────────────────────────────────────────────────

 Visualization Tooling

 Replace or supplement current push_svg.

 Current:

 ```ts
   push_svg → POST http://localhost:3000/ui/svg
 ```

 This was useful for the legacy SVG canvas.

 Long-term web UI should prefer:

 ```text
   create_artifact
   update_artifact
 ```

 Suggested tools:

 create_artifact

 Creates HTML/SVG/Markdown/text artifact.

 update_artifact

 Updates an existing artifact.

 create_chart_svg

 Convenience tool for SVG charts.

 create_chart_html

 Convenience tool for self-contained HTML/D3 charts.

 save_ui_app

 Optional. Writes durable HTML apps to:

 ```text
   src/ui/<name>.html
 ```

 and makes them available at:

 ```text
   /ui/app/:name
 ```

 This should be allowlisted and guarded.

 ────────────────────────────────────────────────────────────────────────────────

 Data APIs

 Current host already has:

 ```text
   POST /ui/api/bls
   GET  /ui/data/*
 ```

 Keep those.

 Long-term add:

 ```text
   GET  /ui/api/status
   GET  /ui/api/lookups/:name
   GET  /ui/api/codes?survey=OE&field=...
   GET  /ui/api/occupations?q=software
   GET  /ui/api/series/validate/:id
   POST /ui/api/data/query
 ```

 The main agent can use tools that call these APIs.

 Example custom tool:

 ```text
   bls_query_series
 ```

 Host-side tool executes:

 ```ts
   POST /ui/api/bls
 ```

 or directly calls BLS API.

 Browser-side display receives resulting artifact.

 ────────────────────────────────────────────────────────────────────────────────

 Security Model

 Moving tools into a browser-controlled UI increases risk.

 Minimum safeguards:

 Browser access

 - Browser only uses http://localhost:8080
 - proxy enforces auth if non-loopback
 - proxy injects x-loopback: 1
 - host rejects non-loopback-header requests

 File access

 For any browser-triggered file/tool API:

 - resolve paths with path.resolve
 - require path remains inside project root or specific subdirectory
 - deny absolute paths from browser
 - deny ..
 - no arbitrary bash endpoint at first

 Artifact writes

 Allow writes only under:

 ```text
   data/artifacts/
   src/ui/
 ```

 depending on tool.

 Prompt editing

 If added later:

 - allowlist AGENTS.md and .pi/agents/*.md
 - backup before write
 - warn that reload/new session is required

 Dangerous tools

 For first web version, avoid exposing raw browser endpoints for:

 ```text
   bash
   edit
   write
 ```

 Instead, keep those inside the server-side agent runtime where tool calls are visible as part of the agent event stream.

 ────────────────────────────────────────────────────────────────────────────────

 File-Level Change Blueprint

 package.json

 Add web scripts and deps.

 Conceptually:

 ```json
   {
     "scripts": {
       "dev:web": "tsc && vite build --config src/web/vite.config.ts && node dist/web-main.js",
       "build:web": "vite build --config src/web/vite.config.ts",
       "start:web": "node dist/web-main.js"
     },
     "dependencies": {
       "@mariozechner/pi-web-ui": "...",
       "@mariozechner/mini-lit": "...",
       "lit": "...",
       "vite": "..."
     }
   }
 ```

 Maybe use dev server during development, but final target should be host-served build through proxy.

 src/web-main.ts

 New primary process.

 Responsibilities:

 - create MCP tools
 - create custom tools
 - create AgentSessionRuntime
 - start in-process host
 - start proxy
 - subscribe to shutdown
 - no InteractiveMode

 src/cli.ts

 Eventually either:

 1. Keep as legacy TUI entrypoint, or
 2. Replace with mode switch:

 ```bash
   node dist/cli.js --ui tui
   node dist/cli.js --ui web
 ```

 Recommended:

 ```text
   src/cli.ts       legacy TUI for now
   src/web-main.ts  new web-first entry
 ```

 Then later retire TUI.

 src/host.ts

 Refactor from immediate server startup to:

 ```ts
   export function startHost(ctx: HostContext): HostServer
 ```

 Add:

 ```text
   /ui
   /ui/assets/*
   /ui/ws/agent
   /ui/api/agent/state
   /ui/api/agent/prompt
   /ui/api/agent/abort
   /ui/api/agent/steer
   /ui/api/agent/follow-up
   /ui/api/system-prompt/effective
   /ui/api/prompt/files
   /ui/api/prompt
   /ui/api/artifacts/*
 ```

 Keep:

 ```text
   /ui/app/:name
   /ui/data/*
   /ui/api/bls
   /ui/canvas          maybe legacy
   /ui/svg             maybe legacy
 ```

 src/proxy.ts

 Recommended change:

 - inject x-loopback: 1
 - support WebSocket forwarding for /ui/ws/agent
 - keep auth behavior

 src/web/src/main.ts

 Creates pi-web-ui shell:

 ```ts
   import { ChatPanel } from "@mariozechner/pi-web-ui";
   import "@mariozechner/pi-web-ui/app.css";
   import { RemoteAgent } from "./remote-agent";

   const agent = new RemoteAgent();
   await agent.connect();

   const chatPanel = new ChatPanel();
   await chatPanel.setAgent(agent as any, {
     // tools are backend-owned, API keys are backend-owned
   });

   document.getElementById("app")!.appendChild(chatPanel);
 ```

 src/web/src/remote-agent.ts

 Client-side bridge between pi-web-ui and backend runtime.

 Responsibilities:

 - load initial state
 - send prompts
 - abort
 - receive WS events
 - maintain state
 - emit events to pi-web-ui

 src/artifacts.ts

 New server-side artifact store.

 Responsibilities:

 - create artifact IDs
 - validate names
 - save content
 - serve content
 - emit artifact events

 .pi/extensions/subagents/index.ts

 Keep as-is initially.

 Optional later changes:

 - improve structured result payload
 - emit richer progress details
 - expose subagent transcript path
 - add artifact/data-research-specific metadata

 ────────────────────────────────────────────────────────────────────────────────

 Runtime Event to Web UI Mapping

 Server event:

 ```text
   message_update
 ```

 Browser action:

 - update streaming assistant message

 Server event:

 ```text
   tool_execution_start
 ```

 Browser action:

 - render tool card
 - if tool name is delegate, show “Research agent running”

 Server event:

 ```text
   tool_execution_update
 ```

 Browser action:

 - update tool card progress

 Server event:

 ```text
   tool_execution_end
 ```

 Browser action:

 - close/update tool card
 - if delegate, show research summary

 Server event:

 ```text
   artifact_created
 ```

 Browser action:

 - open artifact panel
 - show HTML/SVG/chart

 ────────────────────────────────────────────────────────────────────────────────

 End-to-End Desired Flow

 User opens:

 ```text
   http://localhost:8080/ui
 ```

 User prompt:

 ```text
   Show me software developer wage distribution and explain what data source is required.
 ```

 Flow:

 ```text
   Browser pi-web-ui
     ↓ POST /ui/api/agent/prompt
   host runtime.session.prompt(...)
     ↓
   main agent receives prompt
     ↓
   main agent decides data requirements are ambiguous
     ↓
   main agent calls delegate({ agent: "research", task: "Find BLS OEWS data requirements..." })
     ↓
   subagent extension starts isolated child pi process
     ↓
   research agent returns data source/schema/interval findings
     ↓
   main agent fetches/transforms data
     ↓
   main agent calls create_artifact({ filename: "wage-distribution.svg", ... })
     ↓
   host saves artifact and broadcasts artifact_created
     ↓
   browser pi-web-ui opens artifact panel
     ↓
   user sees explanation + chart in same UI
 ```

 ────────────────────────────────────────────────────────────────────────────────

 Migration Phases

 Phase W0 — Stabilize current host/proxy

 - Keep current /ui portal.
 - Restart issues solved.
 - Add prompt viewer if useful.

 Phase W1 — Add web-main without removing TUI

 - Create src/web-main.ts.
 - It starts runtime + host + proxy.
 - No TUI.
 - Add npm run dev:web.

 Acceptance:

 ```bash
   npm run dev:web
 ```

 opens browser UI.

 Phase W2 — Serve pi-web-ui shell at /ui

 - Add Vite web app.
 - Host serves built app.
 - Browser shows pi-web-ui ChatPanel.
 - Initially connect to backend with read-only state/prompt submission.

 Acceptance:

 - User can send prompt from browser.
 - Backend agent responds.
 - Streaming appears in browser.

 Phase W3 — Runtime event bridge

 - Full event streaming over /ui/ws/agent.
 - Tool execution cards show up.
 - delegate calls visible.

 Acceptance:

 - User prompt triggers delegate.
 - Browser shows delegate tool execution/progress/result.

 Phase W4 — Artifact/visualization pipeline

 - Add create_artifact tool.
 - Browser artifact panel displays SVG/HTML.
 - Deprecate push_svg for primary workflow.

 Acceptance:

 - Agent creates chart artifact.
 - Chart appears in same web UI.

 Phase W5 — Data APIs and visualization tools

 - Add BLS/search/SQLite APIs.
 - Add specialized data tools.
 - Add validator path.

 Acceptance:

 - Agent researches, fetches, transforms, renders, validates.

 Phase W6 — TUI retirement

 - Keep TUI as optional fallback.
 - Default command becomes web-first:

 ```bash
   npm run dev:web
 ```

 or:

 ```bash
   npm run dev
 ```

 ────────────────────────────────────────────────────────────────────────────────

 Key Architectural Decision

 The most important decision is this:

 │ Use pi-web-ui as the browser rendering layer, but keep the real agent runtime on the server/host side.

 Do not make the long-term system a purely browser-side Agent unless you are willing to give up the existing Pi coding-agent runtime, extension loading, delegate framework, local tools, and secure backend data pipeline.

 The best long-term target is:

 ```text
   pi-web-ui frontend
   +
   host-owned AgentSessionRuntime backend
   +
   extension delegate preserved
   +
   artifact-based graphical output
 ```

 That gives you the browser UX you want without throwing away the existing Pi agent architecture.
---

## Implementation Update — 2026-05-05: Web-main Tasks 1–3

Implemented the first three incremental migration tasks:

1. **Refactor host startup**
   - `src/host.ts` now exports `startHost(ctx?: HostContext)`.
   - Standalone host behavior is preserved via main-module detection, so `npm run dev:host` still works.
   - Existing routes remain intact: `/ui`, `/ui/app/:name`, `/ui/canvas`, `/ui/data/*`, `/ui/api/bls`, `/ui/svg`.

2. **Add web-main entrypoint**
   - Added `src/web-main.ts`.
   - `web-main` creates the Pi `AgentSessionRuntime`, starts host in-process with runtime access, and starts only the proxy as a child process.
   - It does **not** start `InteractiveMode`, so no TUI is launched.
   - Added package scripts: `dev:web` and `start:web`.

3. **Add initial Host Agent API**
   - Added `GET /ui/api/agent/state`.
   - Added `POST /ui/api/agent/prompt`.
   - Added `POST /ui/api/agent/abort`.
   - Added `GET /ui/api/system-prompt/effective`.
   - Standalone `dev:host` returns `503` for agent APIs because no runtime is present.
   - `dev:web` returns live runtime state and effective system prompt.

Additional support:

- Added `src/env.ts` with `loadProjectEnv()` to load `.env` and `data/.env` before runtime/model registry creation.
- `src/cli.ts` now also calls `loadProjectEnv()` so current TUI startup can see keys such as `OPENROUTER_API_KEY`.

Validation:

- `npm run build` passes.
- Standalone host/proxy tested on alternate ports:
  - `/ui` returned portal HTML.
  - `/ui/app/bls-explorer` returned app HTML.
  - `/ui/api/agent/state` returned `503`, as expected without runtime.
- `web-main` tested on alternate ports:
  - `/ui/api/agent/state` returned live runtime JSON.
  - `/ui/api/system-prompt/effective` returned the assembled runtime prompt.
  - empty prompt POST returned `400` without invoking a model.

Next planned step: Phase 4, Streaming Event Bridge via `/ui/ws/agent`.

---

## Implementation Update — 2026-05-06: Phase 4 Streaming Event Bridge

Implemented the initial runtime event bridge in `src/host.ts`:

- Added `WS /ui/ws/agent` for browser-side runtime event streaming.
- The host subscribes to `runtime.session.subscribe(...)` and broadcasts events as JSON messages:
  - `type: "agent_event"`
  - includes `sessionId`, `event`, and `receivedAt`.
- New WebSocket clients receive:
  - `agent_bridge_ready`
  - `agent_state` when a runtime is available, or `agent_bridge_status` with `status: "no_runtime"` in standalone `dev:host`.
- Added JSON-safe event normalization for errors, bigint values, functions, symbols, and circular references.
- Added reattachment handling for runtime session replacement APIs:
  - `newSession`
  - `switchSession`
  - `fork`
  - `importFromJsonl`
- Preserved the existing legacy SVG canvas socket at `WS /ui/ws`.

Related fixes/verification:

- Restored the host default port to `3000` to match `src/proxy.ts` and the documented architecture.
- Updated `src/web-main.ts` so the spawned proxy targets the active `HOST_PORT`.
- Updated the web-main `push_svg` tool to post to the active `HOST_PORT` instead of a hardcoded stale port.
- Fixed WebSocket proxy close handling so reserved/invalid close codes such as `1005` are not forwarded to `ws.close()`.

Validation:

- `npm run build` passes.
- `package.json` parses successfully and contains `dev:web` / `start:web`.
- Standalone host/proxy on alternate ports:
  - `GET /ui/api/agent/state` returned `503`, expected with no runtime.
  - `WS /ui/ws/agent` returned `agent_bridge_ready` and `agent_bridge_status: no_runtime`.
- `web-main` on alternate ports:
  - `GET /ui/api/agent/state` returned `200` with a live session id, tools, and system prompt.
  - `WS /ui/ws/agent` returned `agent_bridge_ready` and `agent_state`.

Notes:

- Git diff stats do not include untracked files such as `src/web-main.ts`, `src/env.ts`, and `conversations/2026-05-05-blueprint.md`; mention those explicitly in summaries.
- `POST /ui/api/agent/prompt` still awaits `runtime.session.prompt(input)`, so the HTTP response blocks until the model turn finishes. Streaming events are available concurrently over `WS /ui/ws/agent`.
- Validation still avoids sending a non-empty prompt to prevent unnecessary real model invocations.
- If `npm run dev:web` fails because old host/proxy processes already occupy the configured ports, stop those processes first or run on alternate `HOST_PORT` / `PORT` values.

---

## Implementation Update — 2026-05-06: Phase 4 Hardening / Port Realignment

Follow-up hardening after review:

- Changed the project host default from `3000` to `3100` because port `3000` is used by a local MCP server.
  - `src/host.ts` default `HOST_PORT`: `3100`
  - `src/proxy.ts` default `TARGET`: `http://127.0.0.1:3100`
  - `src/web-main.ts` default spawned proxy target host port: `3100`
  - `src/cli.ts` `push_svg` now uses active `HOST_PORT` instead of hardcoded `3000`
  - `AGENTS.md` architecture notes now document host `:3100`
- Refactored the runtime event bridge toward the SDK-documented shape:
  - explicit `attachSession(session: AgentSession)`
  - explicit `detachSession()`
  - `attachCurrentSession()` for runtime replacement handling
  - still reattaches after `newSession`, `switchSession`, `fork`, and `importFromJsonl`
- Added defensive WebSocket send handling for agent event broadcasts.
- Made the proxy inject `x-loopback: 1` for HTTP and WebSocket upstream requests, removing the normal double-hop through the host fallback path.
- Added clearer host/proxy `EADDRINUSE` startup errors.
- Updated `POST /ui/api/agent/prompt` to return `202 Accepted` immediately for non-empty prompts and stream completion/error over `WS /ui/ws/agent`.
  - Empty prompts still return `400`.
  - Concurrent prompts return `409`.
- Added web-main extension binding/rebinding:
  - calls `runtime.session.bindExtensions({})` at startup
  - rebinds after `newSession`, `switchSession`, `fork`, and `importFromJsonl`

Validation:

- `npm run build` passes.
- Standalone host/proxy on alternate ports:
  - `HOST_PORT=3197`, `PORT=8197`
  - `GET /ui/api/agent/state` returned `503`, expected without runtime.
  - `WS /ui/ws/agent` returned `agent_bridge_ready` and `agent_bridge_status: no_runtime`.
  - Proxy header injection removed duplicate host/proxy logs for normal requests.
- `web-main` on alternate ports:
  - `HOST_PORT=3196`, `PORT=8196`
  - `GET /ui/api/agent/state` returned `200` with live session id, tools, and system prompt.
  - `WS /ui/ws/agent` returned `agent_bridge_ready` and `agent_state`.
  - Empty prompt POST returned `400` without invoking a model.

Package alignment note:

- Current npm registry versions show the Pi packages aligned at `0.73.0`:
  - `@mariozechner/pi-coding-agent@0.73.0`
  - `@mariozechner/pi-agent-core@0.73.0`
  - `@mariozechner/pi-tui@0.73.0`
  - `@mariozechner/pi-web-ui@0.73.0`
- Best next dependency step is to pin all Pi packages to the same exact version, preferably `0.73.0`, then rebuild and adapt any API changes before adding the Vite/pi-web-ui shell.

---

## Implementation Update — 2026-05-06: Phase W2 Finalized

Completed Phase W2, serving the `pi-web-ui` browser shell at `/ui` with a client-side `RemoteAgent` adapter connected to the host-owned backend runtime.

Implemented/verified:

- Added Vite web app under `src/web/`:
  - `src/web/index.html`
  - `src/web/vite.config.ts`
  - `src/web/src/main.ts`
  - `src/web/src/app.css`
  - `src/web/src/remote-agent.ts`
- Host now serves the built app from `dist/web` at:
  - `GET /ui`
  - `GET /ui/assets/*`
- Legacy portal remains available at:
  - `GET /ui/portal`
- `RemoteAgent` now:
  - Loads initial server state from `GET /ui/api/agent/state`.
  - Sends prompts via `POST /ui/api/agent/prompt`.
  - Connects to `WS /ui/ws/agent`.
  - Applies runtime events to `pi-web-ui` state.
  - Normalizes assistant/tool messages with string content into pi-web-ui content-part arrays so streamed/final assistant messages render correctly.
  - Preserves the local `artifacts` tool while refreshing server-side tool placeholders.
- `src/web/src/main.ts` creates a `ChatPanel`, disables browser-side attachments/model/thinking controls for this server-owned runtime preview, and installs the remote agent.
- Package scripts/dependencies are aligned for the web build:
  - `npm run build:web`
  - `npm run dev:web`
  - `npm run start:web`
  - Pi packages pinned to `0.73.0`.

Validation:

- `npm run build` passes.
- `npm run build:web` passes. Vite emits non-fatal KaTeX font resolution warnings from upstream CSS and large chunk warnings.
- Browser smoke test with a fake backend runtime through host/proxy on alternate ports passed:
  - Opened `http://localhost:8291/ui`.
  - Loaded the pi-web-ui `ChatPanel`.
  - Sent a prompt from the browser.
  - Host accepted `POST /ui/api/agent/prompt`.
  - `WS /ui/ws/agent` delivered streamed message updates.
  - Browser rendered both the user message and final assistant response: `Hello from the W2 streaming backend.`
  - Screenshot saved at `artifacts/w2-smoke.png`.

W2 acceptance is satisfied:

- User can send a prompt from browser.
- Backend agent/runtime receives the prompt.
- Streaming/final response appears in browser.

Next phase: W3 should deepen tool execution rendering and delegate/subagent lifecycle visibility, including richer progress/result cards for `delegate` calls.
