/**
 * Refresh Oracle driver — Foundry Responses API version.
 *
 * Replaces OpenRouter with Azure AI Foundry for the 4-verb airlock loop.
 * Uses managed identity (DefaultAzureCredential) for authentication —
 * no API keys required.
 *
 * Wire mapping from OpenRouter → Foundry Responses:
 *   messages[]           → input[] (with type field)
 *   system message       → instructions request param
 *   choice.tool_calls[]  → output[] items {type:"function_call", call_id, name, arguments}
 *   {role:"tool", ...}   → {type:"function_call_output", call_id, output}
 *   usage.prompt_tokens  → usage.input_tokens
 */

import type { ToolCall, ToolResult, RefreshSession, TaskContext } from "./broker.js";
import { dispatch } from "./broker.js";
import { DatabaseSync } from "node:sqlite";

const FOUNDRY_ENDPOINT = process.env["AZURE_AI_PROJECT_ENDPOINT"] ?? "";
const FOUNDRY_MODEL = process.env["REFRESH_LLM_MODEL"] ?? "gpt-4.1-mini";
const FOUNDRY_TOKEN = process.env["FOUNDRY_ACCESS_TOKEN"]; // Short-lived Entra token

// ── (B) the system prompt — the rules of engagement ───────────────────────
export const REFRESH_SYSTEM_PROMPT = `You are the Refresh Oracle for the manufacturing nowcast target daemon. You drive a closed tool loop to apply verified leading-indicator broadcasts to frozen forecast skills.

YOUR JOB is given in the first user message (the TaskContext): which contract, reference month, pinned pipeline, verified dataset, in-scope series, and budget. Work that one job, then terminate.

THE FOUR VERBS (you may call ONLY these; the broker executes each, you cannot reach the DB, the sandbox, or the signing key directly):

1. read_indicator_dataset() → returns the verified broadcast dataset {referenceMonth, target, source, seriesIncluded, indicators[], contentHash}. No args — the broker binds it to your job's verified datasetId.
2. read_prior_forecast() → returns {historyDepth, history{<seriesId>: [{date,value}]}, priorRefreshResult}. Read-only: the accumulated YTD series (the target's own indicator_history) + the prior month's signed refresh_result. Use this to judge plausibility, revisions, drift.
3. run_nowcast_skill({options?}) → runs the PINNED frozen skill (the pipeline named in your TaskContext). options accepts ONLY: {vintageComparison?: boolean} (run a second scoring on the prior vintage to decompose a revision). Returns {point, pi80, pi95, drift{features,widened}, delta{newMonth,revision}, outputHash}. The broker digest-checks the skill and signs the hash — YOU CANNOT ALTER THE NUMBERS. You may only choose to call it and the schema-valid options.
4. write_forecast_artifact({analysisMd}) → the ONE durable write. Your ONLY contribution is analysisMd (markdown prose interpreting the result). The broker fills contractId/subjectId/body/envHash/signature — you cannot forge provenance. Terminal: a signed candidate is written to data/refresh-results/.
   finish({status:"abstain", note?}) → terminal, no write. Use when you judge the refresh should not publish (bad data, drift you cannot resolve, etc.).

ORDERING: call read_indicator_dataset and read_prior_forecast before run_nowcast_skill; call run_nowcast_skill before write_forecast_artifact. The broker enforces this.

CRITICAL RULES:
- Numbers come ONLY from run_nowcast_skill. Never invent, round, or "estimate" a forecast value. If the skill failed, finish with abstain — do not fabricate.
- Your prose (analysisMd) is ADVISORY, sitting beside recomputable numbers. Flag drift, revisions, preliminary data, regime breaks (see TaskContext.regimeDummies) honestly.
- Decide proceed vs abstain: if the skill produced a finite result and the data is plausible, call write_forecast_artifact. If not, call finish({status:"abstain"}).
- Budget is finite (TaskContext.budget). Be efficient; you typically need 4 calls.

Begin by reading the TaskContext, then call read_indicator_dataset.`;

