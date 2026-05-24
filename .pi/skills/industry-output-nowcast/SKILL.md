---
name: industry-output-nowcast
description: Nowcast annual industry output (and downstream labor productivity) for U.S. manufacturing industries before the official benchmark release. Uses a panel of monthly indicator series and a menu of regularized linear and tree-based learners with leave-one-year-out cross-validation. Designed for predictor families known by mid-year: industrial production indexes, producer price indexes, manufacturers' shipments, imports and exports, and wages & employment.
---

# Industry-Output Nowcast Skill

This skill predicts **annual real industry output** for U.S.
manufacturing industries using monthly indicator data that arrives
**well before** the official ASM benchmark. Output is the slow input
into labor productivity (`productivity = output / hours`), so a
faster output number gives a faster preliminary productivity number.

The skill is **method-named**, not paper-named. It implements a
standard statistical-learning workflow for indicator-panel
nowcasting. References for further reading are in §10, but the
agent does not need them to operate the skill.

---

## 1. Target

- **Variable:** Δlog of real annual industry output, by NAICS-3
  manufacturing industry (and aggregate manufacturing).
- **Reference year `y`:** specified by the orchestrator.
- **Data cutoff `t`:** any month in year `y` (or month 12 of year
  `y-1` for a year-ahead forecast). Specified by the orchestrator.
- **Granularity:** one model per industry, or a pooled panel with
  industry fixed effects — both are supported (see §6).

---

## 2. Predictor families

Five families, all monthly, all available at cutoff `t`. Each entry
lists the source(s) the skill knows how to fetch.

| # | Family | Why it matters | Sources |
|---|--------|----------------|---------|
| 1 | **Industrial Production Indexes (IPI)** | Direct proxy for real output | FRED `IPMAN`, `IPGMFN` (NSA), `IPB50001N`; `MCUMFN` (capacity util) |
| 2 | **Producer Price Indexes (PPI)** | Convert nominal shipments → real output; capture price effects on margins | BLS `WPU*` (commodity), `PCU*` (industry NAICS) |
| 3 | **M3 shipments, orders, inventories** | Most timely nominal output proxy | FRED `AMTMVS`, `AMTMNO`, `AMTMTI`, `AMDMVS`, `ANXAVS`; Census M3 endpoint for NSA. See `data/lookups/m3_series.json` |
| 4 | **Imports & exports** | International demand shock; relevant for trade-exposed industries | Census USA Trade Online; BEA International Trade by NAICS |
| 5 | **Wages & employment** | Labor side of the production function; arrives ~3 wks after reference month | BLS CES supersectors 30/31/32, datatypes 01 (emp), 06 (AWE), 07 (AWH); BLS QCEW for annual back-checks |

Lagged values of the target itself (annual output for years
`y-1, y-2, ...`) are always included.

Feature-engineering rules:

- Work in **log differences** (or YoY growth for monthly indicators).
- For each monthly predictor at cutoff `t`, build:
  - Year-to-date mean / sum through month `t`.
  - 3-month and 12-month growth rates at month `t`.
  - One-period lags (month `t-1`).
- Add calendar covariates: trading-day count by month, Easter
  dummy. Skip if predictors are already trading-day-adjusted.
- Add regime dummies per the `regime-dummies` skill (M3 SA freeze
  ≥ 2026-01, COVID 2020-Q2, etc.).

---

## 3. Estimator menu

Fit all of these; the leaderboard decides per-industry.

| ID | Estimator | Why it's in the menu |
|----|-----------|----------------------|
| `naive_y_minus_1` | Last-year naïve (Δlog = 0) | Floor benchmark |
| `naive_yoy_trend` | Last-year Δlog repeated | Slightly less dumb floor |
| `ols` | OLS with full feature set | Baseline, no shrinkage |
| `stepwise_bic` | Forward stepwise, BIC | Sparse linear baseline |
| `ridge_cv` | `RidgeCV` (sklearn) | Shrinkage; handles collinearity |
| `lasso_cv` | `LassoCV` (sklearn) | Interpretable; gives a coefficient path |
| `enet_cv` | `ElasticNetCV` (sklearn) | Best of ridge + LASSO when predictors group |
| `rf` | `RandomForestRegressor`, 500 trees | Captures nonlinearity & interactions |
| `gbm` | `HistGradientBoostingRegressor` | Modern boosted-tree default |
| `stack` *(optional)* | Ridge over OOF predictions of 5–9 | Reduces variance further |

