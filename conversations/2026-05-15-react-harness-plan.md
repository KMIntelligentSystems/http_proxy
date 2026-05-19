# Phased Build Plan — React Document Harness

**Date:** 2026-05-15
**Based on:** `conversations/2026-05-13-phased-development-plan.md` (all phases complete)
**Codebase snapshot:** Phase A–D applied, `stylist.md` simplified (no React/Babel)

## How to use this plan

Same rules as the prior plan — sequential phases, checkpoint gates, build after every change.

**Build commands:**

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile backend TypeScript (`src/` → `dist/`) |
| `npm run build:web` | Build React app with Vite (`src/react-app/` → `dist/web/`) |
| `npm run start:web` | Start proxy + host + agent runtime; open `http://localhost:8080/ui` |

---

## Phase 0 — Baseline verification (5 min)

**Files touched:** none.

```bash
npm run build
npm run build:web
```

Both must pass. If they don't, the prior phases may have regressed.

### CHECKPOINT: Phase 0 → Phase 1

- [ ] `npm run build` exits with code 0.
- [ ] `npm run build:web` exits with code 0 (still builds the Lit UI for now).

---

## Phase 1 — React + Vite scaffold (20 min)

**Goal:** A working Vite + React project that replaces the Lit UI at `/ui`.

**Files touched in this phase:**

- `src/react-app/package.json` (new — workspace package or standalone deps)
- `src/react-app/vite.config.ts` (new)
- `src/react-app/index.html` (new)
- `src/react-app/src/main.tsx` (new)
- `src/react-app/src/App.tsx` (new)
- `src/react-app/src/App.css` (new)
- `src/web/vite.config.ts` (delete or repoint)
- `src/web/` (archive — Lit code retained for dev reference)

### 1.1 Create `src/react-app/` directory

```
src/react-app/
  package.json
  vite.config.ts
  index.html
  tsconfig.json
  src/
    main.tsx
    App.tsx
    App.css
    lib/
      remote-agent.ts    (copy/adapt from src/web/src/)
```

### 1.2 `package.json`

```json
{
  "name": "dva-react-harness",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "~5.7.0",
    "vite": "^6.0.0"
  }
}
```

### 1.3 `vite.config.ts`

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ui/api": "http://localhost:3100",
      "/ui/ws": { target: "ws://localhost:3100", ws: true },
    },
  },
});
```

### 1.4 `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DVA</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

### 1.5 `src/react-app/src/main.tsx`

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./App.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

### 1.6 `src/react-app/src/App.tsx` — shell layout

Three-panel grid: Navbar (top), Sidebar (left), Main content (right).

```tsx
export function App() {
  return (
    <div className="app-shell">
      <nav className="navbar">
        <span className="brand">DVA</span>
        <input className="prompt-bar" placeholder="Ask a question…" />
        <button className="submit-btn">Submit</button>
      </nav>
      <aside className="sidebar">
        <section className="saved-docs">
          <h3>Documents</h3>
          <ul>{/* saved document list */}</ul>
        </section>
        <section className="lookups">
          <h3>Data</h3>
          {/* lookup dropdowns */}
        </section>
        <section className="stats">
          <h3>Statistics</h3>
          {/* statistical toggles */}
        </section>
        <button className="generate-btn">Generate</button>
      </aside>
      <main className="viewer">
        {/* document viewer — paginator + iframe */}
        <div className="empty-state">
          <h2>No document loaded</h2>
          <p>Type a prompt above or select a saved document to begin.</p>
        </div>
      </main>
    </div>
  );
}
```

### 1.7 `src/react-app/src/App.css` — dark shell

```css
:root {
  color-scheme: dark;
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #c9d1d9;
  --text-dim: #8b949e;
  --accent: #58a6ff;
  --radius: 8px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--text);
  height: 100vh; overflow: hidden;
}

.app-shell {
  display: grid;
  grid-template-columns: 300px 1fr;
  grid-template-rows: 52px 1fr;
  height: 100vh;
}

/* Navbar */
.navbar {
  grid-column: 1 / -1;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 12px;
  padding: 0 16px;
}
.navbar .brand {
  font-weight: 700; font-size: 18px;
  color: var(--accent); letter-spacing: -0.02em;
}
.navbar .prompt-bar {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 14px; font-size: 14px;
  color: var(--text); outline: none;
}
.navbar .prompt-bar:focus { border-color: var(--accent); }
.navbar .submit-btn {
  padding: 8px 18px;
  background: var(--accent);
  color: #fff; border: none; border-radius: var(--radius);
  font-weight: 600; cursor: pointer; font-size: 13px;
}
.navbar .submit-btn:hover { opacity: 0.9; }

/* Sidebar */
.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 20px;
}
.sidebar h3 {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--text-dim); margin-bottom: 8px;
}
.sidebar select {
  width: 100%; padding: 8px;
  background: var(--bg); border: 1px solid var(--border);
  color: var(--text); border-radius: 6px; font-size: 13px;
}
.sidebar .generate-btn {
  margin-top: auto;
  width: 100%; padding: 10px;
  background: var(--accent); color: #fff;
  border: none; border-radius: var(--radius);
  font-weight: 600; cursor: pointer; font-size: 14px;
}

/* Main viewer */
.viewer {
  background: var(--bg);
  overflow: hidden;
  display: flex; flex-direction: column;
}
.viewer .empty-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  color: var(--text-dim);
}
.viewer .empty-state h2 { font-size: 20px; margin-bottom: 8px; }
```

