# BLS Statistical Visualization Platform — Plan

## Vision

Extend the OEWS National Drilldown into a general-purpose BLS data visualization
platform that combines interactive exploration with embedded statistical validation.
The PQDE vs KDE comparison is the proof-of-concept — demonstrating that interval-
censored survey data can be reconstructed with fidelity comparable to point data.

---

## 1. Current State (OEWS May 2024)

### Delivered
- **Wage Interval Histogram** — variable-width, gap-free, PDF/employment/count modes
- **PQDE Overlay** — O'Malley piecewise quadratic density estimator from binned proportions
- **KDE Overlay** — employment-weighted Gaussian kernel density from H_MEAN point data
- **Statistical Comparison Panel** — mean, std, percentiles (P10–P90), ISE, Hellinger distance
- **Box Plot** — annual percentile distribution with national median reference
- **BLS API Integration** — time series fetch, cache, metric pills

### What the KDE Comparison Proves
The O'Malley paper (JSM 2008 §3.1) showed that PQDE estimates from interval-censored
data are "virtually identical" to estimates from point data. Our implementation confirms
this on *real* May 2024 national data:

| Metric | PQDE | KDE | Δ |
|--------|------|-----|---|
| Mean | $32.09 | $32.34 | $0.25 (0.8%) |
| P50 | $24.78 | $26.60 | $1.82 (6.8%) |
| P90 | $58.80 | $59.29 | $0.49 (0.8%) |
| ISE | — | — | 2.56e-3 |
| Hellinger | — | — | 0.172 |

The largest deviation is at the median (P50), explained by the PQDE's sensitivity to
the peak bin vs the KDE's smoothing. All other metrics agree to within 1%.

---

## 2. Expanding Statistical Techniques

### 2.1 Bin-Width Validation (OEWS-specific)

