import { useEffect, useRef } from "react";
import { type ConversationMessage } from "../hooks/useConversation";

interface ConversationPanelProps {
  messages: ConversationMessage[];
  open: boolean;
  unread: number;
  working: boolean;
  onClose: () => void;
}

export function ConversationPanel({ messages, open, unread, working, onClose }: ConversationPanelProps) {
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const lastPrompt = messages.findLast((m) => m.kind === "prompt");

  return (
    <>
      {/* Toggle button — always visible */}
      <button
        type="button"
        className={`conv-toggle ${unread > 0 ? "conv-toggle-unread" : ""} ${working ? "conv-toggle-working" : ""}`}
        onClick={onClose}
        title={open ? "Close conversation" : `Conversation${unread > 0 ? ` (${unread} new)` : ""}`}
      >
        {unread > 0 && <span className="conv-badge">{unread}</span>}
        {working ? (
          <svg className="conv-spinner" viewBox="0 0 24 24" width="18" height="18">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="42" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>

      {/* Slide-out panel */}
      {open && (
        <>
          <div className="conv-backdrop" onClick={onClose} role="presentation" />
          <div className="conv-panel" role="dialog" aria-label="Agent conversation">
            <div className="conv-header">
              <h3>Conversation</h3>
              <button className="conv-close-btn" onClick={onClose} aria-label="Close">×</button>
            </div>
            <div className="conv-body">
              {messages.length === 0 ? (
                <div className="conv-empty">
                  <p>No conversation yet.</p>
                  <p className="conv-empty-hint">Prompts, agent responses, and clarifications appear here.</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <ConversationBubble key={msg.id} message={msg} />
                ))
              )}
              {/* Spacer for last-message prompt (shown below bubbles) */}
              {lastPrompt && (
                <div className="conv-last-prompt">
                  <div className="conv-divider" />
                  <p className="conv-last-prompt-text">{lastPrompt.text}</p>
                </div>
              )}
              <div ref={tailRef} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

function ConversationBubble({ message: msg }: { message: ConversationMessage }) {
  const isAgent = msg.role === "agent";

  return (
    <div className={`conv-bubble ${isAgent ? "conv-agent" : "conv-user"} ${msg.kind === "question" ? "conv-question" : ""}`}>
      <div className="conv-bubble-head">
        <span className="conv-bubble-role">{isAgent ? "Agent" : "You"}</span>
        <time className="conv-bubble-time" dateTime={msg.timestamp}>
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
      <div className="conv-bubble-text">{msg.text}</div>
    </div>
  );
}
