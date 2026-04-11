# MEMORY.md — Preliminary

> This file will evolve as the project matures. Current status: early-stage.

## Project Overview

Data visualization agent built on the Pi coding-agent SDK. Fetches data from
external sources, transforms it, and renders interactive SVG charts in a browser.

## Architecture

```
Browser ──► proxy (:8080) ──► host (:3000)
                 ▲                  │  ├── /ui          HTML + D3.js canvas
                 └── loopback ──────┘  ├── /ui/ws       WebSocket push
                                       └── /ui/svg      POST endpoint for SVG messages
```

| Component | File | Port | Role |
|-----------|------|------|------|
| proxy | `src/proxy.ts` | 8080 | Reverse proxy, auth, WS upgrade |
| host | `src/host.ts` | 3000 | UI shell, WebSocket broadcast, SVG push API |
| cli | `src/cli.ts` | — | Pi TUI: spawns proxy+host, registers tools, runs agent |
| mcp-tools | `src/mcp-tools.ts` | — | MCP-to-pi tool bridge via mcporter |

## Tech Stack

- **Runtime**: Node 24, ES modules, TypeScript 6
- **Agent SDK**: `@mariozechner/pi-coding-agent` + `pi-tui` + `pi-agent-core`
- **Tool schemas**: `@sinclair/typebox`
- **MCP bridge**: `mcporter` → connects to MCP servers, exposes as pi tools
- **Browser rendering**: D3.js (CDN, client-side)
- **WebSocket**: `ws` library for real-time SVG push

## Build & Run

```bash
pnpm run build        # tsc
pnpm run start:tui    # node dist/cli.js  (starts proxy + host + agent TUI)
pnpm run dev:tui      # build + start
```

Proxy/host logs → `dist/proxy-host.log`

## Custom Tools Registered

| Tool | Defined in | Description |
|------|-----------|-------------|
| `push_svg` | `src/cli.ts` | Push SVG to browser canvas (posts to host :3000 with `x-loopback: 1`) |
| `hello` | `src/cli.ts` | Test greeting tool |
| MCP tools (codegen) | `src/mcp-tools.ts` → `localhost:3003/mcp` | Python execution via codegen MCP server |

## Key Conventions

- **SVG push**: `push_svg` posts to host `:3000` directly (bypasses proxy). Browser connects via proxy `:8080`.
- **Canvas pre-check**: Always navigate to `http://localhost:8080/ui` with Playwright before pushing SVG. If no browser WS client is connected, `push_svg` returns 204 but nothing renders.
- **No `<script>` tags in SVG push** — browsers block innerHTML script execution. Generate final SVG server-side.
- **Dark theme**: bg `#161b22`, text `#c9d1d9`, grid `#30363d`, accents `#58a6ff` `#3fb950` `#f78166` `#d2a8ff`
- **Data output**: When using Python/scripts, print final result as JSON to stdout.

## What's Working

- [x] CLI with MCP tool bridge (mcporter)
- [x] Proxy + host process management from cli.ts
- [x] push_svg tool for SVG canvas updates
- [x] AGENTS.md system prompt with full pipeline description

## What's Not Yet Done

- [ ] Validate host UI supports D3.js rendering end-to-end
- [ ] Test with real data source (BLS, FRED, etc.)
- [ ] Playwright validation workflow
- [ ] Richer chart types and interactivity

## Notes

- `createMcpTools()` in `src/mcp-tools.ts` accepts an array of MCP server configs — extensible for adding more servers
- Proxy/host are spawned as child processes with stdout/stderr piped to a log file
- `InteractiveMode` owns the terminal after boot — handles TUI input loop
