# Pre-registration — can the brain revise itself? (truth maintenance, schema v5)

Written 2026-09-23, **before any run**. The system under test is `e27652c` plus the
re-evaluation worker (`scripts/reevaluate.mjs`, `scripts/brain-llm.mjs`).

## Question

When something the brain knows changes, does it:

1. **find** everything that was built on it,
2. **fix** what became false,
3. **leave alone** what is still true,

so that the brain is still correct afterwards?

## Setup (fixed in advance)

- **Model:** re-evaluation by DeepSeek v4-pro (temperature 0, thinking off). For code
  facts it has read-only tools; for stories it has none.
- **Repetitions:** 3 per scenario, each on a fresh store and a fresh copy of the code.
- **Cap:** $5. Analysis cost is normalized to off-peak rates.
- **Scenarios:** listed in `scenarios.json`. All labels were written before any run.

### Part C — code (`code` in `scenarios.json`)

- **Findings:** 20 hand-written findings about the frozen plan-ledger snapshot, each
  with `file:line` evidence, absorbed with `root` = the working copy. Two further
  findings have **no file link** and rest on others through `depends_on`:
  - F7, the 24-hour retry window, rests on F1 and F2;
  - F18, the ports don't clash, rests on F16 and F17.
- **Edits:** five, applied together:
  - E1: `--max-retries` default 48 → 24;
  - E2: `busy_timeout` 3000 → 5000;
  - E3: boot-test port 4399 → 4319;
  - E4: a comment-only change to `runner-lib.mjs`;
  - E5: `--permission-mode` default `acceptEdits` → `default`.
- **Pipeline:** then `checkStale()`, then `reevaluate()`.
- **Labels:** each finding is labelled `change` (with an acceptable verdict set and
  required/forbidden values for a revision) or `keep` (acceptable verdict:
  `confirmed`).

### Part S — stories (`stories` in `scenarios.json`)

Three scenarios. Labels: `change`, `keep`, or `either` (genuinely ambiguous; reported,
never scored).

| scenario | kind of twist | twist |
|---|---|---|
| **frog** | identity, `impact: high` | "the princess is actually a frog" |
| **heist** | identity, `impact: high` | "Marco is an undercover police officer" |
| **party** | explicit dependency chain, normal impact | the date slot is superseded, Saturday → Sunday |

## Hypotheses and pass rules

