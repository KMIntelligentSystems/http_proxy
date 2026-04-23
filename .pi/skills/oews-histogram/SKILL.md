---
name: oews-histogram
description: Build a probability-density histogram from BLS OEWS data. Detect the correct wage-interval schema for the survey year, compute bin densities, and render a variable-width, gap-free D3.js histogram where bar area represents true probability.
---

# OEWS Wage Interval Histogram Skill

This skill guides an agent through building a histogram of Occupational Employment
and Wage Statistics (OEWS) wage distributions. It explains how to locate the
correct wage-interval table for a survey year, transform employment into
probability density, and render a variable-width histogram in D3.js.

## 1. Identify the Wage-Interval Schema

OEWS updates its wage intervals periodically. Always confirm which schema applies
before computing bins.

### Look up the Methodology PDF

Fetch the year-specific methodology PDF from BLS. If direct access is blocked,
proxy via `https://r.jina.ai/https://www.bls.gov/oes/methods_YY.pdf`.

| Survey panels covered | Methodology PDF | Interval summary |
|-----------------------|-----------------|-------dev:-----------|
| **Nov 2021 – May 2024** | `methods_24.pdf` | 12 ranges A–L, Range A **< $9.25**, Range L **$115+**. [^2024]
| **Nov 2013 – May 2021** | `methods_17.pdf` | Same A–L structure, Range B **$9.25–$11.74**, Range L **$100+**. [^2017]
| **Nov 2011 – May 2013** | `methods_14.pdf` | Prior table with Range B **$9.25–$11.49**, Range L **$100+**. [^2014]
| **Nov 2007 – May 2010** | `methods_10.pdf` | Matches the Nov 2011–May 2013 table (Range B to $11.49$). [^2010]
| **Nov 2003 – May 2006** | `methods_06.pdf` | Earlier table, Range A **< $7.50**, Range L **$80+**. [^2006]

> Need a different year? Download the corresponding `methods_YY.pdf` and search
> for the section headed “wage intervals” or “wage ranges.”

### Define Bin Edges

Convert the table into an ordered array of edges. Each bin spans `[edge[i], edge[i+1])`
(except the last, which is open-ended). Example for the 2021–2024 schema:

```js
const EDGES = [0, 9.25, 12.00, 15.50, 19.75, 25.50, 32.75, 42.00, 54.00, 69.50, 89.50, 115.00, 140];
```

Store metadata `{ range: 'A', lo, hi, label, years }` so the UI can switch schemas
when the user selects another survey vintage.

## 2. Aggregate Employment by Interval

1. **Filter detailed occupations:** `o.o_group === 'detailed'` and
   `o.metrics.H_MEAN?.value != null`.
2. **Assign bins:** for each occupation, find the interval containing `H_MEAN`.
   Treat the last bin as `[lo, ∞)`.
3. **Aggregate per bin:** sum `TOT_EMP` (employment_total) and count occupations
   (wage_count).
4. **Probability mass & density:**

```js
const totalEmp = bins.reduce((sum, bin) => sum + bin.employment_total, 0);

bins.forEach(bin => {
  const mass = bin.employment_total / totalEmp;  // probability mass
  bin.mass = mass;
  bin.pdf = mass / bin.width;                    // density = mass ÷ dollar width
});
// Verification: Σ (bin.pdf * bin.width) ≈ 1
```

Keep both `mass` (for percent-of-total) and `pdf` (for bar height).

## 3. Render the Histogram in D3.js

* **X-scale:** `d3.scaleLinear()` with domain `[minEdge, maxEdgeCap]` guarantees
  bar widths reflect interval widths.
* **Bars:**

```js
g.selectAll('rect').data(bins).join('rect')
  .attr('x', d => x(d.lo))
  .attr('width', d => x(d.hi) - x(d.lo))
  .attr('y', d => y(d.pdf))
  .attr('height', d => innerHeight - y(d.pdf));
```

* **Axes:**
  * X-axis ticks at the bin edges (`EDGES`). Rotate labels for readability.
  * Y-axis label `PROBABILITY DENSITY`; format ticks with `d3.format('.3f')`.
* **Tooltips:** show range letter, wage span, bin width, occupation count,
  employment, % of total (`mass`), and density (`pdf`).
* **Highlight (optional):** draw a dashed line at the selected occupation’s
  `H_MEAN` and tint its bin (e.g., gradient shift or green fill).

See `src/ui/oe-drilldown.html` (`renderHistogram`) for a working reference.

## 4. Checklist

- [ ] Correct wage-interval schema for the chosen survey vintage
- [ ] Linear x-scale; bars touch with no padding
- [ ] Density computed as `mass / width`; area under bars ≈ 1
- [ ] Tooltip/legend cite the survey year and interval table
- [ ] Occupation highlight aligns with its `H_MEAN`
- [ ] Axis labels and units (hourly dollars on x, density on y)

## References

[^2024]: *Occupational Employment and Wage Statistics May 2024 Survey Methods*,
         Table 1, https://r.jina.ai/https://www.bls.gov/oes/methods_24.pdf

[^2017]: *Survey Methods and Reliability Statement for the May 2017 OES Survey*,
         wage-interval table (p. 5), https://r.jina.ai/https://www.bls.gov/oes/methods_17.pdf

[^2014]: *Survey Methods and Reliability Statement for the May 2014 OES Survey*,
         historic wage-interval tables (pp. 4–5), https://r.jina.ai/https://www.bls.gov/oes/methods_14.pdf

[^2010]: *Survey Methods and Reliability Statement for the May 2010 OES Survey*,
         wage-interval table (p. 4), https://r.jina.ai/https://www.bls.gov/oes/methods_10.pdf

[^2006]: *Appendix B. Survey Methods and Reliability Statement for the May 2006 OES Survey*,
         wage-interval table (p. 4), https://r.jina.ai/https://www.bls.gov/oes/methods_06.pdf
