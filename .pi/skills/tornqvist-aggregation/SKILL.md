---
name: tornqvist-aggregation
description: "Aggregate disaggregated manufacturing series into a superlative real-output (or price) index using the Törnqvist formula — the geometric average of Laspeyres and Paasche, weighted by the average of period-t and period-(t-1) nominal-value shares. Use when you have nominal value (M3 shipments) per industry plus a price deflator (BLS PPI) per industry and need a theoretically-defensible aggregate consistent with productivity accounting. Replaces a Laspeyres-IPI proxy as the target variable in the industry-output-nowcast skill."
---

# Törnqvist Aggregation Skill

This skill chains disaggregated nominal-value series and per-industry price
deflators into a real-output (or price) Törnqvist index. The same recipe with
prices and quantities swapped produces the Törnqvist price index.

The index is *superlative*: exact for the translog flexible functional form, so
it provides a second-order approximation to any underlying aggregator. BLS, BEA,
OECD, and Statistics Canada all use Törnqvist for productivity accounts.

---

## 1. The formula

For an aggregate built from `i = 1..N` industries:

```
ΔlnQ_t  =  Σᵢ ½(s_{i,t} + s_{i,t-1}) · Δln(q_{i,t})
```

where:

- `q_{i,t} = nominal_{i,t} / (PPI_{i,t} / 100)` — real value of industry `i` at time `t`
- `s_{i,t} = nominal_{i,t} / Σⱼ nominal_{j,t}` — industry `i`'s share of total *nominal* value at time `t`
- `Δln(q_{i,t}) = ln(q_{i,t}) − ln(q_{i,t-1})`

Chain to get the index level:

```
Q_t  =  Q_{t-1} · exp(ΔlnQ_t)         with  Q_0 = 100
```

Swap `q` for `p` (a price relative) to get the **price** Törnqvist instead. The
two satisfy the *factor-reversal* property approximately (exact only for the
Fisher index).

---

## 2. Inputs this skill expects

| Asset | Where it lives | Notes |
|---|---|---|
| Disaggregated nominal values, monthly | Census M3 EITS API; codes from `data/lookups/m3_series.json` `_detailed.records` (`kind = subsector` or `kind = detail`) | NSA, `data_type_code = VS` (Value of Shipments). Use the 21 NAICS-3 subsectors (`*S`) as the default aggregation level. |
| Industry price deflators, monthly | BLS PPI API (`PCU*` series IDs from `data/lookups/ppi_series.json`) | NSA. One series per NAICS-3 subsector. 20 of 21 subsectors have a true `PCU<NAICS3>---<NAICS3>---` industry-group series; NAICS 316 (Leather) falls back to `PCU3162--3162--` (Footwear proxy). |
| Annual benchmark for cross-check | ASM `RCPTOT` / `VALADD` by NAICS-3 | Use `create_asm_chart` or direct Census ABS/ASM API; aligns at year-end. |

**Frequency alignment:** both inputs are monthly NSA, so no alignment beyond
joining on (year, month). For a monthly Törnqvist, set the period to one month.
For an annual Törnqvist, sum 12 months of nominals and use a December (or
annual-average) PPI.

---

## 3. The recipe in pandas

```python
import json
import pandas as pd
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # data/scripts/<this>.py

with (ROOT / "data/lookups/m3_series.json").open() as f:
    m3 = json.load(f)
detailed = next(item["_detailed"] for item in m3 if "_detailed" in item)

with (ROOT / "data/lookups/ppi_series.json").open() as f:
    ppi = json.load(f)

# Pick aggregation level. NAICS-3 subsectors are the default — 21 components.
subsectors = [r for r in detailed["records"] if r["kind"] == "subsector"]
assert len(subsectors) == 21

# nominals: DataFrame index=(year, month), columns=M3 code, values=$M
nominals = fetch_m3_nsa(
    codes=[r["code"] for r in subsectors],
    data_type="VS",
    start_year=2003, end_year=2025,
)

# deflators: DataFrame index=(year, month), columns=NAICS-3, values=PPI level
deflators = fetch_bls_ppi(
    series_ids=[ppi["by_naics3"][r["naics3"]]["ppi_industry_group"] for r in subsectors],
    start_year=2003, end_year=2025,
)

# Map M3 code -> NAICS-3 to align column names
code_to_naics3 = {r["code"]: r["naics3"] for r in subsectors}
deflators.columns = [code_to_naics3[c] for c in nominals.columns]  # after re-ordering

# 1. Real values (q): nominal / (PPI / 100)
real = nominals / (deflators / 100.0)

# 2. Nominal shares (s_{i,t})
total_nominal = nominals.sum(axis=1)
shares = nominals.div(total_nominal, axis=0)

# 3. Period-to-period log relative of real values
log_rel = np.log(real / real.shift(1))

# 4. Average of period-t and period-(t-1) shares
avg_share = (shares + shares.shift(1)) / 2.0

# 5. Weighted log-relative → ΔlnQ_t
dlnQ = (avg_share * log_rel).sum(axis=1)

# 6. Chain to a level series, base = 100 at first period
index = 100.0 * np.exp(dlnQ.fillna(0.0).cumsum())
index.iloc[0] = 100.0

# 7. Persist as CSV + a model_card.json
index.to_csv("tornqvist_real_output_mfg.csv")
```

