# Can the brain revise itself? — analysis

2026-09-23. Hypotheses: `PREREG.md` (plus Amendments A1 and A2, each written before
its run). Reports: `results/`, `results-v2/` and `results-v3/REPORT.md`. Model:
DeepSeek v4-pro. Spend: $0.84 across three versions × 3 reps. Every prompt and answer
is kept in the `rep*.json` files.

## Verdicts

| | v1 "is it provably still true?" | v2 "does the change falsify it?" | v3 "would a record-keeper still write it?" |
|---|---|---|---|
| **R1** code: deterministic detection | PASS (exact) | PASS | PASS |
| **R2** code: changed facts fixed | PASS 12/12 | PASS 12/12 | PASS 12/12 |
| **R3** code: false alarms cleared | PASS 33/33 | PASS 33/33 | PASS 33/33 |
| **R4** code: cascade | PASS 6/6 | PASS 6/6 | PASS 5/6 (see note) |
| **R5** code: brain correct afterwards (baseline 70%) | PASS 100% | PASS 100% | PASS 98% |
| story settling, confirmatory | **FAIL** 50% (dev) | **FAIL** 78% (held-out 1) | **PASS 85%** (held-out 2) |
| held-out `keep` left unchanged | — | PASS 100% | **FAIL** 86% (bar 90%) |

**Note on R4 in v3:** the one miss (F18, rep 2) is a correct revision, "they use the
same port, so a running board can block the boot-test". It failed only because it
didn't include the literal port number the pre-registered check required. It is left
as scored.

## What this shows

**1. On code, truth maintenance works, and it doesn't depend on the prompt.**

- File-hash staleness plus the one-hop cascade found every affected finding, with zero
  false flags on untouched files.
- The re-evaluator had tools to read the source. Across all 9 runs it revised every
  changed fact to the correct new value (36/36) and cleared every false alarm (99/99),
  including the derived facts reached through the cascade ("24 hours" → "12 hours",
  "different ports" → "same port").
- Without truth maintenance, 30% of the brain would have been silently wrong after
  these edits. With it, 98–100% was correct.

**2. Stories are judgment, and the question you ask decides the failure mode.**

Story facts, all flagged ones, post-hoc:

| prompt | settled right | **silently wrong** (stale fact kept) | over-edited | left suspect |
|---|---|---|---|---|
| v1 | 50% | 0 | 4 | 11 |
| v2 | 65% | **23** | 0 | 0 |
| v3 | **77%** | 4 | 8 | 12 |

- **v1** can't prove anything in a story, so it said unsure, or copied the twist into
  every fact ("the frog's father is King Aldric").
- **v2** accepted anything *possible* ("guests can still fly into Lisbon for a Porto
  wedding"). It was the **most dangerous** version: 23 stale facts kept as truth, while
  its headline score looked better than v1's.
- **v3** asks why the fact was recorded, so facts that held *because of* the old
  value follow the new one. It fixed the Lisbon→Porto and Berlin→Munich chains, frog
  hair, the vegan chef's signature dish and the retired ship's route.
  - Its remaining errors are mostly **unsure**, which is the safe failure: the fact
    stays SUSPECT and is never briefed as fact.
  - Next come over-retractions on identity twists (e.g. "Nimbus sells weather software"
    was retracted once the company "no longer exists").
  - Only 4 errors were silently wrong ("the princess danced until midnight", ×3).

**3. Detection reach is the hard limit for identity twists.**

The high-impact sweep finds facts that *name* the subject. It never found:

- "the prince kissed **her** hand" (a pronoun);
- "the heist went unnoticed by the police" (a consequence that doesn't name Marco).

Both misses were predicted before the run. Explicit dependencies (party, wedding,
office) and file links reach 100%.

## Decision

- **Ship v3** as the re-evaluation prompt. It is the best on held-out data, keeps code
  perfect, and fails mostly safe.
- **"Unsure" is a feature, not a bug.** In a story or notes app, the UI should hand
  those to the human ("3 facts may be affected by 'she's a frog' — check them?").
- Don't claim story revision is solved: 85% on held-out, and keep-precision is 86%, below
  the bar.

## Next levers (untested)

1. **Model-assisted reach:** on a high-impact fact, show the model the subject's
   neighbourhood (facts sharing a subject or scene with facts that name it) and let it
   pick what else is affected. This targets the pronoun and consequence misses.
2. **Batch re-evaluation per twist:** judge all of a twist's suspects in one call, so
   the model sees them together and stays consistent (the v2 party run revised
   "guests" but kept the caterer on Saturday).
3. A second model family as a check on story judgments.