### 1.8 Wire `npm run build:web`

Update the root `package.json` `build:web` script to build the React project instead of the Lit UI:

```json
"build:web": "cd src/react-app && npm run build"
```

### 1.9 Wire `host.ts` static serving

Current `host.ts` serves `dist/web/` at `/ui`. This path doesn't change — the React build output goes to the same place. No edit needed if the Vite `outDir` is `../../dist/web`.

### CHECKPOINT: Phase 1 → Phase 2

- [ ] `npm run build:web` exits with code 0.
- [ ] `npm run start:web` boots; `http://localhost:8080/ui` shows the React shell with navbar, sidebar, empty viewer.
- [ ] No JS console errors.
- [ ] Responsive — resize browser, layout adjusts.

---

## Phase 2 — remote-agent bridge (~30 min)

**Goal:** React app sends prompts to the backend agent and receives streaming tool results via WebSocket. Reuse `src/web/src/remote-agent.ts` — adapt it to be a plain module (no Lit dependency, no ChatPanel).

**Files touched:**

- `src/react-app/src/lib/remote-agent.ts` (new — copied and stripped)
- `src/react-app/src/hooks/useAgent.ts` (new)
- `src/react-app/src/components/Navbar.tsx` (edit — wire prompt)
- `src/react-app/src/App.tsx` (edit — add useAgent hook)

### 2.1 `src/react-app/src/lib/remote-agent.ts`

Copy the core from `src/web/src/remote-agent.ts` but strip:
- Lit imports (none in the core WS logic)
- ChatPanel-specific message accumulation
- `@mariozechner/pi-agent-core` types (replace with local interfaces)

Keep:
- WebSocket connection to `/ui/ws/agent`
- `artifactEvents` EventTarget
- `ArtifactRecord` type (with `role`)
- `sendPrompt(text)` function
- WS message parsing (agent state, artifact creation events)
- Reconnection logic

### 2.2 `src/react-app/src/hooks/useAgent.ts`

React hook that wraps remote-agent:

```tsx
import { useState, useEffect, useCallback } from "react";
import { connectAgent, sendPrompt, artifactEvents, type AgentState, type ArtifactRecord } from "../lib/remote-agent";

export function useAgent() {
  const [state, setState] = useState<AgentState>("idle");
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const cleanup = connectAgent((newState) => {
      setState(newState);
      setWorking(newState === "working");
    });
    const onArtifact = (e: CustomEvent<ArtifactRecord>) => {
      setArtifacts(prev => {
        const filtered = prev.filter(a => a.id !== e.detail.id);
        return [e.detail, ...filtered];
      });
    };
    artifactEvents.addEventListener("artifact_created", onArtifact as EventListener);
    return () => {
      cleanup();
      artifactEvents.removeEventListener("artifact_created", onArtifact as EventListener);
    };
  }, []);

  const submit = useCallback((prompt: string) => {
    sendPrompt(prompt);
  }, []);

  return { state, artifacts, working, submit };
}
```

### 2.3 Wire prompt bar

In `App.tsx`, use the hook and wire the prompt bar + submit button:

```tsx
const { artifacts, working, submit } = useAgent();

const handleSubmit = () => {
  if (!prompt.trim() || working) return;
  submit(prompt);
  setPrompt("");
};
```

### 2.4 Add "working" indicator

When `working` is true, show a spinner/text in the viewer:

```tsx
{working ? (
  <div className="working-state">
    <div className="spinner" />
    <p>Generating document…</p>
  </div>
) : (
  /* document viewer or empty state */
)}
```

### CHECKPOINT: Phase 2 → Phase 3

