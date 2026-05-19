import type { ArtifactRecord } from "../hooks/useAgent";

type DocSummary = Pick<ArtifactRecord, "id" | "title" | "createdAt">;

type Props = {
  docs: DocSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
};

export function SavedDocs({ docs, activeId, onSelect }: Props) {
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
              onClick={() => onSelect(doc.id)}
            >
              <span className="doc-title">{doc.title || "Untitled"}</span>
              {doc.createdAt && (
                <span className="doc-date">
                  {new Date(doc.createdAt).toLocaleDateString()}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
