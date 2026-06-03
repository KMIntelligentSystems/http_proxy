import { useCallback, useEffect, useRef, useState } from "react";
import {
  artifactEvents,
  type ThinkingEntry,
  type ThinkingEventDetail,
} from "../lib/agent-bridge";

/**
 * Buffer of thinking-log entries for the current turn.
 *
 * - `entries` is reset on every new prompt (the bridge dispatches a
 *   `thinking_reset` event from `sendPrompt`).
 * - `unread` counts new entries while the panel is closed and clears when
 *   the panel is opened.
 * - `open` / `openPanel` / `closePanel` / `togglePanel` mirror the
 *   `useConversation` API so the App can drive both panels with the same
 *   ergonomic pattern.
 */
export function useThinking() {
  const [entries, setEntries] = useState<ThinkingEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const panelOpen = useRef(false);

  useEffect(() => {
    const onThinking = (e: Event) => {
      const detail = (e as CustomEvent<ThinkingEventDetail>).detail;
      if (detail.type === "thinking_reset") {
        setEntries([]);
        if (!panelOpen.current) setUnread(0);
        return;
      }
      if (detail.type === "thinking_append") {
        setEntries((prev) => [...prev, detail.entry]);
        if (!panelOpen.current) setUnread((n) => n + 1);
        return;
      }
      if (detail.type === "thinking_update") {
        setEntries((prev) => {
          const idx = prev.findIndex((x) => x.id === detail.entry.id);
          if (idx === -1) return [...prev, detail.entry];
          const next = prev.slice();
          // Preserve fields the update doesn't carry (e.g. body when only
          // streaming flag flipped).
          next[idx] = { ...prev[idx], ...detail.entry };
          return next;
        });
        return;
      }
    };

    artifactEvents.addEventListener("thinking", onThinking as EventListener);
    return () => artifactEvents.removeEventListener("thinking", onThinking as EventListener);
  }, []);

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
    if (panelOpen.current) closePanel();
    else openPanel();
  }, [openPanel, closePanel]);

  return { entries, unread, open, openPanel, closePanel, togglePanel };
}
