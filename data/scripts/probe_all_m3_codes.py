"""Probe EVERY M3 detail/sub_aggregate/subsector/aggregate code in m3_series.json
against the Census EITS API, then write back an `api_verified` flag.

Why: the M3 NAICS documentation PDF lists some codes that the EITS API does not
actually serve (e.g. 21A, 36F). Conversely some "unpublished" codes might
return data. We can't trust the PDF alone — we have to hit the API.

This is rate-limit-friendly: 0.25 s sleep between calls, so ~150 codes takes
~40 seconds.

After this run, the lookup gains:
    record["api_verified"] = True | False
    record["api_sample_year"] = 2023
    record["api_row_count"] = N
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
SLEEP = 0.25
YEAR = 2023


def call(code: str) -> tuple[int, int]:
    """Return (http_status, row_count) for a given category_code, data_type=VS, NSA, year=2023."""
    key = os.environ.get("CENSUS_API_KEY", "")
    params = {
        "get": "cell_value,data_type_code,time_slot_id,seasonally_adj,category_code",
        "for": "us:*",
        "data_type_code": "VS",
        "category_code": code,
        "seasonally_adj": "no",
        "time": str(YEAR),
    }
    if key:
        params["key"] = key
    url = BASE + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            body = r.read().decode("utf-8", errors="replace")
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception:
        return -1, 0
    if status == 204 or not body.strip():
        return status, 0
    try:
        data = json.loads(body)
    except Exception:
        return status, 0
    if not isinstance(data, list) or len(data) < 2:
        return status, 0
    return status, len(data) - 1


def main() -> None:
    with LOOKUP.open("r", encoding="utf-8") as f:
        lookup = json.load(f)

    # Locate the _detailed block
    detailed_block = None
    for item in lookup:
        if isinstance(item, dict) and "_detailed" in item:
            detailed_block = item["_detailed"]
            break
    if detailed_block is None:
        print("No _detailed block in lookup. Run build_m3_detailed_lookup.py first.", file=sys.stderr)
        sys.exit(1)

    records = detailed_block["records"]
    # We probe ALL aggregates / subsectors / sub_aggregates / details
    # Skip detail_unpublished by default unless --include-unpublished is passed
    include_unpub = "--include-unpublished" in sys.argv
    probe_kinds = {"aggregate", "subsector", "sub_aggregate", "detail"}
    if include_unpub:
        probe_kinds.add("detail_unpublished")

    targets = [r for r in records if r["kind"] in probe_kinds]
    print(f"Probing {len(targets)} codes against EITS API (year={YEAR}, data_type=VS, NSA)")
    print(f"Expected duration: ~{len(targets) * SLEEP:.0f}s")
    print()

    stats: dict[str, dict[str, int]] = {}
    for i, r in enumerate(targets, 1):
        status, n = call(r["code"])
        r["api_verified"] = bool(n > 0)
        r["api_sample_year"] = YEAR
        r["api_row_count"] = n
        if status != 200 and status != 204:
            r["api_http_status"] = status
        kind = r["kind"]
        stats.setdefault(kind, {"verified": 0, "empty": 0, "error": 0})
        if n > 0:
            stats[kind]["verified"] += 1
        elif status in (200, 204):
            stats[kind]["empty"] += 1
        else:
            stats[kind]["error"] += 1
        mark = "OK " if n > 0 else ("--" if status in (200, 204) else "ER")
        print(f"  [{i:3d}/{len(targets)}] {mark} {r['code']:5s} {r['kind']:18s} rows={n:2d}  http={status}")
        time.sleep(SLEEP)

    # Write back
    with LOOKUP.open("w", encoding="utf-8") as f:
        json.dump(lookup, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print()
    print("Summary by kind:")
    for kind, s in sorted(stats.items()):
        print(f"  {kind:22s}  verified={s['verified']:3d}  empty={s['empty']:3d}  errors={s['error']:3d}")

    # Note any PDF-published codes that the API rejects
    discrepancies = [r for r in targets if not r.get("api_verified") and r.get("published")]
    print(f"\nPDF says published but API returns no data: {len(discrepancies)}")
    for r in discrepancies:
        print(f"  {r['code']:5s} ({r['kind']})  {r['label'][:60]}")


if __name__ == "__main__":
    main()