| id | claim | pass rule |
|---|---|---|
| **R1** | Deterministic detection (code) | `checkStale` flags **100%** of findings on edited files, and **0** on untouched files, in every rep |
| **R2** | Correct settling (code) | ≥ **90%** of flagged findings labelled `change` get an acceptable verdict, with the right value |
| **R3** | False alarms cleared (code) | ≥ **90%** of flagged findings labelled `keep` are `confirmed` (not wrongly revised or retracted) |
| **R4** | The cascade works (code) | F7 and F18 are re-opened **and** correctly settled in ≥ **5 of 6** (rep × finding) cases |
| **R5** | The brain is correct afterwards (code) | ≥ **95%** of live findings are true after the loop. The baseline with no truth maintenance is 14/20 = 70% |
| **R6** | Story settling | ≥ **80%** of flagged `change`/`keep` story facts settled acceptably |
| **R7** | Frog-rule reach (descriptive, no verdict) | recall of `change` facts, lexical name match only. **Predicted misses:** `s1f` ("kissed **her** hand", which uses a pronoun) and `s2d` (a consequence that doesn't name Marco). Predicted recall 6/8 |

Unparseable model answers count as failures for R2, R3, R4 and R6. Any settling that
is unsure counts as a failure.

## Known limits

- Hand-written findings about a single snapshot, one model family, 3 reps.
- The story labels encode *my* reading of each twist. That is why ambiguous facts are
  labelled `either` and not scored.
- File-level staleness is coarse by design: every finding on an edited file is
  re-opened. R3 measures how well the model clears those false alarms.

## Amendment A1 — results v1, then a pre-registered fix tested on held-out stories (written before any v2 run)

**v1 results (`results/REPORT.md`):**

- **Code: R1–R5 all PASS**, with perfect scores. Detection was exact, 12/12 changed
  facts were revised with the right values, 33/33 false alarms were confirmed, the
  cascade worked 6/6, and the brain ended 60/60 correct against a 70% baseline.
- **Stories: R6 FAIL (15/30 = 50%).** R7 = 18/24 = 75%, exactly as predicted (s1f, s2d).

**Diagnosis, from the recorded prompts and answers:**

1. **Defaulting to "unsure".** When a fact is unaffected but can't be *proven*, the model
   says unsure: s2g, s3e and s1e. With tools on code, it can check the file; in a story
   it can't check anything.
2. **Annotation creep.** It rewrites still-true facts to mention the twist: "the frog's
   father is King Aldric", "Marco drove the getaway van as part of an undercover
   police operation". The v1 grader also accepted this as a valid "change" for s1b,
   which was too lenient. The true v1 story score is therefore below 50%.

**Fix (v2 prompt, `buildReevalPrompt`):** the minimal-change principle from belief
revision.

- The question is "does the new information make this fact false or misleading?", not
  "can you prove it is still true?".
- The new information is already recorded, so it is never copied into other facts.
- `unsure` is only for a real possible contradiction that can't be decided.

**Test design** (the fix was tuned on the v1 stories, so they are development data only):

- **Held-out stories** (`heldout` in `scenarios.json`, written before any v2 run):
  - **wedding:** explicit dependencies, normal impact;
  - **allergy:** high impact;
  - **acquisition:** high impact.
- **Stricter labels:** a `change` revision must drop the contradicted content
  (`mustNot`).
- **Runs:** 3 reps of v2 on code (regression check), the dev stories (descriptive
  only), and the held-out stories (confirmatory).

**Pass rules for v2:**

| id | rule |
|---|---|
| **R2–R5 (code, regression)** | must still meet the v1 thresholds |
| **R6′** | ≥ 80% of flagged `change`/`keep` **held-out** facts settled acceptably |
| **R8** (new) | ≥ 90% of flagged `keep` facts (held-out) are **confirmed** unchanged, i.e. no annotation creep |

## Amendment A2 — v2 results, then v3 on a NEW held-out set (written before any v3 run)

**v2 results (`results-v2/REPORT.md`):**

- **Code: R1–R5 PASS again** (perfect).
- **R8 PASS:** held-out `keep` facts were confirmed unchanged 18/18. Annotation creep is fixed.
- **R6′ FAIL: 28/36 = 78%**, below the 80% bar.

v2 *under*-revises. From the recorded reasons, it treats logical possibility as enough:
"guests fly into Lisbon airport" was confirmed after the wedding moved to Porto,
because "it only states the arrival airport". "Marco is loyal to the crew" was
confirmed because "loyalty can coexist with being undercover".

**Lesson:** "can you prove it's still true?" (v1) fails, and so does "does the change
logically falsify it?" (v2). The right question is about *why the fact was recorded*:
"knowing the new information, would a careful record-keeper still write this fact
the same way?"

- A fact recorded **because of** the old value follows the new one.
- An independent fact is left exactly as it is.

**v3 prompt:** the record-keeper question, keeping the no-annotation rule from v2.

**Data status:** the v2 held-out set (wedding / allergy / acquisition) has now been seen,
so it becomes **development** data. The **new held-out set** is `heldout2` in
`scenarios.json`, written before any v3 run:

| scenario | kind of twist |
|---|---|
| **office** | explicit dependencies, normal impact |
| **vegan** | high impact |
| **ship** | high impact |

**v3 pass rules:**

| id | rule |
|---|---|
| **Code R2–R5** | must still pass |
| **R6″** | ≥ 80% on `heldout2` |
| **R8″** | ≥ 90% of `heldout2` `keep` facts confirmed unchanged |

No further prompt iterations will be tuned on `heldout2`.
