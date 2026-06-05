"""Spot-check detailed M3 category codes against the Census EITS API.

Hits the M3 endpoint with a small sample of detailed and sub_aggregate codes,
plus a couple of `detail_unpublished` to confirm they really do return empty.

Usage:
    py -3 data/scripts/validate_m3_codes.py [--full]
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOOKUP = ROOT / "data" / "lookups" / "m3_series.json"
BASE = "https://api.census.gov/data/timeseries/eits/m3"

# Pick a representative sample. We want at least one from each kind.
SAMPLE = {
    "subsector": ["21S", "33S", "11S", "25S"],
    "sub_aggregate": ["ANM", "TGP", "BTP", "NAP"],
    "detail": ["21A", "33A", "34A", "36F", "11A", "25A"],
    "detail_unpublished": ["33B", "34G", "11D"],  # expected: empty / 204
    "aggregate_extras": ["NXA", "CMS", "ITI", "TCG"],
}


def call(code: str, year: int = 2023) -> tuple[int, int, str]:
    """Return (http_status, row_count, sample_value_or_msg)."""
    key = os.environ.get("CENSUS_API_KEY", "")
    params = {
        "get": "cell_value,data_type_code,time_slot_id,seasonally_adj,category_code",
        "for": "us:*",
        "data_type_code": "VS",
        "category_code": code,
        "seasonally_adj": "no",
        "time": str(year),
    }
    if key:
        params["key"] = key
    url = BASE + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            body = r.read().decode("utf-8", errors="replace")
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, 0, str(e)
    except Exception as e:
        return -1, 0, f"{type(e).__name__}: {e}"

    if status == 204 or not body.strip():
        return status, 0, "(empty body)"

    try:
        data = json.loads(body)
    except Exception as e:
        return status, 0, f"JSON parse error: {e}"

    if not isinstance(data, list) or len(data) < 2:
        return status, 0, "(header only)"

    rows = data[1:]
    sample = rows[0][0] if rows and rows[0] else "(no value)"
    return status, len(rows), str(sample)


def main() -> None:
    do_full = "--full" in sys.argv

    print(f"Sample validation against {BASE} (year=2023, data_type=VS, NSA)")
    print("=" * 90)

    results: dict[str, list[dict]] = {}
    for kind, codes in SAMPLE.items():
        print(f"\n[{kind}]")
        results[kind] = []
        for c in codes:
            status, n, sample = call(c)
            outcome = "OK" if (n > 0) else ("EMPTY" if status == 204 or n == 0 else f"HTTP {status}")
            print(f"  {c:5s}  status={status:4}  rows={n:2}  outcome={outcome:<6}  sample={sample[:60]}")
            results[kind].append({"code": c, "status": status, "rows": n, "outcome": outcome, "sample_value": sample})
            time.sleep(0.25)

    print("\n" + "=" * 90)
    pub = sum(1 for k in ("subsector", "sub_aggregate", "detail", "aggregate_extras") for r in results.get(k, []) if r["rows"] > 0)
    pub_total = sum(len(results.get(k, [])) for k in ("subsector", "sub_aggregate", "detail", "aggregate_extras"))
    unpub_empty = sum(1 for r in results.get("detail_unpublished", []) if r["rows"] == 0)
    unpub_total = len(results.get("detail_unpublished", []))
    print(f"\nPublished codes returning rows:    {pub}/{pub_total}")
    print(f"Unpublished codes returning empty: {unpub_empty}/{unpub_total}  (expected: all)")


if __name__ == "__main__":
    main()
