import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ArtifactMimeType =
  | "image/svg+xml"
  | "text/html"
  | "text/css"
  | "text/csv"
  | "text/markdown"
  | "text/plain"
  | "application/json"
  | "application/vnd.dva.document+json";

export type ArtifactRecord = {
  id: string;
  sessionId: string;
  title: string;
  filename: string;
  mimeType: ArtifactMimeType;
  createdAt: string;
  updatedAt: string;
  size: number;
  url: string;
  description?: string;
  role?: string;        // semantic tag, e.g. "memory", "dataset-csv", "chart", "page", "document-manifest"
  category?: string;    // domain category (from DB JOIN)
  subject?: string;     // domain subject (from DB JOIN)
  tags?: string;        // raw JSON tags array from DB (e.g. '["m3","nsa"]')
};

export type CreateArtifactInput = {
  sessionId?: string | null;
  title: string;
  filename: string;
  mimeType: string;
  content: string;
  description?: string;
  role?: string;
};

type ArtifactListener = (artifact: ArtifactRecord) => void;

const ALLOWED_MIME_TYPES = new Set<ArtifactMimeType>([
  "image/svg+xml",
  "text/html",
  "text/css",
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/json",
  "application/vnd.dva.document+json",
]);

export function isUtf8ArtifactMime(mimeType: string): boolean {
  return mimeType.startsWith("text/")
      || mimeType === "application/json"
      || mimeType === "application/vnd.dva.document+json";
}

/** Safely parse a JSON tags array string, returning an empty array on failure. */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Derive a 4–8 word compact label from an artifact title. Strips dates, version suffixes. */
function deriveLabel(title: string): string {
  let t = title
    // Strip date ranges like "(Jan 2002–Apr 2026)"
    .replace(/\([^)]*\d{4}[^)]*\)/g, "")
    // Strip "2002-2026" ranges
    .replace(/\d{4}\s*[–\-]\s*\d{4}/g, "")
    // Strip trailing parentheticals
    .replace(/\([^)]+\)$/g, "")
    // Strip version suffixes
    .replace(/\s*v\d+$/i, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();

  // Collapse runs of commas
  t = t.replace(/,\s*,/g, ",").replace(/,\s*,/g, ",");

  // Remove leading/trailing commas
  t = t.replace(/^,\s*/, "").replace(/,\s*$/, "");

  // Limit to ~8 words
  const words = t.split(/\s+/);
  if (words.length <= 8) return t || title;
  return words.slice(0, 8).join(" ") + "…";
}

function safeSessionId(sessionId: string | null | undefined): string {
  const value = (sessionId || "standalone").trim();
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "standalone";
}

function validateFilename(filename: string): string {
  const name = String(filename || "").trim();
  if (!name) throw new Error("filename is required");
  if (name.length > 160) throw new Error("filename is too long");
  if (path.isAbsolute(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("filename must be a simple relative filename");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]*$/.test(name)) {
    throw new Error("filename contains unsupported characters");
  }
  return name;
}

