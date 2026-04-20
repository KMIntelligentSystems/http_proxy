---
name: oews-histogram
description: Build a probability density histogram from BLS OEWS data using the 12 official wage intervals (Ranges A–L). Renders a variable-width, gap-free D3.js histogram where bar area represents true probability.
---

# OEWS Wage Interval Histogram

Build a histogram of occupational wage distribution using the 12 wage intervals
defined by the BLS Occupational Employment and Wage Statistics (OEWS) survey.
The y-axis shows **probability density** (PDF) so that bar **area** — not
height — represents the share of employment in each interval.

## The 12 OEWS Wage Intervals

The OEWS survey classifies wages into 12 intervals. These are **unequal width**
— narrow at the low end, wide at the top. A correct histogram must reflect
this by making bar widths proportional to the dollar range.

| Range | Hourly            | Annual                | Bin Width |
|-------|-------------------|-----------------------|-----------|
| A     | Under $9.25       | Under $19,240         | $9.25     |
| B     | $9.25 – $11.99    | $19,240 – $24,959     | $2.75     |
| C     | $12.00 – $15.49   | $24,960 – $32,239     | $3.50     |
| D     | $15.50 – $19.74   | $32,240 – $41,079     | $4.25     |
| E     | $19.75 – $25.49   | $41,080 – $53,039     | $5.75     |
| F     | $25.50 – $32.74   | $53,040 – $68,119     | $7.25     |
| G     | $32.75 – $41.99   | $68,120 – $87,359     | $9.25     |
| H     | $42.00 – $53.99   | $87,360 – $112,319    | $12.00    |
| I     | $54.00 – $69.49   | $112,320 – $144,559   | $15.50    |
| J     | $69.50 – $89.49   | $144,560 – $186,159   | $20.00    |
| K     | $89.50 – $114.99  | $186,160 – $239,199   | $25.50    |
| L     | $115.00 and over  | $239,200 and over     | open      |

## Bin Edges

Use a continuous edge array so bins are contiguous with **no gaps**:

```
[0, 9.25, 12.00, 15.50, 19.75, 25.50, 32.75, 42.00, 54.00, 69.50, 89.50, 115.00]
```

Each bin spans `[edges[i], edges[i+1])`. The last bin (L) is open-ended;
cap it at a display value (e.g. 140) for rendering purposes.

## Data Pipeline

### 1. Load OEWS Data

Use the preprocessed JSON at `dist/oe_national_2024.json` served from
`/ui/data/oe_national_2024.json`. Structure:

```json
{
  "metadata": { ... },
  "metric_catalog": [ { "key": "H_MEAN", "datatype": "03", "format": "dollar" }, ... ],
  "occupations": [
    {
      "occ_code": "15-1252",
      "occ_title": "Software Developers",
      "o_group": "detailed",
      "metrics": {
        "H_MEAN": { "value": 69.50, "datatype": "03" },
        "TOT_EMP": { "value": 1654440, "datatype": "01" },
        ...
      },
      "stencil": { ... }
    }
  ]
}
```

### 2. Filter Occupations

Use **detailed-level** occupations (`o_group === 'detailed'`) with a valid
`H_MEAN` value. This matches the BLS methodology — major/minor/broad groups
are aggregates and must not be double-counted.

```js
const occs = DATA.occupations.filter(
  o => o.o_group === 'detailed' && o.metrics.H_MEAN?.value != null
);
```

### 3. Bin Assignment

For each occupation, assign it to the interval where its `H_MEAN` falls:

```js
const EDGES = [0, 9.25, 12.00, 15.50, 19.75, 25.50, 32.75, 42.00, 54.00, 69.50, 89.50, 115.00, 140];

bins = EDGES.slice(0, -1).map((lo, i) => {
  const hi = EDGES[i + 1];
  const isLast = i === EDGES.length - 2;
  const matches = occs.filter(o => {
    const v = o.metrics.H_MEAN.value;
    return v >= lo && (isLast ? true : v < hi);  // [lo, hi) except last bin [lo, ∞)
  });
  const empTotal = matches.reduce((s, o) => s + (o.metrics.TOT_EMP?.value || 0), 0);
  const binWidth = hi - lo;
  return { lo, hi, isLast, binWidth, empTotal, occCount: matches.length };
});
```

### 4. Compute PDF (Probability Density)

The PDF value for each bin is the **proportion of employment divided by the
bin width** in dollars. This ensures the area under the histogram sums to 1.

```js
const totalEmp = DATA.occupations.find(o => o.occ_code === '00-0000')?.metrics.TOT_EMP?.value;
const totalInBins = bins.reduce((s, b) => s + b.empTotal, 0);

bins.forEach(b => {
  const proportion = b.empTotal / totalInBins;  // fraction of employment in this bin
  b.pdf = proportion / b.binWidth;              // density = proportion / width
});
```

