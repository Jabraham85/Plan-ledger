# Slice coverage — how much of what a task needs reaches its brief?

Offline, zero model calls. Brain: 135 live findings (144 real Part A reports, strict_full). Tasks: 12 H3b questions × 5 needed facts = 60. The brain holds 44/60 of them (the ceiling).

| strategy | needed facts in the brief | of the ceiling | mean brief lines | mean brief chars |
|---|---|---|---|---|
| S0 whole task, top 5 (today) | 24/60 (40%) | 55% | 5.0 | 1058 |
| S1 whole task, top 10 | 33/60 (55%) | 75% | 10.0 | 2109 |
| S2 whole task, top 5, diverse | 26/60 (43%) | 59% | 5.0 | 1039 |
| S3 per part, top 1 each (5 lines) | 39/60 (65%) | 89% | 4.8 | 966 |
| S4 per part, top 1 diverse (5 lines) | 39/60 (65%) | 89% | 4.8 | 966 |
| S5 per part, top 2 each (≤10 lines) | 41/60 (68%) | 93% | 9.6 | 1913 |
| SHIPPED pickBrief (runner-lib, 5 lines) | 39/60 (65%) | 89% | 5.0 | 996 |

Needed facts the brain does not hold at all: 16 (I, J, K, L, U, V, W) — no retrieval can fix those.

**Caveats (exploratory, not pre-registered).**
- The strategies were fixed before the first run. The shipped `pickBrief` is S3 turned into code, written *after* seeing S3 win.
- These tasks are explicitly multi-part. Real steps are looser prose, so expect a smaller gain there.
- "Covers" is a pattern-plus-value match, not a judge.
- The 16 needed facts the brain never held are a *learning* gap (Part A never investigated them), not a retrieval gap.
