# Findings write-back on real agent output — results

Generated 2026-09-23T02:34:00.448Z by bench/findings-real/run.mjs. Hypotheses were fixed beforehand in PREREG.md.

Spend: $0.51 over 140 calls (1 errored) — smoke $0.00, a $0.32, b $0.19

## Part A — real findings

18 agent runs → 144 findings. Parse errors: 0; run errors: 0.
Judge (opus, blind): 65 same-fact clusters. Truth: true 141 (97.9%), false 3 (2.1%).

**H2 (truthfulness ≥ 90%)**: 97.9% judged true → PASS.

Replay: 144 findings, 18 agents, 6 arrival orders, threshold 0.7 (means per order).

| route | merges | wrong merges | lost facts | fragmented facts | excess rows | false kept active | conflicts (catching a false finding) |
|---|---|---|---|---|---|---|---|
| exact | 5.0 | 0.0 (0.0%) | 0.0 | 44.0 | 74.0 | 3.0 | 0.0 (0.0) |
| near | 22.5 | 0.0 (0.0%) | 0.0 | 39.5 | 56.5 | 3.0 | 0.0 (0.0) |
| guarded | 20.5 | 0.0 (0.0%) | 0.0 | 39.5 | 58.5 | 3.0 | 2.0 (0.0) |
| full | 20.5 | 0.0 (0.0%) | 0.0 | 39.5 | 58.5 | 3.0 | 2.0 (0.0) |
| strict | 9.5 | 0.0 (0.0%) | 0.0 | 42.5 | 69.5 | 3.0 | 0.0 (0.0) |
| strict_full | 9.5 | 0.0 (0.0%) | 0.0 | 42.5 | 69.5 | 3.0 | 0.0 (0.0) |

**H1 (strict_full wrong merges ≤ 1%)**: 0.0% → PASS.

## Part B — does the brain help?

120 runs graded mechanically against hand-verified answers.

| arm | correct | mean cost | mean turns | mean input tok | mean output tok | mean time |
|---|---|---|---|---|---|---|
| NONE | 60/60 | $0.0018 | 3.1 | 4390 | 145 | 4.4s |
| BRAIN | 60/60 | $0.0013 | 2.9 | 3411 | 139 | 4.2s |

Per question (correct/runs, mean cost):

| q | NONE | BRAIN | brief had the answer? |
|---|---|---|---|
| q01 | 5/5 $0.001 | 5/5 $0.002 | yes |
| q02 | 5/5 $0.002 | 5/5 $0.002 | yes |
| q03 | 5/5 $0.001 | 5/5 $0.001 | yes |
| q04 | 5/5 $0.001 | 5/5 $0.001 | yes |
| q05 | 5/5 $0.001 | 5/5 $0.001 | yes |
| q06 | 5/5 $0.005 | 5/5 $0.001 | yes |
| q07 | 5/5 $0.001 | 5/5 $0.001 | yes |
| q08 | 5/5 $0.002 | 5/5 $0.001 | yes |
| q09 | 5/5 $0.003 | 5/5 $0.001 | no |
| q10 | 5/5 $0.001 | 5/5 $0.001 | no |
| q11 | 5/5 $0.001 | 5/5 $0.002 | yes |
| q12 | 5/5 $0.001 | 5/5 $0.001 | yes |

**H3 (BRAIN accuracy within 1 of NONE, and ≥ 25% cheaper)**: accuracy Δ +0, cost −27% → PASS.
