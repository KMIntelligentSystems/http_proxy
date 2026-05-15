import { html, LitElement, type TemplateResult } from "lit";

type ManifestPage = {
  artifactId: string;
  title?: string;
  role?: string;
};

type DocumentManifest = {
  title: string;
  pages: ManifestPage[];
  kind?: string;
  schemaVersion?: number;
  [key: string]: unknown;
};

/**
 * Renders a paged document from a manifest URL.
 *
 * Properties:
 *   manifestUrl — URL of the application/vnd.dva.document+json artifact (attribute: manifest-url)
 *   pageIndex  — current page (0-based, public, reactive — usable from Playwright)
 *
 * Lifecycle:
 *   - Fetches the manifest in connectedCallback() and when manifestUrl changes.
 *   - Stale fetches are discarded via a per-load generation counter.
 *   - Keyboard navigation is scoped: ignored when focus is in input/textarea/button/contenteditable.
 *   - No print button. No print CSS.
 */
export class DocumentPaginator extends LitElement {
  static override properties = {
    manifestUrl: { type: String, attribute: "manifest-url" },
    pageIndex:   { type: Number },
    _title:      { state: true },
    _pages:      { state: true },
    _pageCount:  { state: true },
    _error:      { state: true },
  };

  // Initialized directly (no `declare`) so the first render before _loadManifest()
  // resolves has valid values.
  manifestUrl: string = "";
  pageIndex: number = 0;

  private _title = "";
  private _pages: ManifestPage[] = [];
  private _pageCount = 0;
  private _error = "";
  private _loadGen = 0;
  private _boundKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "grid";
    this.style.gridTemplateRows = "auto minmax(0, 1fr)";
    this.style.height = "100%";
    this.style.minHeight = "0";

    this._boundKeyHandler = this._onKeyDown.bind(this);
    window.addEventListener("keydown", this._boundKeyHandler);

    void this._loadManifest();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._boundKeyHandler) {
      window.removeEventListener("keydown", this._boundKeyHandler);
      this._boundKeyHandler = null;
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("manifestUrl")) {
      this._loadGen++;
      void this._loadManifest();
    }
  }

  /** Navigate to a specific page (clamped). Callable from JS / Playwright. */
  goToPage(index: number): void {
    this.pageIndex = Math.max(0, Math.min(index, this._pageCount - 1 || 0));
  }

  nextPage(): void {
    this.goToPage(this.pageIndex + 1);
  }

  prevPage(): void {
    this.goToPage(this.pageIndex - 1);
  }

  private async _loadManifest(): Promise<void> {
    const gen = this._loadGen;
    this._error = "";
    try {
      if (!this.manifestUrl) return;
      const res = await fetch(this.manifestUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json() as DocumentManifest;
      if (gen !== this._loadGen) return; // stale

      this._title = manifest.title ?? "";
      this._pages = Array.isArray(manifest.pages) ? manifest.pages : [];
      this._pageCount = this._pages.length;
      this.pageIndex = 0;
    } catch (err) {
      if (gen !== this._loadGen) return;
      this._error = err instanceof Error ? err.message : String(err);
      this._pages = [];
      this._pageCount = 0;
    }
  }

  private _onKeyDown(event: KeyboardEvent): void {
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
    if ((event.target as HTMLElement)?.isContentEditable) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!this.contains(document.activeElement) && document.activeElement !== this) return;

    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      this.nextPage();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      this.prevPage();
    }
  }

  override render(): TemplateResult {
    if (this._error) {
      return html`<div class="dv-error">${this._error}</div>`;
    }

    const hasPrev = this.pageIndex > 0;
    const hasNext = this.pageIndex < this._pageCount - 1;
    const page = this._pages[this.pageIndex];

    return html`
      <div class="dv-toolbar">
        <button @click=${this.prevPage} ?disabled=${!hasPrev} aria-label="Previous page">
          ‹ Prev
        </button>
        <span class="dv-title">${this._title}</span>
        <span class="dv-page-label" aria-live="polite">
          ${page?.title ?? `${this.pageIndex + 1} / ${this._pageCount}`}
        </span>
        <button @click=${this.nextPage} ?disabled=${!hasNext} aria-label="Next page">
          Next ›
        </button>
      </div>
      ${page
        ? html`<iframe
            class="dv-iframe"
            src="/ui/api/artifacts/${page.artifactId}"
            title=${page.title ?? `Page ${this.pageIndex + 1}`}
            sandbox="allow-scripts allow-same-origin"
          ></iframe>`
        : html`<div class="dv-empty">No pages in this document.</div>`}
    `;
  }
}

if (!customElements.get("document-paginator")) {
  customElements.define("document-paginator", DocumentPaginator);
}
