import { useState, useEffect, useCallback } from "react";
import {
  sendPrompt,
  artifactEvents,
  onWorkingChange,
  isWorking,
  type ArtifactRecord,
} from "../lib/agent-bridge";

export type { ArtifactRecord };

export type Notice = { kind: "info" | "error"; message: string };

export function useAgent() {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [working, setWorking] = useState(isWorking);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [persistedIds, setPersistedIds] = useState<Set<string>>(new Set());
  const [dbArtifacts, setDbArtifacts] = useState<ArtifactRecord[]>([]);

  // Re-fetch DB artifacts after save so the DB section stays current
  const fetchDbArtifacts = useCallback(async () => {
    try {
      const res = await fetch("/ui/api/artifacts/db", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setDbArtifacts(data.artifacts ?? []);
      }
    } catch {
      // DB endpoint may not be available yet
    }
  }, []);

  useEffect(() => {
    fetchDbArtifacts();
  }, [fetchDbArtifacts]);

  useEffect(() => {
    const unsubWorking = onWorkingChange(setWorking);

    const onArtifact = (e: Event) => {
      const detail = (e as CustomEvent<ArtifactRecord>).detail;
      setArtifacts((prev) => {
        const filtered = prev.filter((a) => a.id !== detail.id);
        return [detail, ...filtered];
      });
    };

    // NOTE: assistant_response events are intentionally NOT routed to the
    // notice toast — the ConversationPanel owns assistant replies. The
    // notice toast is reserved for app-level info/error feedback.

    artifactEvents.addEventListener("artifact_created", onArtifact);

    // Load existing artifacts from the server on mount
    fetch("/ui/api/artifacts")
      .then((r) => r.json())
      .then((data: { artifacts?: ArtifactRecord[] }) => {
        if (data.artifacts) setArtifacts(data.artifacts);
      })
      .catch(() => {});

    return () => {
      unsubWorking();
      artifactEvents.removeEventListener("artifact_created", onArtifact);
    };
  }, []);

  const submit = useCallback(async (prompt: string) => {
    const result = await sendPrompt(prompt);
    if (result.kind === "info") setNotice({ kind: "info", message: result.message });
    else if (result.kind === "error") setNotice({ kind: "error", message: result.message });
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const saveArtifact = useCallback(async (id: string) => {
    const res = await fetch(`/ui/api/artifacts/${encodeURIComponent(id)}/save`, { method: "POST" });
    if (!res.ok) throw new Error(`Save failed: ${res.status}`);
    // Mark as persisted instead of removing — keeps it visible in sidebar
    setPersistedIds((prev) => new Set(prev).add(id));
    // Re-fetch DB list so the DB section updates
    fetchDbArtifacts();
  }, [fetchDbArtifacts]);

  const discardArtifact = useCallback(async (id: string) => {
    const res = await fetch(`/ui/api/artifacts/${encodeURIComponent(id)}/discard`, { method: "POST" });
    if (!res.ok) throw new Error(`Discard failed: ${res.status}`);
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return { artifacts, working, submit, saveArtifact, discardArtifact, notice, dismissNotice, setNotice, persistedIds, dbArtifacts, fetchDbArtifacts };
}