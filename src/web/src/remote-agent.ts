import type { Agent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@mariozechner/pi-web-ui";

type RemoteListener = (event: any, signal: AbortSignal) => void | Promise<void>;

type ServerAgentState = {
  sessionId?: string | null;
  cwd?: string;
  model?: AgentState["model"] | null;
  thinkingLevel?: ThinkingLevel | null;
  messages?: AgentMessage[];
  isStreaming?: boolean;
  tools?: string[];
  systemPrompt?: string;
};

type MutableAgentState = Omit<AgentState, "tools" | "messages" | "isStreaming" | "pendingToolCalls"> & {
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  isStreaming: boolean;
  pendingToolCalls: Set<string>;
  streamingMessage?: AgentMessage;
  errorMessage?: string;
};

function createPlaceholderTool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: `Server-side tool: ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: true } as any,
    execute: async () => ({
      content: [{ type: "text", text: "This tool runs on the server-side agent runtime." }],
      details: {},
      terminate: true,
    }),
  };
}

function normalizeTools(tools: unknown): AgentTool<any>[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (typeof tool === "string") return createPlaceholderTool(tool);
    const candidate = tool as Partial<AgentTool<any>>;
    if (typeof candidate.name === "string") {
      return {
        name: candidate.name,
        label: candidate.label ?? candidate.name,
        description: candidate.description ?? `Server-side tool: ${candidate.name}`,
        parameters: candidate.parameters ?? ({ type: "object", properties: {}, additionalProperties: true } as any),
        execute: candidate.execute ?? createPlaceholderTool(candidate.name).execute,
      };
    }
    return createPlaceholderTool(String(tool));
  });
}

function createInitialState(): MutableAgentState {
  let tools: AgentTool<any>[] = [];
  let messages: AgentMessage[] = [];
  return {
    systemPrompt: "",
    model: undefined as unknown as AgentState["model"],
    thinkingLevel: "off",
    get tools() { return tools; },
    set tools(nextTools: AgentTool<any>[]) { tools = Array.isArray(nextTools) ? [...nextTools] : []; },
    get messages() { return messages; },
    set messages(nextMessages: AgentMessage[]) { messages = Array.isArray(nextMessages) ? [...nextMessages] : []; },
    isStreaming: false,
    pendingToolCalls: new Set<string>(),
    streamingMessage: undefined,
    errorMessage: undefined,
  };
}

function sameAssistantMessage(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.role !== "assistant" || b.role !== "assistant") return false;
  return a.timestamp === b.timestamp && a.model === b.model && a.provider === b.provider;
}

function normalizeAgentMessage(message: any): AgentMessage {
  if (!message || typeof message !== "object") return message as AgentMessage;

  // pi-web-ui renders assistant messages by iterating content parts. The
  // server-side coding-agent generally already uses that shape, but older
  // transcript data, smoke tests, and some custom messages may provide plain
  // text. Normalize at the adapter boundary so the UI never receives an
  // assistant/tool message shape it cannot render.
  if (message.role === "assistant") {
    const content = Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
    return { ...message, content } as AgentMessage;
  }

  if (message.role === "toolResult" && typeof message.content === "string") {
    return { ...message, content: [{ type: "text", text: message.content }] } as AgentMessage;
  }

  return message as AgentMessage;
}

function normalizeAgentMessages(messages: unknown): AgentMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeAgentMessage);
}

function upsertAssistantMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const normalized = normalizeAgentMessage(message);
  const last = messages[messages.length - 1] as any;
  if (sameAssistantMessage(last, normalized)) return [...messages.slice(0, -1), normalized];
  return [...messages, normalized];
}

export class RemoteAgent implements Agent {
  readonly state = createInitialState();
  readonly remoteTools: AgentTool<any>[] = [];

  streamFn: any;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  convertToLlm: any = (messages: AgentMessage[]) => messages;
  transport: any = "auto";
  toolExecution: any = "parallel";
  sessionId?: string;
  thinkingBudgets?: any;
  maxRetryDelayMs?: number;

  private listeners = new Set<RemoteListener>();
  private ws?: WebSocket;
  private reconnectTimer?: number;
  private abortController = new AbortController();

  async connect(): Promise<void> {
    await this.refreshState();
    this.connectEvents();
  }

  subscribe(listener: RemoteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
    const text = typeof input === "string"
      ? input
      : Array.isArray(input)
        ? input.map((message: any) => message?.content ?? "").join("\n")
        : String((input as any)?.content ?? "");

    if (!text.trim()) return;

    const optimisticUserMessage = { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
    this.state.messages = [...this.state.messages, optimisticUserMessage];
    this.state.isStreaming = true;
    await this.emit({ type: "agent_start" });

    const res = await fetch("/ui/api/agent/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      this.state.isStreaming = false;
      this.state.errorMessage = body?.error ?? `Prompt failed with HTTP ${res.status}`;
      await this.emit({ type: "agent_end", messages: this.state.messages });
      throw new Error(this.state.errorMessage);
    }
  }

  async abort(): Promise<void> {
    await fetch("/ui/api/agent/abort", { method: "POST" });
    this.state.isStreaming = false;
    this.abortController.abort();
    this.abortController = new AbortController();
    await this.emit({ type: "agent_end", messages: this.state.messages });
  }

  steer(message: AgentMessage): void {
    void fetch("/ui/api/agent/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: typeof (message as any).content === "string" ? (message as any).content : JSON.stringify(message) }),
    });
  }

  followUp(message: AgentMessage): void {
    void fetch("/ui/api/agent/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: typeof (message as any).content === "string" ? (message as any).content : JSON.stringify(message) }),
    });
  }

  clearSteeringQueue(): void {}
  clearFollowUpQueue(): void {}
  clearAllQueues(): void {}
  hasQueuedMessages(): boolean { return false; }
  get signal(): AbortSignal | undefined { return this.abortController.signal; }
  waitForIdle(): Promise<void> { return Promise.resolve(); }
  reset(): void {
    this.state.messages = [];
    this.state.streamingMessage = undefined;
    this.state.pendingToolCalls.clear();
    this.state.isStreaming = false;
    void this.emit({ type: "agent_end", messages: [] });
  }
  continue(): Promise<void> { return this.prompt("continue"); }

  setModel(model: AgentState["model"]): void {
    this.state.model = model;
    this.emitSync({ type: "agent_state_changed" });
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.state.thinkingLevel = level;
    this.emitSync({ type: "agent_state_changed" });
  }

  private async refreshState(): Promise<void> {
    const res = await fetch("/ui/api/agent/state", { cache: "no-store" });
    if (!res.ok) throw new Error(`Unable to load agent state: HTTP ${res.status}`);
    this.applyState(await res.json());
  }

  private applyState(serverState: ServerAgentState): void {
    this.sessionId = serverState.sessionId ?? undefined;
    this.state.systemPrompt = serverState.systemPrompt ?? "";
    if (serverState.model) this.state.model = serverState.model;
    this.state.thinkingLevel = serverState.thinkingLevel ?? "off";
    this.state.messages = normalizeAgentMessages(serverState.messages);
    this.state.isStreaming = Boolean(serverState.isStreaming);
    this.state.streamingMessage = undefined;
    this.state.pendingToolCalls.clear();

    this.remoteTools.splice(0, this.remoteTools.length, ...normalizeTools(serverState.tools));
    const localTools = this.state.tools.filter((tool) => tool.name === "artifacts");
    this.state.tools = localTools.length ? [...localTools, ...this.remoteTools] : this.remoteTools;

    this.emitSync({ type: "agent_state_changed" });
  }

  private connectEvents(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${location.host}/ui/ws/agent`);

    this.ws.onmessage = (message) => {
      try {
        void this.applyServerMessage(JSON.parse(message.data));
      } catch (err) {
        console.warn("Failed to process agent event", err);
      }
    };

    this.ws.onclose = () => {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connectEvents(), 1500);
    };
  }

  private async applyServerMessage(message: any): Promise<void> {
    if (message.type === "agent_state" && message.state) {
      this.applyState(message.state);
      return;
    }

    if (message.type === "agent_prompt_complete" && message.state) {
      this.applyState(message.state);
      this.state.isStreaming = false;
      await this.emit({ type: "agent_end", messages: this.state.messages });
      return;
    }

    if (message.type === "agent_prompt_error") {
      this.state.errorMessage = message.error?.message ?? String(message.error ?? "Agent prompt failed");
      this.state.isStreaming = false;
      await this.emit({ type: "agent_end", messages: this.state.messages });
      return;
    }

    if (message.type !== "agent_event" || !message.event) return;
    const event = message.event;

    switch (event.type) {
      case "agent_start":
        this.state.isStreaming = true;
        break;
      case "agent_end":
        this.state.isStreaming = false;
        this.state.streamingMessage = undefined;
        this.state.pendingToolCalls.clear();
        break;
      case "message_start":
      case "message_update":
        this.state.streamingMessage = normalizeAgentMessage(event.message);
        break;
      case "message_end":
        // message_end can be emitted for user/tool messages as well as assistant
        // messages. Only assistant messages belong in the stable list here:
        // user messages are added optimistically on prompt submission and final
        // authoritative state arrives via agent_prompt_complete; tool results are
        // handled by tool_execution_end for W2/W3 tool-card rendering.
        if (event.message?.role === "assistant") {
          this.state.messages = upsertAssistantMessage(this.state.messages, normalizeAgentMessage(event.message));
        }
        this.state.streamingMessage = undefined;
        break;
      case "tool_execution_start":
        if (event.toolCallId) this.state.pendingToolCalls.add(event.toolCallId);
        break;
      case "tool_execution_end":
        if (event.toolCallId) this.state.pendingToolCalls.delete(event.toolCallId);
        if (event.toolCallId && event.toolName && event.result) {
          this.state.messages = [...this.state.messages, normalizeAgentMessage({
            role: "toolResult",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            content: event.result.content ?? [],
            details: event.result.details,
            isError: Boolean(event.isError),
            timestamp: Date.now(),
          })];
        }
        break;
    }

    await this.emit(event);
  }

  private emitSync(event: any): void {
    void this.emit(event);
  }

  private async emit(event: any): Promise<void> {
    const signal = this.abortController.signal;
    await Promise.all([...this.listeners].map((listener) => Promise.resolve(listener(event, signal))));
  }
}
