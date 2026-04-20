---
name: web-search-mcp
description: Web search and page fetching tools provided by the Web Search MCP server. Use to research external information and retrieve page text.
---

# Web Search MCP Tools

These tools are served by the Web Search MCP server at `http://localhost:3004/mcp` (Brave Search backend).

## When to Use

- You need up-to-date information from the public web.
- You want to discover relevant sources via search queries.
- You need to retrieve sanitized text content from a specific URL (subject to allowlist and site policies).

Avoid unnecessary calls when the answer is already known or available locally.

## Available Tools

### `web_search`
- Parameters: `query` (string), optional `count` (max results, default 5), optional `site_filter` (limit to one domain).
- Returns: ranked search results with title, snippet, and URL. Results are sanitized before delivery.
- Usage: Issue a search query to locate relevant sources before fetching pages.

### `fetch_page`
- Parameters: `url` (string), optional `max_length` (int, default 10,000 characters).
- Returns: Plain-text content extracted from the page body, subject to Brave sanitization rules and site allowlists.
- Notes: Some domains (e.g., certain BLS endpoints) block automated access and may return HTTP 403. Respect robots.txt and site policies.

## Notes

- All requests pass through the MCP proxy; API keys are managed server-side.
- Results are intended for research and attribution—always cite sources when using retrieved information.
- Handle rate limits gracefully: retry sparingly and back off on repeated errors.
