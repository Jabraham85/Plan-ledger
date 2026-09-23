# H3b — the harder H3 test: analysis

2026-09-23. Companion to `REPORT-H3b.md` (auto-generated) and `../PREREG-H3b.md`
(hypotheses, plus Amendment A1). Setup: DeepSeek v4-pro agents on the same frozen
snapshot and the same 144-finding brain, 12 questions × 3 arms × 5 reps = 180 graded
runs. Spend was $1.19 for H3b (pilots $0.20 + confirmatory $0.99); the whole benchmark
now totals $1.69 of the $15 cap.

## Pre-registered verdicts

| hypothesis | accuracy | cost saving | 95% CI | verdict |
|---|---|---|---|---|
| **H3b-1** BRAIN vs NONE | 60/60 vs 60/60 | 18.9% | [−4.8%, 37.1%] | **FAIL** (below 25%; the CI includes 0) |
| **H3b-2** TRUST vs NONE | 60/60 vs 60/60 | 11.4% | [−22.7%, 34.7%] | **FAIL** |
| **H3b-3** trust safety | TRUST 60 vs BRAIN 60 | — | — | safe (no accuracy loss) |

**Difficulty bar not met** (required disclosure under A1): pilot v1 averaged 3.2
turns and was replaced; pilot v2 averaged 3.9 turns, against a bar of 6. The
five-value, multi-file questions cost 40% more than v1, but DeepSeek issues several
tool calls per turn, so the work stays at about 4 rounds.

**Grader disclosure:** the first report showed 2 wrong answers (h11 none/r2, trust/r4).
In both the agent had glued a duplicate answer onto its line
(`…4399ANSWER: 4, 500, 8, 30, 4399`). The line-based regex captured both copies, which
does not follow the pre-registered "last `ANSWER:` anywhere" rule. After the grader
was fixed to split on the marker, both answers are correct. The fix changes no
verdict.

## What the data says

1. **The brain reliably reduces work, but not by enough, and not in dollars.**
   BRAIN cut **turns by 18.4%, CI [6.0%, 29.1%]**. That is the first effect in this
   benchmark whose interval excludes zero. The cost saving (18.9%) is similar in
   size, but its CI crosses 0: the brief adds input tokens to every turn, and
   per-question cost varies a lot.
2. **The "agents re-verify the brief" hypothesis is not supported.** TRUST barely
   changed behaviour (3.1 vs 3.2 turns) and was *more* expensive than BRAIN (its input
   tokens were 12.4k vs 10.7k, driven by one outlier question, h11). Telling agents to
   trust the findings did not make them trust more. What limits the saving is that the
   **retrieved brief only contains about half the needed facts** (median 2/5 answer
   values present). The agent still has to look up the rest.
3. **Accuracy was never hurt** by any arm, on either test (360 graded runs in total,
   0 accuracy regressions).

## Both tests together (post-hoc, descriptive)

| test | questions | cost saving | P(saving > 0) | P(saving ≥ 25%) |
|---|---|---|---|---|
| H3 (easy) | 12 single-fact | 27.2% | 0.96 | 0.52 |
| H3b (multi-file) | 12 five-fact | 18.9% | 0.94 | 0.26 |

Consistent picture: **a real but modest saving, roughly 15–25%, and never harmful.**
The pre-registered bar of "≥ 25% with an interval above zero" is not met on this
workload.

## Why the ceiling is low here, and what would move it

- **Discovery is cheap in this setting.** The codebase is small (~a dozen files),
  heavily commented, and the agent reads 400 lines per call. NONE only needs about
  4 rounds at $0.003, so there is little to save.
- **Retrieval coverage is the bottleneck, not trust.** The top 5 findings rarely
  hold every fact a multi-part question needs. The obvious lever is a larger brief
  (for example, the top 10), but that adds tokens. The trade-off is untested.
- **Generalisation is untested.** The brain's value should grow with the cost of
  discovery: larger repositories, expensive models (Claude Opus/Sonnet via the CLI,
  once `claude setup-token` is re-run), and agents that read narrowly.

## Recommendation

Keep the findings write-back **on**: it is safe (H1, H2, H3b-3) and cheaper in
expectation. Do **not** claim the 25% saving. Do not ship the TRUST prompt line: it
did not help. Next, if wanted: (a) a brief-size arm (top 5 vs top 10) on these same
v2 questions, about $1; (b) a Claude-agent replication; (c) a larger codebase.
