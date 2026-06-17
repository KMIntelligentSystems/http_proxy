import { useState, useMemo, useCallback, useEffect } from "react";

// ─── Types (mirrors server CatalogTree shape) ──────────────────────────────

export type CatalogItem = {
  id: string;
  label: string;
  mimeType: string;
  createdAt: string;
  description?: string;
};

export type CatalogGroup = {
  role: string;
  items: CatalogItem[];
};

export type CatalogBucket = {
  id: string;
  category: string;
  subject: string;
  groups: CatalogGroup[];
};

export type CatalogCollection = {
  id: string;
  name: string;
  summary: string;
  memberIds: string[];
};

export type CatalogTree = {
  schemaVersion: number;
  generatedAt: string;
  buckets: CatalogBucket[];
  collections: CatalogCollection[];
};

// ─── Props ─────────────────────────────────────────────────────────────────

type Props = {
  catalog: CatalogTree | null;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  activeArtifactId: string | null;
  onSelect: (id: string) => void;
  onNotice?: (kind: "info" | "error", message: string) => void;
};

// ─── Role display names ────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  "chart": "Charts",
  "section": "Sections",
  "page": "Pages",
  "dataset-csv": "CSV Data",
  "dataset-meta": "Metadata",
  "research-notes": "Research Notes",
  "link-inventory": "Link Inventory",
  "chart-briefs": "Chart Briefs",
  "shared-css": "CSS",
  "document-manifest": "Document Manifest",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

// ─── Component ─────────────────────────────────────────────────────────────

const CATALOG_SEL_KEY = "dva_catalog_selection";

