# BLS Series ID Format Research — May 3, 2026

## Executive Summary

Complete breakdown of Series ID formats for three major BLS survey programs.

## 1. OE — OCCUPATIONAL EMPLOYMENT AND WAGE STATISTICS

### Format: 25 Characters
- **Pos 1-2:** Survey code = "OE"
- **Pos 3:** Seasonal adj = "U" (always unadjusted)
- **Pos 4:** Area type = letter (N/S/M/B/D)
- **Pos 5-11:** Area code = 7-digit (0000000=national)
- **Pos 12-17:** Industry code = 6-digit (000000=cross-industry)
- **Pos 18-23:** Occupation code = 6-digit SOC (e.g., 151211)
- **Pos 24-25:** Datatype code = 2-digit (01-15)

### Area Type Codes
| N | National |
| S | State |
| M | Metropolitan Statistical Area |
| B | Metropolitan Division |
| D | Department of Defense |

### Datatype Codes (01-15)
| 01 | Total employment |
| 02 | Employment RSE |
| 03 | Mean hourly wage |
| 04 | Mean annual wage |
| 05 | Mean wage RSE |
| 06-10 | 10th, 25th, 50th, 75th, 90th percentile hourly |
| 11-15 | 10th, 25th, 50th, 75th, 90th percentile annual |

### Example: OEUN000000000000015121101
OE + U + N + 0000000 + 000000 + 151211 + 01
= National employment of Software Developers (SOC 15-1211)

Source: memory/2026-04-15.md, src/ui/oe-drilldown.html

## 2. CE — CURRENT EMPLOYMENT STATISTICS

### Format: 20 Characters
- **Pos 1-2:** Survey code = "CE"
- **Pos 3:** Seasonal adj = "S" (SA) or "U" (NSA)
- **Pos 4-8:** State FIPS code = 5-digit (00000=US)
- **Pos 9-14:** Area code = 6-digit (000000=state level)
- **Pos 15-16:** Supersector = 2-digit (00=total, 05=construction, 06=manufacturing, etc.)
- **Pos 17-18:** Industry detail = 2-digit
- **Pos 19-20:** Datatype = 2-digit (01-10)

### Datatype Codes
| 01 | All employees (thousands) |
| 02 | Average weekly hours |
| 03 | Average hourly earnings |
| 04 | Average weekly earnings |
| 09 | Private production/nonsupervisory employees |

### Supersector Codes
| 00 | Total nonfarm |
| 05 | Construction |
| 06 | Manufacturing |
| 07 | Trade, Transportation, Utilities |
| 08 | Information |
| 09 | Financial Activities |
| 10 | Professional and Business Services |
| 11 | Education and Health Services |
| 12 | Leisure and Hospitality |
| 13 | Other Services |

### Examples
- **CES0000000001:** Total nonfarm, all employees (SA)
- **CES0500000001:** Construction, all employees (SA)
- **CEU0600000003:** Manufacturing, average hourly earnings (NSA)

## 3. LN — LABOR FORCE STATISTICS (CPS)

### Format: 12 Characters
- **Pos 1-2:** Survey code = "LN"
- **Pos 3:** Seasonal adj = "S" (SA) or "U" (NSA)
- **Pos 4-6:** Series code = 3-digit (020=unemployment rate, 030=employment, etc.)
- **Pos 7-10:** Demographic = 4-digit (0000=total, 0100=men, 0200=women, etc.)
- **Pos 11-12:** Reserved = "00"

### Series Codes
| 001 | Labor force level |
| 020 | Unemployment rate |
| 030 | Employment level |
| 040 | Not in labor force |
| 050 | Employment-population ratio |
| 060 | Labor force participation rate |

### Demographic Codes
| 0000 | Total, 16+ years |
| 0100 | Men, 16+ years |
| 0200 | Women, 16+ years |
| 0300 | 16-19 years |
| 0400 | 20+ years |
| 0500 | White |
| 0600 | Black or African American |
| 0700 | Asian |
| 0800 | Hispanic ethnicity |
| 1000 | Less than high school |
| 1100 | High school, no college |
| 1200 | Some college |
| 1300 | Bachelor's degree+ |

### Examples
- **LNU02000000:** Unemployment rate, all persons (NSA)
- **LNS14000000:** Civilian employment (SA)
- **LNU02200002:** Unemployment rate, women (NSA)

## API Information

**Endpoint:** https://api.bls.gov/publicAPI/v2/timeseries/data/
**Registration:** https://data.bls.gov/registrationEngine/
**Rate Limit:** 500/day without key, 120/minute with key
**Max Series per Request:** 50

## Metadata Files (BLS Download Center)

OE: https://download.bls.gov/pub/time.series/oe/
CE: https://download.bls.gov/pub/time.series/ce/
LN: https://download.bls.gov/pub/time.series/ln/

Each has .series, .datatype, and lookup tables (rate-limited access).

