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

      if (data.type === "agent_state" && data.state?.model) {
        setCurrentModel(data.state.model);
        return;
      }

      if (data.type === "agent_prompt_complete") {
        setWorking(false);
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