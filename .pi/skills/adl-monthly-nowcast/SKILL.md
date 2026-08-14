---
name: adl-monthly-nowcast
description: Nowcast the current quarter/month of an M3 (or similar) monthly target series with a single core ADL (autoregressive distributed-lag) model over the 13-series refresh.db indicator panel, under release-calendar admissibility. Fit naive floor, ADL-OLS-BIC, LASSO-CV, and elastic-net; validate with expanding-window walk-forward CV under simulated release calendars; deliver the point nowcast with empirical 80%/95% PIs in growth and level terms. Status — Complete (authored 2026-08-09 from prompts/aug-2026-ADL.md).
---

# ADL Monthly Nowcast — M3 Total Manufacturing Shipments (NSA, YoY log growth)

Nowcast the **not-yet-published** month of a monthly target series using a
panel of leading indicators whose publication lags differ. The canonical
application: M3 Total Manufacturing Shipments (NSA), target = YoY log
growth, nowcast produced early in month `t−1`'s successor (i.e. with an
end-of-`t−1` information cutoff).

## 1. Target

```
g_t = log(S_t) − log(S_{t−12})
```

where `S` = `m3_total_shipments_nsa` level (Millions of Dollars, NSA).
NSA throughout — the M3 SA model is frozen 2026-01 → ≥2026-12 (see
`data/regime_dummies.json#m3_sa_freeze`); YoY log growth is itself
season-free to first order, so no SA step is needed.

## 2. Panel — the 13 series of `refresh.db:indicator_history`

Read from `data/refresh.db`, table `indicator_history(series_id, date,
value, is_preliminary, observed_at)`. One row per series-month; `date` is
`YYYY-MM`. All 13 series enter the **single core ADL** — there is no
short-history bridge tier.

| series_id | Family | Transform | Release lag |
|---|---|---|---|
| `m3_total_shipments_nsa` | M3 (target) | YoY log growth (= target) | 2 |
| `m3_new_orders` | M3 | YoY log growth | 2 |
| `m3_unfilled_orders` | M3 | YoY log growth | 2 |
| `fred_ipman` | Activity | YoY log growth | 1 |
| `fred_mcumfn` | Activity | level | 1 |
| `fred_tcu` | Activity | level | 1 |
| `bls_ces_mfg_employment` | Labor | YoY log growth | 1 |
| `bls_ces_mfg_hours` | Labor | level | 1 |
| `bls_ppi_mfg` | Prices | YoY log growth | 1 |
| `fred_cfnai` | Activity index | level | 1 |
| `fred_empire_state_mfg` | Survey | level | 0 |
| `fred_philly_fed_mfg` | Survey | level | 0 |
| `fred_dallas_fed_mfg` | Survey | level | 0 |

Estimation sample starts **2006-03** (bounded by `bls_ces_mfg_hours`
inception; `fred_dallas_fed_mfg`'s 2004-06 inception is inside that
bound). YoY transforms burn 12 months of feature history, which is
available pre-2006 for all series except CES hours — which is why CES
hours enters in **levels**.

## 3. Information cutoff and release admissibility

For a nowcast of target month `t` with an information cutoff at end of
month `t−1` (nowcast produced early in month `t`):

- **Hard-truncate** every series to its release-admissible month:
  - lag 0 (surveys): admissible through `t−1`
  - lag 1 (CES, IPMAN, MCUMFN, TCU, PPI, CFNAI): admissible through `t−1`
    (the month-`t−1` print is released early in month `t`; treat it as
    admissible)
  - lag 2 (M3 shipments / new orders / unfilled orders): admissible
    through `t−2`
- Never let post-cutoff observations touch fitting, feature construction,
  or (during backtesting) prediction inputs. Realized values of the
  *target* are used only for scoring completed backtest origins.

## 4. Feature design (the ADL)

For predicting `g_t`:

- **AR block:** `g_{t−2}, g_{t−3}, g_{t−4}` (g admissible through `t−2`).
- **M3 orders block (lag 2):** transformed values at `t−2, t−3`.
- **Lag-1 blocks** (IPMAN, MCUMFN, TCU, CES employment, CES hours, PPI,
  CFNAI): transformed values at `t−1, t−2`.
- **Survey block (lag 0):** Empire, Philly, Dallas levels at `t−1, t−2`.
- **Regime dummy:** `covid_2020q2` pulse from `data/regime_dummies.json`
  (1 if target month ∈ {2020-04, 2020-05, 2020-06}, else 0), applied to
  the target month `t`.

