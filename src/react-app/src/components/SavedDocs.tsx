import { useState, useCallback } from "react";
import type { ArtifactRecord } from "../hooks/useAgent";

type DocSummary = Pick<ArtifactRecord, "id" | "title" | "createdAt"> & { persisted?: boolean };

type Props = {
  docs: DocSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onSave: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
  onError?: (message: string) => void;
};

export function SavedDocs({ docs, activeId, onSelect, onSave, onDiscard, onError }: Props) {
  const [saving, setSaving] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);

  const handleSave = useCallback(async (id: string) => {
    setSaving(id);
    try {
      await onSave(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SavedDocs] Save failed for ${id}:`, msg);
      onError?.(`Save failed: ${msg}`);
    } finally {
      setSaving(null);
    }
  }, [onSave, onError]);

  const handleDiscard = useCallback(async (id: string) => {
    setDiscarding(id);
    try {
      await onDiscard(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SavedDocs] Discard failed for ${id}:`, msg);
      onError?.(`Discard failed: ${msg}`);
    } finally {
      setDiscarding(null);
    }
  }, [onDiscard, onError]);

  return (
    <div className="saved-docs">
      <h3>Documents</h3>
      {docs.length === 0 ? (
        <p className="dim">No documents yet.</p>
      ) : (
        <ul className="saved-docs-list">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className={doc.id === activeId ? "active" : ""}
            >
              <span className="doc-title" onClick={() => onSelect(doc.id)}>
                {doc.title || "Untitled"}
                {doc.persisted && <span className="persisted-badge">Saved ✓</span>}
              </span>
              {doc.createdAt && (
                <span className="doc-date">
                  {new Date(doc.createdAt).toLocaleDateString()}
                </span>
              )}
              <div className="doc-actions">
                {!doc.persisted && (
                  <button
                    className="doc-btn doc-btn-save"
                    title="Save to database"
                    disabled={saving === doc.id || discarding === doc.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSave(doc.id);
                    }}
                  >
                    {saving === doc.id ? "…" : "Save"}
                  </button>
                )}
                <button
                  className="doc-btn doc-btn-discard"
                  title={doc.persisted ? "Discard (already saved to DB)" : "Discard"}
                  disabled={discarding === doc.id || saving === doc.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDiscard(doc.id);
                  }}
                >
                  {discarding === doc.id ? "…" : "✕"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
