"""Forecast May 2026 M3 NSA Total Manufacturing Shipments.
Uses SARIMA with seasonal order (1,0,1)(1,1,0)[12] on log-transformed series.
Outputs forecast point + 80% prediction interval as JSON."""

import pandas as pd
import numpy as np
import json
import warnings
warnings.filterwarnings("ignore")

# Load data
df = pd.read_csv("data/m3_shipments_nsa_apr2026.csv", parse_dates=["date"])
df = df.set_index("date").sort_index()
df["log_shipments"] = np.log(df["shipments_millions"])

series = df["log_shipments"]

# Fit SARIMA: (1,0,1)x(1,1,0)[12] — intercept (drift) handles trend,
# seasonal differencing handles annual cycle
from statsmodels.tsa.statespace.sarimax import SARIMAX

model = SARIMAX(
    series,
    order=(1, 0, 1),
    seasonal_order=(1, 1, 0, 12),
    trend="c",
    enforce_stationarity=False,
    enforce_invertibility=False,
)
result = model.fit(disp=False, maxiter=200)

# Forecast May 2026 (1 step ahead — we have data through April 2026)
forecast = result.get_forecast(steps=1)
fc_mean = forecast.predicted_mean.iloc[0]
fc_se = forecast.se_mean.iloc[0]
fc_ci = forecast.conf_int(alpha=0.20)  # 80% CI

# Back to levels (millions $)
point_millions = np.exp(fc_mean)
lo80_millions = np.exp(fc_ci.iloc[0, 0])
hi80_millions = np.exp(fc_ci.iloc[0, 1])

# Also compute 95% CI
fc_ci95 = forecast.conf_int(alpha=0.05)
lo95_millions = np.exp(fc_ci95.iloc[0, 0])
hi95_millions = np.exp(fc_ci95.iloc[0, 1])

# In-sample fit statistics
in_sample_pred = result.get_prediction(start=series.index[24])  # skip first 2 years
residuals = in_sample_pred.predicted_mean - series.iloc[24:]
rmse_pct = np.sqrt(np.mean((np.exp(residuals) - 1) ** 2)) * 100

result_dict = {
    "method": "SARIMA(1,0,1)(1,1,0)[12] on log-levels",
    "forecast_month": "2026-05",
    "point_forecast_millions": round(point_millions),
    "pi80_lo_millions": round(lo80_millions),
    "pi80_hi_millions": round(hi80_millions),
    "pi95_lo_millions": round(lo95_millions),
    "pi95_hi_millions": round(hi95_millions),
    "point_forecast_billions": round(point_millions / 1000, 1),
    "pi80_lo_billions": round(lo80_millions / 1000, 1),
    "pi80_hi_billions": round(hi80_millions / 1000, 1),
    "in_sample_rmse_pct": round(rmse_pct, 2),
    "aic": round(result.aic, 1),
    "last_observed": {"month": "2026-04", "billions": round(df["shipments_millions"].iloc[-1] / 1000, 1)},
    "yoy_april": round((df["shipments_millions"].iloc[-1] / df["shipments_millions"].iloc[-13] - 1) * 100, 1),
}

print(json.dumps(result_dict, indent=2))