Choice of winner: lowest LOO-year RMSE (see §4).

---

## 4. Cross-validation

Use **leave-one-year-out** (LOO-year) CV: for each held-out year
`h ∈ {y-1, y-2, ..., y-N}`, train on the remaining `N-1` years and
score on `h`. Compute RMSE, MAE, MAPE, directional accuracy.

This matches the panel's annual cadence. For finer-grained checks
(e.g., does the model improve as more YTD months arrive?), pair
this with the `walk-forward-cv` skill across cutoffs `t = 1..12`.

Hyperparameters of regularized estimators are tuned by an **inner**
5-fold time-series CV on the training fold — never on the held-out
year.

---

## 5. Prediction intervals

Empirical residual distribution from LOO-year CV. For the chosen
estimator:

1. Collect all OOF residuals from §4.
2. 80% PI = point ± empirical quantile (0.10, 0.90) of residuals.
3. 95% PI = point ± empirical quantile (0.025, 0.975).

If residuals fail a basic normality check (Shapiro-Wilk p < 0.01)
or show heteroscedasticity by year, report the empirical interval
*and* a bootstrap interval (see `bootstrap-ci` skill).

---

## 6. Single-industry vs panel mode

- **Single-industry mode (default):** fit independently per NAICS-3.
  Honest but data-thin (≤ 30 annual obs per industry).
- **Panel mode:** stack industries, add industry fixed effects, fit
  one model. Borrows strength across industries. Use when annual
  history is short. The skill defaults to panel mode if any
  industry has < 20 annual observations.

---

## 7. Productivity composition (optional final step)

If the prompt asks for productivity, not just output:

```
productivity_y = output_y_nowcast / hours_y_projection
```

- `hours_y_projection`: CES `AWHAEMAN` × employment, summed YTD
  through cutoff `t` and extrapolated to year-end using the
  industry's typical hours seasonal pattern over the last 5 years.
- Propagate uncertainty: 1000-draw Monte Carlo from the output PI
  and the hours seasonal-pattern bootstrap; report the productivity
  PI from the resulting empirical distribution.

---

## 8. Required inputs from the orchestrator

The orchestrator must pass:

- `reference_year`: target year `y`.
- `cutoff_month`: `t` in `1..12` (or `0` for end-of-prior-year).
- `industries`: list of NAICS-3 codes, or `"all_manufacturing"`.
- `predictor_families`: subset of `{ipi, ppi, m3, trade, ces}`;
  default = all five.
- `granularity`: `"single"` or `"panel"`; default = auto per §6.
- `produce`: `"output"` | `"productivity"`; default = `"output"`.

Dataset CSV artifacts (from the research agent, Mode B) for each
predictor family must already be in the artifact store; reference
them by artifact ID in the delegation instruction.

---

## 9. Outputs

| Artifact | Role | Contents |
|----------|------|----------|
| `model_card.json` | `statistical-analysis` | Estimator winner, hyperparameters, LOO-year leaderboard, feature importances / coefficients |
| `forecast.csv` | `dataset-csv` | Industry, point, PI80_lo, PI80_hi, PI95_lo, PI95_hi |
| `residuals.csv` | `dataset-csv` | LOO-year residuals for the winning model |
| `analysis.md` | `statistical-analysis` | Human-readable report per statistician §4a |
| `memory.md` *(optional)* | `memory` | Cross-call notes |

---

## 10. Further reading (not required to operate the skill)

- Meyer, P. B. & Martinez, W. L. (2017). *Predicting industry output
  with statistical learning methods.* BLS Office of Productivity &
  Technology / JSM Proceedings, Government Statistics Section,
  3256-3269. The technique above is in this lineage; see for an
  applied benchmark on pre-2017 manufacturing data.
- Hastie, Tibshirani & Friedman, *Elements of Statistical Learning*,
  Ch. 3 (linear shrinkage) and Ch. 10 (boosting). Textbook reference
  for the estimator menu.
- Hyndman & Athanasopoulos, *Forecasting: Principles & Practice*,
  Ch. 5 (time-series CV).
