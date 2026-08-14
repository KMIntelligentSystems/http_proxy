import { randomUUID } from "node:crypto";

export type AskUserReason = "timeout" | "no_active_client" | "cancelled" | "server_shutdown" | "agent_aborted" | "stalled";

export type AskUserParams = {
  prompt: string;
  choices?: string[];
  defaultChoice?: string;
  timeoutMs?: number;
  allowFreeText?: boolean;
};

export type UserQuestionEvent = {
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

export type UserQuestionResolvedEvent = {
  type: "user_question_resolved";
  id: string;
  answered: boolean;
  reason?: AskUserReason | "answered";
  response?: string | null;
  resolvedAt: string;
  sessionId?: string | null;
  runId?: string | null;
};

export type AskUserResult = {
  answered: boolean;
  response: string | null;
  reason: AskUserReason | null;
  id: string;
  prompt: string;
  createdAt: string;
  resolvedAt: string;
  sessionId?: string | null;
  runId?: string | null;
};

type PendingQuestion = {
  event: UserQuestionEvent;
  resolve: (result: AskUserResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type UserQuestionTransport = {
  broadcast: (event: UserQuestionEvent | UserQuestionResolvedEvent) => void;
  getClientCount?: () => number;
};

export class UserQuestionManager {
  private pending = new Map<string, PendingQuestion>();
  private recentlyResolved = new Set<string>();
  private transport?: UserQuestionTransport;

  setTransport(transport: UserQuestionTransport) {
    this.transport = transport;
  }

  getPending(): UserQuestionEvent[] {
    return [...this.pending.values()].map((entry) => entry.event);
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  async ask(params: AskUserParams, context: { sessionId?: string | null; runId?: string | null } = {}): Promise<AskUserResult> {
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) throw new Error("ask_user requires a non-empty prompt");

    const now = new Date().toISOString();
    const id = `q_${randomUUID()}`;
    const timeoutMs = clampTimeout(params.timeoutMs);
    const choices = Array.isArray(params.choices)
      ? params.choices.map((choice) => String(choice)).filter((choice) => choice.trim().length > 0).slice(0, 20)
      : undefined;
    const allowFreeText = params.allowFreeText !== false || !choices || choices.length === 0;

    const event: UserQuestionEvent = {
      type: "user_question",
      id,
      prompt,
      ...(choices && choices.length ? { choices } : {}),
      ...(params.defaultChoice ? { defaultChoice: String(params.defaultChoice) } : {}),
      allowFreeText,
      timeoutMs,
      createdAt: now,
      sessionId: context.sessionId ?? null,
      runId: context.runId ?? null,
    };

    if (this.transport?.getClientCount && this.transport.getClientCount() === 0) {
      return this.makeResult(event, false, null, "no_active_client");
    }

    return new Promise<AskUserResult>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveQuestion(id, false, null, "timeout");
      }, timeoutMs);

      this.pending.set(id, { event, resolve, timer });
      this.transport?.broadcast(event);
    });
  }

  answer(id: string, response: string): { ok: true; result: AskUserResult } | { ok: false; status: 404 | 409 | 400; error: string } {
    const cleanId = String(id ?? "").trim();
    if (!cleanId) return { ok: false, status: 400, error: "Missing question id" };
    if (this.recentlyResolved.has(cleanId)) return { ok: false, status: 409, error: "Question already resolved" };

    const pending = this.pending.get(cleanId);
    if (!pending) return { ok: false, status: 404, error: "Question not found" };

    const cleanResponse = String(response ?? "").trim();
    if (!cleanResponse) return { ok: false, status: 400, error: "Missing non-empty response" };
    if (cleanResponse.length > 20_000) return { ok: false, status: 400, error: "Response is too long" };

    const result = this.resolveQuestion(cleanId, true, cleanResponse, null);
    return { ok: true, result };
  }

  cancelAll(reason: AskUserReason = "cancelled") {
    for (const id of [...this.pending.keys()]) {
      this.resolveQuestion(id, false, null, reason);
    }
  }

  private resolveQuestion(id: string, answered: boolean, response: string | null, reason: AskUserReason | null): AskUserResult {
    const pending = this.pending.get(id);
    if (!pending) {
      const now = new Date().toISOString();
      return {
        answered,
        response,
        reason,
        id,
        prompt: "",
        createdAt: now,
        resolvedAt: now,
      };
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.markRecentlyResolved(id);

    const result = this.makeResult(pending.event, answered, response, reason);
    pending.resolve(result);
    this.transport?.broadcast({
      type: "user_question_resolved",
      id,
      answered,
      reason: answered ? "answered" : reason ?? "cancelled",
      response: answered ? response : null,
      resolvedAt: result.resolvedAt,
      sessionId: pending.event.sessionId ?? null,
      runId: pending.event.runId ?? null,
    });
    return result;
  }

  private makeResult(event: UserQuestionEvent, answered: boolean, response: string | null, reason: AskUserReason | null): AskUserResult {
    return {
      answered,
      response,
      reason,
      id: event.id,
      prompt: event.prompt,
      createdAt: event.createdAt,
      resolvedAt: new Date().toISOString(),
      sessionId: event.sessionId ?? null,
      runId: event.runId ?? null,
    };
  }

  private markRecentlyResolved(id: string) {
    this.recentlyResolved.add(id);
    setTimeout(() => this.recentlyResolved.delete(id), 10 * 60 * 1000).unref?.();
  }
}

function clampTimeout(value: unknown): number {
  const fallback = 5 * 60 * 1000;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(5_000, Math.min(Math.round(value), 30 * 60 * 1000));
}
