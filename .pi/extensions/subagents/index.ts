/**
 * Sub-Agent Framework — Extension
 *
 * Registers a "delegate" tool that spawns isolated pi sub-processes.
 * Emits lifecycle events via pi.events for other extensions to observe.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Agent Discovery ──────────────────────────────────────────────

interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}

function discoverAgents(cwd: string): AgentConfig[] {
  const dir = path.join(cwd, ".pi", "agents");
  if (!fs.existsSync(dir)) return [];
  const agents: AgentConfig[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description || "",
      tools: frontmatter.tools
        ?.split(",")
        .map((t: string) => t.trim())
        .filter(Boolean),
      model: frontmatter.model,
      systemPrompt: body,
      filePath,
    });
  }
  return agents;
}

// ── Agent Runner ─────────────────────────────────────────────────

interface RunResult {
  output: string;
  turns: number;
  exitCode: number;
  stderr: string;
}

/**
 * Resolve the standard pi CLI from node_modules.
 *
 * IMPORTANT: Never use process.argv[1] here. The parent process may be a
 * custom TUI wrapper (e.g. dist/cli.js) that starts MCP servers, proxy/host
 * sub-processes, and enters InteractiveMode. Re-running that as a child
 * would hang on port conflicts and interactive input.
 */
function getPiCommand(cwd: string): { command: string; args: string[] } {
  const localCli = path.join(
    cwd,
    "node_modules",
    "@mariozechner",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  if (fs.existsSync(localCli)) {
    return { command: process.execPath, args: [localCli] };
  }

  const binDir = path.join(cwd, "node_modules", ".bin");
  const candidates = [
    path.join(binDir, "pi.cmd"),
    path.join(binDir, "pi.exe"),
    path.join(binDir, "pi"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: candidate, args: [] };
    }
  }

  return { command: "pi", args: [] };
}

async function runAgent(
  cwd: string,
  config: AgentConfig,
  task: string,
  signal?: AbortSignal,
  onUpdate?: (text: string) => void,
): Promise<RunResult> {
  const piCmd = getPiCommand(cwd);
  const args = [
    ...piCmd.args,
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",         // Prevent recursive extension loading
    "--no-skills",             // Agent .md provides the system prompt
    "--no-prompt-templates",
    "--no-themes",
  ];

  if (config.model) args.push("--model", config.model);
  if (config.tools?.length) args.push("--tools", config.tools.join(","));

  // Write system prompt to temp file for --append-system-prompt
  let tmpDir: string | null = null;
  let promptPath: string | null = null;

  if (config.systemPrompt.trim()) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-"));
    promptPath = path.join(tmpDir, "prompt.md");
    fs.writeFileSync(promptPath, config.systemPrompt, "utf-8");
    args.push("--append-system-prompt", promptPath);
  }

  args.push(`Task: ${task}`);

  return new Promise<RunResult>((resolve, reject) => {
    const proc = spawn(piCmd.command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let output = "";
    let stderr = "";
    let turns = 0;

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            turns++;
            const text = ev.message.content?.find((c: any) => c.type === "text")?.text;
            if (text) {
              output = text;
              onUpdate?.(text);
            }
          }
        } catch {
          // Not JSON, skip
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Abort handling
    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }

    proc.on("close", (code) => {
      // Cleanup temp files
      if (promptPath) try { fs.unlinkSync(promptPath); } catch {}
      if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}

      // Process remaining buffer
      const remaining = buffer.trim();
      if (remaining) {
        try {
          const ev = JSON.parse(remaining);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            const text = ev.message.content?.find((c: any) => c.type === "text")?.text;
            if (text) output = text;
          }
        } catch {}
      }

      resolve({ output, turns, exitCode: code ?? 0, stderr });
    });

    proc.on("error", (err) => {
      if (promptPath) try { fs.unlinkSync(promptPath); } catch {}
      if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}
      reject(err);
    });
  });
}

// ── Extension Entry Point ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: [
      "Delegate a task to a specialized sub-agent with an isolated context window.",
      "Available agents are defined in .pi/agents/*.md.",
      "Each agent has its own model, tool set, and system prompt.",
    ].join(" "),
    promptSnippet: "Delegate tasks to specialized sub-agents (research, statistician, validator, etc.)",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent type name (e.g. 'research', 'statistician', 'validator')" }),
      task: Type.String({ description: "Detailed task description for the sub-agent" }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd);
      const config = agents.find((a) => a.name === params.agent);

      if (!config) {
        const available = agents.map((a) => `${a.name}: ${a.description}`).join("\n  ");
        throw new Error(
          `Unknown agent "${params.agent}". Available agents:\n  ${available || "(none — create .pi/agents/<name>.md)"}`,
        );
      }

      const id = crypto.randomUUID().slice(0, 8);

      pi.events.emit("subagent:started", {
        id,
        agent: params.agent,
        task: params.task,
        model: config.model,
        tools: config.tools,
      });

      try {
        const result = await runAgent(ctx.cwd, config, params.task, signal, (text) => {
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { id, agent: params.agent, turns: 0, status: "running" },
          });
        });

        pi.events.emit("subagent:completed", {
          id,
          agent: params.agent,
          output: result.output,
          turns: result.turns,
          exitCode: result.exitCode,
        });

        if (result.exitCode !== 0 && !result.output) {
          throw new Error(
            `Agent "${params.agent}" exited with code ${result.exitCode}.\n${result.stderr || "(no stderr)"}`,
          );
        }

        return {
          content: [{ type: "text", text: result.output || "(no output)" }],
          details: {
            id,
            agent: params.agent,
            turns: result.turns,
            exitCode: result.exitCode,
            status: "completed",
          },
        };
      } catch (err: any) {
        pi.events.emit("subagent:failed", {
          id,
          agent: params.agent,
          error: err.message || String(err),
        });
        throw err;
      }
    },
  });

  // Notify on load
  pi.on("session_start", async (_event, ctx) => {
    const agents = discoverAgents(ctx.cwd);
    if (agents.length > 0) {
      const names = agents.map((a) => a.name).join(", ");
      ctx.ui.setStatus("subagents", `Sub-agents: ${names}`);
    }
  });
}