A reference implementation lives in `data/scripts/tornqvist_aggregate.py`
(create on first use; reuse thereafter).

---

## 4. Output contract

Every Törnqvist run emits **three** artifacts:

1. **`tornqvist_index.csv`** — `date, index_level, dlnQ` columns. `role: dataset-csv`.
2. **`tornqvist_components.csv`** — long format: `date, component_code, nominal, deflator, real_value, share`. `role: dataset-csv`.
3. **`model_card.json`** — `role: statistical-analysis`. Fields:

```json
{
  "method": "Törnqvist real-output index",
  "components": { "level": "NAICS-3 subsector", "count": 21, "codes": ["21S","27S",...] },
  "period": "2003-01 to 2025-12 (monthly)",
  "data_sources": {
    "nominals": "Census M3 EITS API, data_type=VS, NSA",
    "deflators": "BLS PPI industry-group series, NSA (one per NAICS-3)"
  },
  "base_period": "2003-01 = 100",
  "caveats": [
    "PPI proxy for NAICS 316 is Footwear only (PCU3162--3162--).",
    "12 of 21 PPI series begin in 2003; trimming to 2003-01 keeps the panel balanced.",
    "COVID-period weight instability: months 2020-04 to 2020-06 have extreme share shifts; consider a regime dummy or trim those months from the chain when computing year-over-year comparisons.",
    "Detail-level Törnqvist (using kind=detail records, not subsectors) requires more granular PPI series (PCU at NAICS-4/5/6) that this skill's default lookup does not provide."
  ]
}
```

---

## 5. Caveats and known issues

### 5.1 The M3 SA freeze does not affect this skill

M3 SA is frozen 2026-01 onward, but Törnqvist aggregation uses **NSA** nominals
on both sides of the deflation. The output is also NSA. If you need a SA
Törnqvist, run `seasonal-adjustment` on the *output* series, not the inputs.

### 5.2 NAICS revision splice (2017)

BLS PPI rebased some industry classifications in 2017. For long-run charts that
span the splice, document the break and consider modelling it with a
`regime-dummies` indicator. Within a single revision era the chain is fine.

### 5.3 Weight instability around COVID

April-June 2020 has extreme shifts in nominal shares (e.g., petroleum collapsed,
food spiked). The two-period average smooths this somewhat, but a pure Törnqvist
will still inherit the instability. For productivity work, the standard practice
is to either (a) trim April-June 2020 from the chain or (b) interpolate the
shares using a 12-month moving average over the surrounding 2019/2021 months.
State the choice in the model card.

### 5.4 Detail-level aggregation needs a richer PPI lookup

The default lookup matches one PPI per NAICS-3 subsector. Detail-level
Törnqvist (using `kind=detail` records) needs `PCU` series at NAICS-4/5/6,
which exist in `data/bls_pc_series.tsv` but are not pre-mapped. Either:

- Extend `data/lookups/ppi_series.json` with a `by_naics_detail` section, or
- Aggregate the detail-level nominals up to NAICS-3 first, then Törnqvist.

The second is simpler and lossless for the purpose of building total-mfg or
total-durable indexes.

---

## 6. Where this skill plugs into the pipeline

| Downstream skill / tool | What it consumes | What changes |
|---|---|---|
| `industry-output-nowcast` | Has been targeting IPI (Laspeyres). With Törnqvist available, use `tornqvist_real_output_mfg.csv` as the target series. Improves theoretical defensibility for productivity analysis. |
| `seasonal-adjustment` | Optional post-processing if a SA Törnqvist is wanted. |
| `regime-dummies` | The COVID and NAICS-revision dummies belong on the *output* Törnqvist series if you regress against it. |
| `create_fred_chart` | Use to overlay our Törnqvist output against FRED `IPMAN` and quantify the Laspeyres-vs-Törnqvist gap (substitution-bias diagnostic). |

---

## 7. Quick start checklist

1. Confirm both lookups exist: `data/lookups/m3_series.json` (with `_detailed`) and `data/lookups/ppi_series.json`.
2. Set `CENSUS_API_KEY` and `BLS_API_KEY` env vars (without keys you get rate-limited fast on long ranges).
3. Create `data/scripts/tornqvist_aggregate.py` from §3 above the first time.
4. Run it with `start_year=2003` (the year when 12 of 21 PPI series begin) and the current year.
5. Emit the three artifacts in §4.
6. Spot-check: plot `index_level` against FRED `IPMAN` (Laspeyres IPI) for the same date range. They should be close but diverge during periods of large relative-price shifts.

---

## 8. Provenance

- Törnqvist (1936) original definition: `Bank of Finland Monthly Bulletin`.
- Diewert (1976) "Exact and superlative index numbers" — proved superlative property.
- BLS Multifactor Productivity methodology: aggregates output and inputs with Törnqvist. See `https://www.bls.gov/mfp/mprtech.pdf`.
- BEA/BLS Integrated Industry-Level Production Account uses Törnqvist throughout.
