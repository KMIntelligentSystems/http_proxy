import { useState, useRef, useEffect, useCallback } from "react";
import { useAgent, type ArtifactRecord } from "./hooks/useAgent";
import { useLookupConfig } from "./hooks/useLookupConfig";
import { LookupPanel } from "./components/LookupPanel";
import { DocumentViewer, type DocumentManifest } from "./components/DocumentViewer";
import { SavedDocs } from "./components/SavedDocs";

export function App() {
  const { artifacts, working, submit, saveArtifact, discardArtifact, notice, dismissNotice } = useAgent();
  const {
    config,
    lookupData,
    selections,
    statToggles,
    tsMetrics,
    loading,
    activeSlots,
    setSurvey,
    setSelection,
    toggleStat,
    toggleMetric,
    buildLookupContext,
  } = useLookupConfig();

  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // --- Artifact display ---
  // Show only HTML artifacts in the sidebar, deduped by title (newest kept).
  const displayArtifacts = artifacts
    .filter((a) => a.role !== "memory" && a.mimeType === "text/html")
    .filter((a, i, arr) => arr.findIndex((x) => x.title === a.title) === i);

  // Track what's selected and rendered
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<DocumentManifest | null>(null);
  const [viewArtifact, setViewArtifact] = useState<ArtifactRecord | null>(null);

  const loadItem = useCallback(
    (artifactId: string) => {
      setActiveArtifactId(artifactId);
      const a = artifacts.find((x) => x.id === artifactId);
      if (!a) return;
      if (a.mimeType === "application/vnd.dva.document+json") {
        fetch(a.url)
          .then((r) => r.json())
          .then(setManifest)
          .catch(() => setManifest(null));
        setViewArtifact(null);
      } else {
        setManifest(null);
        setViewArtifact(a);
      }
    },
    [artifacts]
  );

  // Auto-select the newest artifact when nothing is selected
  useEffect(() => {
    if (activeArtifactId || displayArtifacts.length === 0) return;
    const latest = displayArtifacts[0];
    loadItem(latest.id);
  }, [displayArtifacts, activeArtifactId, loadItem]);

  // Clear view when active artifact is removed (saved/discarded)
  useEffect(() => {
    if (activeArtifactId && !artifacts.find((a) => a.id === activeArtifactId)) {
      setActiveArtifactId(null);
      setManifest(null);
      setViewArtifact(null);
    }
  }, [artifacts, activeArtifactId]);

  const handleSubmit = () => {
    if (!prompt.trim() || working) return;
    const ctx = buildLookupContext();
    const finalPrompt = ctx ? `${prompt}\n\n[lookup selections: ${ctx}]` : prompt;
    submit(finalPrompt);
    setPrompt("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
  };

  return (
    <div className="app-shell">
      {notice && (
        <div className={`notice notice-${notice.kind}`} role="status">
          <span>{notice.message}</span>
          <button className="notice-close" onClick={dismissNotice} aria-label="Dismiss">×</button>
        </div>
      )}
      <nav className="navbar">
        <span className="brand">DVA</span>
        <input
          ref={inputRef}
          className="prompt-bar"
          placeholder="Ask a question…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={working}
        />
        <button
          className="submit-btn"
          onClick={handleSubmit}
          disabled={working || !prompt.trim()}
        >
          {working ? "Working…" : "Submit"}
        </button>
      </nav>
      <aside className="sidebar">
        <SavedDocs
          docs={displayArtifacts}
          activeId={activeArtifactId}
          onSelect={loadItem}
          onSave={saveArtifact}
          onDiscard={discardArtifact}
        />
        <LookupPanel
          config={config}
          lookupData={lookupData}
          selections={selections}
          statToggles={statToggles}
          tsMetrics={tsMetrics}
          activeSlots={activeSlots}
          loading={loading}
          onSurveyChange={setSurvey}
          onSelect={setSelection}
          onToggleStat={toggleStat}
          onToggleMetric={toggleMetric}
        />
        <button className="generate-btn" disabled={working}>
          Generate
        </button>
      </aside>
      <main className="viewer">
        {working ? (
          <div className="working-state">
            <div className="spinner" />
            <p>Generating…</p>
          </div>
        ) : manifest ? (
          <DocumentViewer manifest={manifest} />
        ) : viewArtifact ? (
          <iframe
            className="dv-iframe"
            src={viewArtifact.url}
            title={viewArtifact.title}
            /* no sandbox — artifacts are same-origin trusted content */
          />
        ) : (
          <div className="empty-state">
            <h2>No document loaded</h2>
            <p>Type a prompt above or select a saved document to begin.</p>
          </div>
        )}
      </main>
    </div>
  );
}