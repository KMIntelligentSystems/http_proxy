# Follow-up Prompt — Compose the June 2026 Nowcast Document

*Action this **after** `june-2026-nowcast-orchestrator-prompt.md` has run through
§8 and I have said "save". Paste the whole body into the frontend prompt bar.*

---

## 0. What this is

Sections 1–7 of the consolidated prompt produced three independent June 2026
estimates, their charts, and their model cards. This prompt turns that material
into one paged document: **seven pages, declarative narrative, every number
sourced.**

The narrative below is a **draft with placeholders**. Every `{{token}}` is a
number or name that must be read out of a saved artifact from the June run. Do
not compose a page until its tokens resolve.

**Hard rule: no invented numbers.** If a token cannot be resolved from a saved
artifact, stop and tell me which one is missing. Do not estimate, round from
memory, or carry a May 2026 figure forward as if it were June. An unresolved
token is a blocker, not a rounding problem.

**Voice** — narrator's rules apply: declarative, no hedging, **bold every
number**, captions ≤ 22 words. The stylist renders prose verbatim and authors no
CSS; it references the existing `role: "shared-css"` theme via
`manifest.cssArtifactId`.

---

## 1. Resolve the inputs first

Query the catalogue for the `june-2026` vintage across the five subjects
(`M3 Manufacturing Analysis`, `M3 Forecasts`, `M3 STL Seasonal Adjustment`,
`Manufacturing Productivity Proxy`, `M3 Output Nowcast`). Build a token ledger
(§ 4) mapping each `{{token}}` to the artifact id and field it came from.

Report the ledger and **STOP** if any token is unresolved.

---

## 2. The narrative flow

Seven pages. For each: the page role, the chart it carries, and the draft prose.

---

### Page 1 — Cover

- type: `heading`
- role: `narrative`
- chart: the §3 annotated history chart, slot `cover-figure`

> # Manufacturing productivity, June 2026
>
> ## A nowcast from three methods, before the benchmark
>
> Reference month June 2026. Last observed month May 2026. Prepared
> {{compose_date}} from Census M3, Federal Reserve G.17, and BLS CES data.

---

### Page 2 — Why nowcast at all

- type: `text`
- role: `narrative`
- chart: none

> Official manufacturing productivity for June 2026 does not exist yet. The
> inputs arrive on staggered release schedules — M3 shipments land **two** months
> after the reference month, industrial production and CES labour data land
> **one** month after — and the benchmark productivity series lands later still.
> A decision that waits for the benchmark waits a quarter.
>
> This document estimates June 2026 ahead of that release, three ways, and states
> plainly where the three disagree. The methods are ordered by how much structure
> they impose: a seasonal decomposition of shipments alone; an accounting identity
> built from output and hours; and a regularised indicator panel trained on
> {{panel_predictor_count}} predictors. Each is a check on the others.
>
> The headline estimate is **{{headline_value}} {{headline_unit}}**, from
> {{headline_method}}, with an 80% prediction interval of **{{headline_pi80_low}}
> to {{headline_pi80_high}}**.

---

### Page 3 — The observed record

- type: `chart` + `text`
- role: `finding`
- chart: §3 annotated NSA history, slot `supporting-chart`
- caption: "NSA manufacturing shipments, January 2002 to May 2026, with 12-month moving average."

> Nominal manufacturing shipments, not seasonally adjusted, run from January 2002
> to May 2026 — **{{nsa_obs_count}}** monthly observations. May 2026 shipments were
> **{{nsa_may_2026}}** million dollars, **{{nsa_yoy_pct}}%** against May 2025.
>
> Two intervals are shaded because they break the series' ordinary behaviour. The
> COVID collapse of April to June 2020 is a genuine outlier in level and variance;
> any model fit through it without acknowledgement will mis-state its own
> uncertainty. From January 2026 the Census M3 seasonal-adjustment freeze applies:
> published SA factors are held fixed through at least December 2026, so
> published SA shipments are not a clean signal for this reference month. This
> document therefore uses NSA shipments throughout and adjusts them itself.

