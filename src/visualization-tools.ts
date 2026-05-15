import fs from "node:fs";
import path from "node:path";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ArtifactStore, ArtifactRecord } from "./artifacts.js";

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
    description: "Create an SVG chart artifact in the web UI. Prefer this over push_svg for durable one-off charts.",
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

  return [createArtifactTool, createChartSvgTool, createBlsSaNsaChartTool, createDocumentTool];
}