function loadSavedSelection(): string[] {
  try {
    const raw = localStorage.getItem(CATALOG_SEL_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveSelection(ids: Set<string>) {
  try {
    localStorage.setItem(CATALOG_SEL_KEY, JSON.stringify([...ids]));
  } catch {}
}

export function CatalogTree({ catalog, selectedIds, onSelectionChange, activeArtifactId, onSelect, onNotice }: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedRoles, setCollapsedRoles] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<"compose" | "save" | null>(null);

  // Restore saved selection on mount
  useEffect(() => {
    const saved = loadSavedSelection();
    if (saved.length > 0 && selectedIds.size === 0) {
      onSelectionChange(new Set(saved));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist selection changes
  useEffect(() => {
    saveSelection(selectedIds);
  }, [selectedIds]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleRoleCollapse = useCallback((id: string) => {
    setCollapsedRoles((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleItem = useCallback(
    (id: string) => {
      const next = new Set(selectedIds);
      next.has(id) ? next.delete(id) : next.add(id);
      onSelectionChange(next);
    },
    [selectedIds, onSelectionChange],
  );

  const toggleGroup = useCallback(
    (items: CatalogItem[]) => {
      const allSelected = items.every((i) => selectedIds.has(i.id));
      const next = new Set(selectedIds);
      for (const item of items) {
        allSelected ? next.delete(item.id) : next.add(item.id);
      }
      onSelectionChange(next);
    },
    [selectedIds, onSelectionChange],
  );

  const clearSelection = useCallback(() => {
    onSelectionChange(new Set());
  }, [onSelectionChange]);

  const handleSaveCollection = useCallback(async () => {
    if (selectedIds.size === 0 || busyAction) return;
    const name = window.prompt("Name this collection:", "Untitled collection");
    if (!name || !name.trim()) return;
    const summary = window.prompt("Optional summary (press OK to skip):", "") || "";
    setBusyAction("save");
    try {
      const res = await fetch("/ui/api/catalog/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), summary: summary.trim(), memberIds: [...selectedIds] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Save failed: ${res.status}`);
      }
      onNotice?.("info", `Saved collection “${name.trim()}” (${selectedIds.size} items).`);
    } catch (err) {
      onNotice?.("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }, [selectedIds, busyAction, onNotice]);

  const handleCompose = useCallback(async () => {
    if (selectedIds.size === 0 || busyAction) return;
    setBusyAction("compose");
    try {
      const res = await fetch("/ui/api/catalog/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: [...selectedIds] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Compose failed: ${res.status}`);
      }
      onNotice?.("info", `Compose request sent (${selectedIds.size} items). Watch the document panel.`);
    } catch (err) {
      onNotice?.("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }, [selectedIds, busyAction, onNotice]);

  // Filter buckets by search
  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = search.toLowerCase().trim();
    if (!q) return catalog.buckets;

    return catalog.buckets
      .map((bucket) => {
        const matchedGroups = bucket.groups
          .map((group) => {
            const matchedItems = group.items.filter(
              (item) =>
                item.label.toLowerCase().includes(q) ||
                item.id.toLowerCase().includes(q) ||
                item.description?.toLowerCase().includes(q),
            );
            return matchedItems.length > 0 ? { ...group, items: matchedItems } : null;
          })
          .filter(Boolean) as CatalogGroup[];

        if (
          matchedGroups.length > 0 ||
          bucket.category.toLowerCase().includes(q) ||
          bucket.subject.toLowerCase().includes(q)
        ) {
          return { ...bucket, groups: matchedGroups.length > 0 ? matchedGroups : bucket.groups };
        }
        return null;
      })
      .filter(Boolean) as CatalogBucket[];
  }, [catalog, search]);

  if (!catalog) {
    return (
      <div className="catalog-tree">
        <h3>Documents</h3>
        <p className="dim">Loading catalog…</p>
      </div>
    );
  }

  const totalSelected = selectedIds.size;

  return (
    <div className="catalog-tree">
      <h3>Documents</h3>

      {/* Search */}
      <input
        className="catalog-search"
        type="text"
        placeholder="Filter…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Collections (if any) */}
      {catalog.collections.length > 0 && (
        <div className="catalog-collections">
          {catalog.collections.map((col) => (
            <button
              key={col.id}
              className="catalog-collection-chip"
              title={col.summary}
              onClick={() => onSelectionChange(new Set(col.memberIds))}
            >
              {col.name}
            </button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <p className="dim">No documents match your search.</p>
      )}

      {/* Buckets */}
      {filtered.map((bucket) => {
        const bucketKey = bucket.id;
        const isBucketCollapsed = collapsed.has(bucketKey);
        const bucketItemCount = bucket.groups.reduce((sum, g) => sum + g.items.length, 0);

        return (
          <div key={bucketKey} className="catalog-bucket">
            {/* Category › Subject header */}
            <div
              className="catalog-bucket-header"
              onClick={() => toggleCollapse(bucketKey)}
            >
              <span className="catalog-chevron">
                {isBucketCollapsed ? "▶" : "▼"}
              </span>
              <span className="catalog-bucket-category">{bucket.category}</span>
              <span className="catalog-bucket-sep">›</span>
              <span className="catalog-bucket-subject">{bucket.subject}</span>
              <span className="catalog-bucket-count">{bucketItemCount}</span>
            </div>

            {!isBucketCollapsed && (
              <div className="catalog-bucket-body">
                {bucket.groups.map((group) => {
                  const roleKey = `${bucketKey}/${group.role}`;
                  const isRoleCollapsed = collapsedRoles.has(roleKey);
                  const allSelected = group.items.length > 0 && group.items.every((i) => selectedIds.has(i.id));
                  const someSelected = group.items.some((i) => selectedIds.has(i.id));
                  const checkState = allSelected ? "all" : someSelected ? "some" : "none";

                  return (
                    <div key={roleKey} className="catalog-group">
                      {/* Role header */}
                      <div className="catalog-group-header">
                        <button
                          className={`catalog-check catalog-check-${checkState}`}
                          title={
                            checkState === "all"
                              ? "Deselect all"
                              : checkState === "some"
                                ? "Select all"
                                : "Select all"
                          }
                          onClick={() => toggleGroup(group.items)}
                        >
                          {checkState === "all" ? "☑" : checkState === "some" ? "◐" : "☐"}
                        </button>
                        <span
                          className="catalog-group-role"
                          onClick={() => toggleRoleCollapse(roleKey)}
                        >
                          <span className="catalog-chevron">
                            {isRoleCollapsed ? "▶" : "▼"}
                          </span>
                          {roleLabel(group.role)}
                        </span>
                        <span className="catalog-group-count">{group.items.length}</span>
                      </div>

                      {/* Items */}
                      {!isRoleCollapsed && (
                        <div className="catalog-items">
                          {group.items.map((item) => (
                            <div
                              key={item.id}
                              className={`catalog-item ${item.id === activeArtifactId ? "catalog-item-active" : ""}`}
                            >
                              <button
                                className={`catalog-check ${selectedIds.has(item.id) ? "catalog-check-on" : ""}`}
                                onClick={() => toggleItem(item.id)}
                              >
                                {selectedIds.has(item.id) ? "☑" : "☐"}
                              </button>
                              <span
                                className="catalog-item-label"
                                title={item.description || item.label}
                                onClick={() => onSelect(item.id)}
                              >
                                {item.label}
                              </span>
                              <span className="catalog-item-date">
                                {new Date(item.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Selection tray (sticky bottom) */}
      <div className={`catalog-tray ${totalSelected > 0 ? "catalog-tray-visible" : ""}`}>
        <span className="catalog-tray-count">
          {totalSelected} item{totalSelected !== 1 ? "s" : ""} selected
        </span>
        <div className="catalog-tray-actions">
          <button
            className="catalog-tray-btn catalog-tray-compose"
            onClick={handleCompose}
            disabled={totalSelected === 0 || busyAction !== null}
          >
            {busyAction === "compose" ? "Composing…" : "Compose document"}
          </button>
          <button
            className="catalog-tray-btn catalog-tray-save"
            onClick={handleSaveCollection}
            disabled={totalSelected === 0 || busyAction !== null}
          >
            {busyAction === "save" ? "Saving…" : "Save as collection"}
          </button>
          <button className="catalog-tray-btn catalog-tray-clear" onClick={clearSelection} disabled={totalSelected === 0 || busyAction !== null}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}