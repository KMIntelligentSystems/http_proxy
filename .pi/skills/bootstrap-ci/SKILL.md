---
name: bootstrap-ci
description: Non-parametric confidence and prediction intervals via the bootstrap. Use when the sampling distribution of a statistic is not analytic or the residuals fail a normality / heteroscedasticity check. Status — STUB.
---

# Bootstrap CI Skill — STUB

**Status:** stub — populate on first use.

Referenced by `industry-output-nowcast` (§5) as the fallback
interval when empirical residual quantiles fail a normality check,
and by any density-estimation skill that needs uncertainty on a
quantile or moment that lacks a closed-form standard error.

## Intended contents (when populated)

1. **Non-parametric bootstrap** — resample observations with
   replacement, recompute statistic, take empirical quantiles.
2. **Block bootstrap** — for serially correlated time series; block
   length picked by the Politis-White automatic rule.
3. **Residual bootstrap** — for regression / forecast intervals;
   resample fitted residuals, add to point prediction.
4. **BCa correction** — bias-corrected and accelerated intervals
   for skewed sampling distributions.
5. **Reporting.** Always report both the bootstrap interval AND the
   empirical residual interval (when applicable); divergence is
   diagnostic.

## References (to add when populated)

- Efron & Tibshirani, *An Introduction to the Bootstrap* (1993).
- Politis & White (2004), *Automatic block-length selection for the
  dependent bootstrap.* `Econometric Reviews` 23(1), 53-70.
- `scipy.stats.bootstrap` — pure-Python implementation, supports BCa.
