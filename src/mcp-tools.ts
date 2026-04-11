/**
 * MCP-to-pi tool bridge.
 *
 * Connects to MCP servers via mcporter, lists their tools, and converts them
 * into pi ToolDefinition[] that can be passed to createAgentSessionFromServices.
 *
 * Optionally associates a SKILL.md with the tools so the agent gets context
 * about when and how to use them.
 */

import { type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type TObject } from "@sinclair/typebox";
import {
  createRuntime as createMcpRuntime,
  type ServerDefinition,
  type Runtime as McpRuntime,
} from "mcporter";
import fs from "node:fs";
import path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** Unique name for this MCP server (used as mcporter registration key). */
  name: string;
  /** HTTP URL the MCP server listens on. */
  url: string;
  /**
   * Optional path to a SKILL.md whose content is injected as `promptSnippet`
   * on every tool from this server, giving the agent usage context.
   */
  skillPath?: string;
  /**
   * Optional prompt guidelines applied to every tool from this server.
   */
  promptGuidelines?: string[];
}

export interface McpBridgeResult {
  /** pi-compatible tool definitions for all discovered MCP tools. */
  tools: ToolDefinition[];
  /** The underlying mcporter runtime (caller may need it for cleanup). */
  runtime: McpRuntime;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Connect to one or more MCP servers and return pi ToolDefinitions for all
 * their tools.
 *
 * ```ts
 * const { tools, runtime } = await createMcpTools([
 *   { name: "codegen", url: "http://localhost:3003/mcp", skillPath: ".pi/skills/codegen-mcp/SKILL.md" },
 * ]);
 * ```
 */
export async function createMcpTools(
  servers: McpServerConfig[],
): Promise<McpBridgeResult> {
  const runtime = await createMcpRuntime();
  const allTools: ToolDefinition[] = [];

  for (const server of servers) {
    const definition: ServerDefinition = {
      name: server.name,
      command: { kind: "http", url: new URL(server.url) },
    };

    await runtime.registerDefinition(definition);

    // Read optional SKILL.md for this server
    const promptSnippet = readSkillContent(server.skillPath);

    const mcpTools = await runtime.listTools(server.name, {
      includeSchema: true,
    });

    for (const tool of mcpTools) {
      allTools.push(
        createToolDefinition(runtime, server, tool, promptSnippet),
      );
    }
  }

  return { tools: allTools, runtime };
}

// ─── Internals ────────────────────────────────────────────────────────────────

function createToolDefinition(
  runtime: McpRuntime,
  server: McpServerConfig,
  tool: { name: string; description?: string; inputSchema?: unknown },
  promptSnippet: string | undefined,
): ToolDefinition {
  return {
    name: tool.name,
    label: `${server.name}/${tool.name}`,
    description: tool.description ?? "",
    parameters: jsonSchemaToTypebox(tool.inputSchema),
    ...(promptSnippet ? { promptSnippet } : {}),
    ...(server.promptGuidelines ? { promptGuidelines: server.promptGuidelines } : {}),

    async execute(_toolCallId, params: any, _signal) {
      const result = await runtime.callTool(server.name, tool.name, {
        args: params,
      });
      const content = extractContent(result);
      return { content, details: { server: server.name, tool: tool.name } };
    },
  };
}

/**
 * Read a SKILL.md file and return its content, or undefined if not found.
 */
function readSkillContent(skillPath: string | undefined): string | undefined {
  if (!skillPath) return undefined;
  const resolved = path.resolve(skillPath);
  try {
    return fs.readFileSync(resolved, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Convert a JSON Schema `properties` object to a TypeBox TObject.
 *
 * Only handles the subset of types MCP tools typically use.
 */
export function jsonSchemaToTypebox(schema: unknown): TObject {
  const s = schema as any;
  if (!s?.properties) return Type.Object({});

  const props: Record<string, any> = {};
  const required = new Set(s.required ?? []);

  for (const [key, value] of Object.entries(s.properties)) {
    const v = value as any;
    let field: any;

    switch (v.type) {
      case "string":
        field = Type.String({ description: v.description });
        break;
      case "number":
      case "integer":
        field = Type.Number({ description: v.description });
        break;
      case "boolean":
        field = Type.Boolean({ description: v.description });
        break;
      case "array":
        field = Type.Array(Type.Unknown(), { description: v.description });
        break;
      case "object":
        field = Type.Unknown({ description: v.description });
        break;
      default:
        field = Type.Unknown({ description: v.description });
        break;
    }

    props[key] = required.has(key) ? field : Type.Optional(field);
  }

  return Type.Object(props);
}

/**
 * Extract text content from an MCP tool result envelope.
 */
export function extractContent(
  result: unknown,
): Array<{ type: "text"; text: string }> {
  const r = result as any;
  if (r?.content && Array.isArray(r.content)) {
    return r.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => ({ type: "text" as const, text: c.text }));
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}
