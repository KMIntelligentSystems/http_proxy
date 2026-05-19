# CLI Architecture — In-Process Host + Artifact Store

**Date:** 2026-05-19
**Context:** Consolidating `web-main.ts` and `cli.ts` into a single architecture where the host runs in-process so visualization tools and the artifact store share the same event space.

## Problem

`cli.ts` spawned `host.js` as a child process. The agent runtime (in the CLI process) calls `create_artifact` / `create_chart_svg` / etc., which write to disk via `ArtifactStore`. But `artifactStore.onCreated()` is an **in-memory listener** — it only fires in the process that registered it. The host process has its own `ArtifactStore` instance with its own listeners. Result: `artifact_created` WebSocket events were never broadcast to browsers when the agent created artifacts.

```
Before (broken):
┌─────────────────┐     spawn      ┌─────────────────┐
│ cli.ts process  │ ────────────── │ host.js process │
│  • agent runtime│                │  • artifactStore │  ← onCreated fires here (host-side)
│  • tools        │                │  • WS broadcast  │     but tools create in cli.ts
│  • NO artifact  │                │  • HTTP server   │     → no broadcast ever
└─────────────────┘                └─────────────────┘
```

This is independent of storage backend — even with SQLite, `onCreated` is an in-memory `Set<ArtifactListener>`, not a database trigger.

## Solution

Run `startHost()` in-process inside `cli.ts`. The proxy stays as a child process (it's a stateless reverse proxy).

```
After (fixed):
┌──────────────────────────────────────────────┐
│ cli.ts process                               │
│                                              │
│  artifactStore ───┬── create_artifact tool   │
│                   ├── startHost()            │
│                   │   └── onCreated() fires   │
│                   │       → WS broadcast ✅   │
│                   └── same memory space      │
│                                              │
│  child: proxy.js (stateless)                 │
└──────────────────────────────────────────────┘
```

## Changes to `src/cli.ts`

| Area | Before | After |
|------|--------|-------|
| Host | `spawn("node", "dist/host.js")` | `startHost({ runtime, artifactStore })` in-process |
| Proxy | `spawn("node", "dist/proxy.js")` | `spawn("node", "dist/proxy.js")` — unchanged |
| Artifact store | None | `createArtifactStore(...)` shared between tools and host |
| Tools | `hello`, `push_svg` only | Added: `create_artifact`, `create_chart_svg`, `create_bls_sa_nsa_chart`, `create_document` |
| Session ID | N/A | Mutable ref pattern: `sessionIdRef.current` wired after runtime creation |
| Shutdown | `stopAll()` kills child procs | `stopProxy()` + `await host.close()` |
| Boot order | Proxy → Host → Runtime → TUI | Runtime → Host → Proxy → TUI |

### Session ID — mutable ref pattern

`createVisualizationTools()` takes a `getSessionId` callback. The runtime doesn't exist yet when tools are created. A mutable ref object bridges the gap:

```ts
const sessionIdRef = { current: (): string | null => null };

const visualizationTools = createVisualizationTools({
  artifactStore,
  getSessionId: () => sessionIdRef.current(),  // delegates through ref
  cwd: process.cwd(),
});

// ... later, after runtime creation:
sessionIdRef.current = () => runtime.session?.sessionId ?? null;
```

## What didn't change

- **`web-main.ts`** — unchanged. Still works with `npm run start:web`. Still runs host in-process (it always did).
- **`host.ts`** — unchanged. Same `startHost()` API. When called with `{ runtime, artifactStore }`, it attaches `onCreated` listeners and broadcasts; when called standalone (was `node dist/host.js` from spawn), it creates its own orphan artifact store.
- **`proxy.ts`** — unchanged. Still a child process in both modes.
- **React app** — unchanged. Connects to `/ui/ws/agent` and `/ui/api/agent/prompt` the same way.
- **`visualization-tools.ts`** — unchanged. Already a clean standalone module.

## Launch

```bash
npm run build          # TypeScript backend → dist/
npm run build:web      # Vite React app → dist/web/
npm run dev:tui        # → proxy (:8080) + host (:3100) + agent TUI
                       # Open http://localhost:8080/ui
```

## Event flow (artifact creation)

```
Agent calls create_artifact("chart.svg", ...)
  → visualization-tools.ts execute()
    → artifactStore.create(input)
      → writes metadata.json + content to data/artifacts/<sessionId>/<id>/
      → fires onCreated(record) listeners  ← in-memory, same process
        → host.ts listener receives it
          → broadcastAgentWsMessage({ type: "artifact_created", artifact: record })
            → all browser WebSocket clients receive it
              → React useAgent hook updates artifacts[]
                → SavedDocs list + DocumentViewer update
```

## Future: SQLite migration

When `ArtifactStore` moves to SQLite:
- `create()` writes to SQLite, then fires `onCreated()` in-memory — **same behavior**
- `get()` / `list()` read from SQLite
- No architectural changes needed — the in-process design works regardless of storage backend
