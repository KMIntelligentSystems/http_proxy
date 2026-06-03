import { useState, useEffect, useCallback, useRef } from "react";
import { artifactEvents, type AssistantResponse, type UserQuestion, type UserQuestionResolved } from "../lib/agent-bridge";

export type ConversationMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  kind: "prompt" | "response" | "question" | "answer" | "question-resolved";
  timestamp: string;
  questionId?: string; // links user_question → user_question_resolved pairs
};

export function useConversation() {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const panelOpen = useRef(false);
  const [open, setOpen] = useState(false);

  const addMessage = useCallback((msg: ConversationMessage) => {
    setMessages((prev) => [...prev, msg]);
    if (!panelOpen.current) setUnread((n) => n + 1);
  }, []);

  // Called by App when user submits a prompt
  const addUserPrompt = useCallback((text: string) => {
    addMessage({
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      text,
      kind: "prompt",
      timestamp: new Date().toISOString(),
    });
  }, [addMessage]);

  useEffect(() => {
    const onAssistantResponse = (e: Event) => {
      const detail = (e as CustomEvent<AssistantResponse>).detail;
      if (!detail.message.trim()) return;
      addMessage({
        id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: "agent",
        text: detail.message.trim(),
        kind: "response",
        timestamp: detail.receivedAt ?? new Date().toISOString(),
      });
    };

    const onUserQuestion = (e: Event) => {
      const detail = (e as CustomEvent<UserQuestion>).detail;
      addMessage({
        id: `q_${detail.id}`,
        role: "agent",
        text: detail.prompt,
        kind: "question",
        timestamp: detail.createdAt,
        questionId: detail.id,
      });
    };

    const onUserQuestionResolved = (e: Event) => {
      const detail = (e as CustomEvent<UserQuestionResolved>).detail;
      const answerText = detail.answered
        ? `→ ${detail.response ?? "(no response)"}`
        : `(unanswered: ${detail.reason ?? "unknown"})`;
      addMessage({
        id: `qr_${detail.id}`,
        role: "user",
        text: answerText,
        kind: "answer",
        timestamp: detail.resolvedAt,
        questionId: detail.id,
      });
    };

    artifactEvents.addEventListener("assistant_response", onAssistantResponse as EventListener);
    artifactEvents.addEventListener("user_question", onUserQuestion as EventListener);
    artifactEvents.addEventListener("user_question_resolved", onUserQuestionResolved as EventListener);

    return () => {
      artifactEvents.removeEventListener("assistant_response", onAssistantResponse as EventListener);
      artifactEvents.removeEventListener("user_question", onUserQuestion as EventListener);
      artifactEvents.removeEventListener("user_question_resolved", onUserQuestionResolved as EventListener);
    };
  }, [addMessage]);

  const openPanel = useCallback(() => {
    panelOpen.current = true;
    setUnread(0);
    setOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    panelOpen.current = false;
    setOpen(false);
  }, []);

  const togglePanel = useCallback(() => {
    if (panelOpen.current) {
      closePanel();
    } else {
      openPanel();
    }
  }, [openPanel, closePanel]);

  return { messages, unread, open, openPanel, closePanel, togglePanel, addUserPrompt };
}
