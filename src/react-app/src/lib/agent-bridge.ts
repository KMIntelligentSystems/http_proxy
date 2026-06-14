/**
 * Lightweight bridge from the React harness to the server-side agent runtime.
 *
 * - Opens a WebSocket to /ui/ws/agent for real-time events (artifact_created,
 *   agent_prompt_complete, agent_prompt_error).
 * - Submits user prompts via POST /ui/api/agent/prompt.
 * - Exposes an EventTarget (`artifactEvents`) so components can subscribe to
 *   artifact creation without importing this module directly.
 */

export type AgentState = "idle" | "working";

export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
};

export type UserQuestion = {
  type: "user_question";
  id: string;
  prompt: string;
  choices?: string[];
  defaultChoice?: string;
  allowFreeText: boolean;
  timeoutMs: number;
  createdAt: string;
  sessionId?: string | null;
  runId?: string | null;
};

export type UserQuestionResolved = {
  type: "user_question_resolved";
  id: string;
  answered: boolean;
  reason?: string;
  response?: string | null;
  resolvedAt: string;
  sessionId?: string | null;
  runId?: string | null;
};

export type AssistantResponse = {
  type: "assistant_response";
  message: string;
  receivedAt?: string;
  sessionId?: string | null;
};

/**
 * Normalised "thinking log" entry derived from the raw agent_event stream.
 * One entry per visible step (assistant text chunk, reasoning chunk, tool call,
 * tool result, lifecycle marker). Consumers render these in a scrolling log.
 */
export type ThinkingEntry = {
  id: string;
  kind:
    | "agent_start"
    | "agent_end"
    | "turn_start"
    | "turn_end"
    | "assistant_text"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "status";
  /** Short label for the entry (e.g. tool name, "Reasoning", "Assistant"). */
  label: string;
  /** Optional body content (assistant text, reasoning text, tool args/result). */
  body?: string;
  /** When true, the entry represents a failure. */
  isError?: boolean;
  /** When true, the entry is still streaming and may be updated. */
  streaming?: boolean;
  /** ToolCallId, used to correlate tool_call -> tool_result and to update partials. */
  toolCallId?: string;
  timestamp: string;
};

export type ThinkingEventDetail =
  | { type: "thinking_append"; entry: ThinkingEntry }
  | { type: "thinking_update"; entry: ThinkingEntry }
  | { type: "thinking_reset" };

export type ArtifactRecord = {
  id: string;
  sessionId?: string;
  title: string;
  filename: string;
  mimeType: string;
  createdAt?: string;
  updatedAt?: string;
  size?: number;
  url: string;
  role: string;
  description?: string;
  category?: string;
  subject?: string;
};

export const artifactEvents = new EventTarget();

export type PromptResponse =
  | { kind: "queued" }
  | { kind: "info"; message: string }
  | { kind: "error"; message: string };

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let working = false;
let workingListeners = new Set<(w: boolean) => void>();

// ─── Client-side WS liveness watchdog ───────────────────────────────────────────
//
// The server pings + heartbeats every 30s. If we go ~75s without any inbound
// message (heartbeat or otherwise) the underlying TCP is presumed dead and
// we force-close so onclose triggers the existing reconnect timer. This
// protects against half-open sockets that survive an idle-timeout drop at
// Railway's edge but never deliver another byte.
const WS_STALE_AFTER_MS = 75_000;
let lastInboundAt = Date.now();
let livenessTimer: ReturnType<typeof setInterval> | null = null;

function startLivenessWatchdog(): void {
  if (livenessTimer) return;
  livenessTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastInboundAt > WS_STALE_AFTER_MS) {
      try { ws.close(4000, "client_stale_timeout"); } catch {}
    }
  }, 15_000);
}

function stopLivenessWatchdog(): void {
  if (livenessTimer) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }
}

// ─── Per-turn activity watchdog ────────────────────────────────────────────────
//
// Independent of the socket-level liveness watchdog above. While a prompt is
// in flight (`working === true`) we expect SOME agent activity — at minimum
// reasoning deltas, text deltas, or tool events — at least every TURN_STALL_
// MS. If the socket is alive (heartbeats arriving) but no agent activity has
// been observed for that window, the turn is presumed stuck (host crashed
// mid-turn, agent loop deadlocked, model provider quietly hung the stream,
// etc.) and we synthesise a terminal error so the UI un-spins.
//
// This is purely defensive: if it ever fires under normal operation the
// threshold needs to go up, not down.
const TURN_STALL_MS = 180_000; // 3 minutes of agent silence ⇒ presumed stalled
let lastAgentActivityAt = 0;
let turnWatchdog: ReturnType<typeof setInterval> | null = null;
let turnStartedAt = 0;

