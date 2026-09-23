# H3b — does the brain help on hard questions?

Generated 2026-09-23T02:56:19.235Z. Hypotheses fixed beforehand in PREREG-H3b.md.

Spend to date: $1.69 total — smoke $0.00, a $0.32, b $0.19, h3b-pilot $0.20, h3b $0.99

## Pilot (calibration only; excluded from every verdict)

NONE ×1: 12/12 correct, mean turns **3.9** (hard if ≥ 6), mean cost $0.0047.

| q | ok | turns | cost | answer |
|---|---|---|---|---|
| h01 | ✓ | 4 | $0.0025 | 4319, 3000, 2, 20, 112 |
| h02 | ✓ | 4 | $0.0046 | 4399, 4, 30, 500, 96 |
| h03 | ✓ | 4 | $0.0059 | 350, 10, 48, 10, 64 |
| h04 | ✓ | 4 | $0.0046 | 20, 5, 2, 12, 4 |
| h05 | ✓ | 3 | $0.0034 | 8,20,20,2,4319 |
| h06 | ✓ | 4 | $0.0044 | 4, 3000, 4399, 30, 500 |
| h07 | ✓ | 4 | $0.0047 | 3, 8, 5, 20, 48 |
| h08 | ✓ | 4 | $0.0057 | 4, 64, 12, 600000, 4319 |
| h09 | ✓ | 5 | $0.0063 | 96, 10, 2, 20, 48 |
| h10 | ✓ | 3 | $0.0027 | 0.7, 20, 2, 112, 350 |
| h11 | ✓ | 4 | $0.0075 | 4,500,8,30,4399 |
| h12 | ✓ | 4 | $0.0040 | 4, 5, 12, 3000, 64 |

## Confirmatory run

180 runs, graded mechanically.

| arm | correct | mean cost | mean turns | mean input tok | mean output tok | mean time |
|---|---|---|---|---|---|---|
| NONE | 60/60 | $0.0030 | 3.9 | 13083 | 520 | 8.9s |
| BRAIN | 60/60 | $0.0025 | 3.2 | 10743 | 483 | 7.8s |
| TRUST | 60/60 | $0.0027 | 3.1 | 12373 | 474 | 7.8s |

| comparison | metric | saving | 95% CI | P(>0) | P(≥25%) |
|---|---|---|---|---|---|
| BRAIN vs NONE | cost | 18.9% | [-4.8%, 37.1%] | 0.94 | 0.26 |
| BRAIN vs NONE | turns | 18.4% | [6.0%, 29.1%] | 1.00 | 0.12 |
| BRAIN vs NONE | tin | 17.9% | [-13.5%, 42.2%] | 0.88 | 0.31 |
| TRUST vs NONE | cost | 11.4% | [-22.7%, 34.7%] | 0.78 | 0.16 |
| TRUST vs NONE | turns | 19.2% | [2.3%, 31.9%] | 0.98 | 0.23 |
| TRUST vs NONE | tin | 5.4% | [-54.9%, 43.2%] | 0.61 | 0.27 |

| q | NONE | BRAIN | TRUST | answer values present in brief (numbers; may be coincidental) |
|---|---|---|---|---|
| h01 | 5/5 $0.002 3.8t | 5/5 $0.002 3.0t | 5/5 $0.002 3.0t | 2/5 values |
| h02 | 5/5 $0.004 3.8t | 5/5 $0.003 3.0t | 5/5 $0.002 3.0t | 1/5 values |
| h03 | 5/5 $0.007 4.6t | 5/5 $0.003 3.0t | 5/5 $0.004 3.4t | 3/5 values |
| h04 | 5/5 $0.003 4.0t | 5/5 $0.003 3.0t | 5/5 $0.002 3.0t | 4/5 values |
| h05 | 5/5 $0.002 3.0t | 5/5 $0.002 3.0t | 5/5 $0.003 3.0t | 3/5 values |
| h06 | 5/5 $0.002 4.2t | 5/5 $0.002 3.0t | 5/5 $0.002 3.0t | 2/5 values |
| h07 | 5/5 $0.002 4.0t | 5/5 $0.001 2.0t | 5/5 $0.001 2.0t | 2/5 values |
| h08 | 5/5 $0.002 4.0t | 5/5 $0.003 4.0t | 5/5 $0.003 3.0t | 3/5 values |
| h09 | 5/5 $0.004 5.0t | 5/5 $0.003 3.0t | 5/5 $0.003 2.6t | 3/5 values |
| h10 | 5/5 $0.001 3.0t | 5/5 $0.002 3.4t | 5/5 $0.002 3.2t | 1/5 values |
| h11 | 5/5 $0.004 3.4t | 5/5 $0.004 4.0t | 5/5 $0.008 5.6t | 1/5 values |
| h12 | 5/5 $0.002 4.0t | 5/5 $0.002 3.8t | 5/5 $0.002 3.0t | 2/5 values |

**H3b-1 (BRAIN vs NONE)**: accuracy 60 vs 60 ✓; saving 18.9% ✗; CI lower -4.8% ✗ → **FAIL**.

**H3b-2 (TRUST vs NONE)**: accuracy 60 vs 60 ✓; saving 11.4% ✗; CI lower -22.7% ✗ → **FAIL**.

**H3b-3 (trust safety)**: TRUST 60 vs BRAIN 60 correct → safe.
