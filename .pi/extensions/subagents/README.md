# Sub-Agent Framework for BLS Data Visualization

## Design Rationale

This framework distils the `pi-subagents` (tintinweb) and the built-in `subagent`
example into a minimal extension skeleton. The goal is **not** to replicate their
full feature sets but to extract the three architectural primitives they share:

1. **Session isolation** — each sub-agent runs in its own pi process/session
2. **Tool calling** — the parent LLM spawns sub-agents via a registered tool
3. **Event broadcasting** — lifecycle events flow through `pi.events` so other
   extensions can react

Everything else — concurrency queues, widget UI, worktree isolation, memory
scopes — is additive and can be layered on later.

---

## Architectural Skeleton

```
┌────────────────────────────────────────────────────────────┐
│                    Parent Agent Session                      │
│                                                              │
│  ┌──────────────┐   pi.registerTool("delegate")             │
│  │  LLM calls   │──► execute() spawns child `pi` process    │
│  │  delegate()   │                                           │
│  └──────┬───────┘                                            │
│         │                                                    │
│         │  pi.events.emit("subagent:started", {...})         │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────────────────────────────────────┐             │
│  │  Child pi process (--mode json --no-session) │             │
│  │  • Own context window                        │             │
│  │  • Own system prompt (from .md agent def)    │             │
│  │  • Own tool subset                           │             │
│  │  • Streams JSON events to parent stdout      │             │
│  └──────────────┬──────────────────────────────┘             │
│                 │                                            │
│                 │  on("message_end") → parse, accumulate     │
│                 │                                            │
│                 ▼                                            │
│  ┌──────────────┐                                            │
│  │  Return tool │  pi.events.emit("subagent:completed")      │
│  │  result to   │  or "subagent:failed"                      │
│  │  parent LLM  │                                            │
│  └──────────────┘                                            │
└────────────────────────────────────────────────────────────┘
```

### Three Primitives

#### 1. Session Isolation (child process)

Both tintinweb and the built-in example spawn `pi --mode json -p --no-session`.
This gives the child:
- A fresh, bounded context window (no parent history pollution)
- Its own model selection (can use a cheaper model for recon)
- Its own tool set (read-only for research agents)
- Structured JSON output on stdout for the parent to parse

The parent reads the child's stdout line-by-line, parsing JSON events
(`message_end`, `tool_result_end`) to track progress and accumulate results.

#### 2. Tool Calling (the `delegate` tool)

The parent agent sees a single registered tool. When it calls it, the extension's
`execute()` function:
1. Resolves the agent type from `.pi/agents/<name>.md`
2. Builds the command-line args (model, tools, system prompt)
3. Spawns the child process
4. Streams `onUpdate()` partials back to the parent as the child works
5. Returns the final result when the child exits

Parameters: `{ agent: string, task: string }` — that's the minimal surface.

#### 3. Event Broadcasting (`pi.events`)

The extension emits lifecycle events so other extensions (widgets, loggers,
orchestrators) can react without coupling:

| Event | When | Payload |
|-------|------|---------|
| `subagent:started` | Child process spawned | `{ id, agent, task }` |
| `subagent:completed` | Child exited successfully | `{ id, agent, result, usage }` |
| `subagent:failed` | Child errored or was aborted | `{ id, agent, error }` |

This is the pub/sub backbone. A widget extension can listen for these to
render status. A logging extension can capture transcripts. The parent
agent doesn't need to know about any of them.

---

## Agent Definition Format

Agent types are markdown files with YAML frontmatter. This is the convention
used by both tintinweb and the built-in example:

```markdown
---
name: research
description: BLS documentation researcher (read-only)
tools: read, bash, grep, find, ls
model: claude-haiku-4-5
---

You are a research specialist for Bureau of Labor Statistics data.
Your job is to find, read, and summarize BLS documentation, methodology
PDFs, data dictionaries, and technical notes.

You must NOT modify any files. Only read and report.

Output format:
## Sources Found
- File/URL and what it contains

## Key Findings
Structured summary of what you learned

## Data Schema
Any column definitions, codes, or interval tables discovered

## Recommendations
What the parent agent should do with this information
```

Discovery: `loadAgentsFromDir()` scans `.pi/agents/` for `.md` files,
parses frontmatter with `parseFrontmatter()`, and returns `AgentConfig[]`.

---

## Concrete Agents for This Project

| Agent | Role | Tools | Model |
|-------|------|-------|-------|
| `research` | Find BLS docs, methodology, data dictionaries | read, bash, grep, find, ls | haiku |
| `data-engineer` | Transform, clean, validate datasets | read, bash, write, edit | sonnet |
| `statistician` | Compute tests, fit distributions, validate estimators | read, bash, execute_python | sonnet |
| `visualizer` | Generate SVG/D3 code, push to canvas | read, write, edit, push_svg | sonnet |
| `validator` | Playwright screenshot + DOM assertions | read, bash, playwright_* | haiku |

Example chain: **research → data-engineer → statistician → visualizer → validator**

---

## Implementation Plan

### File Structure

```
.pi/extensions/subagents/
├── index.ts          # Extension entry: registers "delegate" tool, emits events
├── agents.ts         # Agent discovery (scan .pi/agents/*.md, parse frontmatter)
├── runner.ts         # Spawn child pi process, stream JSON events, return result
└── README.md         # This file

.pi/agents/
├── research.md       # BLS documentation researcher
├── data-engineer.md  # Data transformation specialist
├── statistician.md   # Statistical analysis agent
├── visualizer.md     # D3/SVG visualization agent
└── validator.md      # Playwright validation agent
```

### Phase 1: Minimal Viable Framework

The absolute minimum to get a sub-agent running:

