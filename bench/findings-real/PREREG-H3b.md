# Pre-registration — H3b: does the brain help on HARD questions?

Written 2026-09-22, **before any H3b run**. Follows `PREREG.md` (H1–H3) and
`results-deepseek/ANALYSIS.md`.

## Why

H3 passed on its point estimate (−27% cost) but was statistically inconclusive:
the 95% CI was [−2.7%, 48.6%]. Two identified causes:

1. **Ceiling.** The questions were one grep away — the NONE arm took ~3 turns — so
   there was little discovery cost to save.
2. **Re-verification.** Agents checked the brief instead of using it; turns fell only
   6.5%.

H3b changes exactly those two things.

## Setup (fixed in advance)

**Unchanged from Amendment 1:**

- Agents: DeepSeek v4-pro through the same read-only agent loop and the same frozen
  snapshot.
- The same brain: all 144 Part A findings absorbed with `strict_full`.
- The same brief: `formatFindingLines(queryFindings({ query: question, limit: 5 }))`,
  exactly what the runner injects.

**New:**

- **Questions:** `questions-h3b.json` — 12 multi-hop questions, each needing two to
  four linked facts (defaults × loop bounds, verdict → status transitions, control
  flow across functions, PE-header offsets). Every answer was verified by hand
  against the snapshot before any run. Grading is mechanical from the last
  `ANSWER:` line (the question types are defined in the file).
- **Arms:**
  - **NONE:** as in Part B.
  - **BRAIN:** the runner brief, as deployed.
  - **TRUST:** the same brief plus one sentence: *"These findings were recorded by
    earlier agents that verified them against this code (in a blind audit, 98% were
    correct). Use them directly as facts: only read the code for what they do not
    cover, or for anything marked CONFLICT."* The 98% figure is the real H2 result.
- **Repetitions:** 5 per question per arm → 180 runs, with arm order rotated per
  question.
- **Pilot (declared; excluded from every verdict):** the NONE arm, one run per
  question. Its purpose is calibration only: the workload counts as "hard" if NONE
  mean turns ≥ 6. If it is below 6, easier questions are replaced *before* the
  confirmatory run and the replacement is documented here. If the pilot shows a
  question whose answer key looks wrong, the key is re-checked against the code,
  never against the agent.
- **Cost normalization:** DeepSeek bills 2× at peak hours. Every run records whether it ran at
  peak, and analysis cost is computed at off-peak rates (peak cost ÷ 2), so time of day cannot
  bias one arm against another. Actual spend still counts against the cap.
- **Cap:** the running $15 total for the whole benchmark (currently $0.51 spent).

## Hypotheses

Verdicts use a **question-level bootstrap** (10,000 resamples). Unlike H3, a pass
now also requires a robust interval.

**H3b-1 — the brain as deployed (BRAIN vs NONE).** Accuracy non-inferior (BRAIN
≥ NONE − 2 correct of 60) **and** mean cost saving ≥ 25% **and** the 95% CI lower
bound of the saving > 0.

**H3b-2 — the brain trusted (TRUST vs NONE).** The same three criteria.

**H3b-3 — safety of trust (secondary, descriptive).** TRUST vs BRAIN accuracy,
plus a count of wrong TRUST answers whose brief contained a finding judged false
or a CONFLICT flag. If TRUST is less accurate than BRAIN by more than 2 of 60,
the trust instruction is unsafe to deploy, whatever it saves.

**Descriptive:** turns, input and output tokens, wall time per arm, and whether each
question's brief contained the answer.

## Known limits

Same snapshot, same model family, 12 questions. The questions are about topics
Part A investigated — the brain's intended use case, knowledge reuse — so this is
a best case for coverage. It is a harder test of *value*, not a test of generality.

## Amendment H3b-A1 — the pilot rejected v1 (recorded before any v2 data)

Pilot v1 (NONE ×1, $0.08): 12/12 correct, **mean 3.2 turns**, which is below the pre-set
"hard" bar of 6. Per the pilot rule, the questions were replaced before any confirmatory
run. v1 is kept as `questions-h3b-v1-too-easy.json`, and its pilot as
`results-deepseek/h3b-pilot-v1/`.

Why v1 was easy: each question sat in one file, the read tool returns 400 lines per call,
and the code comments often state the answer outright.

**v2 (`questions-h3b.json`):** 12 questions, each asking for **five numeric values from
three to five different files** (runner, runner-lib, db, build-exe, strip-signature,
web/app). Every value was hand-verified against the snapshot, with the `file:line` given
in `why`.

Grading type `seq`: the numbers in the last `ANSWER:` line must equal the five expected
values, in order. All five must be right; there is no partial credit.

Only the questions changed. Arms, repetitions, hypotheses, the bootstrap and the pass
rules are all unchanged. A second pilot (NONE ×1) re-checks the ≥ 6-turn bar. If v2 also
falls short, the confirmatory run still proceeds, and the report must state that the
difficulty bar was not met.