**Callout:** `{{nsa_yoy_pct}}%` — "Year-over-year change, May 2026"

---

### Page 4 — Removing the season

- type: `chart` + `text`
- role: `finding`
- chart: §4 STL chart, slot `supporting-chart`
- caption: "STL decomposition: observed, trend, and seasonally adjusted shipments with June 2026 forecast."

> Manufacturing shipments carry a strong and stable annual pattern. Robust STL
> with a 12-month period separates it: seasonal strength is
> **{{stl_seasonal_strength}}**, trend strength **{{stl_trend_strength}}**. The
> residual-seasonality test returns **{{stl_residual_test}}**, confirming the
> decomposition left no exploitable seasonal signal behind.
>
> Extending the trend and seasonal components gives a June 2026 seasonally
> adjusted figure of **{{stl_point}}** million dollars, with an 80% prediction
> interval of **{{stl_pi80_low}} to {{stl_pi80_high}}** and a 95% interval of
> **{{stl_pi95_low}} to {{stl_pi95_high}}**.
>
> This is an output-proxy forecast, not a productivity forecast. It uses shipments
> alone: no deflator, no labour input. It belongs here as the baseline the other
> two methods must beat.

---

### Page 5 — From output to productivity

- type: `chart` + `text`
- role: `finding`
- chart: productivity-proxy history, slot `comparison-chart`
- caption: "Monthly productivity proxy: real output per aggregate hour, {{prod_start}} to May 2026."

> Productivity requires a denominator. The proxy is built in three steps:
> shipments deflated to real output, employment multiplied by average weekly hours
> to give aggregate hours, and the ratio taken.
>
> ```
> real output     = M3 shipments / {{deflator_name}}
> aggregate hours = CES employment × CES average weekly hours
> productivity    = real output / aggregate hours
> ```
>
> Each step imports its own assumption. The deflator is
> **{{deflator_name}}**, a proxy for manufacturing output prices rather than a
> matched deflator. Aggregate hours from the CES establishment survey count paid
> hours, not hours worked. The result is a defensible monthly indicator of
> direction; it is not the official productivity statistic and will not match it
> level for level.
>
> On this basis May 2026 productivity was **{{prod_may_2026}}
> {{prod_unit}}**. The lagged baseline puts June 2026 at **{{prod_point}}**, 80%
> interval **{{prod_pi80_low}} to {{prod_pi80_high}}**, from rolling-origin
> backtests over **{{prod_backtest_n}}** origins.

---

### Page 6 — The indicator panel

- type: `chart` + `text`
- role: `finding`
- chart: §6 nowcast chart, slot `primary-chart`
- caption: "June 2026 nowcast against recent history, with 80% and 95% prediction intervals."

> The third method follows the Meyer & Martinez (2017) lineage: assemble every
> indicator known by the cutoff month, then let regularised regression decide
> which ones carry signal. The panel holds **{{panel_predictor_count}}** predictors
> across M3 orders and shipments, industrial production, producer prices, and CES
> labour series, plus regime flags for the 2020 COVID quarter and the M3 SA
> freeze.
>
> **{{panel_candidate_count}}** estimators competed under
> {{panel_cv_scheme}}. The winner is **{{panel_winner}}**
> ({{panel_winner_params}}), at RMSE **{{panel_winner_rmse}}** against
> **{{panel_naive_rmse}}** for the naive year-ago benchmark — an improvement of
> **{{panel_rmse_improvement_pct}}%**. {{panel_excluded_note}}
>
> The June 2026 nowcast is **{{panel_point}} {{panel_unit}}**, 80% interval
> **{{panel_pi80_low}} to {{panel_pi80_high}}**, 95% interval
> **{{panel_pi95_low}} to {{panel_pi95_high}}**. The heaviest-weighted predictors
> are {{panel_top_features}}.

**Callout:** `{{panel_point}}` — "June 2026 nowcast, {{panel_winner}}"

---

### Page 7 — Where the methods agree, and the caveats

- type: `text`
- role: `narrative`
- chart: optional three-estimate comparison, slot `comparison-chart`

