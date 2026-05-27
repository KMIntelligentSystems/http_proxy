import { useState, useEffect, useCallback } from "react";
import {
  sendPrompt,
  artifactEvents,
  onWorkingChange,
  isWorking,
  type ArtifactRecord,
} from "../lib/agent-bridge";

export type { ArtifactRecord };

export function useAgent() {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [working, setWorking] = useState(isWorking);

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

  const submit = useCallback((prompt: string) => {
    sendPrompt(prompt);
  }, []);

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

  return { artifacts, working, submit, saveArtifact, discardArtifact };
}