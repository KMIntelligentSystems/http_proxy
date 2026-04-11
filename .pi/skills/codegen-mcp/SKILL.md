---
name: codegen-mcp
description: Code generation tools provided via MCP server. Use when asked to generate, scaffold, or transform code using the codegen service.
---

# CodeGen MCP Tools

These tools are provided by the CodeGen MCP server at `http://localhost:3003/mcp`.

## When to Use

- Code generation, scaffolding, or transformation tasks
- When the user explicitly asks to use the codegen service

## Available Tools

The tools are dynamically discovered from the MCP server at startup. Use the tool names as listed in the tool definitions.

## Notes

- All tools are proxied through mcporter to the MCP server
- Tool parameters match the MCP server's input schemas
- Results are returned as text content extracted from the MCP response envelope