- [ ] `npm run build:web` exits with code 0.
- [ ] Type a prompt in the React app; agent processes it.
- [ ] Artifacts appear in the `artifacts` state array as they're created.
- [ ] "Generating document…" shows while agent is working.
- [ ] No visible tool-use/thinking stream in the UI.
- [ ] `npm run build` still passes (backend unchanged).

---

## Phase 3 — Config-driven lookups (~40 min)

**Goal:** Sidebar renders dropdowns from `data/lookups-config.json`. Dropdowns chain (survey → area type → area → occupation → industry → datatype). Includes NAICS classification. Time series metric pills from oe-drilldown pattern.

**Files touched:**

- `data/lookups-config.json` (new)
- `data/lookups/naics.json` (new)
- `src/react-app/src/hooks/useLookupConfig.ts` (new)
- `src/react-app/src/components/LookupPanel.tsx` (new)
- `src/react-app/src/App.tsx` (edit — add LookupPanel)

### 3.1 `data/lookups-config.json`

```json
{
  "version": 1,
  "surveys": [
    { "id": "oews",    "label": "OEWS (Wages & Employment)",  "description": "BLS Occupational Employment and Wage Statistics" },
    { "id": "ces",     "label": "CES (Employment, Hours)",    "description": "BLS Current Employment Statistics" },
    { "id": "cps",     "label": "CPS (Labor Force)",           "description": "BLS Current Population Survey / Labor Force Statistics" },
    { "id": "ec",      "label": "Economic Census",             "description": "Census Bureau Economic Census (every 5 years)" },
    { "id": "asm",     "label": "Manufacturers Survey",        "description": "Census Bureau Annual Survey of Manufactures" },
    { "id": "fred-ipi","label": "FRED Industrial Production",   "description": "Federal Reserve Industrial Production Index" }
  ],
  "lookupSlots": [
    { "id": "naics",       "label": "NAICS Industry",  "source": "data/lookups/naics.json",       "keyField": "code", "displayField": "label" },
    { "id": "areaType",    "label": "Area Type",       "source": "data/lookups/oe_areatypes.json", "keyField": "code", "displayField": "label", "dependsOn": "survey" },
    { "id": "area",        "label": "Area",            "source": "data/lookups/oe_areas.json",     "keyField": "code", "displayField": "label", "dependsOn": "survey" },
    { "id": "occupation",  "label": "Occupation",      "source": "data/lookups/oe_occupations.json","keyField": "code", "displayField": "label", "dependsOn": "survey" },
    { "id": "industry",    "label": "Industry",        "source": "data/lookups/oe_industries.json","keyField": "code", "displayField": "label", "dependsOn": "survey" },
    { "id": "datatype",    "label": "Datatype",        "source": "data/lookups/oe_datatypes.json", "keyField": "code", "displayField": "label", "dependsOn": "survey" }
  ],
  "statistics": [
    { "id": "pqde",    "label": "PQDE density",     "description": "Piecewise quadratic density estimation (O'Malley JSM 2008)" },
    { "id": "kde",     "label": "KDE overlay",      "description": "Gaussian kernel density estimate from employment-weighted points" },
    { "id": "sa-nsa",  "label": "SA/NSA comparison", "description": "Overlay seasonally adjusted vs non-adjusted series" },
    { "id": "yoy",     "label": "Year-over-year Δ",  "description": "Compute year-over-year percentage change" },
    { "id": "index",   "label": "Index (base year)", "description": "Rebase series to a user-chosen base year" }
  ],
  "timeSeriesMetrics": [
    { "key": "A_MEAN",   "datatype": "04", "label": "Annual Mean" },
    { "key": "A_MEDIAN", "datatype": "13", "label": "Annual Median" },
    { "key": "H_MEAN",   "datatype": "03", "label": "Hourly Mean" },
    { "key": "H_MEDIAN", "datatype": "08", "label": "Hourly Median" },
    { "key": "TOT_EMP",  "datatype": "01", "label": "Employment" },
    { "key": "EMP_PRSE", "datatype": "16", "label": "Emp. % RSE" }
  ]
}
```

### 3.2 `data/lookups/naics.json`

NAICS 2022 hierarchy — top two levels (sectors and subsectors). ~100 entries.

