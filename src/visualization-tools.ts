import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ArtifactStore, ArtifactRecord } from "./artifacts.js";
import { PDFParse } from "pdf-parse";

const DB_ALLOWED_MIME_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "text/css",
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/json",
  "application/vnd.dva.document+json",
]);

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] ?? ch));
}

function toolResultFor(record: ArtifactRecord, text = `Created artifact: ${record.title}`) {
  return {
    content: [{ type: "text" as const, text: `${text}\n${record.url}` }],
    details: {
      artifactId: record.id,
      title: record.title,
      filename: record.filename,
      mimeType: record.mimeType,
      url: record.url,
      size: record.size,
      role: record.role,
    },
  };
}

function findLookupDir(cwd: string): string {
  const candidates = [path.resolve(cwd, "data", "lookups"), path.resolve(cwd, "dist", "lookups")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function readLookup<T>(cwd: string, name: string): T[] {
  const filePath = path.resolve(findLookupDir(cwd), `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T[];
}

type BLSObservation = {
  date: string;
  label: string;
  value: number;
  year: string;
  period: string;
  periodName?: string;
};

type BLSSeries = {
  id: string;
  label: string;
  seasonality: "SA" | "NSA";
  points: BLSObservation[];
};

async function fetchBlsSeries(seriesIds: string[], startYear: number, endYear: number): Promise<any[]> {
  const body: Record<string, unknown> = { seriesid: seriesIds, startyear: String(startYear), endyear: String(endYear) };
  if (process.env["BLS_API_KEY"]) body.registrationkey = process.env["BLS_API_KEY"];
  const res = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`BLS API returned HTTP ${res.status}`);
  if (!json || json.status !== "REQUEST_SUCCEEDED") {
    throw new Error((json?.message || []).join("; ") || json?.status || "BLS API request failed");
  }
  return json.Results?.series ?? [];
}

function parseBlsSeries(apiSeries: any[], labels: Record<string, { label: string; seasonality: "SA" | "NSA" }>): BLSSeries[] {
  return apiSeries.map((series) => {
    const id = series.seriesID;
    const meta = labels[id] ?? { label: id, seasonality: "SA" as const };
    const points = (series.data ?? [])
      .filter((d: any) => d.period !== "M13")
      .map((d: any) => {
        const month = /^M\d{2}$/.test(d.period) ? Number(d.period.slice(1)) - 1 : 6;
        const date = new Date(Number(d.year), month, 1);
        return {
          date: date.toISOString().slice(0, 10),
          label: `${d.periodName ?? d.period} ${d.year}`,
          value: Number(String(d.value).replace(/,/g, "")),
          year: String(d.year),
          period: String(d.period),
          periodName: d.periodName,
        };
      })
      .filter((d: BLSObservation) => Number.isFinite(d.value))
      .sort((a: BLSObservation, b: BLSObservation) => a.date.localeCompare(b.date));
    return { id, label: meta.label, seasonality: meta.seasonality, points };
  }).filter((series) => series.points.length);
}

function renderSeasonalHtml(opts: {
  title: string;
  subtitle: string;
  unit: string;
  source: string;
  series: BLSSeries[];
  metadata: Record<string, unknown>;
}): string {
  const payload = JSON.stringify(opts).replace(/<\//g, "<\\/");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(opts.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>
:root{color-scheme:dark;--bg:#090d12;--panel:#111821;--ink:#d8e0ea;--muted:#8090a4;--line:#273241;--blue:#58a6ff;--orange:#f78166;--green:#3fb950;--violet:#d2a8ff;--paper:#0d141d;font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 10%,rgba(88,166,255,.18),transparent 32%),radial-gradient(circle at 90% 6%,rgba(247,129,102,.14),transparent 26%),linear-gradient(135deg,#06090d,#0d1117 58%,#070a0f);color:var(--ink)}main{width:min(1180px,calc(100vw - 34px));margin:0 auto;padding:28px 0 36px}.hero{display:grid;grid-template-columns:1.2fr .8fr;gap:18px;margin-bottom:18px}.card{border:1px solid rgba(128,144,164,.22);background:linear-gradient(180deg,rgba(17,24,33,.92),rgba(13,20,29,.82));border-radius:22px;box-shadow:0 24px 80px rgba(0,0,0,.36);padding:22px;overflow:hidden}.eyebrow{font:800 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}h1{margin:10px 0 8px;font-size:clamp(32px,5vw,58px);line-height:.96;letter-spacing:-.045em;color:#f0f6fc}.subtitle{color:#a9b8c8;line-height:1.55}.metric-grid{display:grid;gap:10px}.metric{border:1px solid rgba(128,144,164,.18);border-radius:16px;padding:13px;background:rgba(255,255,255,.035)}.metric b{display:block;color:white;font:800 20px/1 ui-monospace,Consolas,monospace}.metric span{display:block;margin-top:6px;color:var(--muted);font-size:12px}.chart-card{padding:18px}.chart-wrap{position:relative;border:1px solid rgba(128,144,164,.18);background:rgba(8,13,19,.55);border-radius:18px;padding:8px}svg{display:block;width:100%;height:auto}.axis text{fill:#8b949e;font-size:11px}.axis path,.axis line{stroke:#334155}.grid line{stroke:#253041}.grid path{display:none}.legend{display:flex;flex-wrap:wrap;gap:14px;margin:14px 4px 4px;color:#a9b8c8;font-size:13px}.legend i{display:inline-block;width:30px;border-top:3px solid var(--blue);vertical-align:middle;margin-right:7px}.legend .nsa i{border-top-color:var(--orange);border-top-style:dashed}.tooltip{position:fixed;pointer-events:none;opacity:0;transform:translate(-50%,-115%);background:#0b1118;border:1px solid #3b4656;border-radius:12px;padding:10px 12px;box-shadow:0 14px 50px rgba(0,0,0,.45);font-size:12px;z-index:5}.source{margin-top:12px;color:#718096;font-size:12px}.meta{margin-top:12px;color:#718096;font:12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}@media(max-width:850px){.hero{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
  <section class="hero">
    <div class="card">
      <div class="eyebrow">Seasonal adjustment overlay</div>
      <h1>${esc(opts.title)}</h1>
      <div class="subtitle">${esc(opts.subtitle)}</div>
    </div>
    <aside class="card metric-grid" id="metrics"></aside>
  </section>
  <section class="card chart-card">
    <div class="chart-wrap"><svg id="chart" viewBox="0 0 1100 560" role="img" aria-label="${esc(opts.title)}"></svg></div>
    <div class="legend" id="legend"></div>
    <div class="source">${esc(opts.source)}</div>
    <div class="meta" id="meta"></div>
  </section>
</main>
<div class="tooltip" id="tooltip"></div>
<script>
const payload = ${payload};
const series = payload.series || [];
const all = series.flatMap(s => s.points.map(p => ({...p, dateObj: new Date(p.date), series:s})));
const fmt = d3.format(',.1f');
const svg = d3.select('#chart');
const W = 1100, H = 560, margin = {top:34,right:34,bottom:56,left:78};
const innerW = W - margin.left - margin.right, innerH = H - margin.top - margin.bottom;
const g = svg.append('g').attr('transform', 'translate('+margin.left+','+margin.top+')');
const x = d3.scaleTime().domain(d3.extent(all, d => d.dateObj)).range([0, innerW]);
const yExtent = d3.extent(all, d => d.value); const yPad = ((yExtent[1]-yExtent[0]) || 1) * .08;
const y = d3.scaleLinear().domain([yExtent[0]-yPad, yExtent[1]+yPad]).nice().range([innerH, 0]);
g.append('g').attr('class','grid').call(d3.axisLeft(y).ticks(7).tickSize(-innerW).tickFormat(''));
g.append('g').attr('class','axis').attr('transform','translate(0,'+innerH+')').call(d3.axisBottom(x).ticks(8));
g.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(7));
g.append('text').attr('x',0).attr('y',-12).attr('fill','#8b949e').attr('font-size',12).text(payload.unit || 'Value');
const line = d3.line().x(d => x(new Date(d.date))).y(d => y(d.value)).curve(d3.curveMonotoneX);
const colors = {SA:'#58a6ff', NSA:'#f78166'};
if (series.length === 2) {
  const [sa,nsa] = series;
  const byDate = new Map(nsa.points.map(p => [p.date, p]));
  const matched = sa.points.map(p => ({a:p,b:byDate.get(p.date)})).filter(d => d.b);
  const area = d3.area().x(d => x(new Date(d.a.date))).y0(d => y(d.b.value)).y1(d => y(d.a.value)).curve(d3.curveMonotoneX);
  g.append('path').datum(matched).attr('fill','rgba(88,166,255,.09)').attr('d',area);
}
series.forEach(s => {
  g.append('path').datum(s.points).attr('fill','none').attr('stroke',colors[s.seasonality] || '#d2a8ff').attr('stroke-width',2.8).attr('stroke-dasharray',s.seasonality==='NSA'?'8 6':null).attr('d',line);
  g.selectAll('.dot-'+s.seasonality).data(s.points).enter().append('circle').attr('cx',d=>x(new Date(d.date))).attr('cy',d=>y(d.value)).attr('r',2.2).attr('fill',colors[s.seasonality] || '#d2a8ff').attr('opacity',.75);
});
const tooltip = d3.select('#tooltip'); const bisect = d3.bisector(d => new Date(d.date)).center;
g.append('rect').attr('width',innerW).attr('height',innerH).attr('fill','transparent').on('mousemove', (event) => {
  const date = x.invert(d3.pointer(event)[0]);
  const rows = series.map(s => { const p = s.points[bisect(s.points, date)]; return p ? '<div style="color:'+(colors[s.seasonality] || '#d2a8ff')+'"><b>'+s.seasonality+'</b> '+p.label+': '+fmt(p.value)+'</div>' : ''; }).join('');
  tooltip.style('opacity',1).style('left',event.clientX+'px').style('top',event.clientY+'px').html(rows);
}).on('mouseleave', () => tooltip.style('opacity',0));
document.getElementById('legend').innerHTML = series.map(s => '<span class="'+s.seasonality.toLowerCase()+'"><i></i>'+s.label+' <code>'+s.id+'</code></span>').join('');
const latest = series.map(s => ({s, p:s.points[s.points.length-1]})).filter(d=>d.p);
document.getElementById('metrics').innerHTML = latest.map(d => '<div class="metric"><b>'+fmt(d.p.value)+'</b><span>'+d.s.seasonality+' latest · '+d.p.label+'</span></div>').join('') + '<div class="metric"><b>'+series.map(s=>s.points.length).reduce((a,b)=>Math.max(a,b),0)+'</b><span>monthly observations per longest series</span></div>';
document.getElementById('meta').textContent = JSON.stringify(payload.metadata);
</script>
</body>
</html>`;
}

export function createVisualizationTools(options: {
  artifactStore: ArtifactStore;
  getSessionId: () => string | null | undefined;
  cwd?: string;
}) {
  const cwd = options.cwd ?? process.cwd();

  const createArtifactTool = defineTool({
    name: "create_artifact",
    label: "Create Artifact",
    description: "Create a browser-viewable artifact in the web UI. Use for final visualizations, SVG charts, HTML/D3 dashboards, Markdown reports, or JSON outputs.",
    parameters: Type.Object({
      title: Type.String({ description: "Human-readable artifact title." }),
      filename: Type.String({ description: "Simple filename, e.g. chart.svg or dashboard.html." }),
      mimeType: Type.Union([
        Type.Literal("image/svg+xml"),
        Type.Literal("text/html"),
        Type.Literal("text/css"),
        Type.Literal("text/csv"),
        Type.Literal("text/markdown"),
        Type.Literal("text/plain"),
        Type.Literal("application/json"),
      ], { description: "Artifact MIME type." }),
      content: Type.String({ description: "Complete artifact content." }),
      description: Type.Optional(Type.String({ description: "Short note shown in artifact metadata." })),
      role: Type.Optional(Type.String({
        description: "Lowercase-kebab semantic tag, e.g. 'memory', 'research-notes', 'link-inventory', 'dataset-csv', 'dataset-meta', 'section', 'chart-briefs', 'chart', 'shared-css', 'page'. The orchestrator filters artifacts by role."
      })),
    }),
    execute: async (_toolCallId, params) => {
      const record = await options.artifactStore.create({ ...params, sessionId: options.getSessionId() });
      return toolResultFor(record);
    },
  });

  const createChartSvgTool = defineTool({
    name: "create_chart_svg",
    label: "Create SVG Chart Artifact",
    description: "Create an SVG chart artifact in the web UI for durable one-off charts.",
    parameters: Type.Object({
      title: Type.String({ description: "Chart title." }),
      filename: Type.String({ description: "SVG filename, e.g. wage-distribution.svg." }),
      svg: Type.String({ description: "Complete SVG markup." }),
      description: Type.Optional(Type.String({ description: "Short chart description." })),
    }),
    execute: async (_toolCallId, params) => {
      const record = await options.artifactStore.create({
        sessionId: options.getSessionId(),
        title: params.title,
        filename: params.filename,
        mimeType: "image/svg+xml",
        content: params.svg,
        description: params.description,
      });
      return toolResultFor(record, `Created SVG chart artifact: ${record.title}`);
    },
  });

  const createBlsSaNsaChartTool = defineTool({
    name: "create_bls_sa_nsa_chart",
    label: "Create BLS SA/NSA Chart",
    description: "Fetch a BLS seasonally-adjusted and not-seasonally-adjusted pair using project lookup JSON, then create a D3 HTML artifact comparing the two series.",
    parameters: Type.Object({
      survey: Type.Optional(Type.Union([Type.Literal("LN"), Type.Literal("CE")], { description: "BLS survey family. LN uses data/lookups/ln_concepts.json; CE builds CES/CEU series." })),
      concept: Type.Optional(Type.String({ description: "LN concept code from data/lookups/ln_concepts.json, e.g. unemployment_rate." })),
      supersector: Type.Optional(Type.String({ description: "CE supersector, default 00." })),
      industry: Type.Optional(Type.String({ description: "CE industry code, default 000000." })),
      datatype: Type.Optional(Type.String({ description: "CE datatype, default 01." })),
      startYear: Type.Optional(Type.Integer({ description: "Start year, default current year - 4." })),
      endYear: Type.Optional(Type.Integer({ description: "End year, default current year." })),
      title: Type.Optional(Type.String({ description: "Artifact/chart title override." })),
      filename: Type.Optional(Type.String({ description: "HTML artifact filename." })),
    }),
    execute: async (_toolCallId, params) => {
      const currentYear = new Date().getFullYear();
      const startYear = params.startYear ?? currentYear - 4;
      const endYear = params.endYear ?? currentYear;
      if (startYear > endYear) throw new Error("startYear must be <= endYear");

      const survey = params.survey ?? "LN";
      let seriesIds: string[];
      let labels: Record<string, { label: string; seasonality: "SA" | "NSA" }>;
      let title: string;
      let subtitle: string;
      let unit: string;
      let metadata: Record<string, unknown>;

      if (survey === "CE") {
        const supersector = params.supersector ?? "00";
        const industry = params.industry ?? "000000";
        const datatype = params.datatype ?? "01";
        const industries = readLookup<{ supersector: string; label: string }>(cwd, "ce_industries");
        const datatypes = readLookup<{ code: string; label: string }>(cwd, "ce_datatypes");
        const industryLabel = industries.find((item) => item.supersector === supersector)?.label ?? supersector;
        const datatypeLabel = datatypes.find((item) => item.code === datatype)?.label ?? datatype;
        const sa = `CES${supersector}${industry}${datatype}`;
        const nsa = `CEU${supersector}${industry}${datatype}`;
        seriesIds = [sa, nsa];
        const label = `${industryLabel} — ${datatypeLabel}`;
        labels = { [sa]: { label: `${label} (SA)`, seasonality: "SA" }, [nsa]: { label: `${label} (NSA)`, seasonality: "NSA" } };
        unit = datatypeLabel;
        title = params.title ?? `${industryLabel}: SA vs NSA`;
        subtitle = `Current Employment Statistics pair ${sa} / ${nsa}, ${startYear}–${endYear}.`;
        metadata = { survey, supersector, industry, datatype, seriesIds, startYear, endYear };
      } else {
        const conceptCode = params.concept ?? "unemployment_rate";
        const concepts = readLookup<{ code: string; label: string; sa: string; nsa: string; unit: string }>(cwd, "ln_concepts");
        const concept = concepts.find((item) => item.code === conceptCode);
        if (!concept) throw new Error(`Unknown LN concept ${conceptCode}`);
        seriesIds = [concept.sa, concept.nsa];
        labels = {
          [concept.sa]: { label: `${concept.label} (SA)`, seasonality: "SA" },
          [concept.nsa]: { label: `${concept.label} (NSA)`, seasonality: "NSA" },
        };
        unit = concept.unit;
        title = params.title ?? `${concept.label}: SA vs NSA`;
        subtitle = `Labor Force Statistics pair ${concept.sa} / ${concept.nsa}, ${startYear}–${endYear}.`;
        metadata = { survey, concept: conceptCode, seriesIds, startYear, endYear };
      }

      const apiSeries = await fetchBlsSeries(seriesIds, startYear, endYear);
      const series = parseBlsSeries(apiSeries, labels);
      if (series.length < 1) throw new Error("BLS API returned no usable observations");

      const html = renderSeasonalHtml({
        title,
        subtitle,
        unit,
        source: "Source: U.S. Bureau of Labor Statistics Public Data API v2. SA/NSA lookup pair from project data/lookups JSON.",
        series,
        metadata,
      });
      const record = await options.artifactStore.create({
        sessionId: options.getSessionId(),
        title,
        filename: params.filename ?? `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "bls-sa-nsa"}.html`,
        mimeType: "text/html",
        content: html,
        description: subtitle,
      });
      return toolResultFor(record, `Created BLS SA/NSA D3 chart artifact: ${record.title}`);
    },
  });

  const createDocumentTool = defineTool({
    name: "create_document",
    label: "Create Document Manifest",
    description:
      "Persist a paged-document manifest. The manifest must contain a non-empty `pages` array; " +
      "each `pages[i].artifactId` must resolve to an existing text/html artifact. " +
      "This tool is the only legitimate producer of document manifests.",
    parameters: Type.Object({
      title:       Type.String({ description: "Document title; used as the artifact title." }),
      manifest:    Type.Any({ description: "The document manifest. Must contain pages: [{artifactId, ...}]." }),
      filename:    Type.Optional(Type.String({ description: "Filename, defaults to slug(title).document.json." })),
      description: Type.Optional(Type.String()),
      role:        Type.Optional(Type.String({ description: "Defaults to 'document-manifest'." })),
    }),
    execute: async (_toolCallId, params) => {
      const m = params.manifest as any;
      if (!m || typeof m !== "object")
        throw new Error("manifest must be an object");
      if (!Array.isArray(m.pages) || m.pages.length === 0)
        throw new Error("manifest.pages must be a non-empty array");

      const currentSessionId = options.getSessionId() || "standalone";
      for (const [i, p] of m.pages.entries()) {
        if (!p?.artifactId)
          throw new Error(`pages[${i}].artifactId is required`);
        const hit = options.artifactStore.get(p.artifactId);
        if (!hit)
          throw new Error(`pages[${i}].artifactId "${p.artifactId}" does not exist`);
        if (hit.record.mimeType !== "text/html")
          throw new Error(`pages[${i}].artifactId "${p.artifactId}" must be text/html, got ${hit.record.mimeType}`);
        if (hit.record.sessionId !== currentSessionId)
          throw new Error(`pages[${i}].artifactId "${p.artifactId}" belongs to a different session (${hit.record.sessionId})`);
      }

      const manifest = {
        ...m,
        kind: "document",
        schemaVersion: 2,
        createdAt: new Date().toISOString(),
        title: params.title,
      };

      const record = await options.artifactStore.create({
        sessionId: options.getSessionId(),
        title: params.title,
        filename: params.filename
          ?? `${params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "document"}.document.json`,
        mimeType: "application/vnd.dva.document+json",
        content: JSON.stringify(manifest, null, 2),
        description: params.description,
        role: params.role ?? "document-manifest",
      });
      return toolResultFor(record, `Created document "${params.title}" with ${m.pages.length} pages`);
    },
  });

  // ─── FRED Chart Tool ──────────────────────────────────────────────────────

  const createFredChartTool = defineTool({
    name: "create_fred_chart",
    label: "Create FRED Chart",
    description: "Fetch FRED Industrial Production or Capacity Utilization series and create a D3 HTML artifact comparing SA vs NSA.",
    parameters: Type.Object({
      concept: Type.Optional(Type.String({ description: "Concept code from data/lookups/fred_ipi.json, e.g. indpro_total." })),
      startYear: Type.Optional(Type.Integer({ description: "Start year, default current year - 4." })),
      endYear: Type.Optional(Type.Integer({ description: "End year, default current year." })),
      title: Type.Optional(Type.String({ description: "Artifact/chart title override." })),
      filename: Type.Optional(Type.String({ description: "HTML artifact filename." })),
    }),
    execute: async (_toolCallId, params) => {
      const currentYear = new Date().getFullYear();
      const startYear = params.startYear ?? currentYear - 4;
      const endYear = params.endYear ?? currentYear;
      if (startYear > endYear) throw new Error("startYear must be <= endYear");

      const conceptCode = params.concept ?? "indpro_total";
      const concepts = readLookup<{ code: string; label: string; sa: string; nsa: string; unit: string; frequency: string }>(cwd, "fred_ipi");
      const concept = concepts.find((item) => item.code === conceptCode);
      if (!concept) throw new Error(`Unknown FRED concept ${conceptCode}`);

      const apiKey = process.env["FRED_API_KEY"];
      if (!apiKey) throw new Error("FRED_API_KEY not set in environment");

      // Fetch SA and NSA series from FRED
      const fetchFred = async (seriesId: string) => {
        const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=${startYear}-01-01&observation_end=${endYear}-12-31`;
        const res = await fetch(url, { headers: { "User-Agent": "FRED-Client/1.0" } });
        if (!res.ok) throw new Error(`FRED API returned HTTP ${res.status} for ${seriesId}`);
        const json = await res.json() as any;
        const obs = json?.observations ?? [];
        return obs
          .filter((d: any) => d.value !== ".")
          .map((d: any) => ({
            date: d.date,
            label: d.date,
            value: Number(d.value),
            year: d.date.slice(0, 4),
            period: "M" + d.date.slice(5, 7),
            periodName: new Date(d.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" }),
          }))
          .filter((d: { value: number }) => Number.isFinite(d.value))
          .sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date));
      };

      const saPoints = await fetchFred(concept.sa);
      const nsaPoints = concept.nsa !== concept.sa ? await fetchFred(concept.nsa) : [];

      const series: BLSSeries[] = [
        { id: concept.sa, label: `${concept.label} (SA)`, seasonality: "SA", points: saPoints },
      ];
      if (nsaPoints.length > 0) {
        series.push({ id: concept.nsa, label: `${concept.label} (NSA)`, seasonality: "NSA", points: nsaPoints });
      }

      if (series.every(s => s.points.length === 0)) throw new Error("FRED API returned no usable observations");

      const html = renderSeasonalHtml({
        title: params.title ?? `${concept.label}: SA vs NSA`,
        subtitle: `Federal Reserve Industrial Production, ${concept.frequency}, ${startYear}–${endYear}. Series: ${concept.sa} / ${concept.nsa}.`,
        unit: concept.unit,
        source: "Source: Board of Governors of the Federal Reserve System (FRED via St. Louis Fed).",
        series,
        metadata: { concept: conceptCode, seriesIds: [concept.sa, concept.nsa], startYear, endYear },
      });

      const fn = params.filename ?? `${(params.title ?? concept.label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "fred-chart"}.html`;
      const record = await options.artifactStore.create({
        sessionId: options.getSessionId(),
        title: params.title ?? concept.label,
        filename: fn,
        mimeType: "text/html",
        content: html,
        description: `FRED ${concept.label}, ${startYear}–${endYear}`,
      });
      return toolResultFor(record, `Created FRED chart artifact: ${record.title}`);
    },
  });

  // ─── Economic Census Chart Tool ─────────────────────────────────────────────

  function renderEcBarHtml(opts: {
    title: string;
    subtitle: string;
    unit: string;
    source: string;
    rows: { label: string; value: number; naics: string }[];
    metadata: Record<string, unknown>;
  }): string {
    const payload = JSON.stringify(opts).replace(/<\//g, "<\\/");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(opts.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>
:root{color-scheme:dark;--bg:#090d12;--panel:#111821;--ink:#d8e0ea;--muted:#8090a4;--line:#273241;--blue:#58a6ff;--orange:#f78166;--green:#3fb950;--violet:#d2a8ff;font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 10%,rgba(88,166,255,.18),transparent 32%),linear-gradient(135deg,#06090d,#0d1117 58%,#070a0f);color:var(--ink)}main{width:min(1100px,calc(100vw - 34px));margin:0 auto;padding:28px 0 36px}.card{border:1px solid rgba(128,144,164,.22);background:linear-gradient(180deg,rgba(17,24,33,.92),rgba(13,20,29,.82));border-radius:22px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.36);margin-bottom:18px}.eyebrow{font:800 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}h1{margin:10px 0 8px;font-size:clamp(28px,4vw,46px);letter-spacing:-.04em;color:#f0f6fc}.subtitle{color:#a9b8c8;line-height:1.55}svg{display:block;width:100%;height:auto}.bar{transition:opacity .15s}.bar:hover{opacity:.8}.axis text{fill:#8b949e;font-size:11px}.axis path,.axis line{stroke:#334155}.grid line{stroke:#1e293b}.grid path{display:none}.tooltip{position:fixed;pointer-events:none;opacity:0;background:#0b1118;border:1px solid #3b4656;border-radius:10px;padding:8px 12px;box-shadow:0 14px 50px rgba(0,0,0,.45);font-size:12px;z-index:5}.source{margin-top:12px;color:#718096;font-size:12px}
</style>
</head>
<body>
<main>
  <div class="card"><div class="eyebrow">Economic Census</div><h1>${esc(opts.title)}</h1><div class="subtitle">${esc(opts.subtitle)}</div></div>
  <div class="card"><svg id="chart" viewBox="0 0 1100 800" role="img"></svg></div>
  <div class="source">${esc(opts.source)}</div>
</main>
<div class="tooltip" id="tooltip"></div>
<script>
const payload = ${payload};
const data = payload.rows || [];
const fmt = d3.format(',.0f');
const svg = d3.select('#chart');
const W = 1100, H = 800, margin = {top:20,right:60,bottom:24,left:280};
const innerW = W - margin.left - margin.right, innerH = H - margin.top - margin.bottom;
const g = svg.append('g').attr('transform','translate('+margin.left+','+margin.top+')');
const y = d3.scaleBand().domain(data.map(d=>d.label)).range([0,innerH]).padding(.15);
const maxVal = d3.max(data,d=>d.value)||1;
const x = d3.scaleLinear().domain([0,maxVal*1.12]).range([0,innerW]);
g.append('g').attr('class','grid').call(d3.axisTop(x).ticks(6).tickSize(-innerH).tickFormat(''));
g.append('g').attr('class','axis').call(d3.axisLeft(y)).selectAll('text').style('text-anchor','end').attr('dx','-.8em').style('font-size','12px').style('fill','#c9d1d9');
g.append('g').attr('class','axis').attr('transform','translate(0,'+innerH+')').call(d3.axisBottom(x).ticks(6).tickFormat(d=>fmt(d)));
g.selectAll('.bar').data(data).enter().append('rect').attr('class','bar').attr('y',d=>y(d.label)).attr('height',y.bandwidth()).attr('x',0).attr('width',d=>x(d.value)).attr('fill','#58a6ff').attr('rx',3).on('mouseover',(event,d)=>{
  d3.select('#tooltip').style('opacity',1).style('left',event.clientX+'px').style('top',event.clientY+'px').html('<b>'+d.label+'</b><br>'+fmt(d.value)+' '+payload.unit);
}).on('mouseout',()=>d3.select('#tooltip').style('opacity',0));
</script>
</body>
</html>`;
  }

  const createEcChartTool = defineTool({
    name: "create_ec_chart",
    label: "Create Economic Census Chart",
    description: "Fetch Economic Census data from the Census Bureau API and create a D3 HTML bar chart comparing NAICS sectors.",
    parameters: Type.Object({
      year: Type.Optional(Type.String({ description: "Census year: 2022 or 2017." })),
      variable: Type.Optional(Type.String({ description: "Variable code from data/lookups/ec_variables.json, e.g. EMP, PAYANN, RCPTOT." })),
      naics: Type.Optional(Type.String({ description: "NAICS sector filter (2-digit code like 31-33), or omit for all sectors." })),
      title: Type.Optional(Type.String({ description: "Chart title override." })),
      filename: Type.Optional(Type.String({ description: "HTML artifact filename." })),
    }),
    execute: async (_toolCallId, params) => {
      const year = params.year ?? "2022";
      const variableCode = params.variable ?? "EMP";
      const apiKey = process.env["CENSUS_API_KEY"];
      if (!apiKey) throw new Error("CENSUS_API_KEY not set in environment");

      const variables = readLookup<{ code: string; label: string; unit: string }>(cwd, "ec_variables");
      const variable = variables.find((v) => v.code === variableCode);
      if (!variable) throw new Error(`Unknown EC variable ${variableCode}`);

      const years = readLookup<{ code: string; label: string; apiDataset: string }>(cwd, "ec_years");
      const yearEntry = years.find((y) => y.code === year);
      if (!yearEntry) throw new Error(`Unknown EC year ${year}`);

      const naics = readLookup<{ code: string; level: string; label: string; parent: string | null }>(cwd, "naics");

      // Build NAICS filter: if specific NAICS requested, drill into subsectors; otherwise get all sectors
      let naicsList: { code: string; label: string }[];
      if (params.naics) {
        const parent = naics.find((n) => n.code === params.naics);
        if (!parent) throw new Error(`Unknown NAICS ${params.naics}`);
        const children = naics.filter((n) => n.parent === params.naics);
        naicsList = children.length > 0 ? children : [parent];
      } else {
        naicsList = naics.filter((n) => n.level === "sector" && !n.code.includes("-"));
      }

      // Fetch data for each NAICS code
      const rows: { label: string; value: number; naics: string }[] = [];
      for (const n of naicsList) {
        const url = `https://api.census.gov/data/${year}/${yearEntry.apiDataset}?get=GEO_ID,NAME,NAICS2022,NAICS2022_LABEL,${variableCode}&for=us:*&NAICS2022=${encodeURIComponent(n.code)}&key=${apiKey}`;
        const res = await fetch(url, { headers: { "User-Agent": "Census-Client/1.0" } });
        if (!res.ok) {
          if (res.status === 204) continue; // No data for this NAICS
          throw new Error(`Census API returned HTTP ${res.status} for NAICS ${n.code}`);
        }
        const text = await res.text();
        if (!text || text.trim().length === 0) continue; // Empty body = no data
        let json: any;
        try { json = JSON.parse(text); } catch { continue; }
        // Census API returns array of arrays: [headers, ...rows]
        if (Array.isArray(json) && json.length > 1) {
          const headers: string[] = json[0];
          const dataRow: any[] = json[1];
          const valIdx = headers.indexOf(variableCode);
          if (valIdx >= 0) {
            const val = Number(dataRow[valIdx]);
            if (Number.isFinite(val) && val > 0) {
              rows.push({ label: n.label, value: val, naics: n.code });
            }
          }
        }
        // Small delay to be nice to the API
        await new Promise((r) => setTimeout(r, 50));
      }

      if (rows.length === 0) throw new Error("Census API returned no data for the requested parameters");
      rows.sort((a, b) => b.value - a.value);

      const title = params.title ?? `Economic Census ${year}: ${variable.label} by NAICS Sector`;
      const html = renderEcBarHtml({
        title,
        subtitle: `U.S. total, ${variable.label} (${variable.unit}) by NAICS sector, ${year} Economic Census.`,
        unit: variable.unit,
        source: "Source: U.S. Census Bureau, Economic Census API (ecnbasic).",
        rows,
        metadata: { year, variable: variableCode, naicsFilter: params.naics ?? "all sectors" },
      });

      const fn = params.filename ?? `ec-${year}-${variableCode.toLowerCase()}.html`;
      const record = await options.artifactStore.create({
        sessionId: options.getSessionId(),
        title,
        filename: fn,
        mimeType: "text/html",
        content: html,
        description: `${year} Economic Census, ${variable.label} by NAICS`,
      });
      return toolResultFor(record, `Created Economic Census chart artifact: ${record.title}`);
    },
  });

  // ─── ABS Chart Tool ────────────────────────────────────────────────────────

  function renderAbsGroupedBarHtml(opts: {
    title: string;
    subtitle: string;
    source: string;
    categories: string[];
    groups: { label: string; values: number[] }[];
    metadata: Record<string, unknown>;
  }): string {
    const payload = JSON.stringify(opts).replace(/<\//g, "<\\/");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(opts.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>
:root{color-scheme:dark;--bg:#090d12;--panel:#111821;--ink:#d8e0ea;--muted:#8090a4;--line:#273241;font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 10%,rgba(88,166,255,.18),transparent 32%),linear-gradient(135deg,#06090d,#0d1117 58%,#070a0f);color:var(--ink)}main{width:min(1100px,calc(100vw - 34px));margin:0 auto;padding:28px 0 36px}.card{border:1px solid rgba(128,144,164,.22);background:linear-gradient(180deg,rgba(17,24,33,.92),rgba(13,20,29,.82));border-radius:22px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.36);margin-bottom:18px}.eyebrow{font:800 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}h1{margin:10px 0 8px;font-size:clamp(24px,4vw,42px);letter-spacing:-.04em;color:#f0f6fc}.subtitle{color:#a9b8c8;line-height:1.55}svg{display:block;width:100%;height:auto}.bar{transition:opacity .15s}.bar:hover{opacity:.8}.axis text{fill:#8b949e;font-size:11px}.axis path,.axis line{stroke:#334155}.grid line{stroke:#1e293b}.grid path{display:none}.legend{display:flex;flex-wrap:wrap;gap:16px;margin:14px 0 4px;color:#a9b8c8;font-size:13px}.legend i{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:middle;margin-right:6px}.tooltip{position:fixed;pointer-events:none;opacity:0;background:#0b1118;border:1px solid #3b4656;border-radius:10px;padding:8px 12px;box-shadow:0 14px 50px rgba(0,0,0,.45);font-size:12px;z-index:5}.source{margin-top:12px;color:#718096;font-size:12px}
</style>
</head>
<body>
<main>
  <div class="card"><div class="eyebrow">Annual Business Survey</div><h1>${esc(opts.title)}</h1><div class="subtitle">${esc(opts.subtitle)}</div></div>
  <div class="card">
    <svg id="chart" viewBox="0 0 1100 600" role="img"></svg>
    <div class="legend" id="legend"></div>
  </div>
  <div class="source">${esc(opts.source)}</div>
</main>
<div class="tooltip" id="tooltip"></div>
<script>
const payload = ${payload};
const groups = payload.groups || [];
const categories = payload.categories || [];
const fmt = d3.format(',.0f');
const svg = d3.select('#chart');
const W = 1100, H = 600, margin = {top:20,right:40,bottom:80,left:100};
const innerW = W - margin.left - margin.right, innerH = H - margin.top - margin.bottom;
const g = svg.append('g').attr('transform','translate('+margin.left+','+margin.top+')');
const x0 = d3.scaleBand().domain(categories).range([0,innerW]).padding(.2);
const x1 = d3.scaleBand().domain(groups.map(d=>d.label)).range([0,x0.bandwidth()]).padding(.05);
const colors = ['#58a6ff','#3fb950','#f78166','#d2a8ff','#f0c24b','#9c6ade','#4cb5ab','#e5537b'];
const maxVal = d3.max(groups.flatMap(d=>d.values))||1;
const y = d3.scaleLinear().domain([0,maxVal*1.12]).range([innerH,0]);
g.append('g').attr('class','grid').call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(''));
g.append('g').attr('class','axis').attr('transform','translate(0,'+innerH+')').call(d3.axisBottom(x0)).selectAll('text').style('text-anchor','end').attr('dx','-.8em').attr('dy','.15em').attr('transform','rotate(-25)').style('font-size','11px').style('fill','#c9d1d9');
g.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(5).tickFormat(d=>fmt(d)));
const catGroup = g.selectAll('.cat').data(categories).enter().append('g').attr('transform',d=>'translate('+x0(d)+',0)');
catGroup.selectAll('rect').data((cat,i)=>groups.map(g=>({cat,g,idx:i,val:g.values[i]}))).enter().append('rect').attr('class','bar').attr('x',d=>x1(d.g.label)).attr('y',d=>y(d.val)).attr('width',x1.bandwidth()).attr('height',d=>innerH-y(d.val)).attr('fill',d=>colors[groups.indexOf(d.g)%colors.length]).attr('rx',2).on('mouseover',(event,d)=>{
  d3.select('#tooltip').style('opacity',1).style('left',event.clientX+'px').style('top',event.clientY+'px').html('<b>'+d.g.label+'</b> — '+d.cat+'<br>'+fmt(d.val));
}).on('mouseout',()=>d3.select('#tooltip').style('opacity',0));
document.getElementById('legend').innerHTML = groups.map((g,i)=>'<span><i style="background:'+colors[i%colors.length]+'"></i>'+g.label+'</span>').join('');
</script>
</body>
</html>`;
  }

  const createAbsChartTool = defineTool({
    name: "create_abs_chart",
    label: "Create ABS Chart",
    description: "Fetch Annual Business Survey data from the Census Bureau API and create a D3 HTML grouped bar chart of business demographics.",
    parameters: Type.Object({
      dataset: Type.Optional(Type.String({ description: "ABS dataset: abscs (Company Summary), abscb (Characteristics of Businesses), or abscbo (Characteristics of Business Owners)." })),
      year: Type.Optional(Type.Integer({ description: "Survey reference year (2023=most recent)." })),
      naics: Type.Optional(Type.String({ description: "NAICS sector filter (2-digit code), or omit for all sectors." })),
      dimension: Type.Optional(Type.String({ description: "Demographic dimension to group by: SEX, RACE_GROUP, ETH_GROUP, or VET_GROUP." })),
      title: Type.Optional(Type.String({ description: "Chart title override." })),
      filename: Type.Optional(Type.String({ description: "HTML artifact filename." })),
    }),
    execute: async (_toolCallId, params) => {
      const datasetCode = params.dataset ?? "abscs";
      const refYear = params.year ?? 2023;
      const apiKey = process.env["CENSUS_API_KEY"];
      if (!apiKey) throw new Error("CENSUS_API_KEY not set in environment");

      const datasets = readLookup<{ code: string; label: string; description: string; apiDataset: string; years: number[] }>(cwd, "abs_datasets");
      const dataset = datasets.find((d) => d.code === datasetCode);
      if (!dataset) throw new Error(`Unknown ABS dataset ${datasetCode}`);
      if (!dataset.years.includes(refYear)) throw new Error(`Year ${refYear} not available for dataset ${datasetCode}. Available: ${dataset.years.join(", ")}`);

      const naics = readLookup<{ code: string; level: string; label: string; parent: string | null }>(cwd, "naics");
      const dim = params.dimension ?? "SEX";

      // For ABS, if NAICS specified, use it; otherwise get top-level sectors with significant firm counts
      const naicsCodes = params.naics
        ? [params.naics]
        : naics.filter((n) => n.level === "sector" && !n.code.includes("-")).slice(0, 10).map((n) => n.code);

      // Dimension labels lookup
      const dimLabels: Record<string, { code: string; label: string }[]> = {
        SEX: [{ code: "001", label: "Male" }, { code: "002", label: "Female" }, { code: "003", label: "Equally M/F" }],
        RACE_GROUP: [{ code: "00", label: "Total" }, { code: "RAC10", label: "White" }, { code: "RAC20", label: "Black/AA" }, { code: "RAC30", label: "American Indian" }, { code: "RAC40", label: "Asian" }, { code: "RAC60", label: "Other" }],
        ETH_GROUP: [{ code: "001", label: "Hispanic" }, { code: "002", label: "Non-Hispanic" }, { code: "096", label: "Equally H/NH" }],
        VET_GROUP: [{ code: "001", label: "Veteran" }, { code: "002", label: "Nonveteran" }, { code: "003", label: "Equally Vet/Nonvet" }],
      };
      const dimValues = dimLabels[dim] ?? dimLabels["SEX"];

      // Fetch FIRMPDEMP (number of firms) for each NAICS x dimension combination
      const groups: { label: string; values: number[] }[] = [];
      const categories: string[] = [];
      const naicsLabelMap = new Map(naics.map((n) => [n.code, n.label]));

      for (const nCode of naicsCodes) {
        const naicsLabel = naicsLabelMap.get(nCode) ?? nCode;
        categories.push(naicsLabel.length > 28 ? naicsLabel.slice(0, 26) + "…" : naicsLabel);

        // Build dimension groups
        if (groups.length === 0) {
          for (const dv of dimValues) {
            groups.push({ label: dv.label, values: [] });
          }
        }

        for (const dv of dimValues) {
          const url = `https://api.census.gov/data/${refYear}/${dataset.apiDataset}?get=GEO_ID,NAME,NAICS2022,NAICS2022_LABEL,${dim},${dim}_LABEL,FIRMPDEMP&for=us:*&NAICS2022=${encodeURIComponent(nCode)}&${dim}=${dv.code}&key=${apiKey}`;
          const res = await fetch(url, { headers: { "User-Agent": "Census-Client/1.0" } });
          if (!res.ok) {
            groups[dimValues.indexOf(dv)].values.push(0);
            continue;
          }
          const text = await res.text();
          if (!text || text.trim().length === 0) { groups[dimValues.indexOf(dv)].values.push(0); continue; }
          let json: any;
          try { json = JSON.parse(text); } catch { groups[dimValues.indexOf(dv)].values.push(0); continue; }
          if (Array.isArray(json) && json.length > 1) {
            const headers: string[] = json[0];
            const dataRow: any[] = json[1];
            const valIdx = headers.indexOf("FIRMPDEMP");
            const val = valIdx >= 0 ? Number(dataRow[valIdx]) : 0;
            groups[dimValues.indexOf(dv)].values.push(Number.isFinite(val) ? val : 0);
          } else {
            groups[dimValues.indexOf(dv)].values.push(0);
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (groups.every(g => g.values.every(v => v === 0))) throw new Error("ABS API returned no data for the requested parameters");

      const title = params.title ?? `ABS ${refYear}: ${dataset.label} — Firms by ${dim.replace(/_/g, " ")}`;
      const html = renderAbsGroupedBarHtml({
        title,
        subtitle: `${dataset.label} (reference year ${refYear}), number of employer firms by NAICS sector and ${dim.replace(/_/g, " ").toLowerCase()}.`,
        source: "Source: U.S. Census Bureau, Annual Business Survey API (ABS).",
        categories,
        groups,
        metadata: { dataset: datasetCode, year: refYear, dimension: dim, naicsFilter: params.naics ?? "top sectors" },
      });

      const fn = params.filename ?? `abs-${refYear}-${datasetCode}.html`;
      const record = await options.artifactStore.create({
        sessionId: options.getSessionId(),
        title,
        filename: fn,
        mimeType: "text/html",
        content: html,
        description: `ABS ${refYear}, ${dataset.label} by ${dim}`,
      });
      return toolResultFor(record, `Created ABS chart artifact: ${record.title}`);
    },
  });

  // ─── ASM Chart Tool ────────────────────────────────────────────────────────

  function renderAsmHtml(opts: {
    title: string;
    subtitle: string;
    unit: string;
    source: string;
    xLabel: string;
    series: { label: string; points: { x: string; value: number }[] }[];
    metadata: Record<string, unknown>;
  }): string {
    const payload = JSON.stringify(opts).replace(/<\//g, "<\\/");
    const isTimeSeries = opts.series.length > 0 && opts.series[0].points.every((p: any) => /^\d{4}$/.test(p.x));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(opts.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>
:root{color-scheme:dark;--bg:#090d12;--panel:#111821;--ink:#d8e0ea;--muted:#8090a4;--line:#273241;font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 10%,rgba(88,166,255,.18),transparent 32%),linear-gradient(135deg,#06090d,#0d1117 58%,#070a0f);color:var(--ink)}main{width:min(1100px,calc(100vw - 34px));margin:0 auto;padding:28px 0 36px}.card{border:1px solid rgba(128,144,164,.22);background:linear-gradient(180deg,rgba(17,24,33,.92),rgba(13,20,29,.82));border-radius:22px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.36);margin-bottom:18px}.eyebrow{font:800 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}h1{margin:10px 0 8px;font-size:clamp(24px,4vw,42px);letter-spacing:-.04em;color:#f0f6fc}.subtitle{color:#a9b8c8;line-height:1.55}svg{display:block;width:100%;height:auto}.bar{transition:opacity .15s}.bar:hover{opacity:.8}.line-path{fill:none;stroke-width:2.8}.axis text{fill:#8b949e;font-size:11px}.axis path,.axis line{stroke:#334155}.grid line{stroke:#1e293b}.grid path{display:none}.legend{display:flex;flex-wrap:wrap;gap:14px;margin:14px 4px 4px;color:#a9b8c8;font-size:13px}.legend i{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:middle;margin-right:6px}.tooltip{position:fixed;pointer-events:none;opacity:0;background:#0b1118;border:1px solid #3b4656;border-radius:10px;padding:8px 12px;box-shadow:0 14px 50px rgba(0,0,0,.45);font-size:12px;z-index:5}.source{margin-top:12px;color:#718096;font-size:12px}
</style>
</head>
<body>
<main>
  <div class="card"><div class="eyebrow">Annual Survey of Manufactures</div><h1>${esc(opts.title)}</h1><div class="subtitle">${esc(opts.subtitle)}</div></div>
  <div class="card">
    <svg id="chart" viewBox="0 0 1100 ${isTimeSeries ? 480 : Math.max(500, 60 + opts.series.reduce((a: number, s: any) => a + Math.max(1, s.points.length), 0) * 24)}" role="img"></svg>
    <div class="legend" id="legend"></div>
  </div>
  <div class="source">${esc(opts.source)}</div>
</main>
<div class="tooltip" id="tooltip"></div>
<script>
const payload = ${payload};
const isTimeSeries = ${isTimeSeries};
const fmt = d3.format(',.0f');
const colors = ['#58a6ff','#3fb950','#f78166','#d2a8ff','#f0c24b','#9c6ade','#4cb5ab','#e5537b'];
const svg = d3.select('#chart');
const W = 1100;
let H = ${isTimeSeries ? 480 : Math.max(500, 60 + opts.series.reduce((a: number, s: any) => a + Math.max(1, s.points.length), 0) * 24)};
const margin = isTimeSeries ? {top:20,right:40,bottom:48,left:90} : {top:20,right:60,bottom:24,left:280};
const innerW = W - margin.left - margin.right, innerH = H - margin.top - margin.bottom;
const g = svg.append('g').attr('transform','translate('+margin.left+','+margin.top+')');

if (isTimeSeries) {
  // LINE CHART: time series across years
  const allPts = payload.series.flatMap((s,i) => s.points.map(p => ({x: p.x, v: p.value, series:s, idx:i})));
  const x = d3.scaleBand().domain([...new Set(allPts.map(d=>d.x))].sort()).range([0,innerW]).padding(.3);
  const maxV = d3.max(allPts, d=>d.v) || 1;
  const y = d3.scaleLinear().domain([0, maxV*1.12]).range([innerH,0]);
  g.append('g').attr('class','grid').call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat(''));
  g.append('g').attr('class','axis').attr('transform','translate(0,'+innerH+')').call(d3.axisBottom(x)).selectAll('text').style('font-size','12px').style('fill','#c9d1d9');
  g.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(6).tickFormat(d=>fmt(d)));

  payload.series.forEach((s,i) => {
    const pts = s.points.map(p => ({...p, xVal: x(p.x)+x.bandwidth()/2}));
    const line = d3.line().x(d => d.xVal).y(d => y(d.value)).curve(d3.curveMonotoneX);
    g.append('path').datum(pts).attr('class','line-path').attr('stroke',colors[i%colors.length]).attr('d',line);
    g.selectAll('.dot-'+i).data(pts).enter().append('circle').attr('cx',d=>d.xVal).attr('cy',d=>y(d.value)).attr('r',3.5).attr('fill',colors[i%colors.length]).on('mouseover',(event,d)=>{
      d3.select('#tooltip').style('opacity',1).style('left',event.clientX+'px').style('top',event.clientY+'px').html('<b>'+s.label+'</b><br>'+d.x+': '+fmt(d.value)+' '+payload.unit);
    }).on('mouseout',()=>d3.select('#tooltip').style('opacity',0));
  });
  document.getElementById('legend').innerHTML = payload.series.map((s,i)=>'<span><i style="background:'+colors[i%colors.length]+'"></i>'+s.label+'</span>').join('');
} else {
  // BAR CHART: cross-section by NAICS
  const flat = payload.series.flatMap(s => s.points.map(p => ({label: p.x, value: p.value, series: s.label})));
  flat.sort((a,b) => b.value - a.value);
  const y = d3.scaleBand().domain(flat.map(d=>d.label)).range([0,innerH]).padding(.12);
  const maxV = d3.max(flat,d=>d.value)||1;
  const x = d3.scaleLinear().domain([0,maxV*1.12]).range([0,innerW]);
  g.append('g').attr('class','grid').call(d3.axisTop(x).ticks(6).tickSize(-innerH).tickFormat(''));
  g.append('g').attr('class','axis').call(d3.axisLeft(y).tickFormat(d => { const t = String(d); return t.length > 32 ? t.slice(0,30)+'\u2026' : t; })).selectAll('text').style('text-anchor','end').attr('dx','-.6em').style('font-size','12px').style('fill','#c9d1d9');
  g.append('g').attr('class','axis').attr('transform','translate(0,'+innerH+')').call(d3.axisBottom(x).ticks(6).tickFormat(d=>fmt(d)));
  const colorMap = {};
  payload.series.forEach((s,i) => { s.points.forEach(p => { colorMap[p.x] = colors[i%colors.length]; }); });
  g.selectAll('.bar').data(flat).enter().append('rect').attr('class','bar').attr('y',d=>y(d.label)).attr('height',y.bandwidth()).attr('x',0).attr('width',d=>x(d.value)).attr('fill',d=>colorMap[d.label]||'#58a6ff').attr('rx',3).on('mouseover',(event,d)=>{
    d3.select('#tooltip').style('opacity',1).style('left',event.clientX+'px').style('top',event.clientY+'px').html('<b>'+d.label+'</b><br>'+fmt(d.value)+' '+payload.unit);
  }).on('mouseout',()=>d3.select('#tooltip').style('opacity',0));
  document.getElementById('legend').innerHTML = payload.series.map((s,i)=>'<span><i style="background:'+colors[i%colors.length]+'"></i>'+s.label+'</span>').join('');
}
</script>
</body>
</html>`;
  }

  const createAsmChartTool = defineTool({
    name: "create_asm_chart",
    label: "Create ASM Chart",
    description: "Fetch Annual Survey of Manufactures data from the Census Bureau API and create a D3 HTML chart. Time series (line chart) when NAICS is specified; cross-section (bar chart) comparing all manufacturing subsectors for a single year.",
    parameters: Type.Object({
      naics: Type.Optional(Type.String({ description: "NAICS code, e.g. 31-33 for all manufacturing, 311 for food, or omit for all 3-digit subsectors." })),
      year: Type.Optional(Type.Integer({ description: "Year (2018-2021). Omit to get all years (time series mode)." })),
      variable: Type.Optional(Type.String({ description: "Variable from data/lookups/asm_variables.json, e.g. EMP, PAYANN, VALADD." })),
      title: Type.Optional(Type.String({ description: "Chart title override." })),
      filename: Type.Optional(Type.String({ description: "HTML artifact filename." })),
    }),
    execute: async (_toolCallId, params) => {
      const apiKey = process.env["CENSUS_API_KEY"];
      if (!apiKey) throw new Error("CENSUS_API_KEY not set in environment");

      const variableCode = params.variable ?? "EMP";
      const variables = readLookup<{ code: string; label: string; unit: string }>(cwd, "asm_variables");
      const variable = variables.find((v) => v.code === variableCode);
      if (!variable) throw new Error(`Unknown ASM variable ${variableCode}`);

      const naicsCode = params.naics ?? "31*"; // Default: all manufacturing 3-digit
      const year = params.year;

      const series: { label: string; points: { x: string; value: number }[] }[] = [];

      if (year) {
        // Cross-section mode: single year, multiple NAICS
        const url = `https://api.census.gov/data/timeseries/asm/area2017?get=YEAR,NAICS2017,NAICS2017_LABEL,${variableCode}&for=us:*&YEAR=${year}&NAICS2017=${encodeURIComponent(naicsCode)}&key=${apiKey}`;
        const res = await fetch(url, { headers: { "User-Agent": "Census-Client/1.0" } });
        if (!res.ok) throw new Error(`Census API returned HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.trim().length === 0) throw new Error("ASM API returned empty response");
        let json: any;
        try { json = JSON.parse(text); } catch { throw new Error("ASM API returned invalid JSON"); }
        if (!Array.isArray(json) || json.length < 2) throw new Error("No data rows returned");
        const headers: string[] = json[0];
        const naicsIdx = headers.indexOf("NAICS2017_LABEL");
        const valIdx = headers.indexOf(variableCode);
        const points: { x: string; value: number }[] = [];
        for (let i = 1; i < json.length; i++) {
          const row: any[] = json[i];
          const label = row[naicsIdx] ?? row[1] ?? "?";
          const val = Number(row[valIdx]);
          if (Number.isFinite(val)) {
            points.push({ x: label, value: val });
          }
        }
        if (points.length === 0) throw new Error("No valid data in ASM response");
        series.push({ label: String(year), points });
      } else {
        // Time series mode: all years for a specific NAICS
        const url = `https://api.census.gov/data/timeseries/asm/area2017?get=YEAR,NAICS2017,NAICS2017_LABEL,${variableCode}&for=us:*&NAICS2017=${encodeURIComponent(naicsCode)}&key=${apiKey}`;
        const res = await fetch(url, { headers: { "User-Agent": "Census-Client/1.0" } });
        if (!res.ok) throw new Error(`Census API returned HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.trim().length === 0) throw new Error("ASM API returned empty response");
        let json: any;
        try { json = JSON.parse(text); } catch { throw new Error("ASM API returned invalid JSON"); }
        if (!Array.isArray(json) || json.length < 2) throw new Error("No data rows returned");
        const headers: string[] = json[0];
        const yearIdx = headers.indexOf("YEAR");
        const labelIdx = headers.indexOf("NAICS2017_LABEL");
        const valIdx = headers.indexOf(variableCode);
        const label = json[1][labelIdx] ?? naicsCode;
        const points: { x: string; value: number }[] = [];
        for (let i = 1; i < json.length; i++) {
          const row: any[] = json[i];
          const y = String(row[yearIdx]);
          const val = Number(row[valIdx]);
          if (Number.isFinite(val)) {
            points.push({ x: y, value: val });
          }
        }
        points.sort((a, b) => a.x.localeCompare(b.x));
        if (points.length === 0) throw new Error("No valid data in ASM response");
        series.push({ label, points });
      }

      const title = params.title
        ?? (year
          ? `ASM ${year}: ${variable.label} by NAICS`
          : `${variable.label} — ASM ${series[0]?.label ?? ""}`.trim());

      const html = renderAsmHtml({
        title,
        subtitle: year
          ? `U.S. manufacturing, NAICS filter: ${naicsCode}, ${year}.`
          : `U.S. manufacturing, ${naicsCode}, 2018–2021.`,
        unit: variable.unit,
        source: "Source: U.S. Census Bureau, Annual Survey of Manufactures API (timeseries/asm).",
        xLabel: year ? "NAICS Industry" : "Year",
        series,
        metadata: { naics: naicsCode, year: year ?? "all", variable: variableCode },
      });

      const fn = params.filename ?? `asm-${naicsCode.replace(/[^a-z0-9]/gi, "-")}-${variableCode.toLowerCase()}.html`;
      const record = await options.artifactStore.create({
        sessionId: options.getSessionId(),
        title,
        filename: fn,
        mimeType: "text/html",
        content: html,
        description: `ASM ${year ?? "2018-2021"}, ${variable.label}`,
      });
      return toolResultFor(record, `Created ASM chart artifact: ${record.title}`);
    },
  });

  // ─── Query Artifact DB Tool ────────────────────────────────────────────────
  //
  // Translates a natural-language request into a SELECT against data/artifacts.db,
  // then surfaces every renderable matching row to the frontend Documents panel
  // via artifactStore.create() (which triggers the artifact_created WS broadcast).
  //
  // ─── parse_pdf ────────────────────────────────────────────────────────────
  // In-process PDF text extraction. Primary engine: pdf-parse (pdfjs-dist v4
  // under the hood). Fallback engine: the `pdftotext` binary from poppler-utils
  // if it is on PATH — this is the rescue path for PDFs with Type0/Identity-H
  // font encoding (e.g. Census M3 code-list PDFs) where pdfjs alone returns
  // empty strings.
  //
  // The tool returns the extracted text directly. If `saveAs` is provided, it
  // also persists the text as a `text/plain` artifact for downstream sessions.

  const parsePdfTool = defineTool({
    name: "parse_pdf",
    label: "Parse PDF",
    description: `Extract text from a PDF file or URL using pdf-parse, with an automatic fallback to the local 'pdftotext' binary if the PDF has fonts that the JS parser cannot decode (the typical failure mode for Census M3 code-list PDFs).

Returns the extracted text plus per-page byte counts. Set 'saveAs' to also persist the result as a text/plain artifact.

Typical uses:
  - extract code lists from Census / BLS methodology PDFs into a parseable form
  - convert OEWS / M3 / methods PDFs already in data/ to text for further processing
  - dump a single page range for inspection

If both engines yield empty text, the response will say so explicitly — fall back to Playwright scraping in that case.`,
    parameters: Type.Object({
      filePath: Type.Optional(Type.String({ description: "Path to a local PDF (absolute, or relative to project root). Provide either filePath or url." })),
      url: Type.Optional(Type.String({ description: "HTTPS URL of the PDF. The tool will fetch the bytes and parse in memory." })),
      pages: Type.Optional(Type.String({ description: "Page selection. 'all' (default), a single page like '3', or a range like '1-10'." })),
      mode: Type.Optional(Type.Union([
        Type.Literal("text"),
        Type.Literal("info"),
      ], { description: "'text' returns extracted text (default). 'info' returns document metadata only (page count, title, producer)." })),
      engine: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("pdf-parse"),
        Type.Literal("pdftotext"),
      ], { description: "'auto' (default) tries pdf-parse then pdftotext. Force one engine by name for debugging." })),
      saveAs: Type.Optional(Type.String({ description: "If set, persist the extracted text as a text/plain artifact with this filename (e.g. 'm3_sichist.txt'). The artifact appears in the Documents panel." })),
      title: Type.Optional(Type.String({ description: "Artifact title when saveAs is used. Defaults to a path-derived title." })),
    }),
    execute: async (_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> => {
      // ─── Resolve source bytes ────────────────────────────────────────────
      let bytes: Uint8Array;
      let sourceLabel: string;
      let localPath: string | null = null;

      if (params.filePath && params.url) {
        return { content: [{ type: "text" as const, text: "Provide exactly one of filePath or url, not both." }], details: {}, isError: true };
      }
      if (!params.filePath && !params.url) {
        return { content: [{ type: "text" as const, text: "Must provide filePath or url." }], details: {}, isError: true };
      }

      if (params.filePath) {
        const resolved = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(cwd, params.filePath);
        if (!fs.existsSync(resolved)) {
          return { content: [{ type: "text" as const, text: `File not found: ${resolved}` }], details: {}, isError: true };
        }
        bytes = new Uint8Array(fs.readFileSync(resolved));
        sourceLabel = resolved;
        localPath = resolved;
      } else {
        try {
          const res = await fetch(params.url!);
          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Fetch failed: ${res.status} ${res.statusText} for ${params.url}` }], details: {}, isError: true };
          }
          const buf = await res.arrayBuffer();
          bytes = new Uint8Array(buf);
          sourceLabel = params.url!;
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Fetch error: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
        }
      }

      // ─── Parse page selection ────────────────────────────────────────────
      const pagesSpec = (params.pages ?? "all").trim().toLowerCase();
      let pageFilter: { first?: number; last?: number; partial?: number[] } = {};
      if (pagesSpec !== "all") {
        const rangeMatch = pagesSpec.match(/^(\d+)\s*-\s*(\d+)$/);
        const singleMatch = pagesSpec.match(/^\d+$/);
        if (rangeMatch) {
          const a = parseInt(rangeMatch[1]!, 10);
          const b = parseInt(rangeMatch[2]!, 10);
          pageFilter = { first: Math.min(a, b), last: Math.max(a, b) };
        } else if (singleMatch) {
          const n = parseInt(pagesSpec, 10);
          pageFilter = { partial: [n] };
        } else {
          return { content: [{ type: "text" as const, text: `Invalid pages spec: "${params.pages}". Use 'all', '3', or '1-10'.` }], details: {}, isError: true };
        }
      }

      const mode = params.mode ?? "text";
      const engine = params.engine ?? "auto";
      const enginesTried: string[] = [];
      let extractedText = "";
      let perPage: { num: number; chars: number }[] = [];
      let totalPages = 0;
      let infoBlob: Record<string, unknown> = {};

      // ─── Engine 1: pdf-parse (pdfjs-dist) ─────────────────────────────────
      const tryPdfParse = engine === "auto" || engine === "pdf-parse";
      if (tryPdfParse) {
        enginesTried.push("pdf-parse");
        try {
          const parser = new PDFParse({ data: bytes });
          try {
            if (mode === "info") {
              const info = await parser.getInfo();
              infoBlob = {
                pageCount: (info as any).numPages ?? (info as any).total ?? null,
                metadata: (info as any).info ?? null,
                metadataRaw: (info as any).metadata ?? null,
              };
              totalPages = Number(infoBlob.pageCount ?? 0);
            } else {
              const result = await parser.getText(pageFilter);
              const pages = (result.pages ?? []).filter((p: any) => {
                if (pageFilter.first != null && p.num < pageFilter.first) return false;
                if (pageFilter.last != null && p.num > pageFilter.last) return false;
                if (pageFilter.partial && !pageFilter.partial.includes(p.num)) return false;
                return true;
              });
              extractedText = pages.map((p: any) => `--- page ${p.num} ---\n${p.text ?? ""}`).join("\n\n");
              perPage = pages.map((p: any) => ({ num: p.num, chars: (p.text ?? "").length }));
              totalPages = result.total ?? pages.length;
            }
          } finally {
            await parser.destroy().catch(() => {});
          }
        } catch (err) {
          // Swallow — we may still try pdftotext below.
          if (engine === "pdf-parse") {
            return { content: [{ type: "text" as const, text: `pdf-parse failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
          }
        }
      }

      // ─── Engine 2: pdftotext (poppler) fallback ───────────────────────────
      const stripped = extractedText.replace(/--- page \d+ ---/g, "").trim();
      const looksEmpty = mode === "text" && stripped.length === 0;
      const tryPdftotext = engine === "pdftotext" || (engine === "auto" && looksEmpty);
      if (tryPdftotext) {
        enginesTried.push("pdftotext");
        // pdftotext can read stdin with '-' and write to stdout with '-'.
        const args: string[] = ["-layout"];
        if (pageFilter.first != null) { args.push("-f", String(pageFilter.first)); }
        if (pageFilter.last != null) { args.push("-l", String(pageFilter.last)); }
        if (pageFilter.partial && pageFilter.partial.length === 1) {
          args.push("-f", String(pageFilter.partial[0]), "-l", String(pageFilter.partial[0]));
        }
        args.push(localPath ?? "-", "-");
        const result = spawnSync("pdftotext", args, {
          input: localPath ? undefined : Buffer.from(bytes),
          encoding: "utf-8",
          maxBuffer: 64 * 1024 * 1024,
        });
        if (result.error) {
          // ENOENT means the binary isn't on PATH; report the situation clearly.
          const msg = (result.error as any).code === "ENOENT"
            ? "pdftotext binary not found on PATH. Install poppler-utils (provides 'pdftotext') or use Playwright scraping as a rescue path."
            : `pdftotext error: ${result.error.message}`;
          if (engine === "pdftotext" || looksEmpty) {
            return {
              content: [{ type: "text" as const, text: msg + (looksEmpty ? "\n\nNote: pdf-parse returned empty text first — the PDF likely uses non-decodable embedded fonts. Recommended next step: Playwright scrape of the source page." : "") }],
              details: { enginesTried, sourceLabel, pdfParseEmpty: looksEmpty },
              isError: true,
            };
          }
        } else if (result.status !== 0) {
          if (engine === "pdftotext") {
            return {
              content: [{ type: "text" as const, text: `pdftotext exited with status ${result.status}: ${result.stderr ?? ""}` }],
              details: { enginesTried, sourceLabel },
              isError: true,
            };
          }
        } else {
          extractedText = result.stdout ?? "";
          // pdftotext doesn't emit page numbers in -layout mode; report a single block.
          perPage = [{ num: 0, chars: extractedText.length }];
        }
      }

      // ─── Compose response ─────────────────────────────────────────────────
      const finalStripped = extractedText.replace(/--- page \d+ ---/g, "").trim();
      const isEmpty = mode === "text" && finalStripped.length === 0;

      const header: string[] = [];
      header.push(`Source: ${sourceLabel}`);
      header.push(`Engines tried: ${enginesTried.join(", ") || "(none)"}`);
      if (totalPages) header.push(`Total pages in document: ${totalPages}`);
      if (perPage.length) header.push(`Pages returned: ${perPage.length}, total chars: ${perPage.reduce((s, p) => s + p.chars, 0)}`);
      if (mode === "info") {
        return {
          content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${JSON.stringify(infoBlob, null, 2)}` }],
          details: { sourceLabel, enginesTried, info: infoBlob },
        };
      }

      if (isEmpty) {
        return {
          content: [{ type: "text" as const, text: `${header.join("\n")}\n\nBoth engines returned empty text. The PDF likely uses embedded fonts without a usable ToUnicode CMap (the Census M3 code-list pattern). Recommended fallback: use Playwright to scrape the equivalent web page (e.g. census.gov/econ/currentdata for M3 codes).` }],
          details: { sourceLabel, enginesTried, empty: true },
          isError: true,
        };
      }

      // ─── Optional persistence ─────────────────────────────────────────────
      if (params.saveAs) {
        const title = params.title ?? `PDF text — ${path.basename(sourceLabel)}`;
        const record = await options.artifactStore.create({
          sessionId: options.getSessionId(),
          title,
          filename: params.saveAs,
          mimeType: "text/plain",
          content: extractedText,
          description: `Text extracted from ${sourceLabel} using ${enginesTried.join(" → ")}.`,
          role: "dataset-meta",
        });
        return {
          content: [{ type: "text" as const, text: `${header.join("\n")}\n\nSaved as artifact: ${record.title} (${record.url})\n\n--- preview (first 1200 chars) ---\n${extractedText.slice(0, 1200)}` }],
          details: {
            artifactId: record.id,
            url: record.url,
            sourceLabel,
            enginesTried,
            totalPages,
            perPage,
          },
        };
      }

      return {
        content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${extractedText}` }],
        details: { sourceLabel, enginesTried, totalPages, perPage },
      };
    },
  });

  // ─── query_artifacts ──────────────────────────────────────────────────────
  // This is the agent's DEFAULT data-access path. Only fall back to external
  // APIs / web search when this tool returns 0 rows or only irrelevant rows.

  const queryArtifactsTool = defineTool({
    name: "query_artifacts",
    label: "Query Artifact Database",
    description: `Run a read-only SELECT against the artifact database (data/artifacts.db) and
surface every matching row to the user's Documents panel (Save / Discard buttons appear).

**Use this BEFORE calling external APIs or web-search.** Many user requests can
be satisfied entirely from prior-session artifacts already in the DB.

Do NOT also call create_artifact for rows surfaced this way — they are already
pushed to the frontend by this tool.

Schema:
  artifact(id, session_id, title, filename, mime_type, role, description, content, size_bytes, created_at, updated_at, model_id, replaces_id, provenance, tags)
  session(id, subject_id, model_id, title, started_at, ended_at, prompt_count, created_at)
  subject(id, category_id, name, description, tags, created_at, updated_at)
  category(id, name, description, created_at, updated_at)
  model(id, provider, display_name, created_at)

  tags and provenance are JSON. For tag containment use LIKE: tags LIKE '%\"m3\"%'
  role examples: chart, dataset-csv, dataset-meta, section, page, document-manifest, memory
  mime_type examples: text/html, text/csv, text/markdown, application/json, image/svg+xml

The query MUST select at minimum: id, title, filename, mime_type, content.
Recommended: SELECT id, title, filename, mime_type, role, description, content, tags FROM artifact WHERE …

Example — "Provide the results of M3 NSA data surveys":
  SELECT id, title, filename, mime_type, role, description, content
  FROM artifact
  WHERE tags LIKE '%\"m3\"%' AND tags LIKE '%\"nsa\"%'
  ORDER BY created_at DESC`,
    parameters: Type.Object({
      sql: Type.String({ description: "SELECT-only SQL query against data/artifacts.db. Must include content column to render artifacts." }),
    }),
    execute: async (_toolCallId, params) => {
      const sql = (params.sql || "").trim();
      if (!/^SELECT\b/i.test(sql)) {
        return {
          content: [{ type: "text" as const, text: "Error: Only SELECT queries are allowed." }],
          details: {},
          isError: true,
        };
      }

      const dbPath = path.resolve(cwd, "data", "artifacts.db");
      let sqldb: DatabaseSync;
      try {
        sqldb = new DatabaseSync(dbPath);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error opening database: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }

      let rows: Record<string, unknown>[];
      try {
        rows = sqldb.prepare(sql).all() as Record<string, unknown>[];
      } catch (err) {
        sqldb.close();
        return {
          content: [{ type: "text" as const, text: `SQL error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      } finally {
        try { sqldb.close(); } catch {}
      }

      const surfaced: { id: string; dbId: string; title: string; url: string }[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const row of rows) {
        const dbId = String(row["id"] ?? "");
        const title = String(row["title"] ?? "").trim() || `DB row ${dbId || "(unknown)"}`;
        const filename = String(row["filename"] ?? "").trim();
        const mimeType = String(row["mime_type"] ?? "").trim();
        const content = row["content"];
        const role = row["role"] != null ? String(row["role"]) : undefined;
        const description = row["description"] != null ? String(row["description"]) : undefined;

        if (!content || typeof content !== "string") {
          skipped.push({ id: dbId || title, reason: "row has no string content column (include `content` in SELECT)" });
          continue;
        }
        if (!mimeType || !DB_ALLOWED_MIME_TYPES.has(mimeType)) {
          skipped.push({ id: dbId || title, reason: `unsupported mime_type "${mimeType}"` });
          continue;
        }
        if (!filename) {
          skipped.push({ id: dbId || title, reason: "row has no filename" });
          continue;
        }

        try {
          const record = await options.artifactStore.create({
            sessionId: options.getSessionId(),
            title,
            filename,
            mimeType,
            content,
            description: description ? `${description} (restored from DB row ${dbId})` : `Restored from DB row ${dbId}`,
            role,
          });
          surfaced.push({ id: record.id, dbId, title: record.title, url: record.url });
        } catch (err) {
          skipped.push({ id: dbId || title, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      const lines: string[] = [];
      lines.push(`Found ${rows.length} row(s); surfaced ${surfaced.length} to the Documents panel${skipped.length ? `, skipped ${skipped.length}` : ""}.`);
      if (surfaced.length) {
        lines.push("");
        lines.push("Surfaced:");
        for (const s of surfaced) lines.push(`  • ${s.title} (db:${s.dbId})`);
      }
      if (skipped.length) {
        lines.push("");
        lines.push("Skipped:");
        for (const s of skipped) lines.push(`  • ${s.id}: ${s.reason}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {},
      };
    },
  });

  return [createArtifactTool, createChartSvgTool, createBlsSaNsaChartTool, createDocumentTool, createFredChartTool, createEcChartTool, createAbsChartTool, createAsmChartTool, parsePdfTool, queryArtifactsTool];
}
