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