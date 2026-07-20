#!/usr/bin/env python3
"""
m3-sarima@1.0.0 — SARIMA(1,0,1)(1,1,0)[12] on log-levels with drift.

FROZEN SKILL (glm-5-2-plan semantics (b): refit with pinned params + env).
Spec validated interactively via the run_sarima tool against the May 2026
model card (artifact mqnf8wxi-97a29b71): point 654,350 vs card 654,503
(-0.02%), PI bounds within ~0.07%, statsmodels 0.14.6, n=292 through 2026-04.

SELF-CONTAINED BY RULE: the broker's pipelineDigest hashes ONLY this file —
do not import project modules; inline everything the fit needs.

Conventions (identical to pipelines/shared/sarima_fit.py — the flow-1 tool —
so interactive and frozen outputs are directly comparable):
  - fit on log(values), statsmodels trend="c" (constant in the differenced
    model = drift), MLE refit on the appended series (reproducible given
    data+params+env)
  - PI: empirical residual quantiles on the FIT (log) scale, in-sample
    one-step residuals with the first s+1=13 observations excluded
    (statespace burn-in); bounds = exp(log_point + q)

Reads { dataset, prior } on stdin (the broker assembles these from the
verified broadcast + the target's own indicator_history). Writes a canonical
SkillResult JSON to stdout. No network, no filesystem, no RNG.
"""
import json
import sys

ORDER = (1, 0, 1)
SEASONAL = (1, 1, 0, 12)
BURN_IN = SEASONAL[3] + 1  # 13 — same convention as sarima_fit.py
SERIES_ID = "m3_total_shipments_nsa"


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw else {}
    dataset = payload.get("dataset") or {}
    prior = payload.get("prior") or {}
    hist = (prior.get("history") or {})

    # Accumulated history → ascending (month, value) series.
    series = []
    for r in (hist.get(SERIES_ID) or []):
        series.append((str(r["date"])[:7], float(r["value"])))

    # Append the broadcast's new observation if present.
    new_month = dataset.get("referenceMonth")
    appended = False
    if new_month:
        for ind in (dataset.get("indicators") or []):
            if ind.get("seriesId") == SERIES_ID and (ind.get("observations") or []):
                series.append((str(new_month)[:7], float(ind["observations"][-1]["value"])))
                appended = True

    # Dedupe by month (later write wins) + sort.
    seen = {}
    for d, v in series:
        seen[d] = v
    series = sorted(seen.items())

    if len(series) < 40:
        print(json.dumps(error_result(f"insufficient history for SARIMA ({len(series)} < 40)")))
        return

    import numpy as np
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    y = np.log(np.array([v for _, v in series], dtype=float))
    res = SARIMAX(y, order=ORDER, seasonal_order=SEASONAL, trend="c").fit(disp=False)

    fc = res.get_forecast(steps=1)
    log_point = float(np.asarray(fc.predicted_mean, dtype=float)[0])
    point = float(np.exp(log_point))

    resid = np.asarray(res.resid, dtype=float)[BURN_IN:]
    q10, q90 = (float(np.quantile(resid, q)) for q in (0.10, 0.90))
    q025, q975 = (float(np.quantile(resid, q)) for q in (0.025, 0.975))

    out = {
        "point": point,
        "pi80": [float(np.exp(log_point + q10)), float(np.exp(log_point + q90))],
        "pi95": [float(np.exp(log_point + q025)), float(np.exp(log_point + q975))],
        "drift": {"features": [], "widened": False},
        "delta": {"newMonth": 1 if appended else 0, "revision": 0},
        "_chartSeries": {"label": "M3 NSA Total Mfg Shipments (millions $)", "values": [{"date": d, "value": v} for d, v in series[-120:]]},
        "_nObs": int(len(series)),
        "_aic": float(res.aic),
        "_sigma": float(np.std(resid, ddof=1)),
    }
    print(json.dumps(out))


def error_result(msg):
    return {
        "point": 0, "pi80": [0, 0], "pi95": [0, 0],
        "drift": {"features": [], "widened": False},
        "delta": {"newMonth": 0, "revision": 0},
        "error": msg,
    }


if __name__ == "__main__":
    main()
