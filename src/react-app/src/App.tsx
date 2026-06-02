import { useState, useRef, useEffect, useCallback } from "react";
import { useAgent, type ArtifactRecord } from "./hooks/useAgent";
import { useLookupConfig } from "./hooks/useLookupConfig";
import { LookupPanel } from "./components/LookupPanel";
import { DocumentViewer, type DocumentManifest } from "./components/DocumentViewer";
import { SavedDocs } from "./components/SavedDocs";
import { ModelSelector } from "./components/ModelSelector";
import { answerUserQuestion, artifactEvents, type UserQuestion } from "./lib/agent-bridge";

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
  const [questionQueue, setQuestionQueue] = useState<UserQuestion[]>([]);
  const [questionResponse, setQuestionResponse] = useState("");
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const activeQuestion = questionQueue[0] ?? null;

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

  useEffect(() => {
    const onQuestion = (event: Event) => {
      const question = (event as CustomEvent<UserQuestion>).detail;
      setQuestionQueue((prev) => prev.some((q) => q.id === question.id) ? prev : [...prev, question]);
      setQuestionError(null);
    };
    const onResolved = (event: Event) => {
      const resolved = (event as CustomEvent<{ id: string }>).detail;
      setQuestionQueue((prev) => prev.filter((q) => q.id !== resolved.id));
      setQuestionError(null);
      setAnsweringQuestion(false);
    };
    artifactEvents.addEventListener("user_question", onQuestion as EventListener);
    artifactEvents.addEventListener("user_question_resolved", onResolved as EventListener);
    return () => {
      artifactEvents.removeEventListener("user_question", onQuestion as EventListener);
      artifactEvents.removeEventListener("user_question_resolved", onResolved as EventListener);
    };
  }, []);

  useEffect(() => {
    setQuestionResponse(activeQuestion?.defaultChoice ?? "");
    setQuestionError(null);
    setAnsweringQuestion(false);
  }, [activeQuestion?.id]);

  const submitQuestionAnswer = async (response: string) => {
    if (!activeQuestion || answeringQuestion) return;
    const trimmed = response.trim();
    if (!trimmed) {
      setQuestionError("Please enter an answer before submitting.");
      return;
    }
    setAnsweringQuestion(true);
    setQuestionError(null);
    try {
      await answerUserQuestion(activeQuestion.id, trimmed);
      setQuestionQueue((prev) => prev.filter((q) => q.id !== activeQuestion.id));
      setQuestionResponse("");
    } catch (err) {
      setQuestionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnsweringQuestion(false);
    }
  };

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
      {activeQuestion && (
        <div className="question-modal-backdrop" role="presentation">
          <div className="question-modal" role="dialog" aria-modal="true" aria-labelledby="agent-question-title">
            <div className="question-modal-kicker">Agent needs clarification</div>
            <h2 id="agent-question-title">Question</h2>
            <p className="question-modal-prompt">{activeQuestion.prompt}</p>
            {activeQuestion.choices && activeQuestion.choices.length > 0 && (
              <div className="question-choice-list" aria-label="Answer choices">
                {activeQuestion.choices.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className="question-choice-btn"
                    disabled={answeringQuestion}
                    onClick={() => submitQuestionAnswer(choice)}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            )}
            {activeQuestion.allowFreeText !== false && (
              <textarea
                className="question-response"
                value={questionResponse}
                onChange={(e) => setQuestionResponse(e.target.value)}
                placeholder="Type your answer…"
                disabled={answeringQuestion}
                autoFocus
              />
            )}
            {questionError && <div className="question-error" role="alert">{questionError}</div>}
            <div className="question-modal-actions">
              <span className="question-timeout">Timeout: {Math.round(activeQuestion.timeoutMs / 1000)}s</span>
              {activeQuestion.allowFreeText !== false && (
                <button
                  type="button"
                  className="question-submit-btn"
                  disabled={answeringQuestion || !questionResponse.trim()}
                  onClick={() => submitQuestionAnswer(questionResponse)}
                >
                  {answeringQuestion ? "Sending…" : "Send answer"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {notice && (
        <div className={`notice notice-${notice.kind}`} role="status">
          <span>{notice.message}</span>
          <button className="notice-close" onClick={dismissNotice} aria-label="Dismiss">×</button>
        </div>
      )}
      <nav className="navbar">
        <span className="brand">DVA</span>
        <ModelSelector />
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