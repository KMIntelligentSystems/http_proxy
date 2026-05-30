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

  useEffect(() => {
    const unsubWorking = onWorkingChange(setWorking);

    const onArtifact = (e: Event) => {
      const detail = (e as CustomEvent<ArtifactRecord>).detail;
      setArtifacts((prev) => {
        const filtered = prev.filter((a) => a.id !== detail.id);
        return [detail, ...filtered];
      });
    };

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
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const discardArtifact = useCallback(async (id: string) => {
    const res = await fetch(`/ui/api/artifacts/${encodeURIComponent(id)}/discard`, { method: "POST" });
    if (!res.ok) throw new Error(`Discard failed: ${res.status}`);
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return { artifacts, working, submit, saveArtifact, discardArtifact, notice, dismissNotice };
}