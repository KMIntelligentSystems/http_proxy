# Web Search MCP Server — Design

## Overview

A lightweight MCP server that wraps a search API (Brave Search recommended),
providing controlled, auditable web search to the agent.

## Architecture

```
Agent ──► mcporter ──► search-mcp (:3004) ──► Brave Search API
                            │
                            ├── query sanitization
                            ├── domain allowlist (optional)
                            ├── result sanitization
                            └── audit log
```

## Tools Exposed

### `web_search`
General web search returning text snippets.

```json
{
  "name": "web_search",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":       { "type": "string", "description": "Search query" },
      "count":       { "type": "number", "description": "Max results (default 5, max 20)" },
      "site_filter": { "type": "string", "description": "Restrict to domain (e.g. bls.gov)" }
    },
    "required": ["query"]
  }
}
```

**Returns:** Array of `{title, snippet, url}` as text content. No raw HTML.

### `fetch_page` (optional, gated)
Fetch a specific URL and return extracted text content.

```json
{
  "name": "fetch_page",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url":        { "type": "string", "description": "URL to fetch" },
      "max_length": { "type": "number", "description": "Max chars to return (default 5000)" }
    },
    "required": ["url"]
  }
}
```

**Returns:** Extracted text content (HTML stripped). Only allowed for domains
in the allowlist.

## Security Controls

### Input Sanitization
- Strip control characters from queries
- Enforce max query length (256 chars)
- Reject queries containing suspicious patterns (encoded URLs, base64 blocks)

### Domain Allowlist (configurable)
```json
{
  "allowlist_mode": "warn",  // "off" | "warn" | "enforce"
  "allowed_domains": [
    "bls.gov",
    "census.gov",
    "fred.stlouisfed.org",
    "api.bls.gov",
    "data.gov"
  ]
}
```

- **off**: no restrictions
- **warn**: log when results outside allowlist are returned
- **enforce**: only return results from allowed domains

### Result Sanitization
- Strip all HTML tags
- Remove tracking parameters from URLs
- Truncate snippets to max length
- No JavaScript, no embedded content

### Rate Limiting
- Max queries per minute (configurable, default 10)
- Max queries per session (configurable, default 100)

### Audit Log
Every query logged with timestamp, query text, result count, domains returned:
```jsonl
{"ts":"2026-04-12T22:00:00Z","query":"BLS OES series ID format","count":5,"domains":["bls.gov","bls.gov","stackoverflow.com"]}
```

## API Key Management
- Stored in environment variable `BRAVE_SEARCH_API_KEY`
- Never exposed to agent — server reads it at startup
- Alternatively: `.env` file in server directory (gitignored)

## Implementation Skeleton

```
search-mcp/
├── server.ts          # MCP server (Express + @modelcontextprotocol/sdk)
├── search.ts          # Brave Search API client
├── sanitize.ts        # Input/output sanitization
├── allowlist.ts       # Domain filtering
├── audit.ts           # Query logging
├── config.ts          # Configuration (allowlist, rate limits, etc.)
├── package.json
├── .env.example       # BRAVE_SEARCH_API_KEY=
└── README.md
```

### server.ts — Key Structure

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({ name: "web-search", version: "1.0.0" });

server.tool("web_search", schema, async (params) => {
  // 1. Sanitize query
  // 2. Check rate limit
  // 3. Call Brave Search API
  // 4. Filter by allowlist
  // 5. Sanitize results
  // 6. Audit log
  // 7. Return {content: [{type: "text", text: "..."}]}
});

// Optional gated tool
server.tool("fetch_page", schema, async (params) => {
  // 1. Validate URL against allowlist (enforce mode)
  // 2. Fetch with timeout
  // 3. Extract text (strip HTML)
  // 4. Truncate
  // 5. Return text content
});
```

## Registration in cli.ts

```typescript
const { tools: mcpTools, runtime: mcpRuntime } = await createMcpTools([
  { name: "codegen",    url: "http://localhost:3003/mcp", ... },
  { name: "playwright", url: "http://localhost:3000/mcp" },
  { name: "search",     url: "http://localhost:3004/mcp" },
]);
```

## Brave Search API

- **Endpoint**: `https://api.search.brave.com/res/v1/web/search`
- **Auth**: `X-Subscription-Token` header
- **Free tier**: 2,000 queries/month
- **Response**: JSON with `web.results[]` containing `title`, `description`, `url`
- **Docs**: https://brave.com/search/api/

## Alternatives to Brave

| Provider | Free Tier | Notes |
|----------|-----------|-------|
| Brave Search | 2K/mo | Privacy-focused, clean JSON |
| SerpAPI | 100/mo | Google results, expensive beyond free |
| Tavily | 1K/mo | Built for AI agents, includes extract |
| Bing Web Search | 1K/mo | Microsoft, good coverage |

Brave is recommended for privacy posture and simplicity.
