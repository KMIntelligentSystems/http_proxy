import { useState, useEffect, useCallback } from "react";

export type DocumentManifest = {
  title: string;
  pages: { artifactId: string; title?: string; role?: string }[];
  kind?: string;
  schemaVersion?: number;
  createdAt?: string;
  cssArtifactId?: string;
};

type Props = {
  manifest: DocumentManifest | null;
};

export function DocumentViewer({ manifest }: Props) {
  const [pageIndex, setPageIndex] = useState(0);

  // Reset page when manifest changes
  useEffect(() => {
    setPageIndex(0);
  }, [manifest]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!manifest?.pages?.length) return;
      // Don't capture when focus is in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "ArrowLeft" && pageIndex > 0) {
        setPageIndex((i) => i - 1);
      } else if (e.key === "ArrowRight" && pageIndex < manifest.pages.length - 1) {
        setPageIndex((i) => i + 1);
      }
    },
    [manifest, pageIndex]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!manifest || !manifest.pages?.length) {
    return (
      <div className="empty-state">
        <h2>No document loaded</h2>
        <p>Type a prompt above or select a saved document to begin.</p>
      </div>
    );
  }

  const page = manifest.pages[pageIndex];
  const total = manifest.pages.length;

  return (
    <div className="document-viewer">
      <div className="dv-toolbar">
        <button
          className="dv-nav-btn"
          disabled={pageIndex === 0}
          onClick={() => setPageIndex((i) => i - 1)}
        >
          ‹ Prev
        </button>
        <span className="dv-title">{manifest.title}</span>
        <span className="dv-page-label">
          {page?.title ?? `Page ${pageIndex + 1} of ${total}`}
        </span>
        <span className="dv-page-count">
          {pageIndex + 1} / {total}
        </span>
        <button
          className="dv-nav-btn"
          disabled={pageIndex >= total - 1}
          onClick={() => setPageIndex((i) => i + 1)}
        >
          Next ›
        </button>
      </div>
      <iframe
        className="dv-iframe"
        src={`/ui/api/artifacts/${page.artifactId}`}
        title={page.title ?? `Page ${pageIndex + 1}`}
        /* no sandbox — artifacts are same-origin trusted content */
      />
    </div>
  );
}
