import { useEffect, useRef } from "react";
import { type ThinkingEntry } from "../lib/agent-bridge";

interface ThinkingPanelProps {
  entries: ThinkingEntry[];
  open: boolean;
  unread: number;
  working: boolean;
  onToggle: () => void;
  onClose: () => void;
}

/**
 * A slide-out diagnostic panel that mirrors what the TUI shows while the
 * agent is working: reasoning chunks, tool calls, tool results, and
 * lifecycle markers.
 *
 * Separate from `ConversationPanel` on purpose \u2014 the user-facing chat stays
 * clean while developers can pop this open to see why a turn is taking so
 * long.
 */
export function ThinkingPanel({ entries, open, unread, working, onToggle, onClose }: ThinkingPanelProps) {
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, open]);

  return (
    <>
      <button
        type="button"
        className={`think-toggle ${unread > 0 ? "think-toggle-unread" : ""} ${working ? "think-toggle-working" : ""}`}
        onClick={onToggle}
        title={open ? "Close thinking log" : `Thinking log${unread > 0 ? ` (${unread} new)` : ""}`}
      >
        {unread > 0 && <span className="think-badge">{unread}</span>}
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {/* simple "activity" icon */}
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      </button>

      {open && (
        <>
          <div className="think-backdrop" onClick={onClose} role="presentation" />
          <div className="think-panel" role="dialog" aria-label="Agent thinking log">
            <div className="think-header">
              <h3>Thinking log</h3>
              <span className="think-header-meta">{entries.length} event{entries.length === 1 ? "" : "s"}</span>
              <button className="think-close-btn" onClick={onClose} aria-label="Close">\u00d7</button>
            </div>
            <div className="think-body">
              {entries.length === 0 ? (
                <div className="think-empty">
                  <p>{working ? "Waiting for the first event\u2026" : "No activity yet."}</p>
                  <p className="think-empty-hint">Reasoning, tool calls, and tool results appear here as the agent works.</p>
                </div>
              ) : (
                entries.map((entry) => <ThinkingRow key={entry.id} entry={entry} />)
              )}
              <div ref={tailRef} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

function ThinkingRow({ entry }: { entry: ThinkingEntry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const classes = [
    "think-row",
    `think-${entry.kind}`,
    entry.isError ? "think-error" : "",
    entry.streaming ? "think-streaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Lifecycle markers render as a single dim line.
  if (entry.kind === "agent_start" || entry.kind === "agent_end" || entry.kind === "turn_start" || entry.kind === "turn_end") {
    return (
      <div className={classes}>
        <span className="think-lifecycle-dot" aria-hidden />
        <span className="think-lifecycle-label">{entry.label}</span>
        <time className="think-time" dateTime={entry.timestamp}>{time}</time>
      </div>
    );
  }

  return (
    <div className={classes}>
      <div className="think-row-head">
        <span className="think-kind">{kindLabel(entry.kind)}</span>
        <span className="think-label">{entry.label}</span>
        {entry.streaming && <span className="think-streaming-dot" aria-label="streaming" />}
        <time className="think-time" dateTime={entry.timestamp}>{time}</time>
      </div>
      {entry.body && (
        <pre className="think-body-text">{entry.body}</pre>
      )}
    </div>
  );
}

function kindLabel(kind: ThinkingEntry["kind"]): string {
  switch (kind) {
    case "assistant_text": return "MSG";
    case "reasoning": return "THK";
    case "tool_call": return "CALL";
    case "tool_result": return "RES";
    case "status": return "STATUS";
    default: return "\u2022";
  }
}
