---
name: seasonal-adjustment
description: "Seasonally adjust a monthly (or quarterly) economic time series. Two engines: STL (statsmodels, pure-Python, robust default) and X-13ARIMA-SEATS (Census reference implementation, via statsmodels.tsa.x13 wrapper around the local x13as.exe binary). Use when the source's published SA is stale, frozen, or unavailable - notably during the M3 SA freeze (Jan 2026 → at least Dec 2026)."
---

# Seasonal Adjustment Skill

This skill produces an own-SA estimate of a monthly economic series.
It is needed whenever the source's published SA cannot be trusted -
the M3 SA-model freeze for 2026 is the proximate cause.

Two engines are supported:

1. **STL** (Seasonal-Trend decomposition using Loess) - pure-Python,
   no external binary, robust to outliers, transparent.
2. **X-13ARIMA-SEATS** - the Census Bureau's reference implementation
   (`x13as.exe`). Matches the methodology Census uses on M3 itself.
   Authoritative; the right choice when we want our SA to be
   comparable in *kind* to the frozen published series.

Use STL for quick exploratory work; use X-13 for any analysis we
will publish or compare against Census.

---

## 1. Local install - verified

The X-13 binary is already installed on this machine:

```
C:\Program Files\x13as\
├── x13as.exe                      # the binary
├── libgcc_s_seh-1.dll
├── libgfortran-5.dll
├── libquadmath-0.dll
└── docs\
    ├── docx13as.pdf               # reference manual (~300 pp)
    └── qrefx13aspc.pdf            # quick reference
```

The `statsmodels` wrapper (`statsmodels.tsa.x13.x13_arima_analysis`)
shells out to this binary. For the wrapper to find it, set:

```
X13PATH=C:/Program Files/x13as
```

(or pass `x12path="C:/Program Files/x13as"` as a kwarg - yes, the
kwarg is misnamed `x12path` for historical reasons; the wrapper
works with X-13 too).

`statsmodels` itself is **not yet installed** in the project venv
(see MEMORY.md). Before first use:

```bash
C:/repos/codeGen-mcp-server/venv/Scripts/python.exe -m pip install statsmodels
```

---

## 2. When to use which engine

| Situation | Engine | Why |
|-----------|--------|-----|
| Quick look during exploration | STL | No setup, fast, robust to outliers |
| The series has obvious calendar effects (trading days, Easter) | X-13 | regARIMA pre-adjustment for calendar |
| The series has known outliers (COVID 2020-Q2) | X-13 | Automatic outlier detection (AO, LS, TC) |
| We need to compare against Census's frozen-SA M3 number | X-13 | Same methodology family |
| The series is short (< 5 years monthly) | STL | X-13 needs a stable ARIMA fit; short series → unreliable |
| We want to publish the SA series with a defensible method statement | X-13 | Standard, citable |

---

## 3. STL recipe

```python
# write to a temp file, run via bash; see statistician.md §3 for why
import pandas as pd
from statsmodels.tsa.seasonal import STL

# df: DataFrame with monthly DatetimeIndex, one value column
y = df["value"].asfreq("MS")
stl = STL(y, period=12, robust=True).fit()

result = pd.DataFrame({
    "date": y.index.strftime("%Y-%m-%d"),
    "observed": y.values,
    "trend": stl.trend.values,
    "seasonal": stl.seasonal.values,
    "resid": stl.resid.values,
    "sa": (y - stl.seasonal).values,   # SA = observed - seasonal
})
result.to_csv("stl_out.csv", index=False)

# JSON for the orchestrator (no \n in print)
import json
print(json.dumps({
    "engine": "STL",
    "n_obs": int(len(y)),
    "seasonal_strength": float(1 - stl.resid.var() / (stl.resid + stl.seasonal).var()),
    "trend_strength":    float(1 - stl.resid.var() / (stl.resid + stl.trend).var()),
}))
```

Key knobs:

- `period=12` for monthly, `4` for quarterly.
- `robust=True` downweights outliers using bisquare weights - turn on
  for any series spanning 2020.
- `seasonal=13` (default) is fine; raise it for smoother seasonal
  patterns when seasonality drifts over a decade.

---

## 4. X-13ARIMA-SEATS recipe

Two passes - automatic and explicit - depending on how much control
we want.

### 4a. Automatic (recommended for first run on a new series)

```python
import os
os.environ["X13PATH"] = "C:/Program Files/x13as"

import pandas as pd
from statsmodels.tsa.x13 import x13_arima_analysis

y = df["value"].asfreq("MS")
res = x13_arima_analysis(
    y,
    x12path="C:/Program Files/x13as",   # historical kwarg name; works with X-13
    outlier=True,
    trading=True,
    log=True,           # multiplicative decomposition; set False for additive
)

# res has: observed, seasadj, trend, irregular, results (raw X-13 spc text)
res.plot()   # diagnostic plot

sa = res.seasadj
sa.to_csv("x13_sa.csv")

import json
print(json.dumps({
    "engine": "X-13ARIMA-SEATS",
    "n_obs": int(len(y)),
    "outliers": [str(s) for s in res.results.splitlines() if "Outlier" in s][:10],
}))
```

