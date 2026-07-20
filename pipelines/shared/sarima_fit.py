#!/usr/bin/env python3
"""
sarima_fit.py — canonical SARIMA fitter for the run_sarima tool.

Reads one JSON payload on stdin:
  { observations: [{date, value}],            # YYYY-MM (or YYYY-MM-DD), ascending
    order: [p,d,q], seasonal_order: [P,D,Q,s],
    transformation: "none"|"log", trend: "n"|"c"|"drift",
    horizon: int, piLevels: [0.80, 0.95] }

Writes one canonical JSON result to stdout (see the run_sarima tool spec).
Deterministic given (data, spec, env): statsmodels MLE (L-BFGS-B) has no RNG.
No network, no filesystem, no stdout noise — diagnostics go to stderr.

trend: "drift" maps to statsmodels trend="c" when d+D>0 (a constant in the
differenced model IS drift). residualQuantiles are computed on the FIT scale
(i.e. log scale when transformation="log") over in-sample one-step residuals,
excluding the first s+1 observations (statespace burn-in). Both conventions
must be reproduced verbatim by any frozen skill that transcribes this output.
"""
import json
import sys


def main() -> None:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw else {}
        obs = payload["observations"]
        order = payload["order"]
        seasonal = payload["seasonal_order"]
        transformation = payload.get("transformation", "none")
        trend_req = payload.get("trend", "n")
        horizon = int(payload.get("horizon", 1))
        pi_levels = payload.get("piLevels", [0.80, 0.95])
    except (KeyError, TypeError, ValueError) as e:
        fail(f"bad payload: {e}")

    import numpy as np

    dates = [str(o["date"])[:7] for o in obs]
    y = np.array([float(o["value"]) for o in obs], dtype=float)
    if len(y) < 40:
        fail(f"insufficient observations ({len(y)} < 40) for a seasonal SARIMA")
    if transformation == "log" and (y <= 0).any():
        fail("log transformation requires strictly positive values")

    endog = np.log(y) if transformation == "log" else y
    p, d, q = (int(v) for v in order)
    P, D, Q, s = (int(v) for v in seasonal)
    trend = "c" if trend_req == "drift" else trend_req
    if trend_req == "drift" and d + D == 0:
        sys.stderr.write("sarima_fit: drift requested with d+D==0; 'c' used (constant in levels)\n")

    from statsmodels.tsa.statespace.sarimax import SARIMAX
    mod = SARIMAX(endog, order=(p, d, q), seasonal_order=(P, D, Q, s), trend=trend)
    res = mod.fit(disp=False)

    fc = res.get_forecast(steps=horizon)
    mean = np.asarray(fc.predicted_mean, dtype=float)
    forecasts = []
    for h in range(horizon):
        f = {"date": next_month(dates[-1], h + 1)}
        m = float(mean[h])
        f["point"] = float(np.exp(m)) if transformation == "log" else m
        for level in pi_levels:
            ci = np.asarray(fc.conf_int(alpha=1.0 - float(level)), dtype=float)[h]
            lo, hi = float(ci[0]), float(ci[1])
            if transformation == "log":
                lo, hi = float(np.exp(lo)), float(np.exp(hi))
            f[f"pi{int(round(level * 100))}"] = [lo, hi]
        forecasts.append(f)

    resid = np.asarray(res.resid, dtype=float)
    tail = resid[s + 1:]  # statespace burn-in excluded (see header)
    rq = {
        "q10": float(np.quantile(tail, 0.10)),
        "q90": float(np.quantile(tail, 0.90)),
        "q025": float(np.quantile(tail, 0.025)),
        "q975": float(np.quantile(tail, 0.975)),
        "sigma": float(np.std(tail, ddof=1)),
        "scale": transformation,
        "burnInExcluded": s + 1,
    }

    from statsmodels.stats.diagnostic import acorr_ljungbox
    from statsmodels.stats.stattools import jarque_bera
    n_params = p + q + P + Q + (1 if trend in ("c", "t", "ct") else 0)
    lb = acorr_ljungbox(tail, lags=[12, 24], model_df=n_params, return_df=True)
    jb_stat, jb_p, _, _ = jarque_bera(tail)

    # With a numpy endog, res.params/bse are plain ndarrays — zip with param_names.
    names = [str(n) for n in getattr(res, "param_names", [f"p{i}" for i in range(len(res.params))])]
    params_arr = np.asarray(res.params, dtype=float)
    bse_arr = np.asarray(res.bse, dtype=float)
    coefs = [{"name": n, "value": float(v), "se": float(s)} for n, v, s in zip(names, params_arr, bse_arr)]
    sigma2 = float(params_arr[names.index("sigma2")]) if "sigma2" in names else float("nan")

    import hashlib
    import statsmodels
    input_hash = hashlib.sha256(json.dumps(
        {"observations": [[d, float(v)] for d, v in zip(dates, y)],
         "spec": [order, seasonal, transformation, trend_req]},
        separators=(",", ":")).encode()).hexdigest()

    out = {
        "forecasts": forecasts,
        "fit": {
            "coefficients": coefs,
            "sigma2": sigma2,
            "n_obs": int(len(y)),
        },
        "diagnostics": {
            "aic": float(res.aic),
            "bic": float(res.bic),
            "ljung_box": {
                "lag12": {"q": float(lb["lb_stat"].iloc[0]), "p": float(lb["lb_pvalue"].iloc[0])},
                "lag24": {"q": float(lb["lb_stat"].iloc[1]), "p": float(lb["lb_pvalue"].iloc[1])},
            },
            "jarque_bera_p": float(jb_p),
        },
        "residualQuantiles": rq,
        "spec": {
            "order": [p, d, q],
            "seasonal_order": [P, D, Q, s],
            "transformation": transformation,
            "trend": trend_req,
        },
        "meta": {
            "statsmodels": statsmodels.__version__,
            "inputHash": input_hash,
            "range": [dates[0], dates[-1]],
        },
    }
    print(json.dumps(out))


def next_month(yyyymm: str, step: int) -> str:
    y, m = int(yyyymm[:4]), int(yyyymm[5:7])
    total = (y * 12 + (m - 1)) + step
    return f"{total // 12}-{(total % 12) + 1:02d}"


def fail(msg: str) -> None:
    print(json.dumps({"error": msg}))
    sys.exit(1)


if __name__ == "__main__":
    main()
