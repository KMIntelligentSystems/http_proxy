import { useState, useRef, useEffect, useCallback } from "react";
import { useAgent, type ArtifactRecord } from "./hooks/useAgent";
import { useConversation } from "./hooks/useConversation";
import { useThinking } from "./hooks/useThinking";
import { useLookupConfig } from "./hooks/useLookupConfig";
import { LookupPanel } from "./components/LookupPanel";
import { DocumentViewer, type DocumentManifest } from "./components/DocumentViewer";
import { CatalogTree } from "./components/CatalogTree";
import { ModelSelector } from "./components/ModelSelector";
import { ConversationPanel } from "./components/ConversationPanel";
import { ThinkingPanel } from "./components/ThinkingPanel";
import { SchedulerPanel } from "./components/SchedulerPanel";
import { LoginScreen } from "./components/LoginScreen";
import { useAuth } from "./lib/auth";
import { abortAgent, answerUserQuestion, artifactEvents, type UserQuestion } from "./lib/agent-bridge";

export function App() {
  const { auth, loading, refresh } = useAuth();
  // Brief blank while /ui/api/auth/me resolves — avoids flashing the login screen.
  if (loading) return null;
  // No resolved identity → collect credentials. This is what scopes the
  // sidebar catalog + Documents panel to the logged-in user (session.user_id).
  if (!auth) return <LoginScreen onLogin={refresh} />;
  return <AuthenticatedApp auth={auth} />;
}

function AuthenticatedApp({ auth }: { auth: { username: string; role: string } | null }) {
  const { artifacts, working, submit, notice, dismissNotice, setNotice, catalog, dbArtifacts } = useAgent();
  const conversation = useConversation();
  const thinking = useThinking();
  const [aborting, setAborting] = useState(false);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
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
  // Track what's selected and rendered
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<DocumentManifest | null>(null);
  const [viewArtifact, setViewArtifact] = useState<ArtifactRecord | null>(null);
  const [jsonContent, setJsonContent] = useState<string | null>(null);
  const [mdContent, setMdContent] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const loadItem = useCallback(
    (artifactId: string) => {
      setActiveArtifactId(artifactId);
      const a = artifacts.find((x) => x.id === artifactId)
             || dbArtifacts.find((x) => x.id === artifactId);
      if (!a) return;
      if (a.mimeType === "application/vnd.dva.document+json") {
        fetch(a.url)
          .then((r) => r.json())
          .then(setManifest)
          .catch(() => setManifest(null));
        setViewArtifact(null);
        setJsonContent(null);
        setMdContent(null);
      } else if (a.mimeType === "application/json") {
        setManifest(null);
        setViewArtifact(a);
        setMdContent(null);
        fetch(a.url)
          .then((r) => r.text())
          .then((text) => {
            try {
              const parsed = JSON.parse(text);
              setJsonContent(JSON.stringify(parsed, null, 2));
            } catch {
              setJsonContent(text);
            }
          })
          .catch(() => setJsonContent(null));
      } else if (a.mimeType === "text/markdown") {
        // Render markdown in-app: browsers cannot reliably display a
        // text/markdown response inside the sandboxed iframe (nosniff +
        // unrenderable MIME = silent download -> blank white iframe).
        setManifest(null);
        setJsonContent(null);
        setMdContent(null);
        setViewArtifact(a);
        fetch(a.url)
          .then((r) => r.text())
          .then(setMdContent)
          .catch(() => setMdContent(null));
      } else {
        setManifest(null);
        setJsonContent(null);
        setMdContent(null);
        setViewArtifact(a);
      }
    },
    [artifacts, dbArtifacts]
  );

  // Auto-select the newest artifact when nothing is selected
  useEffect(() => {
    if (activeArtifactId || artifacts.length === 0) return;
    const latest = artifacts[0];
    loadItem(latest.id);
  }, [artifacts, activeArtifactId, loadItem]);

  // Clear view when active artifact is removed (saved/discarded)
  useEffect(() => {
    if (activeArtifactId && !artifacts.find((a) => a.id === activeArtifactId) && !dbArtifacts.find((a) => a.id === activeArtifactId)) {
      setActiveArtifactId(null);
      setManifest(null);
      setViewArtifact(null);
      setMdContent(null);
    }
  }, [artifacts, dbArtifacts, activeArtifactId]);

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
    // Echo the user's prompt into the conversation panel immediately so the
    // chat reads as a real exchange (the assistant response arrives later via
    // the `assistant_response` event).
    conversation.addUserPrompt(prompt);
    submit(finalPrompt);
    setPrompt("");
    inputRef.current?.focus();
  };

  const handleAbort = async () => {
    if (!working || aborting) return;
    setAborting(true);
    try {
      await abortAgent();
      setNotice({ kind: "info", message: "Abort requested. The agent will stop after the current step." });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setAborting(false);
    }
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
        <span className={`user-pill ${auth?.role ?? "anon"}`} title={auth ? `Logged in as ${auth.username} (${auth.role})` : "Not authenticated"}>
          {auth ? (auth.role === "admin" ? "🔧" : "👤") : "🔒"} {auth?.username ?? "guest"}
        </span>
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
        {working && (
          <button
            className="abort-btn"
            onClick={handleAbort}
            disabled={aborting}
            title="Stop the current agent turn"
          >
            {aborting ? "Aborting…" : "Abort"}
          </button>
        )}
        <ConversationPanel
          messages={conversation.messages}
          open={conversation.open}
          unread={conversation.unread}
          working={working}
          onClose={conversation.togglePanel}
        />
        <ThinkingPanel
          entries={thinking.entries}
          open={thinking.open}
          unread={thinking.unread}
          working={working}
          onToggle={thinking.togglePanel}
          onClose={thinking.closePanel}
        />
        <SchedulerPanel
          open={schedulerOpen}
          onToggle={() => setSchedulerOpen((v) => !v)}
          onClose={() => setSchedulerOpen(false)}
        />
      </nav>
      <aside className="sidebar">
        <CatalogTree
          catalog={catalog}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          activeArtifactId={activeArtifactId}
          onSelect={loadItem}
          onNotice={(kind, message) => setNotice({ kind, message })}
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
        ) : viewArtifact && viewArtifact.mimeType === "application/json" && jsonContent !== null ? (
          <pre className="json-viewer">{jsonContent}</pre>
        ) : viewArtifact && viewArtifact.mimeType === "text/markdown" ? (
          <pre className="md-viewer">{mdContent ?? "Loading…"}</pre>
        ) : viewArtifact ? (
          <iframe
            className="dv-iframe"
            src={viewArtifact.url}
            title={viewArtifact.title}
            sandbox="allow-scripts"
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