### 4b. Explicit `.spc` (when we need a specific ARIMA model or
specific outlier handling - e.g., forcing an AO at 2020-04)

Build an X-13 `.spc` file directly and call `x13as.exe`. The full
spec syntax is in `C:\Program Files\x13as\docs\docx13as.pdf`.
Bookmark §7 ("regression spec") and §11 ("seats spec"). Common
specs we'll need:

```
series  { file="series.dat"  period=12  start=2002.1 }
transform { function=log }
regression { variables = (ao2020.apr td easter[8]) }
arima { model = (0 1 1)(0 1 1) }
outlier { types = (ao ls) critical=4.0 }
seats { }
```

Run with:

```bash
"C:/Program Files/x13as/x13as.exe" myspec.spc
```

X-13 writes `myspec.out` (text report) and `myspec.d11` (the SA
series). Parse `.d11` back into Python with `pandas.read_csv` on a
fixed-width or whitespace-delimited read.

---

## 5. Diagnostics to report (both engines)

| Metric | Interpretation | Both / X-13 only |
|--------|----------------|------------------|
| Seasonal F (Q-stat) | Stability of seasonal factor; > 1.0 = unstable | X-13 only |
| Sliding-spans test | Revision stability over rolling windows | X-13 only |
| Residual seasonality (Friedman / KW test) | Did SA actually remove seasonality? | Both |
| Seasonal strength (1 - var(resid)/var(resid+seas)) | 0..1; > 0.6 = strong | Both |
| Trend strength | 0..1; > 0.6 = strong | Both |
| Outliers detected | List of AO/LS/TC dates | X-13 only |

Always include the residual-seasonality test in the report. An SA
that still has seasonality is worse than the NSA original.

---

## 6. M3 SA-freeze use case (the immediate motivator)

The Census M3 SA is frozen through end-2026. To produce our own SA
of an M3 series:

1. **Fetch NSA M3 from the Census M3 EITS API.** FRED does not mirror
   NSA for most M3 series. See `data/lookups/m3_series.json` for the
   correct `category_code` + `data_type_code` per series, and see
   `MEMORY.md` §"Census M3 EITS API" for query format and gotchas.

   Working fetch example (Total Mfg Shipments, NSA, one year):
   ```
   GET https://api.census.gov/data/timeseries/eits/m3
     ?get=cell_value,data_type_code,time_slot_id,seasonally_adj,category_code
     &for=us:*
     &category_code=MTM
     &data_type_code=VS
     &seasonally_adj=no
     &time=2024
     &key={CENSUS_API_KEY}
   ```
   Returns 12 monthly rows. Loop over years for the full history.

   **Key gotchas:** `for=us:*` is mandatory (400 without it);
   response has duplicate columns (time is at index 8); HTTP 204
   means no data (check before JSON parse).

   Pre-fetched file: `data/m3_total_mfg_shipments_nsa.csv`
   (291 obs, Jan 2002–Mar 2026).

2. Run X-13 (§4a) on the NSA history through end-2025 to fit the
   model — this matches the freeze cutoff and uses only “live”
   methodology.
3. Apply the frozen model to NSA data 2026-01 onwards: pass
   `forecast_years=0`, `maxiter=0` on a refresh, or in `.spc` use
   `seats { save = (s11) noadmiss = yes }` with the prior model’s
   ARIMA coefficients fixed.
4. Report both our SA and the frozen Census SA on the same chart,
   with the divergence shaded. This is itself a publishable artifact.

---

## 7. Output contract for the statistician

When this skill is invoked, emit:

| Artifact | Role | Contents |
|----------|------|----------|
| `sa_series.csv` | `dataset-csv` | date, observed, trend, seasonal, sa, resid |
| `sa_diagnostics.json` | `statistical-analysis` | engine, n_obs, strengths, residual-seasonality test, outliers |
| `sa_analysis.md` | `statistical-analysis` | Markdown report per statistician §4a |
| `sa_spc.txt` *(X-13 only, optional)* | `text/plain` | The `.spc` used, for reproducibility |

---

## 8. References

- U.S. Census Bureau, *X-13ARIMA-SEATS Reference Manual* (PDF),
  installed locally at `C:/Program Files/x13as/docs/docx13as.pdf`.
  Primary authority for the X-13 path.
- Cleveland, Cleveland, McRae & Terpenning (1990), *STL: A
  seasonal-trend decomposition procedure based on Loess.*
  `J. Off. Stat.` 6(1), 3-73. Primary reference for STL.
- `statsmodels` docs:
  <https://www.statsmodels.org/stable/generated/statsmodels.tsa.x13.x13_arima_analysis.html>
  and
  <https://www.statsmodels.org/stable/generated/statsmodels.tsa.seasonal.STL.html>.
