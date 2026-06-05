"""Build data/lookups/ppi_series.json by intersecting the BLS PPI catalog
(pc.series + pc.industry) with the NAICS-3 codes that appear in our M3
detailed-code lookup.

Inputs (cached locally first; re-fetch if missing):
    data/lookups/m3_series.json       (already has the _detailed block)
    data/bls_pc_series.tsv            (cached BLS pc.series)
    data/bls_pc_industry.tsv          (cached BLS pc.industry)

Output:
    data/lookups/ppi_series.json

Schema:
    {
        "_meta": {
            "source": "BLS Producer Price Index industry data (pc database)",
            "endpoint_series_catalog": "https://download.bls.gov/pub/time.series/pc/pc.series",
            "endpoint_industry_catalog": "https://download.bls.gov/pub/time.series/pc/pc.industry",
            "endpoint_api": "https://api.bls.gov/publicAPI/v2/timeseries/data/",
            "extraction_date": "YYYY-MM-DD",
            "rules": "NSA only (seasonal=U). One industry-group series per NAICS-3, product_code='---' (the all-products PPI for that industry).",
            "m3_link": "M3 detailed codes share a NAICS-3 prefix; durable M3 prefix XY -> NAICS 3XY; nondurable preserves."
        },
        "by_naics3": {
            "321": {
                "naics3": "321",
                "label": "Wood Products",
                "ppi_industry_group": "PCU321---321---",
                "ppi_label": "PPI industry group data for Wood product manufacturing, not seasonally adjusted",
                "begin_year": 1985,
                "end_year_known": 2026,
                "m3_subsector_code": "21S",
                "m3_detail_codes": ["21A", "21B"]
            },
            ...
        },
        "fallback_commodity_series": {
            "comment": "If an industry-group PPI is unavailable, use a commodity-level WPU series.",
            "endpoint_catalog": "https://download.bls.gov/pub/time.series/wp/wp.series"
        }
    }

Run:
    py -3 data/scripts/build_ppi_lookup.py
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
M3_LOOKUP = ROOT / "data" / "lookups" / "m3_series.json"
PPI_OUT = ROOT / "data" / "lookups" / "ppi_series.json"
BLS_PC_SERIES_CACHE = ROOT / "data" / "bls_pc_series.tsv"
BLS_PC_INDUSTRY_CACHE = ROOT / "data" / "bls_pc_industry.tsv"

BLS_UA = "Mozilla/5.0 (research; mailto:kim@example.com)"


def fetch_if_missing(url: str, path: Path) -> None:
    if path.exists() and path.stat().st_size > 1024:
        return
    print(f"Fetching {url} -> {path.name}")
    req = urllib.request.Request(url, headers={"User-Agent": BLS_UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    path.write_bytes(body)


def load_tsv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    """Parse a BLS tab-delimited file. Returns (header, rows)."""
    with path.open("r", encoding="utf-8") as f:
        lines = [line.rstrip("\n") for line in f if line.strip()]
    header = [c.strip() for c in lines[0].split("\t")]
    rows: list[dict[str, str]] = []
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) < len(header):
            parts += [""] * (len(header) - len(parts))
        row = {header[i]: parts[i].strip() for i in range(len(header))}
        rows.append(row)
    return header, rows


def get_m3_detailed_records() -> list[dict]:
    with M3_LOOKUP.open("r", encoding="utf-8") as f:
        lookup = json.load(f)
    for item in lookup:
        if isinstance(item, dict) and "_detailed" in item:
            return item["_detailed"]["records"]
    raise SystemExit("No _detailed block in m3_series.json — run build_m3_detailed_lookup.py first.")


def main() -> None:
    # ── Fetch raw BLS catalogs (cached) ──
    fetch_if_missing("https://download.bls.gov/pub/time.series/pc/pc.series", BLS_PC_SERIES_CACHE)
    fetch_if_missing("https://download.bls.gov/pub/time.series/pc/pc.industry", BLS_PC_INDUSTRY_CACHE)

    _, series_rows = load_tsv(BLS_PC_SERIES_CACHE)
    _, industry_rows = load_tsv(BLS_PC_INDUSTRY_CACHE)
    print(f"Loaded {len(series_rows)} PPI series, {len(industry_rows)} industry rows.")

    industry_label_by_code = {r["industry_code"]: r["industry_name"] for r in industry_rows}

    # ── Collect NAICS-3 codes present in M3 ──
    m3_recs = get_m3_detailed_records()
    naics3_to_m3: dict[str, dict] = {}
    for r in m3_recs:
        n3 = r.get("naics3")
        if not n3 or len(n3) != 3:
            continue
        bucket = naics3_to_m3.setdefault(n3, {"subsector_code": None, "subsector_label": None, "detail_codes": []})
        if r["kind"] == "subsector":
            bucket["subsector_code"] = r["code"]
            bucket["subsector_label"] = r["label"]
        elif r["kind"] == "detail":
            bucket["detail_codes"].append(r["code"])

    print(f"M3 NAICS-3 subsectors needing a PPI deflator: {len(naics3_to_m3)}")
    for n3 in sorted(naics3_to_m3):
        b = naics3_to_m3[n3]
        print(f"  {n3}  {b['subsector_code']}  {b['subsector_label']}  ({len(b['detail_codes'])} details)")

    # ── Build PPI lookup by intersecting ──
    # BLS industry_code format we care about:
    #   "NNN---"  - the 3-digit NAICS subsector summary (industry group)
    # Series ID for that group's all-products PPI: "PCU<INDCODE><PRODCODE>" with product_code='---'.
    by_naics3: dict[str, dict] = {}
    missing: list[str] = []
    for n3, m3 in sorted(naics3_to_m3.items()):
        target_industry_code = f"{n3}---"
        # Find the NSA industry-group all-products series
        matches = [
            r for r in series_rows
            if r["industry_code"] == target_industry_code
            and r["product_code"] == "---"
            and r["seasonal"] == "U"
        ]
        if not matches:
            # Fallback: any NSA series for this industry code
            matches = [r for r in series_rows if r["industry_code"] == target_industry_code and r["seasonal"] == "U"]
        if not matches:
            missing.append(n3)
            continue
        # Prefer the longest history
        matches.sort(key=lambda r: int(r["begin_year"] or 0))
        chosen = matches[0]
        by_naics3[n3] = {
            "naics3": n3,
            "label": industry_label_by_code.get(target_industry_code) or m3["subsector_label"],
            "ppi_industry_group": chosen["series_id"].strip(),
            "ppi_label": chosen["series_title"],
            "begin_year": int(chosen["begin_year"] or 0),
            "end_year_known": int(chosen["end_year"] or 0),
            "m3_subsector_code": m3["subsector_code"],
            "m3_subsector_label": m3["subsector_label"],
            "m3_detail_codes": sorted(m3["detail_codes"]),
        }

    print(f"\nMatched {len(by_naics3)} / {len(naics3_to_m3)} NAICS-3 subsectors to a BLS PPI industry-group series.")
    if missing:
        print(f"Missing PPI for NAICS-3: {missing}")

    out = {
        "_meta": {
            "source": "BLS Producer Price Index industry data (pc database)",
            "endpoint_series_catalog": "https://download.bls.gov/pub/time.series/pc/pc.series",
            "endpoint_industry_catalog": "https://download.bls.gov/pub/time.series/pc/pc.industry",
            "endpoint_api": "https://api.bls.gov/publicAPI/v2/timeseries/data/",
            "extraction_date": "2026-06-05",
            "rules": "NSA only (seasonal=U). One industry-group series per NAICS-3, product_code='---' (the all-products PPI for that industry). Picked by longest begin_year history.",
            "m3_link": "M3 detailed codes share a NAICS-3 prefix; durable M3 prefix XY -> NAICS 3XY; nondurable XYS preserves digits.",
            "usage": "For Tornqvist deflation: nominal_real = nominal_M3 / (PPI_index / 100). Both monthly NSA. Take period-average for monthly Tornqvist.",
            "bls_api_quota": "25 series/year per request without key, 50 with registered key. Set BLS_API_KEY env var.",
        },
        "by_naics3": by_naics3,
        "missing_naics3": missing,
        "fallback_commodity_series": {
            "comment": "If an industry-group PPI is unavailable or thin, use a commodity-level WPU series. We did not build a WPU index in this lookup.",
            "endpoint_catalog": "https://download.bls.gov/pub/time.series/wp/wp.series",
        },
    }

    with PPI_OUT.open("w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\nWrote {PPI_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