function markAgentActivity(): void {
  lastAgentActivityAt = Date.now();
}

function startTurnWatchdog(): void {
  stopTurnWatchdog();
  turnStartedAt = Date.now();
  lastAgentActivityAt = Date.now();
  turnWatchdog = setInterval(() => {
    if (!working) {
      stopTurnWatchdog();
      return;
    }
    const silentMs = Date.now() - lastAgentActivityAt;
    if (silentMs > TURN_STALL_MS) {
      const totalMs = Date.now() - turnStartedAt;
      const reason = `No agent activity for ${Math.round(silentMs / 1000)}s (turn age ${Math.round(totalMs / 1000)}s). Marking turn as stalled.`;
      stopTurnWatchdog();
      handleClientSideStall(reason);
    }
  }, 15_000);
}

function stopTurnWatchdog(): void {
  if (turnWatchdog) {
    clearInterval(turnWatchdog);
    turnWatchdog = null;
  }
}

/**
 * Client-side stall handler. Surfaces a status row + assistant error bubble
 * and flips `working` back to false so the UI un-spins. Does NOT touch the
 * server — if the server is still running the turn, its eventual completion
 * event will just re-flip the flag.
 */
function handleClientSideStall(reason: string): void {
  if (!working) return;
  emitThinking({
    type: "thinking_append",
    entry: {
      id: nextId("stall"),
      kind: "status",
      label: "Turn stalled",
      body: reason,
      isError: true,
      timestamp: new Date().toISOString(),
    },
  });
  artifactEvents.dispatchEvent(
    new CustomEvent<AssistantResponse>("assistant_response", {
      detail: {
        type: "assistant_response",
        message: `⚠ Agent turn appears stalled: ${reason}\n\nThe UI has been un-locked. If the server is still working you may see late events arrive in the thinking panel.`,
        receivedAt: new Date().toISOString(),
        sessionId: null,
      },
    }),
  );
  setWorking(false);
  finalizeThinking(true);
}

let currentModel: ModelInfo | null = null;
let modelListeners = new Set<(m: ModelInfo | null) => void>();

function setWorking(w: boolean) {
  working = w;
  for (const fn of workingListeners) fn(w);
}

function setCurrentModel(m: ModelInfo | null) {
  currentModel = m;
  for (const fn of modelListeners) fn(m);
}

function extractTextPart(part: any): string {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return "";
}

function latestAssistantText(messages: any): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const content = message.content;
    const text = Array.isArray(content)
      ? content.map(extractTextPart).filter(Boolean).join("\n")
      : typeof content === "string"
        ? content
        : "";
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Inspect the most recent assistant message for an error condition.
 *
 * The agent records failed turns as an assistant message with empty content
 * plus `stopReason: "error"` and a human-readable `errorMessage`. Without
 * surfacing these, the React UI silently shows nothing back to the user
 * (e.g. on OpenRouter 402 "insufficient credits" the prompt just appears
 * to vanish).
 */
function lastAssistantError(messages: any): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const errMsg = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
    const stop = typeof message.stopReason === "string" ? message.stopReason : "";
    if (errMsg) return errMsg;
    if (stop === "error") return "Agent turn ended with an unspecified error.";
    // Only check the most recent assistant message; older ones are irrelevant.
    return null;
  }
  return null;
}

// ─── Thinking-log derivation ────────────────────────────────────────────────
//
// The server broadcasts the raw AgentSession event stream as { type:
// "agent_event", event: ... } messages. We translate that stream into a
// flat sequence of `ThinkingEntry` items for the UI.
//
// Goals:
//   - One entry per logical step (text chunk, reasoning chunk, tool call,
//     tool result). Deltas update the in-flight entry rather than appending.
//   - Tool calls and their results are correlated by toolCallId so the UI
//     can collapse them into a single block.
//   - Lifecycle events (agent_start/end, turn_start/end) appear as terse
//     status markers.