```json
[
  { "code": "11", "level": "sector", "label": "Agriculture, Forestry, Fishing and Hunting", "parent": null },
  { "code": "111", "level": "subsector", "label": "Crop Production", "parent": "11" },
  { "code": "112", "level": "subsector", "label": "Animal Production and Aquaculture", "parent": "11" },
  { "code": "21", "level": "sector", "label": "Mining, Quarrying, and Oil and Gas Extraction", "parent": null },
  { "code": "211", "level": "subsector", "label": "Oil and Gas Extraction", "parent": "21" },
  { "code": "212", "level": "subsector", "label": "Mining (except Oil and Gas)", "parent": "21" },
  { "code": "213", "level": "subsector", "label": "Support Activities for Mining", "parent": "21" },
  { "code": "22", "level": "sector", "label": "Utilities", "parent": null },
  { "code": "221", "level": "subsector", "label": "Utilities", "parent": "22" },
  { "code": "23", "level": "sector", "label": "Construction", "parent": null },
  { "code": "236", "level": "subsector", "label": "Construction of Buildings", "parent": "23" },
  { "code": "237", "level": "subsector", "label": "Heavy and Civil Engineering Construction", "parent": "23" },
  { "code": "238", "level": "subsector", "label": "Specialty Trade Contractors", "parent": "23" },
  { "code": "31-33","level": "sector","label": "Manufacturing","parent": null },
  { "code": "311", "level": "subsector", "label": "Food Manufacturing", "parent": "31-33" },
  { "code": "312", "level": "subsector", "label": "Beverage and Tobacco Product Manufacturing", "parent": "31-33" },
  { "code": "313", "level": "subsector", "label": "Textile Mills", "parent": "31-33" },
  { "code": "314", "level": "subsector", "label": "Textile Product Mills", "parent": "31-33" },
  { "code": "315", "level": "subsector", "label": "Apparel Manufacturing", "parent": "31-33" },
  { "code": "316", "level": "subsector", "label": "Leather and Allied Product Manufacturing", "parent": "31-33" },
  { "code": "321", "level": "subsector", "label": "Wood Product Manufacturing", "parent": "31-33" },
  { "code": "322", "level": "subsector", "label": "Paper Manufacturing", "parent": "31-33" },
  { "code": "323", "level": "subsector", "label": "Printing and Related Support Activities", "parent": "31-33" },
  { "code": "324", "level": "subsector", "label": "Petroleum and Coal Products Manufacturing", "parent": "31-33" },
  { "code": "325", "level": "subsector", "label": "Chemical Manufacturing", "parent": "31-33" },
  { "code": "326", "level": "subsector", "label": "Plastics and Rubber Products Manufacturing", "parent": "31-33" },
  { "code": "327", "level": "subsector", "label": "Nonmetallic Mineral Product Manufacturing", "parent": "31-33" },
  { "code": "331", "level": "subsector", "label": "Primary Metal Manufacturing", "parent": "31-33" },
  { "code": "332", "level": "subsector", "label": "Fabricated Metal Product Manufacturing", "parent": "31-33" },
  { "code": "333", "level": "subsector", "label": "Machinery Manufacturing", "parent": "31-33" },
  { "code": "334", "level": "subsector", "label": "Computer and Electronic Product Manufacturing", "parent": "31-33" },
  { "code": "335", "level": "subsector", "label": "Electrical Equipment, Appliance, and Component Mfg", "parent": "31-33" },
  { "code": "336", "level": "subsector", "label": "Transportation Equipment Manufacturing", "parent": "31-33" },
  { "code": "337", "level": "subsector", "label": "Furniture and Related Product Manufacturing", "parent": "31-33" },
  { "code": "339", "level": "subsector", "label": "Miscellaneous Manufacturing", "parent": "31-33" },
  { "code": "42", "level": "sector", "label": "Wholesale Trade", "parent": null },
  { "code": "423", "level": "subsector", "label": "Merchant Wholesalers, Durable Goods", "parent": "42" },
  { "code": "424", "level": "subsector", "label": "Merchant Wholesalers, Nondurable Goods", "parent": "42" },
  { "code": "425", "level": "subsector", "label": "Wholesale Electronic Markets and Agents", "parent": "42" },
  { "code": "44-45","level": "sector", "label": "Retail Trade", "parent": null },
  { "code": "441", "level": "subsector", "label": "Motor Vehicle and Parts Dealers", "parent": "44-45" },
  { "code": "442", "level": "subsector", "label": "Furniture and Home Furnishings Stores", "parent": "44-45" },
  { "code": "443", "level": "subsector", "label": "Electronics and Appliance Stores", "parent": "44-45" },
  { "code": "444", "level": "subsector", "label": "Building Material and Garden Supply Stores", "parent": "44-45" },
  { "code": "445", "level": "subsector", "label": "Food and Beverage Stores", "parent": "44-45" },
  { "code": "449", "level": "subsector", "label": "Furniture, Home Furnishings, Electronics Stores", "parent": "44-45" },
  { "code": "455", "level": "subsector", "label": "General Merchandise Retailers", "parent": "44-45" },
  { "code": "456", "level": "subsector", "label": "Health and Personal Care Retailers", "parent": "44-45" },
  { "code": "457", "level": "subsector", "label": "Gasoline Stations and Fuel Dealers", "parent": "44-45" },
  { "code": "458", "level": "subsector", "label": "Clothing, Accessories, Shoe, and Jewelry Retailers", "parent": "44-45" },
  { "code": "459", "level": "subsector", "label": "Sporting Goods, Hobby, Musical, Book Stores", "parent": "44-45" },
  { "code": "48-49","level": "sector", "label": "Transportation and Warehousing", "parent": null },
  { "code": "481", "level": "subsector", "label": "Air Transportation", "parent": "48-49" },
  { "code": "482", "level": "subsector", "label": "Rail Transportation", "parent": "48-49" },
  { "code": "483", "level": "subsector", "label": "Water Transportation", "parent": "48-49" },
  { "code": "484", "level": "subsector", "label": "Truck Transportation", "parent": "48-49" },
  { "code": "485", "level": "subsector", "label": "Transit and Ground Passenger Transportation", "parent": "48-49" },
  { "code": "486", "level": "subsector", "label": "Pipeline Transportation", "parent": "48-49" },
  { "code": "487", "level": "subsector", "label": "Scenic and Sightseeing Transportation", "parent": "48-49" },
  { "code": "488", "level": "subsector", "label": "Support Activities for Transportation", "parent": "48-49" },
  { "code": "491", "level": "subsector", "label": "Postal Service", "parent": "48-49" },
  { "code": "492", "level": "subsector", "label": "Couriers and Messengers", "parent": "48-49" },
  { "code": "493", "level": "subsector", "label": "Warehousing and Storage", "parent": "48-49" },
  { "code": "51", "level": "sector", "label": "Information", "parent": null },
  { "code": "511", "level": "subsector", "label": "Publishing Industries", "parent": "51" },
  { "code": "512", "level": "subsector", "label": "Motion Picture and Sound Recording", "parent": "51" },
  { "code": "513", "level": "subsector", "label": "Broadcasting and Content Providers", "parent": "51" },
  { "code": "516", "level": "subsector", "label": "Web Search Portals, Libraries, Archives", "parent": "51" },
  { "code": "517", "level": "subsector", "label": "Telecommunications", "parent": "51" },
  { "code": "518", "level": "subsector", "label": "Computing Infrastructure, Data Processing, Hosting", "parent": "51" },
  { "code": "519", "level": "subsector", "label": "Other Information Services", "parent": "51" },
  { "code": "52", "level": "sector", "label": "Finance and Insurance", "parent": null },
  { "code": "521", "level": "subsector", "label": "Monetary Authorities - Central Bank", "parent": "52" },
  { "code": "522", "level": "subsector", "label": "Credit Intermediation and Related Activities", "parent": "52" },
  { "code": "523", "level": "subsector", "label": "Securities, Commodity Contracts, Investments", "parent": "52" },
  { "code": "524", "level": "subsector", "label": "Insurance Carriers and Related Activities", "parent": "52" },
  { "code": "525", "level": "subsector", "label": "Funds, Trusts, and Other Financial Vehicles", "parent": "52" },
  { "code": "53", "level": "sector", "label": "Real Estate and Rental and Leasing", "parent": null },
  { "code": "531", "level": "subsector", "label": "Real Estate", "parent": "53" },
  { "code": "532", "level": "subsector", "label": "Rental and Leasing Services", "parent": "53" },
  { "code": "54", "level": "sector", "label": "Professional, Scientific, and Technical Services", "parent": null },
  { "code": "541", "level": "subsector", "label": "Professional, Scientific, and Technical Services", "parent": "54" },
  { "code": "55", "level": "sector", "label": "Management of Companies and Enterprises", "parent": null },
  { "code": "551", "level": "subsector", "label": "Management of Companies and Enterprises", "parent": "55" },
  { "code": "56", "level": "sector", "label": "Admin & Support, Waste Mgmt, Remediation", "parent": null },
  { "code": "561", "level": "subsector", "label": "Administrative and Support Services", "parent": "56" },
  { "code": "562", "level": "subsector", "label": "Waste Management and Remediation Services", "parent": "56" },
  { "code": "61", "level": "sector", "label": "Educational Services", "parent": null },
  { "code": "611", "level": "subsector", "label": "Educational Services", "parent": "61" },
  { "code": "62", "level": "sector", "label": "Health Care and Social Assistance", "parent": null },
  { "code": "621", "level": "subsector", "label": "Ambulatory Health Care Services", "parent": "62" },
  { "code": "622", "level": "subsector", "label": "Hospitals", "parent": "62" },
  { "code": "623", "level": "subsector", "label": "Nursing and Residential Care Facilities", "parent": "62" },
  { "code": "624", "level": "subsector", "label": "Social Assistance", "parent": "62" },
  { "code": "71", "level": "sector", "label": "Arts, Entertainment, and Recreation", "parent": null },
  { "code": "711", "level": "subsector", "label": "Performing Arts, Spectator Sports, Related", "parent": "71" },
  { "code": "712", "level": "subsector", "label": "Museums, Historical Sites, and Similar", "parent": "71" },
  { "code": "713", "level": "subsector", "label": "Amusement, Gambling, and Recreation", "parent": "71" },
  { "code": "72", "level": "sector", "label": "Accommodation and Food Services", "parent": null },
  { "code": "721", "level": "subsector", "label": "Accommodation", "parent": "72" },
  { "code": "722", "level": "subsector", "label": "Food Services and Drinking Places", "parent": "72" },
  { "code": "81", "level": "sector", "label": "Other Services (except Public Administration)", "parent": null },
  { "code": "811", "level": "subsector", "label": "Repair and Maintenance", "parent": "81" },
  { "code": "812", "level": "subsector", "label": "Personal and Laundry Services", "parent": "81" },
  { "code": "813", "level": "subsector", "label": "Religious, Civic, Professional Organizations", "parent": "81" },
  { "code": "814", "level": "subsector", "label": "Private Households", "parent": "81" },
  { "code": "92", "level": "sector", "label": "Public Administration", "parent": null },
  { "code": "921", "level": "subsector", "label": "Executive, Legislative, Other General Gov", "parent": "92" },
  { "code": "922", "level": "subsector", "label": "Justice, Public Order, and Safety Activities", "parent": "92" },
  { "code": "923", "level": "subsector", "label": "Administration of Human Resource Programs", "parent": "92" },
  { "code": "924", "level": "subsector", "label": "Administration of Environmental Quality Programs", "parent": "92" },
  { "code": "925", "level": "subsector", "label": "Administration of Housing, Urban, Community Dev", "parent": "92" },
  { "code": "926", "level": "subsector", "label": "Administration of Economic Programs", "parent": "92" },
  { "code": "927", "level": "subsector", "label": "Space Research and Technology", "parent": "92" },
  { "code": "928", "level": "subsector", "label": "National Security and International Affairs", "parent": "92" }
]
```

