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
 * Returns true if the prompt was accepted (HTTP 202).
 */
export async function sendPrompt(text: string): Promise<boolean> {
  if (!text.trim() || working) return false;

  setWorking(true);
  try {
    const res = await fetch("/ui/api/agent/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
    });

    if (!res.ok) {
      setWorking(false);
      return false;
    }
    return true;
  } catch {
    setWorking(false);
    return false;
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