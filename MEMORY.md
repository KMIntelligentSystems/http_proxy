# HTTP Proxy + BLS Visualization Project

## Architecture

```
Browser ──► proxy (:8080) ──► host (:3000)
                                ├── /ui          HTML + D3.js canvas
                                ├── /ui/ws       WebSocket push (SVG + chart data)
                                └── /ui/svg      POST endpoint for SVG messages
```

## Entry Points

| File | Purpose |
|------|---------|
| `src/proxy.ts` | HTTP reverse proxy (port 8080 → 3000), auth, WS upgrade |
| `src/host.ts` | Backend: serves UI, WebSocket broadcast, SVG push API |
| `src/cli.ts` | Pi TUI: spawns proxy+host, runs InteractiveMode |
| `src/sdk.ts` | **NEW** — SDK session with custom tools (phase 1) |
| `src/tools.ts` | **NEW** — Custom tool definitions (bls_fetch, push_chart, clear_canvas) |
| `src/bls.ts` | **NEW** — BLS API client |

## Custom Tools

| Tool | Description |
|------|-------------|
| `bls_fetch` | Fetch time-series data from BLS Public API v2 |
| `push_chart` | Push D3.js chart config to browser canvas via host API |
| `clear_canvas` | Clear the browser canvas |

## BLS API

- **Base URL**: `https://api.bls.gov/publicAPI/v2/timeseries/data/`
- **Key series**:
  - `CUSR0000SA0` — CPI (Consumer Price Index, All Urban)
  - `LNS14000000` — Unemployment Rate
  - `CES0000000001` — Total Nonfarm Payrolls
  - `CES0500000003` — Average Hourly Earnings
- **Rate limits**: 25 req/day without key, 500 with key
- **Env var**: `BLS_API_KEY` (optional)

## Phases

- [x] Phase 1: SDK session (`src/sdk.ts`) with custom tools, no TUI
- [ ] Phase 2: Upgrade host UI to support D3.js chart rendering
- [ ] Phase 3: Wire custom tools into TUI (`src/cli.ts`) via extensionFactories
- [ ] Phase 4: Richer chart types, interactivity, analysis prompts

## Tech Stack

- TypeScript (ES module, Node 24)
- Pi SDK (`@mariozechner/pi-coding-agent`)
- TypeBox for tool parameter schemas
- D3.js (browser-side, CDN)
- BLS Public API v2
- WebSocket for real-time chart push

## Key Decisions

- D3.js runs **client-side** (browser) — we push data + chart config, browser renders
- Host UI upgraded with new message type `{ type: "chart", ... }` for D3 rendering
- Custom tools registered via `customTools` array in `createAgentSession`
- BLS data cached in-memory to respect rate limits