### 3.3 `src/react-app/src/hooks/useLookupConfig.ts`

Fetches `lookups-config.json` and resolves each lookup source.

```tsx
import { useState, useEffect } from "react";

type LookupSlot = {
  id: string;
  label: string;
  source: string;
  keyField: string;
  displayField: string;
  dependsOn?: string;
};

type SurveyDef = {
  id: string;
  label: string;
  description: string;
};

type StatToggle = {
  id: string;
  label: string;
  description: string;
};

type TimeSeriesMetric = {
  key: string;
  datatype: string;
  label: string;
};

type LookupConfig = {
  version: number;
  surveys: SurveyDef[];
  lookupSlots: LookupSlot[];
  statistics: StatToggle[];
  timeSeriesMetrics: TimeSeriesMetric[];
};

type LookupData = Record<string, { key: string; display: string }[]>;

export function useLookupConfig() {
  const [config, setConfig] = useState<LookupConfig | null>(null);
  const [lookupData, setLookupData] = useState<LookupData>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [statToggles, setStatToggles] = useState<Record<string, boolean>>({});
  const [tsMetrics, setTsMetrics] = useState<string[]>([]); // active metric keys

  useEffect(() => {
    fetch("/ui/api/lookups-config") // or direct static file
      .then(r => r.json())
      .then(setConfig);
  }, []);

  useEffect(() => {
    if (!config) return;
    config.lookupSlots.forEach(slot => {
      fetch(`/${slot.source}`)
        .then(r => r.json())
        .then(data => {
          setLookupData(prev => ({
            ...prev,
            [slot.id]: data.map((d: any) => ({
              key: d[slot.keyField],
              display: d[slot.displayField],
            })),
          }));
        });
    });
  }, [config]);

  const setSelection = (slotId: string, value: string) => {
    setSelections(prev => ({ ...prev, [slotId]: value }));
  };

  const toggleStat = (statId: string) => {
    setStatToggles(prev => ({ ...prev, [statId]: !prev[statId] }));
  };

  const toggleMetric = (metricKey: string) => {
    setTsMetrics(prev =>
      prev.includes(metricKey) ? prev.filter(k => k !== metricKey) : [...prev, metricKey]
    );
  };

  // Build the context string to inject into the agent prompt
  const buildLookupContext = (): string => {
    const parts: string[] = [];
    for (const [slotId, value] of Object.entries(selections)) {
      if (value) parts.push(`${slotId}: ${value}`);
    }
    const stats = Object.entries(statToggles).filter(([, v]) => v).map(([k]) => k);
    if (stats.length) parts.push(`statistics: ${stats.join(", ")}`);
    return parts.join("; ");
  };

  return { config, lookupData, selections, statToggles, tsMetrics, setSelection, toggleStat, toggleMetric, buildLookupContext };
}
```

