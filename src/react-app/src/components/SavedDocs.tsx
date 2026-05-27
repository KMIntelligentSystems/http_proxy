import { useState } from "react";
import type { ArtifactRecord } from "../hooks/useAgent";

type DocSummary = Pick<ArtifactRecord, "id" | "title" | "createdAt">;

type Props = {
  docs: DocSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onSave: (id: string) => void;
  onDiscard: (id: string) => void;
};

export function SavedDocs({ docs, activeId, onSelect, onSave, onDiscard }: Props) {
  const [saving, setSaving] = useState<string | null>(null);

  return (
    <div className="saved-docs">
      <h3>Documents</h3>
      {docs.length === 0 ? (
        <p className="dim">No saved documents yet.</p>
      ) : (
        <ul className="saved-docs-list">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className={doc.id === activeId ? "active" : ""}
            >
              <span className="doc-title" onClick={() => onSelect(doc.id)}>
                {doc.title || "Untitled"}
              </span>
              {doc.createdAt && (
                <span className="doc-date">
                  {new Date(doc.createdAt).toLocaleDateString()}
                </span>
              )}
              <div className="doc-actions">
                <button
                  className="doc-btn doc-btn-save"
                  title="Save to database"
                  disabled={saving === doc.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSaving(doc.id);
                    onSave(doc.id);
                  }}
                >
                  {saving === doc.id ? "…" : "Save"}
                </button>
                <button
                  className="doc-btn doc-btn-discard"
                  title="Discard"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDiscard(doc.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