> Three estimates, one month:
>
> | Method | June 2026 | 80% interval | Basis |
> |---|---|---|---|
> | STL output proxy | **{{stl_point}}** | {{stl_pi80_low}}–{{stl_pi80_high}} | Shipments only |
> | Lagged productivity baseline | **{{prod_point}}** | {{prod_pi80_low}}–{{prod_pi80_high}} | Output ÷ hours identity |
> | Indicator panel | **{{panel_point}}** | {{panel_pi80_low}}–{{panel_pi80_high}} | {{panel_predictor_count}} predictors, {{panel_winner}} |
>
> {{reconciliation_paragraph}}
>
> The headline is **{{headline_method}}**, because {{headline_rationale}}.
> Against the May 2026 vintage of this same lineage, {{vintage_comparison}}.
>
> ### What would change these numbers
>
> - **The M3 SA freeze.** Published seasonal factors are fixed from January 2026
>   through at least December 2026. Self-adjusted NSA data carries the freeze as a
>   modelling choice, not a resolved fact.
> - **COVID outliers.** April to June 2020 is flagged, not deleted. Prediction
>   intervals widen accordingly.
> - **Employment data currency.** CES manufacturing employment sets the common
>   latest month for the productivity identity: as of this document,
>   **{{employment_latest_month}}**. It is fetched on the same schedule as the
>   other indicators; if it lags, the productivity estimate is stale rather than
>   wrong.
> - **The deflator is a proxy.** {{deflator_name}} stands in for a matched output
>   deflator.
> - **Intervals are backtest-derived.** They price in historical forecast error,
>   not structural breaks that have not happened yet.
> - **Revisions.** M3 and CES both revise. A June figure re-fetched in the autumn
>   will differ.

---

## 3. Delegation order

1. **Narrator** — hand it the resolved token ledger plus the model cards from
   §4, §5, §6 and the caveats. It emits the seven `role: "section"` artifacts and
   one `role: "chart-briefs"` JSON. Prose above is a draft: the narrator may
   tighten it, but may not change a resolved number or drop a caveat.
2. **Coder** — only if Page 7's three-estimate comparison chart is wanted. Every
   other chart already exists from the June run; reuse those artifact ids. Data
   must be embedded inline.
3. **Stylist** — reads the outline and the theme, emits seven `role: "page"`
   artifacts and the manifest. Charts load by `<iframe>`; prose renders verbatim.

Before delegating to the stylist, write a `role: "document-outline"` head for
subject `M3 Output Nowcast` with `status: ready-to-compose`, the seven sections
in order with their types and `artifactId`s, and `audience` / `theme` filled.
Ask me for `audience` and `theme` if they are unset.

---

## 4. Token ledger

Report this table before composing. Every row must resolve.

| Token group | Source |
|---|---|
| `nsa_*` | §2/§3 shipments CSV + dataset-meta |
| `stl_*` | §4 statistical-analysis JSON |
| `prod_*`, `deflator_name` | §5 statistical-analysis JSON |
| `panel_*` | §6 model card + leaderboard |
| `headline_*`, `reconciliation_paragraph`, `vintage_comparison`, `*_rationale` | §7 reconciliation |
| `employment_latest_month` | §1 refresh summary |
| `compose_date` | today |

`{{reconciliation_paragraph}}`, `{{headline_rationale}}`,
`{{vintage_comparison}}` and `{{panel_excluded_note}}` are prose, not numbers —
the narrator writes them from the §7 analysis. They must still cite figures that
appear in the table above.

---

## 5. Validation and gate

Before presenting: every page renders; every chart iframe returns 200; no
console errors; no `{{token}}` survives in any page; the three interval pairs are
internally consistent (95% wider than 80%); each page carries its
`<meta name="dva-page">` tag.

Then present the pending tree, the manifest id, and the `/ui/doc/<manifestId>`
link. **STOP.** Do not persist until I say "save". File under category
`Economics`, subject `M3 Output Nowcast`, tags
`["nowcast","productivity","m3","report","june-2026"]`, collection intent
`executive-briefing` with the slots assigned above.