### 3.4 `src/react-app/src/components/LookupPanel.tsx`

Renders the sidebar lookups from config.

```tsx
type Props = {
  config: LookupConfig | null;
  lookupData: LookupData;
  selections: Record<string, string>;
  statToggles: Record<string, boolean>;
  tsMetrics: string[];
  onSelect: (slotId: string, value: string) => void;
  onToggleStat: (statId: string) => void;
  onToggleMetric: (key: string) => void;
};

export function LookupPanel({ config, lookupData, selections, statToggles, tsMetrics, onSelect, onToggleStat, onToggleMetric }: Props) {
  if (!config) return <div className="loading">Loading lookups…</div>;

  return (
    <>
      {/* Survey selector */}
      <div className="lookup-group">
        <label>Survey</label>
        <select value={selections["survey"] ?? ""} onChange={e => onSelect("survey", e.target.value)}>
          <option value="">Select…</option>
          {config.surveys.map(s => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Data lookups (NAICS, area type, area, occupation, industry, datatype) */}
      {config.lookupSlots.map(slot => (
        <div className="lookup-group" key={slot.id}>
          <label>{slot.label}</label>
          <select value={selections[slot.id] ?? ""} onChange={e => onSelect(slot.id, e.target.value)}>
            <option value="">All</option>
            {(lookupData[slot.id] ?? []).map(item => (
              <option key={item.key} value={item.key}>{`${item.key} — ${item.display}`}</option>
            ))}
          </select>
        </div>
      ))}

      {/* Time series metrics (pill toggles — oe-drilldown pattern) */}
      {config.timeSeriesMetrics?.length > 0 && (
        <div className="lookup-group">
          <label>Time Series Metrics</label>
          <div className="metric-pills">
            {config.timeSeriesMetrics.map(m => (
              <button
                key={m.key}
                className={`pill ${tsMetrics.includes(m.key) ? "active" : ""}`}
                onClick={() => onToggleMetric(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Statistical techniques */}
      {config.statistics.length > 0 && (
        <div className="lookup-group">
          <label>Statistics</label>
          {config.statistics.map(stat => (
            <label key={stat.id} className="stat-toggle" title={stat.description}>
              <input
                type="checkbox"
                checked={statToggles[stat.id] ?? false}
                onChange={() => onToggleStat(stat.id)}
              />
              {stat.label}
            </label>
          ))}
        </div>
      )}
    </>
  );
}
```