// ── (B) the tool schemas (Foundry Responses API format) ────────────────────
export const REFRESH_TOOLS = [
  {
    type: "function",
    name: "read_indicator_dataset",
    description: "Return the verified broadcast dataset for this job. No args.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "read_prior_forecast",
    description: "Return the accumulated YTD history + the prior signed refresh_result (read-only). No args.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "run_nowcast_skill",
    description: "Run the pinned frozen skill. Returns the forecast + drift + outputHash. You cannot alter the numbers.",
    parameters: {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { vintageComparison: { type: "boolean" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "write_forecast_artifact",
    description: "Terminal: write the signed candidate. Your only input is analysisMd (markdown prose).",
    parameters: {
      type: "object",
      properties: {
        analysisMd: { type: "string", description: "Markdown interpretation of the result (advisory)." },
      },
      required: ["analysisMd"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "finish",
    description: "Terminal: abstain (no write).",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["abstain"] },
        note: { type: "string" },
      },
      required: ["status"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ── Helper: get Entra token via managed identity ──────────────────────────
async function getToken(): Promise<string> {
  // If FOUNDRY_ACCESS_TOKEN is set (e.g., from airlock), use it.
  if (FOUNDRY_TOKEN) return FOUNDRY_TOKEN;

  // Otherwise, try to get a token via Azure IMDS (managed identity).
  const resp = await fetch(
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://ai.azure.com/.default",
    { headers: { Metadata: "true" } }
  );
  if (!resp.ok) {
    throw new Error(`IMDS token request failed: ${resp.status} ${await resp.text()}`);
  }
  const j: any = await resp.json();
  return j.access_token;
}

// ── (C) the loop ───────────────────────────────────────────────────────────
/** Drive the oracle loop for one job using Foundry Responses API.
 *  Returns terminal status ("stored" | "abstain" | "failed").
 */
export async function runOracle(
  ctx: TaskContext,
  session: RefreshSession,
  db: DatabaseSync,
): Promise<string> {
  if (!FOUNDRY_ENDPOINT) {
    console.log("[oracle-foundry] AZURE_AI_PROJECT_ENDPOINT not set — using scripted driver");
    return scriptedDriver(session, db);
  }

  console.log(`[oracle-foundry] Foundry path (${FOUNDRY_MODEL}) — oracle drives the loop for ${ctx.contractId}/${ctx.referenceMonth}`);

  let token: string;
  try {
    token = await getToken();
  } catch (err) {
    console.error("[oracle-foundry] Token acquisition failed, falling back to scripted:", err instanceof Error ? err.message : String(err));
    return scriptedDriver(session, db);
  }

  // Foundry Responses input format
  const input: any[] = [
    { role: "user", content: JSON.stringify(ctx) },
  ];

  for (let i = 0; i < ctx.budget.max_tool_calls + 2; i++) {
    let resp: Response;
    try {
      resp = await fetch(`${FOUNDRY_ENDPOINT}/evaluations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: FOUNDRY_MODEL,
          instructions: REFRESH_SYSTEM_PROMPT,
          input,
          tools: REFRESH_TOOLS,
          tool_choice: "auto",
          temperature: 0,
          max_output_tokens: 800,
        }),
      });
    } catch (err) {
      console.error("[oracle-foundry] LLM call failed, falling back to scripted:", err instanceof Error ? err.message : String(err));
      return scriptedDriver(session, db);
    }

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[oracle-foundry] HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return scriptedDriver(session, db);
    }

    const j: any = await resp.json();
    const output: any[] = j?.output ?? [];
    const usage = j?.usage ?? { input_tokens: 0, output_tokens: 0 };

    // Append model output items to input for next round
    input.push(...output);

    // Find function_call items
    const toolCalls = output.filter((item: any) => item.type === "function_call");

    if (toolCalls.length === 0) {
      // LLM stopped without a tool call
      return session.skill ? "stored" : "abstain";
    }

    let terminal: string | undefined;
    for (const tc of toolCalls) {
      const name = tc.name;
      let args: any = {};
      try { args = JSON.parse(tc.arguments || "{}"); } catch { /* empty */ }
      const call: ToolCall = { callId: tc.call_id, tool: name, args };
      console.log(`[oracle-foundry] → ToolCall ${name} ${Object.keys(args).length ? JSON.stringify(args).slice(0, 80) : ""}`);
      const { result, terminal: t } = await dispatch(call, session, db);
      console.log(`[oracle-foundry] ← ToolResult ${name} ok=${result.ok}${result.error ? " " + result.error.code : ""}${terminal ? " terminal=" + terminal : ""}`);
      terminal = terminal ?? t;

      // Feed result back as function_call_output
      input.push({
        type: "function_call_output",
        call_id: tc.call_id,
        output: JSON.stringify(result),
      });

      if (!result.ok) console.warn(`[oracle-foundry] verb ${name} failed: ${result.error?.code}`);
      if (terminal) break;
    }
    if (terminal) return terminal;
  }

  console.warn("[oracle-foundry] exhausted budget without a terminal");
  return "abstain";
}

/** Scripted driver: deterministic fallback when LLM is unavailable.
 *  Mirrors the original oracle.ts scripted driver exactly.
 */
async function scriptedDriver(session: RefreshSession, db: DatabaseSync): Promise<string> {
  const seq: ToolCall[] = [
    { callId: "s1", tool: "read_indicator_dataset", args: {} },
    { callId: "s2", tool: "read_prior_forecast", args: {} },
    { callId: "s3", tool: "run_nowcast_skill", args: {} },
    { callId: "s4", tool: "write_forecast_artifact", args: { analysisMd: `Scripted refresh for ${session.contract.subjectId} ${session.referenceMonth} (Foundry LLM unavailable).` } },
  ];
  let terminal: string | undefined;
  for (const call of seq) {
    const { result, terminal: t } = await dispatch(call, session, db);
    if (!result.ok) { console.error(`[oracle-foundry/scripted] ${call.tool} failed: ${result.error?.message}`); return "failed"; }
    terminal = terminal ?? t;
    if (terminal) break;
  }
  return terminal ?? "failed";
}
