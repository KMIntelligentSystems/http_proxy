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

function dispatchAssistantResponse(data: any) {
  const message = latestAssistantText(data?.state?.messages);
  if (!message) return;
  artifactEvents.dispatchEvent(
    new CustomEvent<AssistantResponse>("assistant_response", {
      detail: {
        type: "assistant_response",
        message,
        receivedAt: data.receivedAt,
        sessionId: data.sessionId ?? data.state?.sessionId ?? null,
      },
    })
  );
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ui/ws/agent`);

  ws.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);

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

      if (data.type === "agent_prompt_complete") {
        setWorking(false);
        dispatchAssistantResponse(data);
        return;
      }

      if (data.type === "agent_prompt_error") {
        setWorking(false);
        return;
      }
    } catch {
      // Ignore unparseable messages
    }
  };

  ws.onclose = () => {
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

  setWorking(true);
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