import { html, LitElement, type TemplateResult } from "lit";
import { artifactEvents, type ArtifactRecord } from "./remote-agent";

function formatSize(size?: number): string {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(mimeType: string, role?: string): string {
  if (role === "memory") return "✎";
  if (mimeType === "image/svg+xml") return "◈";
  if (mimeType === "text/html") return "▣";
  if (mimeType === "text/markdown") return "▤";
  if (mimeType === "text/css") return "≡";
  if (mimeType === "text/csv") return "▥";
  if (mimeType === "application/json") return "{}";
  if (mimeType === "application/vnd.dva.document+json") return "▦";
  return "◇";
}

export class ArtifactPanel extends LitElement {
  static override properties = {
    artifacts: { state: true },
    selectedId: { state: true },
    loading: { state: true },
    error: { state: true },
  };

  private artifacts: ArtifactRecord[] = [];
  private selectedId: string | undefined;
  private loading = true;
  private error = "";
  private jsonContent: string | null = null;
  private jsonLoading = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "flex";
    this.style.minHeight = "0";
    this.addEventListener("click", this.onClick as EventListener);

    artifactEvents.addEventListener("artifact_created", this.onArtifactCreated as EventListener);
    void this.loadArtifacts();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("click", this.onClick as EventListener);
    artifactEvents.removeEventListener("artifact_created", this.onArtifactCreated as EventListener);
  }

  private async loadArtifacts() {
    this.loading = true;
    this.error = "";
    try {
      const res = await fetch("/ui/api/artifacts", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      this.artifacts = Array.isArray(json.artifacts) ? json.artifacts : [];
      this.selectedId = this.selectedId ?? this.artifacts[0]?.id;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private onArtifactCreated = (event: CustomEvent<ArtifactRecord>) => {
    const artifact = event.detail;
    if (!artifact?.id) return;
    this.artifacts = [artifact, ...this.artifacts.filter((item) => item.id !== artifact.id)];
    this.selectedId = artifact.id;
  };

  private onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>("[data-artifact-id]");
    if (button) this.selectedId = button.dataset.artifactId;
  };

  private async loadJson(artifact: ArtifactRecord): Promise<void> {
    this.jsonLoading = true;
    this.jsonContent = null;
    this.requestUpdate();
    try {
      const res = await fetch(artifact.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        this.jsonContent = JSON.stringify(parsed, null, 2);
      } catch {
        this.jsonContent = text;
      }
    } catch (err) {
      this.jsonContent = `Error loading JSON: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.jsonLoading = false;
      this.requestUpdate();
    }
  }

  private renderPreview(artifact: ArtifactRecord | undefined): TemplateResult {
    if (!artifact) {
      return html`
        <div class="artifact-empty">
          <div class="artifact-empty-mark">◇</div>
          <h2>No artifacts yet</h2>
          <p>When the agent creates an SVG, D3 HTML chart, Markdown report, or JSON artifact, it will appear here.</p>
        </div>
      `;
    }

    // Reset JSON state when switching away from a JSON artifact
    if (artifact.mimeType !== "application/json" && this.jsonContent !== null) {
      this.jsonContent = null;
      this.jsonLoading = false;
    }

    if (artifact.mimeType === "application/vnd.dva.document+json") {
      return html`<document-paginator manifest-url=${artifact.url}></document-paginator>`;
    }

    if (artifact.mimeType === "application/json") {
      if (this.jsonLoading) {
        return html`<pre class="artifact-json">Loading…</pre>`;
      }
      if (this.jsonContent !== null) {
        return html`<pre class="artifact-json">${this.jsonContent}</pre>`;
      }
      // Trigger fetch — will re-render when loaded
      void this.loadJson(artifact);
      return html`<pre class="artifact-json">Loading…</pre>`;
    }

    if (artifact.mimeType === "text/markdown"
        || artifact.mimeType === "text/plain"
        || artifact.mimeType === "text/css"
        || artifact.mimeType === "text/csv") {
      return html`<iframe class="artifact-frame" src=${artifact.url} title=${artifact.title}></iframe>`;
    }

    return html`<iframe class="artifact-frame" src=${artifact.url} title=${artifact.title} sandbox="allow-scripts allow-same-origin"></iframe>`;
  }

  override render(): TemplateResult {
    const selected = this.artifacts.find((artifact) => artifact.id === this.selectedId) ?? this.artifacts[0];

    return html`
      <aside class="artifact-panel-shell" aria-label="Artifacts">
        <header class="artifact-header">
          <div>
            <p class="artifact-kicker">W4 Artifact View</p>
            <h1>Visual outputs</h1>
          </div>
          <button class="artifact-refresh" title="Refresh artifacts" @click=${() => this.loadArtifacts()}>↻</button>
        </header>

        ${this.error ? html`<div class="artifact-error">Artifact API error: ${this.error}</div>` : ""}

        <div class="artifact-list" aria-label="Artifact list">
          ${this.loading
            ? html`<div class="artifact-loading">Loading artifacts…</div>`
            : this.artifacts.length
              ? this.artifacts.map((artifact) => html`
                  <button
                    class="artifact-item ${artifact.id === selected?.id ? "active" : ""} ${artifact.role === "memory" ? "memory" : ""}"
                    data-artifact-id=${artifact.id}
                    title=${artifact.title}
                  >
                    <span class="artifact-icon">${iconFor(artifact.mimeType, artifact.role)}</span>
                    <span class="artifact-item-main">
                      <strong>${artifact.title}</strong>
                      <small>
                        ${artifact.filename} · ${artifact.mimeType}${artifact.size ? ` · ${formatSize(artifact.size)}` : ""}
                        ${artifact.role ? html` · <span class="role-tag">${artifact.role}</span>` : ""}
                      </small>
                    </span>
                  </button>
                `)
              : html`<div class="artifact-loading">No saved artifacts for this session.</div>`}
        </div>

        <section class="artifact-preview">
          ${selected ? html`
            <div class="artifact-preview-bar">
              <div>
                <strong>${selected.title}</strong>
                <small>${selected.description || selected.filename}</small>
              </div>
              <a href=${selected.url} target="_blank" rel="noopener noreferrer">Open</a>
            </div>
          ` : ""}
          ${this.renderPreview(selected)}
        </section>
      </aside>
    `;
  }
}

if (!customElements.get("artifact-panel")) {
  customElements.define("artifact-panel", ArtifactPanel);
}
