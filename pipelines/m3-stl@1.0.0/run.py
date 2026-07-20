#!/usr/bin/env python3
"""
m3-stl@1.0.0 — STL seasonal-trend decomposition of M3 NSA Total Manufacturing
Shipments, with a one-step forecast.

glm-5-2-plan semantics (b): refit with pinned params + env. STL is local, cheap,
and deterministic given (data, params, env), so refitting on the appended series
preserves the purity contract (output = f(input, contract, env)).

Reads { dataset, prior } on stdin (the broker assembles these from the verified
broadcast + the target's own indicator_history). Writes a canonical SkillResult
JSON to stdout. No network, no filesystem, no RNG.

Forecast (mirrors the interactive run behind sub-stl-deepseek):
  - STL(period=12, robust=True) on the appended NSA series
  - trend extrapolated: linear fit on the last 24 trend values, one step ahead
  - seasonal: average of the last 5 same-month seasonal components
  - SA forecast = trend_extrap + seasonal_avg
  - PI: normal approximation using sigma of the last 36 STL residuals
"""
import json
import sys


def main():
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw else {}
    dataset = payload.get("dataset") or {}
    prior = payload.get("prior") or {}
    hist = (prior.get("history") or {})

    # Build the NSA shipments series from accumulated history.
    rows = hist.get("m3_total_shipments_nsa") or []
    series = []
    for r in rows:
        d = str(r["date"])[:7]
        v = float(r["value"])
        series.append((d, v))
    # Append the broadcast's new observation if present.
    new_month = dataset.get("referenceMonth")
    if new_month:
        for ind in dataset.get("indicators") or []:
            if ind.get("seriesId") == "m3_total_shipments_nsa":
                obs = ind.get("observations") or []
                if obs:
                    series.append((new_month, float(obs[-1]["value"])))
    # Dedupe + sort by date.
    seen = {}
    for d, v in series:
        seen[d] = v
    series = sorted(seen.items())

    if len(series) < 26:  # STL needs ~2 cycles minimum
        print(json.dumps(error_result("insufficient history for STL (<26 obs)")))
        return

    import numpy as np
    from statsmodels.tsa.seasonal import STL

    values = np.array([v for _, v in series], dtype=float)
    stl = STL(values, period=12, robust=True).fit()
    trend = stl.trend
    seasonal = stl.seasonal
    resid = stl.resid

    # Trend extrapolation: linear fit on the last 24 trend values.
    w = min(24, len(trend))
    x = np.arange(w)
    y = trend[-w:]
    # np.polyfit is deterministic; guard against NaNs in early trend.
    mask = np.isfinite(y)
    if mask.sum() < 2:
        print(json.dumps(error_result("trend not finite for extrapolation")))
        return
    coef = np.polyfit(x[mask], y[mask], 1)
    trend_next = coef[0] * w + coef[1]

    # Seasonal: average of the last 5 same-month (period=12) seasonal components.
    seasonal_avg = float(np.nanmean(seasonal[-12 * 5::12])) if len(seasonal) >= 12 else 0.0

    point = float(trend_next + seasonal_avg)

    # PI: normal approximation using sigma of the last 36 residuals.
    rwin = resid[-36:]
    rwin = rwin[np.isfinite(rwin)]
    sigma = float(np.std(rwin, ddof=1)) if len(rwin) > 1 else 0.0
    from statistics import NormalDist
    nd = NormalDist()
    pi80 = [point + nd.inv_cdf(0.10) * sigma, point + nd.inv_cdf(0.90) * sigma]
    pi95 = [point + nd.inv_cdf(0.025) * sigma, point + nd.inv_cdf(0.975) * sigma]

    out = {
        "point": point,
        "pi80": pi80,
        "pi95": pi95,
        "drift": {"features": [], "widened": False},
        "delta": {"newMonth": 1 if new_month else 0, "revision": 0},
        "_chartSeries": {"label": "M3 NSA Total Mfg Shipments (millions $)", "values": [{"date": d, "value": v} for d, v in series[-120:]]},
        "_nObs": int(len(series)),
        "_trendNext": float(trend_next),
        "_seasonalAvg": seasonal_avg,
        "_sigma": sigma,
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
