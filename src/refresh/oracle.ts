/**
 * Refresh Oracle driver — the (B) spawn + (C) loop.
 *
 * (B) SPAWN: an LLM session is started with the system prompt (the rules of
 *     engagement — names the four verbs, I/O contracts, proceed-vs-abstain,
 *     the closed param menu, and "numbers come only from run_nowcast_skill")
 *     + the TaskContext handshake (the specific job instance, built by the
 *     broker). This is separate from dispatch: the broker builds TaskContext
 *     and starts the oracle; the oracle then drives dispatch.
 *
 * (C) LOOP: the oracle emits tool_calls; each is routed through the broker's
 *     dispatch (the router from step 1) and the ToolResult fed back, until a
 *     terminal (write_forecast_artifact → "stored", or finish → "abstain").
 *     This replaces the P2 oracleDecide single-gate call: the LLM now drives
 *     the verb order itself, exactly like the source daemon's run_oracle.
 *
 * The broker is the only thing with DB/sandbox/signing capabilities; the
 * oracle (OpenRouter) has none — it only emits tool_calls that dispatch
 * routes. That is the airlock separation, in-process. If REFRESH_LLM_KEY is
 * unset, a scripted driver runs the same four verbs so the loop is testable
 * without an API key.
 */
import type { ToolCall, ToolResult, RefreshSession, TaskContext } from "./broker.js";
import { dispatch } from "./broker.js";
import { DatabaseSync } from "node:sqlite";

const LLM_KEY = process.env["REFRESH_LLM_KEY"] ?? process.env["OPENROUTER_API_KEY"];
const LLM_MODEL = process.env["REFRESH_LLM_MODEL"] ?? "openai/gpt-4o-mini";

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

// ── (B) the tool schemas (OpenAI/OpenRouter function format) ───────────────
export const REFRESH_TOOLS = [
  { type: "function", function: {
    name: "read_indicator_dataset", description: "Return the verified broadcast dataset for this job. No args.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }},
  { type: "function", function: {
    name: "read_prior_forecast", description: "Return the accumulated YTD history + the prior signed refresh_result (read-only). No args.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }},
  { type: "function", function: {
    name: "run_nowcast_skill",
    description: "Run the pinned frozen skill. Returns the forecast + drift + outputHash. You cannot alter the numbers.",
    parameters: { type: "object",
      properties: { options: { type: "object", properties: { vintageComparison: { type: "boolean" } }, additionalProperties: false } },
      additionalProperties: false },
  }},
  { type: "function", function: {
    name: "write_forecast_artifact",
    description: "Terminal: write the signed candidate. Your only input is analysisMd (markdown prose).",
    parameters: { type: "object",
      properties: { analysisMd: { type: "string", description: "Markdown interpretation of the result (advisory)." } },
      required: ["analysisMd"], additionalProperties: false },
  }},
  { type: "function", function: {
    name: "finish",
    description: "Terminal: abstain (no write).",
    parameters: { type: "object",
      properties: { status: { type: "string", enum: ["abstain"] }, note: { type: "string" } },
      required: ["status"], additionalProperties: false },
  }},
];

// ── (C) the loop ───────────────────────────────────────────────────────────
/** Drive the oracle loop for one job. Returns the terminal status
 *  ("stored" | "abstain" | "failed"). Uses a real LLM (OpenRouter tool-calling)
 *  when REFRESH_LLM_KEY is set; otherwise a scripted driver so the loop is
 *  testable without an API key. */
export async function runOracle(
  ctx: TaskContext,
  session: RefreshSession,
  db: DatabaseSync,
): Promise<string> {
  if (!LLM_KEY) {
    console.log("[oracle] no LLM key — using scripted driver");
    return scriptedDriver(session, db);
  }
  console.log(`[oracle] LLM path (${LLM_MODEL}) — oracle drives the loop for ${ctx.contractId}/${ctx.referenceMonth}`);
  const messages: any[] = [
    { role: "system", content: REFRESH_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(ctx) },
  ];
  for (let i = 0; i < ctx.budget.max_tool_calls + 2; i++) {
    let resp: Response;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LLM_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: LLM_MODEL, messages, tools: REFRESH_TOOLS, tool_choice: "auto", temperature: 0, max_tokens: 800 }),
      });
    } catch (err) {
      console.error("[oracle] LLM call failed, falling back to scripted:", err instanceof Error ? err.message : String(err));
      return scriptedDriver(session, db);
    }
    const j: any = await resp.json();
    const msg = j?.choices?.[0]?.message;
    if (!msg) { console.error("[oracle] no message in response:", JSON.stringify(j).slice(0, 300)); return "failed"; }
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // LLM stopped without a tool call — treat as abstain unless it already wrote.
      return session.skill ? "stored" : "abstain";
    }
    let terminal: string | undefined;
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args: any = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* empty */ }
      const call: ToolCall = { callId: tc.id, tool: name, args };
      console.log(`[oracle] → ToolCall ${name} ${Object.keys(args).length ? JSON.stringify(args).slice(0,80) : ""}`);
      const { result, terminal: t } = await dispatch(call, session, db);
      console.log(`[oracle] ← ToolResult ${name} ok=${result.ok}${result.error ? " "+result.error.code : ""}${terminal ? " terminal="+terminal : ""}`);
      terminal = terminal ?? t;
      // Feed the ToolResult back to the LLM as a tool message.
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      if (!result.ok) console.warn(`[oracle] verb ${name} failed: ${result.error?.code}`);
      if (terminal) break;
    }
    if (terminal) return terminal;
  }
  console.warn("[oracle] exhausted budget without a terminal");
  return "abstain";
}

/** Scripted driver: calls the four verbs in order, mirroring the dispatch test.
 *  Used when no LLM key is configured (dev) — proves the loop plumbing without
 *  an API call. The LLM replaces this when REFRESH_LLM_KEY is set. */
async function scriptedDriver(session: RefreshSession, db: DatabaseSync): Promise<string> {
  const seq: ToolCall[] = [
    { callId: "s1", tool: "read_indicator_dataset", args: {} }, 
    { callId: "s2", tool: "read_prior_forecast", args: {} },
    { callId: "s3", tool: "run_nowcast_skill", args: {} },
    { callId: "s4", tool: "write_forecast_artifact", args: { analysisMd: `Scripted refresh for ${session.contract.subjectId} ${session.referenceMonth} (LLM unset; REFRESH_LLM_KEY not configured).` } },
  ];
  let terminal: string | undefined;
  for (const call of seq) {
    const { result, terminal: t } = await dispatch(call, session, db);
    if (!result.ok) { console.error(`[oracle/scripted] ${call.tool} failed: ${result.error?.message}`); return "failed"; }
    terminal = terminal ?? t;
    if (terminal) break;
  }
  return terminal ?? "failed";
}