**Why divide by bin width?** In a true probability density histogram, the
**area** of each bar (density × width) equals the probability. Without this
normalization, wide bins appear inflated relative to narrow bins. The density
formula corrects for unequal bin widths so the visual representation is honest.

**Verification:** `Σ (pdf_i × binWidth_i) ≈ 1.0` for all bins.

## Rendering with D3.js

### Critical: Use a Linear X-Scale

Do **not** use `d3.scaleBand()` — that creates equal-width bars. Use
`d3.scaleLinear()` mapping dollar values to pixel positions:

```js
const x = d3.scaleLinear()
  .domain([EDGES[0], EDGES[EDGES.length - 1]])
  .range([0, innerWidth]);
```

Each bar is positioned and sized by its actual dollar boundaries:

```js
g.selectAll('rect').data(bins).join('rect')
  .attr('x',      d => x(d.lo))
  .attr('width',   d => x(d.hi) - x(d.lo))   // proportional to interval width
  .attr('y',      d => y(d.pdf))
  .attr('height', d => innerHeight - y(d.pdf));
```

### No Gaps Between Bars

Bars must be **contiguous** — this is a histogram, not a bar chart. The right
edge of bin i is the left edge of bin i+1. Do not add padding or border-radius
that creates visual gaps. A thin stroke (`0.5px`) at the surface color is
acceptable to delineate adjacent bars.

### X-Axis Ticks

Place tick marks at each bin edge, labeled with the dollar value:

```js
d3.axisBottom(x)
  .tickValues(EDGES)
  .tickFormat(d => d === EDGES[EDGES.length - 1] ? '' : '$' + d)
```

### Y-Axis

Label the y-axis **PROBABILITY DENSITY**. Format tick values to 3 decimal
places (`d3.format('.3f')`).

### Range Letters

Optionally render the range letter (A–L) inside each bar near the baseline
for quick identification. Only show if the bar is wide enough in pixels.

### Occupation Marker

When a specific occupation is selected, draw a vertical dashed line at its
exact `H_MEAN` value on the x-axis, with a label showing the dollar amount
and which range it falls in. Highlight that bar in a contrasting color (e.g.
green).

## Example Output (2024 Data)

| Range | Bin Width | Occ Count | Employment   | % Emp  | PDF Density |
|-------|-----------|-----------|--------------|--------|-------------|
| A     | $9.25     | 1         | 252,690      | 0.17%  | 0.0002      |
| B     | $2.75     | 2         | 168,380      | 0.12%  | 0.0004      |
| C     | $3.50     | 14        | 7,748,450    | 5.29%  | 0.0151      |
| D     | $4.25     | 22        | 16,307,720   | 11.14% | 0.0262      |
| E     | $5.75     | 121       | 31,534,020   | 21.54% | 0.0375      |
| F     | $7.25     | 179       | 32,610,860   | 22.28% | 0.0307      |
| G     | $9.25     | 140       | 18,211,270   | 12.44% | 0.0134      |
| H     | $12.00    | 109       | 15,282,710   | 10.44% | 0.0087      |
| I     | $15.50    | 84        | 14,573,370   | 9.96%  | 0.0064      |
| J     | $20.00    | 48        | 5,535,790    | 3.78%  | 0.0019      |
| K     | $25.50    | 8         | 922,230      | 0.63%  | 0.0002      |
| L     | $25.00*   | 44        | 3,285,120    | 2.24%  | 0.0009      |

*L display width is capped at $25 ($115–$140) for rendering; actual bin is open-ended.

## Styling (Dark Theme)

```css
--bg: #0c0f13;
--surface: #13171d;
--accent: #6eaaff;         /* default bar gradient */
--green: #4ade80;          /* selected occupation highlight */
--text-dim: #636d7e;       /* axis labels, ticks */
--mono: 'Geist Mono', 'Consolas', monospace;
```

Bar fill: vertical linear gradient from `accent` at 90% opacity (top) to 45%
opacity (bottom). Grid lines at `rgba(255,255,255,.04)`.

## Checklist

- [ ] 12 bins matching OEWS Ranges A–L
- [ ] Linear x-scale (not band scale)
- [ ] Bar widths proportional to dollar range of each interval
- [ ] No gaps between bars
- [ ] Y-axis is probability density (proportion / bin_width)
- [ ] Area under histogram sums to ≈ 1.0
- [ ] X-axis ticks at bin edges with dollar labels
- [ ] Filter to detailed-level occupations only
- [ ] Use `H_MEAN` (hourly mean wage) for bin assignment
- [ ] Weight by `TOT_EMP` (total employment) for proportions
- [ ] Tooltip with range, bin width, count, employment, percentage
- [ ] Optional: occupation marker line at selected H_MEAN value

## Reference Implementation

See `src/ui/oe-drilldown.html` — search for `HIST_EDGES` and
`renderHistogram()` for the working D3.js implementation.