```typescript
// index.ts — ~80 lines
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "./agents.js";
import { runAgent } from "./runner.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: "Delegate a task to a specialized sub-agent",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent type name" }),
      task:  Type.String({ description: "Task description" }),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd);
      const config = agents.find(a => a.name === params.agent);
      if (!config) {
        const names = agents.map(a => a.name).join(", ");
        throw new Error(`Unknown agent "${params.agent}". Available: ${names}`);
      }

      const id = crypto.randomUUID().slice(0, 8);
      pi.events.emit("subagent:started", { id, agent: params.agent, task: params.task });

      try {
        const result = await runAgent(ctx.cwd, config, params.task, signal, (partial) => {
          onUpdate?.({
            content: [{ type: "text", text: partial.text }],
            details: partial,
          });
        });

        pi.events.emit("subagent:completed", { id, agent: params.agent, result });
        return {
          content: [{ type: "text", text: result.output }],
          details: result,
        };
      } catch (err) {
        pi.events.emit("subagent:failed", { id, agent: params.agent, error: String(err) });
        throw err;
      }
    },
  });
}
```

```typescript
// runner.ts — ~60 lines
import { spawn } from "node:child_process";
import type { AgentConfig } from "./agents.js";

export interface RunResult {
  output: string;
  turns: number;
  exitCode: number;
}

export async function runAgent(
  cwd: string,
  config: AgentConfig,
  task: string,
  signal?: AbortSignal,
  onUpdate?: (partial: { text: string }) => void,
): Promise<RunResult> {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (config.model) args.push("--model", config.model);
  if (config.tools?.length) args.push("--tools", config.tools.join(","));
  // Append system prompt via temp file or --append-system-prompt
  args.push(`Task: ${task}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [process.argv[1], ...args], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "", output = "", turns = 0;

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            turns++;
            const text = ev.message.content?.find(c => c.type === "text")?.text;
            if (text) { output = text; onUpdate?.({ text }); }
          }
        } catch {}
      }
    });

    if (signal) {
      const kill = () => proc.kill("SIGTERM");
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }

    proc.on("close", (code) => {
      if (code !== 0 && !output) reject(new Error(`Agent exited with code ${code}`));
      else resolve({ output, turns, exitCode: code ?? 0 });
    });
    proc.on("error", reject);
  });
}
```

```typescript
// agents.ts — ~40 lines
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
}

export function discoverAgents(cwd: string): AgentConfig[] {
  const dirs = [
    path.join(cwd, ".pi", "agents"),
    // Could add ~/.pi/agent/agents for global agents
  ];
  const agents: AgentConfig[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      if (!frontmatter.name) continue;
      agents.push({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools: frontmatter.tools?.split(",").map(t => t.trim()).filter(Boolean),
        model: frontmatter.model,
        systemPrompt: body,
      });
    }
  }
  return agents;
}
```

### Phase 2: Additions (incremental)

| Feature | Effort | Source of pattern |
|---------|--------|-------------------|
| Parallel execution | Medium | tintinweb `agent-manager.ts`, built-in `mapWithConcurrencyLimit` |
| Chain mode (`{previous}` placeholder) | Low | Built-in example's chain loop |
| Widget UI (spinner, status) | Medium | tintinweb `agent-widget.ts` |
| Steering (inject message mid-run) | Medium | tintinweb `steer_subagent` tool |
| Background execution | High | tintinweb `agent-manager.ts` concurrency queue |
| Cross-extension RPC | Medium | tintinweb `cross-extension-rpc.ts` via `pi.events` |
| Persistent memory | Medium | tintinweb `memory.ts` MEMORY.md pattern |
| Git worktree isolation | Medium | tintinweb `worktree.ts` |

### Phase 3: Integration with BLS Pipeline

Wire the sub-agent framework into the data visualization pipeline:

```
User: "Add CPI-adjusted real wages to the OEWS histogram"

Parent agent:
  1. delegate({ agent: "research", task: "Find BLS CPI data series..." })
     → Returns: series IDs, methodology notes, data format
  2. delegate({ agent: "data-engineer", task: "Download CPI data, compute deflator..." })
     → Returns: JSON with deflated wage bins
  3. delegate({ agent: "statistician", task: "Refit PQDE on real wages, compare..." })
     → Returns: fit coefficients, comparison stats
  4. delegate({ agent: "visualizer", task: "Add real-wage overlay to histogram..." })
     → Returns: updated oe-drilldown.html
  5. delegate({ agent: "validator", task: "Screenshot and verify rendering..." })
     → Returns: pass/fail with screenshot
```

---

## Key Differences: tintinweb vs Built-in vs This Framework

| Aspect | tintinweb/pi-subagents | Built-in subagent example | This framework |
|--------|----------------------|--------------------------|----------------|
| **Scope** | Full product (800+ LOC) | Reference impl (~600 LOC) | Skeleton (~180 LOC) |
| **Process model** | SDK `createAgentSession` | `pi --mode json` subprocess | Subprocess (like built-in) |
| **Agent defs** | `.pi/agents/*.md` with rich frontmatter | `~/.pi/agent/agents/*.md` | `.pi/agents/*.md` (simple) |
| **Concurrency** | Queue with configurable limit | `mapWithConcurrencyLimit` | Not yet (Phase 2) |
| **Events** | Full lifecycle + RPC protocol | `onUpdate` streaming only | `pi.events` emit (minimal) |
| **UI** | Widget, conversation viewer, styled notifications | `renderCall`/`renderResult` | None yet (Phase 2) |
| **Steering** | `steer_subagent` tool | Not supported | Not yet (Phase 2) |
| **Memory** | 3-scope persistent memory | None | Not yet (Phase 2) |

The design philosophy: start with the three primitives (isolation, tool calling,
events), prove the pipeline works end-to-end with BLS data, then layer on
sophistication as needed.