### CHECKPOINT: Phase 3 → Phase 4

- [ ] `npm run build:web` exits with code 0.
- [ ] Sidebar renders all lookup dropdowns from config.
- [ ] NAICS dropdown shows ~100 sectors and subsectors.
- [ ] Selecting a survey changes available area/occupation/industry options.
- [ ] Stat toggles show checkboxes; clicking toggles them.
- [ ] Metric pills toggle on/off with visual active state.
- [ ] "Generate" button captures all selections + prompt.

---

## Phase 4 — Document viewer (~30 min)

**Goal:** React paginator replaces `<document-paginator>`. Shows document manifest pages, prev/next navigation, iframe rendering. Auto-loads the latest document-manifest artifact.

**Files touched:**

- `src/react-app/src/components/DocumentViewer.tsx` (new)
- `src/react-app/src/components/Paginator.tsx` (new)
- `src/react-app/src/App.tsx` (edit — use DocumentViewer)

### 4.1 `DocumentViewer.tsx`

```tsx
type DocumentManifest = {
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

  useEffect(() => { setPageIndex(0); }, [manifest]);

  if (!manifest || !manifest.pages?.length) {
    return (
      <div className="empty-state">
        <h2>No document loaded</h2>
        <p>Type a prompt above or select a saved document.</p>
      </div>
    );
  }

  const page = manifest.pages[pageIndex];
  const total = manifest.pages.length;

  return (
    <div className="document-viewer">
      <div className="dv-toolbar">
        <button disabled={pageIndex === 0} onClick={() => setPageIndex(i => i - 1)}>
          ‹ Prev
        </button>
        <span className="dv-title">{manifest.title}</span>
        <span className="dv-page-label">
          {page?.title ?? `${pageIndex + 1} / ${total}`}
        </span>
        <button disabled={pageIndex >= total - 1} onClick={() => setPageIndex(i => i + 1)}>
          Next ›
        </button>
      </div>
      <iframe
        className="dv-iframe"
        src={`/ui/api/artifacts/${page.artifactId}`}
        title={page.title ?? `Page ${pageIndex + 1}`}
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}
```

