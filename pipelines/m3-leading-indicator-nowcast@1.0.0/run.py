#!/usr/bin/env python3
"""m3-leading-indicator-nowcast@1.0.0 — SCAFFOLD (frozen weights not yet extracted).

Bridge-equation LASSO re-score. Requires pipelines/.../weights.json
({coef[], intercept, scaler{mean[],scale[]}, feature_names[], residualQuantiles})
extracted by re-fitting against the indicator panel. Until that file exists,
exit non-zero so run_nowcast_skill reports 'weights not frozen' rather than
emitting a fake result.
"""
import json
import os
import sys

WEIGHTS = os.path.join(os.path.dirname(__file__), "weights.json")
if not os.path.exists(WEIGHTS):
    sys.stderr.write("m3-leading-indicator-nowcast@1.0.0: frozen weights not found (weights.json absent)\n")
    sys.exit(3)
sys.stderr.write("m3-leading-indicator-nowcast@1.0.0: weights present but scorer not yet implemented\n")
sys.exit(3)
