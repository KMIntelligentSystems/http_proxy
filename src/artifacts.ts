import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ArtifactMimeType =
  | "image/svg+xml"
  | "text/html"
  | "text/markdown"
  | "text/plain"
  | "application/json";

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
};

export type CreateArtifactInput = {
  sessionId?: string | null;
  title: string;
  filename: string;
  mimeType: string;
  content: string;
  description?: string;
};

type ArtifactListener = (artifact: ArtifactRecord) => void;

const ALLOWED_MIME_TYPES = new Set<ArtifactMimeType>([
  "image/svg+xml",
  "text/html",
  "text/markdown",
  "text/plain",
  "application/json",
]);

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

export class ArtifactStore {
  readonly rootDir: string;
  private listeners = new Set<ArtifactListener>();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  onCreated(listener: ArtifactListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const title = String(input.title || "").trim();
    if (!title) throw new Error("title is required");
    if (title.length > 200) throw new Error("title is too long");

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
