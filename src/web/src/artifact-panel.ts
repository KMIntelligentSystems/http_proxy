import { html, LitElement, type TemplateResult } from "lit";
import { artifactEvents, type ArtifactRecord } from "./remote-agent";

function formatSize(size?: number): string {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(mimeType: string): string {
  if (mimeType === "image/svg+xml") return "◈";
  if (mimeType === "text/html") return "▣";
  if (mimeType === "text/markdown") return "▤";
  if (mimeType === "application/json") return "{}";
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

    if (artifact.mimeType === "text/markdown" || artifact.mimeType === "text/plain" || artifact.mimeType === "application/json") {
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
                    class="artifact-item ${artifact.id === selected?.id ? "active" : ""}"
                    data-artifact-id=${artifact.id}
                    title=${artifact.title}
                  >
                    <span class="artifact-icon">${iconFor(artifact.mimeType)}</span>
                    <span class="artifact-item-main">
                      <strong>${artifact.title}</strong>
                      <small>${artifact.filename} · ${artifact.mimeType}${artifact.size ? ` · ${formatSize(artifact.size)}` : ""}</small>
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
