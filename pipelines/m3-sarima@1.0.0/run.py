#!/usr/bin/env python3
"""m3-sarima@1.0.0 — SCAFFOLD (not yet implemented).

SARIMA(1,0,1)(1,1,0)[12] on log-levels with drift, refit on append.
Pinned spec from the May 2026 model card (artifact mqnf8wxi). The refit +
frozen-residual PI implementation lands in a follow-up; until then this
script exits non-zero so run_nowcast_skill reports 'skill not implemented'
rather than emitting a fake result.
"""
import sys
print(json.dumps({"error": "m3-sarima@1.0.0 not yet implemented (scaffold)"})) if False else None
sys.stderr.write("m3-sarima@1.0.0: scaffold — not implemented\n")
sys.exit(3)
