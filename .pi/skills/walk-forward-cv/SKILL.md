---
name: walk-forward-cv
description: Honest out-of-sample evaluation for time-series models via expanding-window or rolling-window walk-forward cross-validation. Pair with any time-series learner; complements (does not replace) leave-one-year-out CV when sub-annual cadence matters. Status — STUB.
---

# Walk-Forward Cross-Validation Skill — STUB

**Status:** stub — populate on first use.

This skill will encode expanding-window and rolling-window
walk-forward CV recipes for time-series models. It is referenced by
`industry-output-nowcast` (§4) as a finer-grained alternative to
LOO-year CV when we want to know "does the model improve as more
YTD months arrive?".

## Intended contents (when populated)

1. **Expanding-window recipe.** Start with N months of train, score
   the next 1 month, expand by 1, repeat. Pure-Python loop; no
   external deps.
2. **Rolling-window recipe.** Same but train window is fixed size —
   useful when there's regime change in deep history.
3. **Honesty rules.** No look-ahead, no target leakage, no
   hyperparameter tuning on the test fold. Inner CV for tuning on
   the training fold only.
4. **Reporting.** RMSE / MAE / MAPE / directional accuracy by fold,
   plus learning-curve plot as a function of training-set size.

## References (to add when populated)

- Hyndman & Athanasopoulos, *Forecasting: Principles & Practice*,
  Ch. 5.10 — Time-series cross-validation.
- `sklearn.model_selection.TimeSeriesSplit` — built-in helper for
  the expanding-window variant.
