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

function setWorking(w: boolean) {
  working = w;
  for (const fn of workingListeners) fn(w);
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

// Connect immediately on module load
connect();