function assertInside(baseDir: string, candidatePath: string) {
  const relative = path.relative(baseDir, candidatePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error("artifact path escaped artifact root");
}

function artifactId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

// ─── Catalog types ──────────────────────────────────────────────────────────────

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

/** Server-side filter applied to buildCatalog(). Set by the agent via
 *  query_artifacts when the user's prompt carries domain concepts.
 *  When null/empty, buildCatalog() returns an empty tree — the sidebar
 *  shows nothing until the agent explicitly filters. */
export type CatalogFilter = {
  tags?: string[];
  roles?: string[];
  categories?: string[];
  subjects?: string[];
};

export class ArtifactStore {
  readonly rootDir: string;
  private listeners = new Set<ArtifactListener>();
  private schemaEnsured = false;
  private catalogFilter: CatalogFilter | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    // Wipe stale file-store artifacts from prior runs. The catalog DB
    // is the durable store; the file store is scratch space per process.
    try { fs.rmSync(this.rootDir, { recursive: true, force: true }); } catch { /* first run */ }
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  /** Current user id for browser-catalog scoping. Set by the host from
   *  x-authenticated-user header. The TUI agent sets this to null (unscoped). */
  currentUserId: string | null = null;

  /** Set a server-side filter that buildCatalog() applies. When null or
   *  all fields empty, the catalog returns an empty tree. Called by the
   *  agent (query_artifacts tool) after extracting concepts from the
   *  user's prompt. */
  setCatalogFilter(filter: CatalogFilter | null): void {
    this.catalogFilter = filter;
  }

  /** Remove the active catalog filter. The next buildCatalog() call
   *  returns an empty tree until a new filter is set. */
  clearCatalogFilter(): void {
    this.catalogFilter = null;
  }

  /** Path to the SQLite DB shared with the host. */
  private dbPath(): string {
    return path.resolve(this.rootDir, "..", "artifacts.db");
  }

  /**
   * Open the artifact DB and apply any lazy migrations the codebase relies on.
   * Today this only ensures the `v_artifact_head` view exists — older DBs
   * created from earlier revisions of data/schema.sql don't have it.
   * Returns undefined when the DB file is missing (legitimate first-run state).
   */
  private openDb(): DatabaseSync | undefined {
    const p = this.dbPath();
    if (!fs.existsSync(p)) return undefined;
    const db = new DatabaseSync(p);
    if (!this.schemaEnsured) {
      try {
        // Drop old view first so schema changes are picked up on restart.
        db.exec("DROP VIEW IF EXISTS v_artifact_head");
        db.exec(
          `CREATE VIEW v_artifact_head AS
             SELECT a.*
             FROM artifact a
             LEFT JOIN artifact b ON b.replaces_id = a.id
             WHERE b.id IS NULL
               AND a.role NOT IN ('memory', 'catalog', 'dataset-csv')
               AND a.mime_type NOT IN ('application/json', 'text/csv');`
        );
        this.schemaEnsured = true;
      } catch (err) {
        console.warn(`[artifacts] could not ensure v_artifact_head view: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return db;
  }

  onCreated(listener: ArtifactListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const title = String(input.title || "").trim();
    if (!title) throw new Error("title is required");
    if (title.length > 200) throw new Error("title is too long");

    if (input.role !== undefined) {
      const role = String(input.role).trim();
      if (role.length > 64) throw new Error("role is too long");
      if (role && !/^[a-z0-9-]+$/.test(role)) throw new Error("role must be lowercase kebab-case");
    }

    const mimeType = input.mimeType as ArtifactMimeType;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`Unsupported artifact mimeType: ${input.mimeType}`);
    }

    const filename = validateFilename(input.filename);
    const content = String(input.content ?? "");
    const maxBytes = 8 * 1024 * 1024;
    const size = Buffer.byteLength(content, "utf-8");
    if (size > maxBytes) throw new Error(`artifact content exceeds ${maxBytes} bytes`);

    const sessionId = safeSessionId(input.sessionId);
    const id = artifactId();
    const dir = path.resolve(this.rootDir, sessionId, id);
    assertInside(this.rootDir, dir);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.resolve(dir, filename);
    assertInside(dir, filePath);
    fs.writeFileSync(filePath, content, "utf-8");

    const now = new Date().toISOString();
    const record: ArtifactRecord = {
      id,
      sessionId,
      title,
      filename,
      mimeType,
      createdAt: now,
      updatedAt: now,
      size,
      url: `/ui/api/artifacts/${encodeURIComponent(id)}`,
      description: input.description?.trim() || undefined,
      role: input.role?.trim() || undefined,
    };
    fs.writeFileSync(path.resolve(dir, "metadata.json"), JSON.stringify(record, null, 2), "utf-8");

    for (const listener of this.listeners) {
      try { listener(record); } catch (err) { console.warn(`[artifacts] listener failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return record;
  }

  list(sessionId?: string | null): ArtifactRecord[] {
    const records: ArtifactRecord[] = [];
    const sessions = sessionId ? [safeSessionId(sessionId)] : this.safeReadDir(this.rootDir).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const session of sessions) {
      const sessionDir = path.resolve(this.rootDir, session);
      if (!this.isInsideRoot(sessionDir)) continue;
      for (const entry of this.safeReadDir(sessionDir)) {
        if (!entry.isDirectory()) continue;
        const metadata = this.readMetadata(path.resolve(sessionDir, entry.name, "metadata.json"));
        if (metadata) records.push(metadata);
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** All artifacts from the SQLite DB, returned as ArtifactRecord-shaped objects. */
  /**
   * Build a catalog tree from DB artifacts, grouped by category → subject → role.
   * Excludes memory and prior catalog artifacts. Within each (bucket, role),
   * prefers the latest artifact by replaces_id chain head (fallback: created_at).
   */
  /** Build the catalog tree, scoped to currentUserId if set (browser session)
   *  or unscoped (TUI agent session). */
  buildCatalog(): CatalogTree {
    const records = this.dbList(this.currentUserId);
    const now = new Date().toISOString();

    // Exclude internal-only roles and mime types — these are plumbing,
    // not end-user content.
    const visible = records.filter((r) => {
      if (r.role === "memory" || r.role === "catalog") return false;
      if (r.role === "dataset-csv") return false;
      if (r.mimeType === "application/json") return false;
      if (r.mimeType === "text/csv") return false;
      return true;
    });

    // ── Apply server-side catalog filter ──────────────────────────────────
    // When the agent hasn't set a filter (startup), return an empty catalog.
    // The sidebar shows nothing until the agent extracts concepts from the
    // user's prompt and runs a filtered query_artifacts call.
    const filter = this.catalogFilter;
    const hasFilter = filter && (
      (filter.tags && filter.tags.length > 0) ||
      (filter.roles && filter.roles.length > 0) ||
      (filter.categories && filter.categories.length > 0) ||
      (filter.subjects && filter.subjects.length > 0)
    );

    let filtered: typeof visible;
    if (!hasFilter) {
      return { schemaVersion: 1, generatedAt: now, buckets: [], collections: this.loadCollections() };
    }

    filtered = visible.filter((r) => {
      // OR across filter fields, OR within each field's values
      if (filter.tags && filter.tags.length > 0) {
        const artTags: string[] = parseTags(r.tags);
        if (filter.tags.some(ft => artTags.includes(ft))) return true;
      }
      if (filter.roles && filter.roles.length > 0) {
        if (filter.roles.includes(r.role || "")) return true;
      }
      if (filter.categories && filter.categories.length > 0) {
        if (filter.categories.includes(r.category || "")) return true;
      }
      if (filter.subjects && filter.subjects.length > 0) {
        if (filter.subjects.includes(r.subject || "")) return true;
      }
      return false;
    });

    // Group: category → subject → role → items
    const bucketMap = new Map<string, CatalogBucket>();

    for (const rec of filtered) {
      const category = rec.category || "Uncategorized";
      const subject = rec.subject || "General";
      const role = rec.role || "other";
      const bucketKey = `${category}//${subject}`;

      let bucket = bucketMap.get(bucketKey);
      if (!bucket) {
        bucket = {
          id: `${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          category,
          subject,
          groups: [],
        };
        bucketMap.set(bucketKey, bucket);
      }

      let group = bucket.groups.find((g) => g.role === role);
      if (!group) {
        group = { role, items: [] };
        bucket.groups.push(group);
      }

      // Derive compact label: strip dates and version suffixes
      const label = deriveLabel(rec.title);

      group.items.push({
        id: rec.id,
        label,
        mimeType: rec.mimeType,
        createdAt: rec.createdAt,
        description: rec.description || undefined,
      });
    }

    // Sort buckets, groups, items
    const buckets = [...bucketMap.values()].sort((a, b) =>
      a.category.localeCompare(b.category) || a.subject.localeCompare(b.subject),
    );

    for (const bucket of buckets) {
      const roleOrder = ["chart", "section", "page", "dataset-csv", "dataset-meta", "research-notes", "link-inventory", "chart-briefs", "shared-css", "document-manifest"];
      bucket.groups.sort((a, b) => {
        const ai = roleOrder.indexOf(a.role);
        const bi = roleOrder.indexOf(b.role);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      for (const group of bucket.groups) {
        group.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
    }

    // Load current collections from the latest catalog artifact
    const collections = this.loadCollections();

    return { schemaVersion: 1, generatedAt: now, buckets, collections };
  }

  /**
   * Latest persisted catalog artifact (head of the role='catalog' chain),
   * or undefined if no catalog has been persisted yet. We follow replaces_id
   * forward from any catalog row — the head is the one nothing replaces.
   */
  private getLatestCatalogRow(): { id: string; content: string; createdAt: string } | undefined {
    const sqldb = this.openDb();
    if (!sqldb) return undefined;
    try {
      const rows = sqldb.prepare(
        `SELECT a.id, a.content, a.created_at
           FROM artifact a
           LEFT JOIN artifact b ON b.replaces_id = a.id
          WHERE a.role = 'catalog' AND b.id IS NULL
          ORDER BY a.created_at DESC
          LIMIT 1`
      ).all() as Record<string, unknown>[];
      if (rows.length === 0) return undefined;
      const r = rows[0];
      return { id: r.id as string, content: r.content as string, createdAt: r.created_at as string };
    } catch {
      return undefined;
    } finally {
      sqldb.close();
    }
  }

  private loadCollections(): CatalogCollection[] {
    const head = this.getLatestCatalogRow();
    if (!head) return [];
    try {
      const catalog = JSON.parse(head.content);
      return Array.isArray(catalog?.collections) ? catalog.collections : [];
    } catch {
      return [];
    }
  }

  /**
   * Persist a catalog tree as a role='catalog' JSON artifact with replaces_id
   * pointing at the previous head. No-ops when the structural payload
   * (buckets + collections) is byte-identical to the head — prevents churn
   * on routine GET-driven rebuilds.
   *
   * Returns the new artifact id when a write happened, or undefined when the
   * payload was unchanged.
   */
  persistCatalogIfChanged(catalog: CatalogTree): string | undefined {
    const sqldb = this.openDb();
    if (!sqldb) return undefined;
    try {
      // Build a stable serialization that ignores volatile fields like generatedAt.
      const payload = {
        schemaVersion: catalog.schemaVersion,
        buckets: catalog.buckets,
        collections: catalog.collections,
      };
      const payloadStr = JSON.stringify(payload);

      const headRows = sqldb.prepare(
        `SELECT a.id, a.content
           FROM artifact a
           LEFT JOIN artifact b ON b.replaces_id = a.id
          WHERE a.role = 'catalog' AND b.id IS NULL
          ORDER BY a.created_at DESC
          LIMIT 1`
      ).all() as Record<string, unknown>[];

      const previousId = headRows.length > 0 ? (headRows[0].id as string) : null;
      if (previousId) {
        try {
          const prev = JSON.parse(headRows[0].content as string);
          const prevPayload = JSON.stringify({
            schemaVersion: prev.schemaVersion,
            buckets: prev.buckets,
            collections: prev.collections,
          });
          if (prevPayload === payloadStr) return undefined; // No change — skip the write.
        } catch {
          // Fall through and write a fresh row if previous was unparseable.
        }
      }

      const id = artifactId();
      const now = new Date().toISOString();
      const content = JSON.stringify({ ...catalog, generatedAt: now }, null, 2);
      const size = Buffer.byteLength(content, "utf-8");
      const title = "Artifact Catalog";
      const filename = "artifact-catalog.json";

      // Reuse a synthetic session row so the FK is satisfied. "catalog" is a
      // stable, reserved session id we own.
      sqldb.prepare(
        "INSERT OR IGNORE INTO session (id, model_id, title, started_at, prompt_count) VALUES (?, NULL, ?, ?, 0)"
      ).run("catalog", "Catalog snapshots", now);

      sqldb.prepare(
        `INSERT INTO artifact
           (id, session_id, title, filename, mime_type, role, description, content,
            size_bytes, created_at, updated_at, replaces_id, provenance, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, "catalog", title, filename, "application/json", "catalog",
        "Derived catalog tree (buckets[] + collections[]).", content,
        size, now, now, previousId, "{}", JSON.stringify(["catalog"]),
      );
      return id;
    } catch (err) {
      console.warn(`[artifacts] persistCatalogIfChanged failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      sqldb.close();
    }
  }

  /**
   * Upsert a collection (by id, or append a new one) on the latest catalog
   * and persist a new catalog row that points at the previous head via
   * replaces_id. Returns the post-write catalog tree.
   */
  saveCollection(input: {
    id?: string;
    name: string;
    summary?: string;
    memberIds: string[];
  }): CatalogTree {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("collection name is required");
    if (name.length > 120) throw new Error("collection name is too long");
    const memberIds = Array.isArray(input.memberIds) ? input.memberIds.filter((m) => typeof m === "string" && m.length > 0) : [];
    if (memberIds.length === 0) throw new Error("collection must have at least one member");
    const summary = (input.summary || "").trim().slice(0, 500);
    const id = input.id?.trim() || `col-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

    // Build a fresh derived catalog, then apply the collection mutation on top.
    const catalog = this.buildCatalog();
    const idx = catalog.collections.findIndex((c) => c.id === id);
    const entry: CatalogCollection = { id, name, summary, memberIds };
    if (idx >= 0) catalog.collections[idx] = entry;
    else catalog.collections.push(entry);

    this.persistCatalogIfChanged(catalog);
    return catalog;
  }

  /** Remove a collection by id. Returns the post-write catalog tree. */
  deleteCollection(id: string): CatalogTree {
    const catalog = this.buildCatalog();
    catalog.collections = catalog.collections.filter((c) => c.id !== id);
    this.persistCatalogIfChanged(catalog);
    return catalog;
  }

  /** List artifacts from DB, optionally scoped to a user. When userId is
   *  provided, only artifacts in sessions belonging to that user are returned.
   *  When null, all artifacts are returned (TUI agent mode). */
  dbList(userId?: string | null): ArtifactRecord[] {
    const sqldb = this.openDb();
    if (!sqldb) return [];
    try {
      const userClause = userId ? `AND sess.user_id = '${userId.replace(/'/g, "''")}'` : "";
      const sql = `SELECT a.id, a.session_id, a.title, a.filename, a.mime_type, a.role,
                a.description, a.size_bytes, a.created_at, a.updated_at,
                a.tags,
                c.name AS category, s.name AS subject
         FROM v_artifact_head a
         LEFT JOIN session sess ON a.session_id = sess.id
         LEFT JOIN subject s ON sess.subject_id = s.id
         LEFT JOIN category c ON s.category_id = c.id
         WHERE 1=1 ${userClause}
         ORDER BY a.created_at DESC`;
      const rows = sqldb.prepare(sql).all() as Record<string, unknown>[];
      return rows.map((rec) => ({
        id: rec.id as string,
        sessionId: rec.session_id as string,
        title: rec.title as string,
        filename: rec.filename as string,
        mimeType: rec.mime_type as ArtifactMimeType,
        role: (rec.role as string) || undefined,
        description: (rec.description as string) || undefined,
        size: (rec.size_bytes as number) || 0,
        createdAt: rec.created_at as string,
        updatedAt: rec.updated_at as string,
        url: `/ui/api/artifacts/${rec.id}`,
        category: (rec.category as string) || undefined,
        subject: (rec.subject as string) || undefined,
        tags: (rec.tags as string) || undefined,
      }));
    } finally {
      sqldb.close();
    }
  }

  /** Fetch a single artifact's content from the SQLite DB, optionally scoped to user.
   *  Returns undefined if not found. */
  dbGet(id: string, userId?: string | null): { record: ArtifactRecord; content: string } | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
    const sqldb = this.openDb();
    if (!sqldb) return undefined;
    try {
      const rows = sqldb.prepare("SELECT id, session_id, title, filename, mime_type, role, description, size_bytes, created_at, updated_at, content FROM artifact WHERE id = ?").all(id) as Record<string, unknown>[];
      if (rows.length === 0) return undefined;
      const rec = rows[0];
      return {
        record: {
          id: rec.id as string,
          sessionId: rec.session_id as string,
          title: rec.title as string,
          filename: rec.filename as string,
          mimeType: rec.mime_type as ArtifactMimeType,
          role: (rec.role as string) || undefined,
          description: (rec.description as string) || undefined,
          size: (rec.size_bytes as number) || 0,
          createdAt: rec.created_at as string,
          updatedAt: rec.updated_at as string,
          url: `/ui/api/artifacts/${rec.id}`,
        },
        content: rec.content as string,
      };
    } finally {
      sqldb.close();
    }
  }

  get(id: string): { record: ArtifactRecord; filePath: string } | undefined {
    if (!/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/.test(id)) return undefined;
    for (const record of this.list()) {
      if (record.id !== id) continue;
      const filePath = path.resolve(this.rootDir, record.sessionId, record.id, record.filename);
      const baseDir = path.resolve(this.rootDir, record.sessionId, record.id);
      assertInside(baseDir, filePath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
      return { record, filePath };
    }
    return undefined;
  }

  delete(id: string): boolean {
    for (const record of this.list()) {
      if (record.id !== id) continue;
      const dir = path.resolve(this.rootDir, record.sessionId, record.id);
      if (!this.isInsideRoot(dir)) return false;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private safeReadDir(dir: string): fs.Dirent[] {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  }

  private readMetadata(filePath: string): ArtifactRecord | undefined {
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ArtifactRecord;
      if (!record?.id || !record?.filename || !record?.mimeType) return undefined;
      return record;
    } catch {
      return undefined;
    }
  }

  private isInsideRoot(candidatePath: string): boolean {
    const relative = path.relative(this.rootDir, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
}

export function createArtifactStore(rootDir = path.resolve(process.cwd(), "data", "artifacts")): ArtifactStore {
  return new ArtifactStore(rootDir);
}