const thinkingState = {
  // contentIndex -> entryId for the active assistant message's blocks
  textByIndex: new Map<number, string>(),
  reasoningByIndex: new Map<number, string>(),
  // toolCallId -> entryId for active tool calls (so results can flip them closed)
  toolEntryByCallId: new Map<string, string>(),
  // toolCallId -> pretty tool name, for tool_result lookups
  toolNameByCallId: new Map<string, string>(),
  counter: 0,
};

function nextId(prefix: string): string {
  thinkingState.counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${thinkingState.counter.toString(36)}`;
}

function emitThinking(detail: ThinkingEventDetail) {
  artifactEvents.dispatchEvent(new CustomEvent<ThinkingEventDetail>("thinking", { detail }));
}

function shortJson(value: unknown, max = 400): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (!s) return "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

function extractToolResultText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  // pi tools return { content: [{ type: "text", text }], details? }
  if (typeof result === "object") {
    const r = result as any;
    if (Array.isArray(r.content)) {
      const text = r.content
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return shortJson(result, 800);
}

function resetThinkingState() {
  thinkingState.textByIndex.clear();
  thinkingState.reasoningByIndex.clear();
  thinkingState.toolEntryByCallId.clear();
  thinkingState.toolNameByCallId.clear();
}

function finalizeThinking(_error: boolean) {
  // Any still-streaming entries are now closed. We don't currently surface
  // a separate "closed" state; consumers can rely on `streaming: false`.
  resetThinkingState();
}

/**
 * Translate a single raw AgentEvent into zero-or-more ThinkingEntry events.
 * Kept exhaustive on the known event types; unknown types are ignored.
 */
function handleAgentEvent(event: any): void {
  if (!event || typeof event !== "object") return;
  const now = new Date().toISOString();

  switch (event.type) {
    case "agent_start":
      resetThinkingState();
      emitThinking({
        type: "thinking_append",
        entry: { id: nextId("evt"), kind: "agent_start", label: "Agent start", timestamp: now },
      });
      return;

    case "agent_end":
      emitThinking({
        type: "thinking_append",
        entry: { id: nextId("evt"), kind: "agent_end", label: "Agent end", timestamp: now },
      });
      return;

    case "turn_start":
      emitThinking({
        type: "thinking_append",
        entry: { id: nextId("evt"), kind: "turn_start", label: "Turn start", timestamp: now },
      });
      // New turn → drop per-message contentIndex maps but keep tool-call map
      // (tool results may arrive after the assistant message that emitted them).
      thinkingState.textByIndex.clear();
      thinkingState.reasoningByIndex.clear();
      return;

    case "turn_end":
      emitThinking({
        type: "thinking_append",
        entry: { id: nextId("evt"), kind: "turn_end", label: "Turn end", timestamp: now },
      });
      return;

    case "message_update": {
      const ev = event.assistantMessageEvent;
      if (!ev || typeof ev !== "object") return;
      const idx = typeof ev.contentIndex === "number" ? ev.contentIndex : -1;

      // Text streaming
      if (ev.type === "text_start") {
        const id = nextId("txt");
        thinkingState.textByIndex.set(idx, id);
        emitThinking({
          type: "thinking_append",
          entry: { id, kind: "assistant_text", label: "Assistant", body: "", streaming: true, timestamp: now },
        });
        return;
      }
      if (ev.type === "text_delta") {
        const id = thinkingState.textByIndex.get(idx);
        if (!id) return;
        // Re-derive full text from the partial message rather than concatenating
        // deltas (the server already aggregates).
        const fullText = readContentText(ev.partial, idx);
        emitThinking({
          type: "thinking_update",
          entry: { id, kind: "assistant_text", label: "Assistant", body: fullText, streaming: true, timestamp: now },
        });
        return;
      }
      if (ev.type === "text_end") {
        const id = thinkingState.textByIndex.get(idx);
        if (!id) return;
        emitThinking({
          type: "thinking_update",
          entry: { id, kind: "assistant_text", label: "Assistant", body: ev.content ?? "", streaming: false, timestamp: now },
        });
        thinkingState.textByIndex.delete(idx);
        return;
      }

      // Reasoning streaming (thinking)
      if (ev.type === "thinking_start") {
        const id = nextId("thk");
        thinkingState.reasoningByIndex.set(idx, id);
        emitThinking({
          type: "thinking_append",
          entry: { id, kind: "reasoning", label: "Reasoning", body: "", streaming: true, timestamp: now },
        });
        return;
      }
      if (ev.type === "thinking_delta") {
        const id = thinkingState.reasoningByIndex.get(idx);
        if (!id) return;
        const fullText = readContentText(ev.partial, idx);
        emitThinking({
          type: "thinking_update",
          entry: { id, kind: "reasoning", label: "Reasoning", body: fullText, streaming: true, timestamp: now },
        });
        return;
      }
      if (ev.type === "thinking_end") {
        const id = thinkingState.reasoningByIndex.get(idx);
        if (!id) return;
        emitThinking({
          type: "thinking_update",
          entry: { id, kind: "reasoning", label: "Reasoning", body: ev.content ?? "", streaming: false, timestamp: now },
        });
        thinkingState.reasoningByIndex.delete(idx);
        return;
      }

      // Tool-call streaming is summarised when the call actually executes
      // (tool_execution_start); the intermediate toolcall_* deltas are noisy.
      return;
    }

    case "tool_execution_start": {
      const id = nextId("tc");
      thinkingState.toolEntryByCallId.set(event.toolCallId, id);
      thinkingState.toolNameByCallId.set(event.toolCallId, event.toolName);
      emitThinking({
        type: "thinking_append",
        entry: {
          id,
          kind: "tool_call",
          label: event.toolName ?? "Tool",
          body: shortJson(event.args),
          streaming: true,
          toolCallId: event.toolCallId,
          timestamp: now,
        },
      });
      return;
    }

    case "tool_execution_end": {
      const callEntryId = thinkingState.toolEntryByCallId.get(event.toolCallId);
      // Flip the tool_call entry out of streaming, regardless of success.
      if (callEntryId) {
        emitThinking({
          type: "thinking_update",
          entry: {
            id: callEntryId,
            kind: "tool_call",
            label: event.toolName ?? thinkingState.toolNameByCallId.get(event.toolCallId) ?? "Tool",
            body: undefined,
            streaming: false,
            toolCallId: event.toolCallId,
            timestamp: now,
          },
        });
      }
      emitThinking({
        type: "thinking_append",
        entry: {
          id: nextId("tr"),
          kind: "tool_result",
          label: `${event.toolName ?? "tool"} → ${event.isError ? "error" : "ok"}`,
          body: extractToolResultText(event.result),
          isError: Boolean(event.isError),
          toolCallId: event.toolCallId,
          timestamp: now,
        },
      });
      thinkingState.toolEntryByCallId.delete(event.toolCallId);
      thinkingState.toolNameByCallId.delete(event.toolCallId);
      return;
    }

    case "auto_retry_start":
      emitThinking({
        type: "thinking_append",
        entry: {
          id: nextId("evt"),
          kind: "status",
          label: "Auto-retry",
          body: `Attempt ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms — ${event.errorMessage ?? ""}`.trim(),
          isError: true,
          timestamp: now,
        },
      });
      return;

    case "compaction_start":
      emitThinking({
        type: "thinking_append",
        entry: {
          id: nextId("evt"),
          kind: "status",
          label: "Compaction",
          body: `reason=${event.reason}`,
          timestamp: now,
        },
      });
      return;

    default:
      return;
  }
}

/** Pull text out of an AssistantMessage partial at a given contentIndex. */
function readContentText(partial: any, contentIndex: number): string {
  const blocks = Array.isArray(partial?.content) ? partial.content : [];
  const block = contentIndex >= 0 ? blocks[contentIndex] : undefined;
  if (!block) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  return "";
}

function dispatchAssistantResponse(data: any) {
  const messages = data?.state?.messages;
  const text = latestAssistantText(messages);
  const err = lastAssistantError(messages);
  const sessionId = data?.sessionId ?? data?.state?.sessionId ?? null;
  const receivedAt = data?.receivedAt ?? new Date().toISOString();

  // If the assistant produced text before the error (mid-turn provider
  // failure, tool wrapper exception after a streamed reply, etc.) surface
  // BOTH the partial reply and the error. Previously we only routed to the
  // error path when `text` was empty, which meant any partial output ate the
  // error and the user just saw an apparently-truncated message.
  if (text) {
    artifactEvents.dispatchEvent(
      new CustomEvent<AssistantResponse>("assistant_response", {
        detail: {
          type: "assistant_response",
          message: text,
          receivedAt,
          sessionId,
        },
      }),
    );
  }

  if (err) {
    emitThinking({
      type: "thinking_append",
      entry: {
        id: nextId("err"),
        kind: "status",
        label: "Turn error",
        body: err,
        isError: true,
        timestamp: new Date().toISOString(),
      },
    });
    artifactEvents.dispatchEvent(
      new CustomEvent<AssistantResponse>("assistant_response", {
        detail: {
          type: "assistant_response",
          message: `⚠ Agent turn failed: ${err}`,
          receivedAt,
          sessionId,
        },
      }),
    );
    return;
  }

  // Neither text nor error — surface a low-key status so the user sees that
  // the turn ended (otherwise the UI just stops spinning with no feedback).
  if (!text) {
    emitThinking({
      type: "thinking_append",
      entry: {
        id: nextId("end"),
        kind: "status",
        label: "Turn completed",
        body: "No assistant text was produced. See thinking log for details.",
        timestamp: new Date().toISOString(),
      },
    });
    artifactEvents.dispatchEvent(
      new CustomEvent<AssistantResponse>("assistant_response", {
        detail: {
          type: "assistant_response",
          message: "(Agent turn completed with no message. See the Thinking panel for details.)",
          receivedAt,
          sessionId,
        },
      }),
    );
  }
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ui/ws/agent`);

  ws.onmessage = (message) => {
    // Any inbound byte counts as liveness, regardless of type — the watchdog
    // doesn't care whether it's an event, a heartbeat, or noise.
    lastInboundAt = Date.now();
    try {
      const data = JSON.parse(message.data);

      // Server-driven heartbeat: no payload, just an activity marker. We
      // already updated lastInboundAt above, so nothing else to do.
      if (data.type === "heartbeat") return;

      if (data.type === "artifact_created" && data.artifact) {
        artifactEvents.dispatchEvent(
          new CustomEvent<ArtifactRecord>("artifact_created", {
            detail: data.artifact,
          })
        );
        return;
      }

      if (data.type === "user_question" && data.id && data.prompt) {
        artifactEvents.dispatchEvent(
          new CustomEvent<UserQuestion>("user_question", {
            detail: data,
          })
        );
        return;
      }

      if (data.type === "user_question_resolved" && data.id) {
        artifactEvents.dispatchEvent(
          new CustomEvent<UserQuestionResolved>("user_question_resolved", {
            detail: data,
          })
        );
        return;
      }

      if (data.type === "agent_state" && data.state?.model) {
        setCurrentModel(data.state.model);
        return;
      }

      if (data.type === "agent_event" && data.event) {
        // Any agent event counts as turn-level activity for the stall watchdog.
        markAgentActivity();
        handleAgentEvent(data.event);
        return;
      }

      if (data.type === "agent_empty_turn_nudge") {
        // Server detected that the previous turn produced no assistant text
        // and no tool calls, and is now sending ONE follow-up nudge prompt.
        // The original turn is still in flight from the client's POV —
        // do NOT stop the watchdog or flip `working` to false. Just surface
        // a status row so the user can see what happened, and mark activity
        // so the client-side stall watchdog stays satisfied.
        markAgentActivity();
        const detail = typeof data?.detail === "string" ? data.detail : "empty turn detected";
        emitThinking({
          type: "thinking_append",
          entry: {
            id: nextId("nudge"),
            kind: "status",
            label: "Empty-turn nudge",
            body: `Previous turn produced no output (${detail}). Sending a follow-up nudge to the agent.`,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      if (data.type === "agent_prompt_complete") {
        stopTurnWatchdog();
        setWorking(false);
        finalizeThinking(false);
        dispatchAssistantResponse(data);
        return;
      }

      if (data.type === "agent_prompt_stalled") {
        // Server-side stall watchdog fired. Treat as an error and surface it.
        stopTurnWatchdog();
        setWorking(false);
        finalizeThinking(true);
        const reason = typeof data?.reason === "string" ? data.reason : "Server-side stall watchdog fired.";
        emitThinking({
          type: "thinking_append",
          entry: {
            id: nextId("stall"),
            kind: "status",
            label: "Server-side stall",
            body: reason,
            isError: true,
            timestamp: new Date().toISOString(),
          },
        });
        artifactEvents.dispatchEvent(
          new CustomEvent<AssistantResponse>("assistant_response", {
            detail: {
              type: "assistant_response",
              message: `⚠ Agent turn was aborted by the server stall watchdog: ${reason}`,
              receivedAt: data.receivedAt ?? new Date().toISOString(),
              sessionId: data.sessionId ?? null,
            },
          }),
        );
        return;
      }

      if (data.type === "agent_prompt_error") {
        stopTurnWatchdog();
        setWorking(false);
        finalizeThinking(true);
        // Surface the error into the conversation panel so the user sees
        // *something* instead of a silently-aborted turn.
        const errMsg =
          typeof data?.error?.message === "string" ? data.error.message :
          typeof data?.error === "string" ? data.error :
          "Agent turn failed.";
        emitThinking({
          type: "thinking_append",
          entry: {
            id: nextId("err"),
            kind: "status",
            label: "Prompt error",
            body: errMsg,
            isError: true,
            timestamp: new Date().toISOString(),
          },
        });
        artifactEvents.dispatchEvent(
          new CustomEvent<AssistantResponse>("assistant_response", {
            detail: {
              type: "assistant_response",
              message: `⚠ Agent turn failed: ${errMsg}`,
              receivedAt: data.receivedAt,
              sessionId: data.sessionId ?? null,
            },
          })
        );
        return;
      }
    } catch {
      // Ignore unparseable messages
    }
  };

  ws.onopen = () => {
    lastInboundAt = Date.now();
    startLivenessWatchdog();
  };

  ws.onclose = () => {
    stopLivenessWatchdog();
    window.clearTimeout(reconnectTimer ?? undefined);
    reconnectTimer = setTimeout(() => connect(), 1500);
  };
}

/**
 * Send a user prompt to the server-side agent runtime.
 * - 202: prompt queued, agent will stream events (working stays true)
 * - 200: synchronous command result (e.g. /m), no turn started (working returns to false)
 * - !ok: error response
 */
export async function sendPrompt(text: string): Promise<PromptResponse> {
  if (!text.trim() || working) return { kind: "error", message: "Busy or empty input" };

  // Each new prompt starts a fresh thinking log.
  artifactEvents.dispatchEvent(
    new CustomEvent<ThinkingEventDetail>("thinking", { detail: { type: "thinking_reset" } }),
  );
  setWorking(true);
  startTurnWatchdog();
  try {
    const res = await fetch("/ui/api/agent/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
    });

    const body = await res.json().catch(() => ({}));

    if (res.status === 202) return { kind: "queued" };

    setWorking(false);
    const message = typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
      ? body.error
      : `HTTP ${res.status}`;
    return res.ok ? { kind: "info", message } : { kind: "error", message };
  } catch (err) {
    setWorking(false);
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Abort the active agent turn (server-side). Safe to call even when idle;
 * the server returns 503 if no turn is running, which we surface as an error.
 */
export async function abortAgent(): Promise<void> {
  const res = await fetch("/ui/api/agent/abort", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
  }
  // Server-side abort eventually fires agent_prompt_error which will flip
  // working back to false; we don't pre-emptively do it here.
}

export async function answerUserQuestion(id: string, response: string): Promise<void> {
  const res = await fetch("/ui/api/agent/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, response }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
  }
}

/**
 * Subscribe to working-state changes. Returns an unsubscribe function.
 */
export function onWorkingChange(fn: (w: boolean) => void): () => void {
  workingListeners.add(fn);
  return () => workingListeners.delete(fn);
}

/** Returns the current working state synchronously. */
export function isWorking(): boolean {
  return working;
}

/** Fetch the list of available models and current selection. */
export async function fetchModels(): Promise<{ current: ModelInfo | null; available: ModelInfo[] }> {
  const res = await fetch("/ui/api/agent/models");
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  const data = await res.json();
  setCurrentModel(data.current ?? null);
  return data;
}

/**
 * Switch model via the /m handler (POST /ui/api/agent/prompt with "/m provider:id").
 * Returns the server response body.
 */
export async function switchModel(providerColonId: string): Promise<any> {
  const res = await fetch("/ui/api/agent/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: `/m ${providerColonId}` }),
  });
  return res.json();
}

/** Subscribe to current-model changes. Returns unsubscribe. */
export function onModelChange(fn: (m: ModelInfo | null) => void): () => void {
  modelListeners.add(fn);
  return () => modelListeners.delete(fn);
}

/** Returns the current model synchronously. */
export function getCurrentModel(): ModelInfo | null {
  return currentModel;
}

// Connect immediately on module load
connect();