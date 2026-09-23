# Findings write-back on real agent output — analysis

2026-09-22. Companion to `REPORT.md` (auto-generated, pre-registered verdicts) and
`../PREREG.md` (hypotheses plus Amendments 1–2). Everything below the "Pre-registered
verdicts" section is **post-hoc**: it is exploration, not confirmation. It must not
be used to retune the default on this same data without held-out validation.

## Setup

- **Agents:** DeepSeek v4-pro through a read-only agent loop over a frozen plan-ledger
  snapshot.
- **Judge:** 6 blind Claude Opus subagents (a different model family from the agents).
- **Part A:** 18 investigations → 144 findings.
- **Part B:** 12 hand-verified questions × 2 arms × 5 reps = 120 graded runs.
- **Spend:** $0.51 of DeepSeek, of which Part A was $0.32 and Part B $0.19; the judges
  ran in-session. Zero budget stops. One errored call: the smoke test that sent a
  comment line as the key, before the parser fix. It cost $0.

## Pre-registered verdicts

| hypothesis | rule | result | verdict |
|---|---|---|---|
| **H1** dedup safety | `strict_full` wrong merges ≤ 1% | 0.0% (0 of 9.5 merges, 6 arrival orders) | **PASS** |
| **H2** truthfulness | ≥ 90% judged true | 97.9% (141/144) | **PASS** |
| **H3** value | accuracy within 1 **and** ≥ 25% cheaper | 60/60 vs 60/60; −27.2% cost | **PASS on the point estimate — statistically inconclusive** (below) |

**Judge reliability.** I hand-checked a seeded random sample of 10 "true" labels plus
all 3 "false" labels against the snapshot code: **13/13 agreement**. The 3 false
labels each caught a subtle error: a stage count that contradicts its own list; "a
missing line returns an error reason" when it actually returns `error: null`; and
"non-object items → empty findings" when valid objects are in fact kept. That is not
rubber-stamping.

## H3 is not robust

A question-level bootstrap (10,000 resamples):

| metric | saving | 95% CI | P(saving > 0) | P(saving ≥ 25%) |
|---|---|---|---|---|
| cost | 27.2% | [−2.7%, 48.6%] | 0.96 | **0.52** |
| input tokens | 22.3% | [−9.7%, 44.4%] | 0.90 | 0.40 |
| turns | 6.5% | [−2.9%, 14.9%] | 0.91 | 0.00 |

- The saving comes from 4 of 12 questions (q04 −51%, q06 −73%, q08 −35%, q09 −54%).
  On 5 questions the brief *added* cost (+4% to +38%), because it adds tokens.
- **Turns barely change.** Agents re-verify the brief instead of trusting it — the
  agent prompt says "never guess, check it".
- **Ceiling effect.** The NONE arm was already 60/60 at about 3 turns. These
  questions are one grep away, so there was little discovery cost to save.

**Honest reading:** the brain probably saves something (P = 0.96 that it saves
more than zero) and never hurt accuracy. At this n the 25% bar is a coin flip.
The workload was too easy to show the brain's intended value.

## Contract compliance, and a production bug this experiment found

Only **7 of 18** agents followed the FINDINGS/VERDICT contract exactly. The failures:

- 4 agents glued `VERDICT` onto the end of the FINDINGS array.
- 4 put `FINDINGS:` mid-line after prose.
- 3 omitted the VERDICT.

Under the original strict parser, **44% of findings would have been silently
dropped (80/144)**, and **10 of 18 steps recorded as FAIL** by the production runner.
The parser was hardened (Amendment 2): the FINDINGS array is bracket-matched
anywhere, string-aware, and cut out before the VERDICT search. The result: 144/144
findings recovered and 15/18 verdicts recovered. A truly missing VERDICT still fails.
This is the most valuable product outcome of the experiment.

## Dedup on real data: safe, but conservative (post-hoc)

At 0.7 on real data, **no route made a wrong merge**, not even the unguarded one. But
`strict_full` caught only about 9.5 of the ~79 possible merges. It stores **~135
rows for 65 true facts (≈2× bloat)**.

**Why:** 76% of true same-fact pairs share an identical subject and 100% share the
same file, so subject naming is a minor factor. The main limit is paraphrase: real
same-fact pairs have a median claim similarity of only **0.57**, and only 30% reach
0.7. The **substitution guard** (added from the synthetic benchmark) blocks most
real paraphrases, because real paraphrases swap words:

| route @ threshold | real: merges / wrong / excess rows | synthetic: wrong merges / current kept |
|---|---|---|
| strict_full @ 0.3–0.7 | 9.5–11 / **0** / 68–70 | **0** / 100% |
| guarded @ 0.4 | 34.5 / **0** / 44.5 (12.5 conflicts, all false alarms) | **32** / 90% |
| near @ 0.4 | 46.7 / **0** / 32.3 | **160** / 61% |
| near @ 0.3 | 55.8 / 0.5 (0.9%) / 23.2 | 160 / 61% |

The two benchmarks disagree:

- **Real data:** the substitution guard costs about 2× bloat and prevented **zero**
  real errors in this sample.
- **Synthetic data:** it prevents 32 constructed wrong merges (one-word-different
  distinct facts).

144 real findings did not contain that adversarial pattern, but absence at this n
does not prove it is rare.

**Other observations:**

- **Conflict detection catches no false findings.** All 3 false findings stayed
  active on every route. The guarded routes' conflicts are false alarms — plausibly
  from line numbers inside claims tripping the number guard. That hypothesis is
  untested.
- **Snapshot artifact.** t4 agents report that `sea-config.json` is missing. That
  is true for the snapshot, which omitted the file, and false for the live repo.

## Recommendations

1. **Keep `strict_full` @ 0.7 as the default.** It passed the pre-registered test,
   and never merged wrongly on either benchmark. Accept ≈2× bloat for now; recall
   still finds the facts.
2. **Ship the parser hardening.** It is already in `scripts/runner-lib.mjs` with 10
   regression cases. It fixes silent loss and false FAILs in production.
3. **Validate a less conservative route on held-out data before changing any
   default.** Candidate: `guarded` at ≈0.4–0.5, with a number guard that ignores line
   references. Run a fresh Part A (new topics, ~$0.35) plus a blind judge, and require
   0 wrong merges on both benchmarks.
4. **Re-test H3 on a harder workload** (multi-hop, where discovery costs 10+ turns).
   Add a prompt arm that trusts non-conflicted findings, to see whether re-verification
   is what eats the saving.
5. **Replicate with Claude agents** (`BENCH_PROVIDER=claude`) once the CLI login is
   fixed. H2 and H3 magnitudes here are DeepSeek-specific.