**Why the bins are the sizes they are** — The 2024 OEWS wage intervals (A–L) are *not*
equal width. They are set so that the maximum relative error of observations within
each interval is approximately equal (O'Malley §1.2). This is a deliberate design choice
by BLS to balance information content across the wage distribution.

| Technique | Purpose | Implementation |
|-----------|---------|----------------|
| **Relative Error Analysis** | Show max relative error per bin (bin_width / midpoint) | Add a "Bin Quality" mode showing error bars |
| **Information Content** | Shannon entropy per bin: -p·log(p) | Color-code bars by information density |
| **Bin Width vs Density** | Scatter: bin_width ~ density → verify wider bins have lower density | Small inset chart |
| **Sturges/Freedman-Diaconis** | Compare BLS bin count to "optimal" bin count from standard rules | Overlay reference lines |
| **Chi-squared Goodness of Fit** | Test histogram vs PQDE fit | Report χ² statistic and p-value |

### 2.2 Distribution Shape Analysis

| Technique | Purpose | Implementation |
|-----------|---------|----------------|
| **Skewness & Kurtosis** | Quantify asymmetry and tail weight from PQDE moments | Add to stats panel |
| **Q-Q Plot** | PQDE quantiles vs lognormal theoretical quantiles | Inset panel below histogram |
| **Lognormal Fit** | Overlay a fitted LN(μ,σ) curve — O'Malley used LN(3.5,0.3) | Third curve option |
| **Bimodality Detection** | Dip test statistic; flag occupations with bimodal wages | Alert badge on histogram |
| **Kolmogorov-Smirnov** | PQDE CDF vs KDE CDF maximum divergence | Report D statistic |

### 2.3 Confidence and Uncertainty

| Technique | Purpose | Implementation |
|-----------|---------|----------------|
| **Bootstrap CI** | Resample occupation bins, refit PQDE 1000×, show 95% CI band | Shaded confidence band |
| **RSE Integration** | Use BLS-provided EMP_PRSE and MEAN_PRSE | Error bars on KPI cards |
| **Sensitivity to Bin Edges** | Shift edges ±5%, show PQDE variation | "Robustness" toggle |

---

## 3. Expanding to Other BLS Datasets

### 3.1 Dataset Roadmap

| Priority | Dataset | Source | Visualization | Statistical Techniques |
|----------|---------|--------|---------------|----------------------|
| **P0** | OEWS National (current) | `national_M2024_dl.xlsx` | Histogram + PQDE/KDE + box plot | All §2 techniques |
| **P1** | OEWS by Area | `state_M2024_dl.xlsx`, `MSA_M2024_dl.xlsx` | Choropleth + small-multiple histograms | Spatial autocorrelation, between-area variance |
| **P2** | OEWS by Industry | `nat_industry_M2024_dl.xlsx` | Stacked/faceted histograms by NAICS | Industry concentration (HHI), wage inequality (Gini) |
| **P3** | OEWS Time Series | BLS API (`OE` series) | Animated histogram evolution | Structural break detection, trend decomposition |
| **P4** | CPI / Inflation | BLS CPI series | Real wage adjustment overlay | Deflator application, purchasing power index |
| **P5** | QCEW (employment counts) | `CSVs from QCEW` | Employment heatmaps by area × industry | Location quotient, shift-share analysis |
| **P6** | CES (Current Employment) | BLS CES series | Payroll employment time series | Seasonal adjustment, Henderson trend-cycle |
| **P7** | JOLTS | BLS JT series | Job openings vs hires flow chart | Beveridge curve, matching efficiency |
| **P8** | NCS (compensation) | BLS ECI series | Total compensation breakdown | Benefits decomposition, cost index |

### 3.2 Architecture for Multi-Dataset Support

```
┌─────────────────────────────────────────────────────────────────┐
│                        Dataset Registry                          │
├─────────────────────────────────────────────────────────────────┤
│  {                                                               │
│    id: 'oews-national-2024',                                     │
│    name: 'OEWS National May 2024',                               │
│    source: '/data/oe_national_2024.json',                        │
│    schema: { intervals: EDGES_2024, ... },                       │
│    visualizations: ['histogram', 'boxplot', 'timeseries'],       │
│    statistics: ['pqde', 'kde', 'chi2', 'ks', 'moments'],        │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐    ┌─────────────────────┐
│  Data Pipeline       │    │  Stats Engine        │
│  • Load / cache      │───▶│  • PQDE fitter       │
│  • Transform         │    │  • KDE estimator     │
│  • Bin / aggregate   │    │  • Moment calculator  │
│  • Normalize         │    │  • Divergence metrics │
│                      │    │  • Bootstrap CI       │
└─────────────────────┘    └─────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Visualization Layer                            │
│  • Histogram (variable-width, density)                           │
│  • Box/violin plot                                               │
│  • Time series (line/area)                                       │
│  • Choropleth (geographic)                                       │
│  • Small multiples (faceted)                                     │
│  • Q-Q plot                                                      │
│  • Scatter                                                       │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 UI Evolution

**Phase 1: Dataset Selector** — Add a top-level dropdown/tab bar to switch between
loaded datasets. Each dataset brings its own schema, filter dimensions, and
applicable visualizations.

**Phase 2: Comparison Mode** — Side-by-side panels showing the same occupation's
wage distribution in two different contexts (e.g., national vs state, 2020 vs 2024).

**Phase 3: Statistical Dashboard** — A dedicated "Statistics" tab per dataset showing:
- Distribution diagnostics (moments, normality tests)
- Estimator comparison (PQDE vs KDE vs parametric fits)
- Temporal evolution metrics (if time series available)
- Data quality indicators (RSE, suppression rates, coverage)

---

## 4. The PQDE as a Validation Framework

The O'Malley PQDE is not just a visualization tool — it's a *validation framework*
for interval-censored survey data. The key insight:

> If the PQDE from binned data produces estimates virtually identical to
> those from point data, then the bin structure is capturing sufficient
> information for statistical inference.

This makes the PQDE/KDE comparison a **diagnostic tool** for any binned dataset:

1. **Bin adequacy** — If ISE and Hellinger are low, bins are well-sized
2. **Information loss** — If percentile Δ's are small, binning isn't destroying information
3. **Distribution shape** — If PQDE captures bimodality that KDE misses (or vice versa),
   it reveals which estimator is better suited to the data's structure

For new BLS datasets with interval structure (OEWS by area, industry, etc.), we can
apply the same PQDE → KDE → comparison pipeline to validate the bin schemas and
measure information loss from censoring.

---

## 5. Implementation Phases

| Phase | Scope | Timeline | Key Deliverables |
|-------|-------|----------|-----------------|
| **0 (done)** | PQDE + KDE overlay + stats panel | Delivered | Histogram with dual overlays, comparison table |
| **1** | Distribution diagnostics | Next | Moments, Q-Q plot, lognormal fit, χ² test |
| **2** | OEWS geographic expansion | After P1 | State/MSA data, small multiples, choropleth |
| **3** | Multi-dataset framework | After P2 | Dataset registry, pluggable schemas, CPI integration |
| **4** | Time series analytics | After P3 | Animated histograms, trend decomposition, structural breaks |
| **5** | Statistical dashboard | After P4 | Full diagnostic suite, export/reporting |

---

## References

- O'Malley, M. (2008). *Density Estimation for Censored Economic Data*. JSM 2008, Section on Survey Research Methods. pp. 1204–1211.
- BLS. *Occupational Employment and Wage Statistics Technical Notes*. https://www.bls.gov/oes/
- Silverman, B.W. (1986). *Density Estimation for Statistics and Data Analysis*. Chapman & Hall.
- Aitchison, J. & Brown, J.A.C. (1957). *The Lognormal Distribution*. Cambridge University Press.
