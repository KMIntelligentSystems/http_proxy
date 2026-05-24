---
name: regime-dummies
description: Detect and encode structural breaks (policy shocks, data-methodology changes, hiatuses) as covariates in time-series and regression models. Catalogs known breaks for the data sources this project uses. Status — STUB.
---

# Regime Dummies Skill — STUB

**Status:** stub — populate on first use.

Referenced by `industry-output-nowcast` (§2 feature engineering)
and by `seasonal-adjustment` (X-13 outlier handling). Centralizes
the project's catalog of known data regime breaks so each analysis
doesn't re-derive them.

## Intended contents (when populated)

1. **Catalog of known breaks** for the data sources this app uses:
   - **M3 SA-model freeze** — step dummy from 2026-01 onwards.
     Source: census.gov/manufacturing/m3.
   - **M3 Advance-report nondurable coverage expansion** — step
     dummy from 2025-07 onwards on nondurable Advance vintages.
   - **NAICS-2017 → NAICS-2022 revision** — affects ASM/CES level
     comparability; handle via concordance, not dummy.
   - **COVID 2020** — additive outliers 2020-04 through 2020-06,
     level shift 2020-03 in some series. Treat with X-13 AO/LS
     detection or robust loss.
   - **2018 trade-policy tariff shock** — narrative-only for most
     industries; spike in trade-exposed NAICS-3.
2. **Encoding recipes.**
   - Step dummy: `1 if date >= break, else 0`.
   - Pulse dummy: `1 if date == break, else 0`.
   - Trend-shift: `(date - break) * step_dummy`.
   - Holiday-style: passed to X-13's `regression` spec as user
     regressors when doing SA.
3. **Detection (for unknown breaks).** Bai-Perron test for unknown
   multiple breakpoints; CUSUM for sequential monitoring.
4. **Reporting.** Always disclose which dummies were active in the
   model fit (statistician §4a Caveats).

## References (to add when populated)

- Bai & Perron (2003), *Computation and analysis of multiple
  structural change models.* `J. Applied Econometrics` 18(1), 1-22.
- Census Bureau X-13ARIMA-SEATS docs §7 (regression spec) for the
  user-regressor encoding of step / pulse dummies in SA.