28 features total. This relative-lag alignment is time-invariant, so one
panel construction automatically simulates the release calendar at every
backtest origin (see §6).

## 5. Models

1. **Naive floor:** `ĝ_t = g_{t−2}` (persistence of the last admissible
   YoY growth).
2. **ADL-OLS-BIC:** forward stepwise selection over the 28 features
   minimizing BIC, OLS fit.
3. **LASSO-CV:** `sklearn.linear_model.LassoCV`, features standardized
   on the training window only, α chosen by internal time-series CV.
4. **Elastic-net:** `ElasticNetCV` with an `l1_ratio` grid, same
   standardization discipline.

## 6. Validation — expanding-window walk-forward CV

Origins `τ` = 2015-01 … the last origin with a realized target (e.g.
2026-04). At each origin:

1. Training rows: target months `m ∈ [2006-03, τ−2]` (the target is
   admissible only through `τ−2` under the simulated release calendar).
2. Build features exactly as in §4 (alignment is relative, so the
   release calendar is simulated by construction).
3. Fit all four models on the expanding window; predict `ĝ_τ`.
4. Score against realized `g_τ` (realized target values may be read from
   the full history for scoring only).

Metrics vs the naive floor: **RMSE, MAE, directional accuracy**
(fraction of origins with `sign(ĝ) = sign(g)`). Also report the **survey
block's incremental RMSE**: re-run the winning model's walk-forward with
the survey features excluded and report
`ΔRMSE = RMSE(without surveys) − RMSE(with surveys)`.

## 7. Nowcast and empirical prediction intervals

- Winning ADL = lowest walk-forward RMSE among ADL-OLS-BIC, LASSO-CV,
  elastic-net. Report all four models' scores regardless.
- Point nowcast `ĝ_t` from the winning model fit on the full admissible
  sample.
- **Empirical PIs** from the winning model's walk-forward errors
  `{e_τ}`: 80% PI = `ĝ + [q10(e), q90(e)]`, 95% PI =
  `ĝ + [q2.5(e), q97.5(e)]`. Report PIs with and without the COVID
  origins as a sensitivity.
- **Level terms:** `Ŝ_t = S_{t−12} · exp(ĝ_t)`; apply the same transform
  to the PI bounds. State units (Millions of Dollars).

## 8. Contribution decomposition

For the winning model, decompose the point nowcast into additive blocks:
intercept, AR, M3 orders, activity (IPMAN+MCUMFN+TCU), labor (CES
employment + hours), prices (PPI), CFNAI, surveys, COVID dummy.
Contribution = `Σ β_j·x_j` over each block (linear models only — this is
exact); blocks + intercept sum to the point nowcast. Feed the
contribution chart.

## 9. Output contract

Artifacts (orchestrator hand-off):

1. `analysis.md` — `text/markdown`, role `statistical-analysis`, per the
   statistician §4a contract. Caveats **must** surface the M3 SA freeze
   and the COVID-2020 pulse per MEMORY.md "Data Hiatuses".
2. `model_card.json` — `application/json`, role `statistical-analysis`,
   per §4b, extended with: admissibility table, feature list, per-model
   CV metrics, survey-block ΔRMSE, contributions.
3. `nowcast.csv` — point + PI bounds in growth and level terms
   (role `dataset-csv`).
4. `backtest.csv` — origin, actual, per-model predictions (role
   `dataset-csv`).
5. `residuals.csv` — fitted residuals + walk-forward errors (role
   `dataset-csv`).
6. `panel.csv` — the full modeling panel (role `dataset-csv`).
7. Chart-feed JSON artifacts (role `dataset-meta`), one per gallery part,
   each containing the named arrays the coder's briefs reference.

Print a compact JSON summary (point, PIs, metric table) to stdout at the
end of the run.

## 10. Caveats to always disclose

- M3 SA freeze 2026-01 → ≥2026-12 (NSA used throughout; YoY growth is
  season-free to first order but not exactly).
- COVID 2020-Q2 pulse dominates residual tails; report PI sensitivity.
- NAICS-2017 → NAICS-2022 revision affects pre-2022 levels.
- Empirical PIs assume backtest errors are representative of the current
  regime; with ~135 origins the tail quantiles are noisy.
