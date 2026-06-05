"""Parse data/m3_naicshist.txt into a structured detailed-code dictionary and
merge it into data/lookups/m3_series.json under a new `_detailed` block.

The source text follows a consistent pattern (with some labels wrapping over 2-3
lines). We tokenize by section, then classify each code-bearing line:

    Aggregate series Totals:
    <CODE> \t <Label>                # kind=aggregate, parent=None
    ...
    Durable Subsector series:
    <SUBS> \t <Label>                # kind=subsector (XYS), parent=MDM, naics3=3XY
    <DET>  \t <Label>                # kind=detail, parent=<SUBS>
    <SUBAGG> \t <Label>              # kind=sub_aggregate; next "Includes:" attaches details
    Includes:
        <DET> <Label>                # kind=detail, parent=<SUBAGG>
    Not published, but included in XYS:
        <DET> <Label>                # kind=detail_unpublished, parent=<SUBS>, published=False
    Nondurable Subsector series:
    ...
    Aggregate series:
    <CODE> \t <Label>                # kind=aggregate (the extras like CMS, ITI, ..., ODG, 34X)

Outputs structured records back into data/lookups/m3_series.json under a new
top-level entry `{"_detailed": {...}}` that sits just before `_meta`.

Run from project root:
    py -3 data/scripts/build_m3_detailed_lookup.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEXT_FILE = ROOT / "data" / "m3_naicshist.txt"
LOOKUP_FILE = ROOT / "data" / "lookups" / "m3_series.json"


# ─────────────────────────── tokenizer ────────────────────────────

PAGE_MARKER = re.compile(r"^---\s*page\s*\d+\s*---\s*$", re.I)

SECTION_PATTERNS = [
    ("aggregate_totals", re.compile(r"^Aggregate series Totals:", re.I)),
    ("durable_subsectors", re.compile(r"^Durable Subsector series:", re.I)),
    ("nondurable_subsectors", re.compile(r"^Nondurable Subsector series:", re.I)),
    ("aggregate_extras", re.compile(r"^Aggregate series:", re.I)),
]

UNPUBLISHED_MARK = re.compile(r"^Not published,?\s+but included in\s+(?P<parent>[A-Z0-9]{2,3}S?)\b", re.I)
INCLUDES_MARK = re.compile(r"^Includes:\s*$", re.I)

# Code line: a 3-char code at the start, possibly followed by whitespace then label.
# Codes are uppercase letters/digits exclusively.
CODE_LINE = re.compile(r"^(?P<code>[A-Z0-9]{3})(?:[ \t]+(?P<label>\S.*?)\s*)?$")

# Lines we ignore entirely (boilerplate, column headers, data-type listings).
BOILERPLATE = re.compile(
    r"^("
    r"NOTE:|FILE LAYOUT:|MANUFACTURERS|HISTORICAL|"
    r"Column [A-N]\b|"
    r"M3 SERIES|"
    r"Position\s+\d|"
    r"VS\s+\W|NO\s+\W|UO\s+\W|TI\s+\W|MI\s+\W|WI\s+\W|FI\s+\W|IS\s+\W|US\s+\W|"
    r"VS\s*\u2013|NO\s*\u2013|UO\s*\u2013|TI\s*\u2013|MI\s*\u2013|WI\s*\u2013|FI\s*\u2013|IS\s*\u2013|US\s*\u2013|"
    r"This field|"
    r"Note: Estimates|"
    r"Note:"
    r")",
    re.I,
)


def is_section_header(line: str) -> str | None:
    for name, pat in SECTION_PATTERNS:
        if pat.match(line):
            return name
    return None


def normalize(text: str) -> list[str]:
    """Strip page markers and blank lines. Keep all real content lines as-is."""
    out: list[str] = []
    for raw in text.splitlines():
        s = raw.rstrip()
        if not s.strip():
            continue
        if PAGE_MARKER.match(s):
            continue
        out.append(s)
    return out


# ─────────────────────────── parser ────────────────────────────

# Sub-aggregate codes are identified by their *position* in the doc: a 3-letter
# all-alpha code (e.g. ANM, TGP, BTP, NAP, DAP) OR a digit-digit-letter code
# where the letter is not S and Z (e.g. 34X, 36Z is also sub_aggregate) — but ONLY
# when followed by an "Includes:" line. We pre-scan to find these unambiguously.

def find_sub_aggregate_codes(lines: list[str]) -> set[str]:
    """A code is a sub_aggregate iff the next non-blank line is exactly 'Includes:'."""
    out: set[str] = set()
    for i, line in enumerate(lines):
        m = CODE_LINE.match(line)
        if not m:
            continue
        # Find next content line
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j < len(lines) and INCLUDES_MARK.match(lines[j]):
            out.add(m.group("code"))
    return out


def parse(text: str) -> list[dict]:
    lines = normalize(text)
    sub_agg_codes = find_sub_aggregate_codes(lines)

    records: list[dict] = []
    section: str | None = None
    current_durable: bool | None = None
    current_subsector: str | None = None  # the most recent XYS
    active_subagg: str | None = None       # set after an "Includes:" until the block ends
    unpublished_parent: str | None = None  # set after "Not published, but included in XYS:"

    # Track which records each detail also rolls into (for the also_in field).
    code_to_record: dict[str, dict] = {}

    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1

        # Section transitions
        sec = is_section_header(line)
        if sec:
            section = sec
            active_subagg = None
            unpublished_parent = None
            if sec == "durable_subsectors":
                current_durable = True
            elif sec == "nondurable_subsectors":
                current_durable = False
            elif sec == "aggregate_extras":
                # The extras section reuses aggregate parsing
                pass
            continue

        if BOILERPLATE.match(line):
            continue

        # Markers that bracket detail blocks
        um = UNPUBLISHED_MARK.match(line)
        if um:
            parent = um.group("parent")
            if not parent.endswith("S") and len(parent) == 2:
                parent = parent + "S"
            unpublished_parent = parent
            active_subagg = None  # unpublished block is sibling, not under any subagg
            continue
        if INCLUDES_MARK.match(line):
            # active_subagg was set when the preceding code was recognized as sub_aggregate
            continue

        m = CODE_LINE.match(line)
        if not m:
            # Likely a label continuation. Ignore — codes always lead.
            continue

        code = m.group("code")
        label = (m.group("label") or "").strip()

        # If this line had no label, peek ahead and stitch the next non-blank
        # non-marker line as the label.
        if not label and i < len(lines):
            nxt = lines[i]
            if not is_section_header(nxt) and not BOILERPLATE.match(nxt) and not UNPUBLISHED_MARK.match(nxt) and not INCLUDES_MARK.match(nxt) and not CODE_LINE.match(nxt):
                label = nxt.strip()
                i += 1

        # ── classify ──
        kind: str
        parent_code: str | None = None
        included_in: str | None = None
        published = True
        naics3: str | None = None

        if section in ("aggregate_totals", "aggregate_extras"):
            kind = "aggregate"
            naics3 = derive_naics3(code, durable=None)
        elif re.match(r"^[12][1-9]S$|^3[1-9]S$", code) and section in ("durable_subsectors", "nondurable_subsectors"):
            kind = "subsector"
            parent_code = "MDM" if current_durable else "MNM"
            current_subsector = code
            active_subagg = None
            unpublished_parent = None
            naics3 = derive_naics3(code, durable=current_durable)
        elif code in sub_agg_codes and section in ("durable_subsectors", "nondurable_subsectors"):
            kind = "sub_aggregate"
            parent_code = current_subsector
            included_in = current_subsector
            active_subagg = code   # becomes the parent for items in the upcoming Includes block
            unpublished_parent = None
            naics3 = derive_naics3(code, durable=current_durable)
        elif unpublished_parent:
            kind = "detail_unpublished"
            parent_code = unpublished_parent
            included_in = unpublished_parent
            published = False
            naics3 = derive_naics3(code, durable=current_durable)
        elif active_subagg:
            kind = "detail"
            parent_code = active_subagg
            included_in = active_subagg
            naics3 = derive_naics3(code, durable=current_durable)
        elif section in ("durable_subsectors", "nondurable_subsectors"):
            kind = "detail"
            parent_code = current_subsector
            included_in = current_subsector
            naics3 = derive_naics3(code, durable=current_durable)
        else:
            kind = "aggregate"
            naics3 = derive_naics3(code, durable=None)

        # Dedup: if a code already exists, enrich rather than duplicate. This
        # matters when a 36F-style code appears once under its sub_aggregate
        # (NAP "Includes:") and isn't re-listed later.
        if code in code_to_record:
            prev = code_to_record[code]
            if parent_code and prev.get("parent_code") != parent_code:
                prev.setdefault("also_in", [])
                if parent_code not in prev["also_in"]:
                    prev["also_in"].append(parent_code)
            continue

        rec = {
            "code": code,
            "label": label,
            "kind": kind,
            "parent_code": parent_code,
            "included_in": included_in,
            "naics3": naics3,
            "published": published,
        }
        code_to_record[code] = rec
        records.append(rec)

    return records


def derive_naics3(code: str, durable: bool | None) -> str | None:
    """M3 drops the NAICS leading "3" for codes whose first two chars are digits.
    Durable subsectors 21..39 map to NAICS 321..339.
    Nondurable subsectors 11..16 map to NAICS 311..316; 22..27 map to NAICS 322..327.
    """
    if not code[:2].isdigit():
        return None
    n = int(code[:2])
    if durable is True:
        if 21 <= n <= 39:
            return f"3{n:02d}"
        return None
    if durable is False:
        if 11 <= n <= 16 or 22 <= n <= 27:
            return f"3{n:02d}"
        return None
    # Unknown context (top-level aggregate section): heuristic
    if 21 <= n <= 39:
        return f"3{n:02d}"
    if 11 <= n <= 16 or 22 <= n <= 27:
        return f"3{n:02d}"
    return None


# ─────────────────────────── merge into lookup ────────────────────────────

def merge_into_lookup(records: list[dict]) -> None:
    with LOOKUP_FILE.open("r", encoding="utf-8") as f:
        lookup = json.load(f)

    # Remove any prior `_detailed` block
    lookup = [item for item in lookup if not (isinstance(item, dict) and "_detailed" in item)]

    # Build counts
    counts: dict[str, int] = {}
    for r in records:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1

    detailed_block = {
        "_detailed": {
            "source_pdf": "https://www2.census.gov/programs-surveys/m3/technical-documentation/code-lists/naicshist.pdf",
            "extracted_at": "2026-06-05",
            "extraction_method": "parse_pdf tool (pdf-parse engine) + data/scripts/build_m3_detailed_lookup.py",
            "schema": {
                "code": "3-char M3 series identifier (positions 2-4 of the 6-char ID)",
                "label": "Industry label as printed in the Census M3 NAICS-based documentation",
                "kind": "aggregate | subsector | sub_aggregate | detail | detail_unpublished",
                "parent_code": "immediate parent grouping (subsector for details; MDM/MNM for subsectors; current subsector for sub_aggregates)",
                "included_in": "for sub_aggregates and details under sub_aggregates, the umbrella code",
                "naics3": "3-digit NAICS subsector (M3 drops the leading '3'; durable 21->321; nondurable 11->311, 22->322)",
                "published": "true if queryable via the Census EITS API; false for 'Not published, but included in XS' rows",
                "also_in": "(optional) other parent groupings this code rolls up into",
            },
            "counts_by_kind": counts,
            "records": records,
        }
    }

    # Insert before _meta
    meta_idx = None
    for i, item in enumerate(lookup):
        if isinstance(item, dict) and "_meta" in item:
            meta_idx = i
            break
    if meta_idx is None:
        lookup.append(detailed_block)
    else:
        lookup.insert(meta_idx, detailed_block)

    with LOOKUP_FILE.open("w", encoding="utf-8") as f:
        json.dump(lookup, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main() -> None:
    text = TEXT_FILE.read_text(encoding="utf-8")
    records = parse(text)

    counts: dict[str, int] = {}
    for r in records:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    print(f"Parsed {len(records)} records:")
    for k in sorted(counts):
        print(f"  {k:22s}  {counts[k]:3d}")

    # Sanity probe
    print("\nFirst record per kind:")
    seen: set[str] = set()
    for r in records:
        if r["kind"] not in seen:
            seen.add(r["kind"])
            print(f"  [{r['kind']:18s}] {r['code']} - {r['label'][:55]}  parent={r['parent_code']}  naics3={r['naics3']}  pub={r['published']}")

    if "--no-write" in sys.argv:
        return
    merge_into_lookup(records)
    print(f"\nMerged into {LOOKUP_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