### 4.2 Wire into App.tsx

Find the latest document-manifest from artifacts:

```tsx
const docManifest = artifacts
  .filter(a => a.mimeType === "application/vnd.dva.document+json")
  .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];

// Fetch manifest content...
const [manifest, setManifest] = useState<DocumentManifest | null>(null);

useEffect(() => {
  if (!docManifest) return;
  fetch(docManifest.url)
    .then(r => r.json())
    .then(setManifest);
}, [docManifest?.id]);
```

```tsx
<main className="viewer">
  {working ? (
    <div className="working-state"><div className="spinner" /><p>Generating document…</p></div>
  ) : (
    <DocumentViewer manifest={manifest} />
  )}
</main>
```

### 4.3 Keyboard navigation

Add `useEffect` with `keydown` listener in `DocumentViewer` for ArrowLeft/ArrowRight page navigation (same scoping as document-paginator.ts).

### CHECKPOINT: Phase 4 → Phase 5

- [ ] `npm run build:web` exits with code 0.
- [ ] After running the pipeline, the document appears in the viewer automatically.
- [ ] Prev/Next navigate between pages; buttons disabled at boundaries.
- [ ] ArrowLeft/ArrowRight navigate pages (scoped — not when typing in prompt).
- [ ] Chart iframes inside pages load and render.

---

## Phase 5 — Saved documents list + polish (~20 min)

**Goal:** Sidebar shows a list of all document-manifest artifacts. Clicking one loads it. Plus CSS polish.

**Files touched:**

- `src/react-app/src/components/SavedDocs.tsx` (new)
- `src/react-app/src/App.tsx` (edit — wire saved docs)
- `src/react-app/src/App.css` (edit — add styles)

### 5.1 `SavedDocs.tsx`

```tsx
type DocSummary = { id: string; title: string; createdAt?: string };

type Props = {
  docs: DocSummary[];
  activeId?: string;
  onSelect: (id: string) => void;
};

export function SavedDocs({ docs, activeId, onSelect }: Props) {
  return (
    <div className="saved-docs">
      <h3>Documents</h3>
      {docs.length === 0 ? (
        <p className="dim">No saved documents yet.</p>
      ) : (
        <ul>
          {docs.map(doc => (
            <li key={doc.id} className={doc.id === activeId ? "active" : ""} onClick={() => onSelect(doc.id)}>
              {doc.title}
              {doc.createdAt && <span className="date">{new Date(doc.createdAt).toLocaleDateString()}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### 5.2 CSS polish

- `.saved-docs ul` — clean list, active state highlight
- `.metric-pills` — pill buttons from oe-drilldown pattern
- `.stat-toggle` — checkbox styling in dark theme
- `.spinner` — CSS animation for generating state
- Transitions on sidebar → viewer content swap

### CHECKPOINT: Phase 5 → Done

- [ ] Sidebar lists all document-manifest artifacts.
- [ ] Clicking a saved document loads it in the viewer.
- [ ] Switching documents resets to page 0.
- [ ] Full end-to-end: prompt → pipeline → document appears → user navigates pages.

---

## Phase summary

| Phase | Time | Key Risk |
|-------|------|----------|
| 1 | 20 min | Vite + React config errors; host static serving mismatch |
| 2 | 30 min | WebSocket bridge adaptation; useAgent hook lifecycle bugs |
| 3 | 40 min | NAICS JSON completeness; lookup chaining logic |
| 4 | 30 min | iframe sandbox issues; manifest fetch timing |
| 5 | 20 min | CSS polish in dark theme |
| **Total** | ~2.5 hrs | |

## Dependency graph

```
Phase 1 (React scaffold)
  │
  ▼
Phase 2 (remote-agent bridge)    ──► Phase 3 (lookups) can start in parallel
  │                                     │
  ▼                                     ▼
Phase 4 (document viewer) ◄──────────────┘
  │
  ▼
Phase 5 (saved docs + polish)
```

## Rollback plan

Each phase touches a discrete set of files:
- Phase 1: delete `src/react-app/`, revert `package.json` `build:web` script
- Phase 2–5: `git checkout src/react-app/`
