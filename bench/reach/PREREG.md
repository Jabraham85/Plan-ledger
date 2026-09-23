# Pre-registration — model-assisted reach (the frog rule's second half)

Written 2026-09-23, **before any run**.

## Question

The high-impact sweep only re-opens facts that **name** the subject. In
`bench/revision` it missed:

- "the prince kissed **her** hand" (a pronoun);
- "the heist went unnoticed by the police" (a consequence).

Both misses were predicted.

Model-assisted reach adds one model call per high-impact fact. The model sees every
other live fact and lists the ones the new fact affects indirectly. Does that find the
hidden facts without dragging in unrelated ones?

## Setup (fixed in advance)

- **Model:** DeepSeek v4-pro (temperature 0, no thinking, no tools).
- **Reach prompt:** `buildReachPrompt`.
- **Settling:** re-evaluation with the v3 "record-keeper" prompt.
- **Repetitions:** 3, each on a fresh store.
- **Cap:** $3.

**Development data** (seen before this design): the frog and heist stories from
`bench/revision`. Reported only.

**Held-out** (`scenarios.json`, written now): three stories. Each has one twist with
`impact: "high"` and labelled facts:

| label | meaning |
|---|---|
| `named` | names the subject; the sweep's job, reported only |
| `hidden` | refers to the subject only indirectly (pronoun, role/title, or consequence); every one must change after the twist |
| `keep` | an unrelated fact, some on the *same subjects* as hidden facts, to test precision |

| scenario | subject | twist | hidden facts |
|---|---|---|---|
| **abroad** | anna | "Anna was abroad for all of last summer" | a pronoun fact, a role fact |
| **blind** | captain reyes | "Captain Reyes lost her sight in a storm last year" | a pronoun fact, a role fact |
| **moved** | dr patel | "Dr Patel moved to Canada in January" | a pronoun fact, a role fact |

## Hypotheses (held-out only)

| id | claim | pass rule |
|---|---|---|
| **R9** | Reach finds hidden facts | ≥ **80%** of `hidden` facts re-opened, pooled over 3 reps (18 cases) |
| **R10** | Reach stays precise | ≤ **20%** of `keep` facts re-opened by reach (27 cases) |
| **R11** | End to end (descriptive) | share of `hidden` facts correctly settled (revised or retracted) after reach plus re-evaluation. Without reach this is 0% by construction |

An unparseable reach answer counts as 0 hidden facts found for that run.

## Amendment A1 — v1 results, then v2 on a NEW role-heavy held-out set (written before any v2 run)

**v1 (`results/REPORT.md`, $0.02):**

- **R10 PASS:** 0/27 unrelated facts reached.
- **R9 FAIL: 14/18 = 78%**, just below 80%.
  - Pronoun facts: 9/9 held-out, plus both dev misses (s1f, s2d) in 3/3 reps.
  - All 4 misses are **role references**: "the shopkeeper" 0/3, "the town doctor" 1/3.

**Diagnosis:** the reach prompt shows the twist but not what was already known about
the subject. The model is told "Anna was abroad" but never "Anna ran the village
shop", so it cannot know she is "the shopkeeper".

**v2:** the reach prompt also lists the recorded facts that name the subject (the
facts the sweep just flagged), as "what was known".

**Test design:**

- v1's held-out set becomes development data.
- The new held-out set is `heldout2` in `scenarios.json`, written now. Three stories
  (judge, coach, baker). Each has named facts that establish the subject's roles, one
  hidden **role** fact, one hidden **pronoun** fact, and three unrelated `keep` facts.

**Pass rules on `heldout2`:**

| id | rule |
|---|---|
| **R9′** | ≥ 80% of hidden facts reached |
| **R10′** | ≤ 20% of keep facts reached |

No further iteration will be tuned on `heldout2`.

## Amendment A2 — v2 results, then v3 (reach passes its link to re-evaluation) on held-out 3 (written before any v3 run)

**v2 (`results-v2/REPORT.md`, $0.03):**

- **R9′ PASS: 18/18** hidden facts reached.
- **R10′ PASS: 0/27** false alarms.
- Development data: 24/24 reached, 0/45 false alarms.

Reach itself is solved on these data.

**Settling afterwards** (descriptive) was only 9/18. Diagnosis from the recorded
prompts: the re-evaluator never learns *why* the fact was reached. It sees "a new
fact about Judge Okafor" next to "the presiding judge hears appeals", without the link
"the presiding judge is Okafor", so it confirms or says unsure. That is the role gap
again, one stage later.

**Label correction:** a pure role fact ("the head coach runs training on Wednesdays")
may stay true under the role's next holder, so for settling it is `either`. Only
person-bound facts, meaning pronouns and facts that name the person's own actions,
must change. Reach must still find role facts.

**v3:**

- The reach model answers `REACH: [{"id": N, "why": "<the link>"}]`.
- The link is stored with the suspect event.
- The re-evaluation prompt shows it: "this fact refers to X indirectly: <why>".

**New held-out set** (`heldout3`, written now): three stories.

- **Must change:** 2 hidden pronoun or person-bound facts per story.
- **Either** (reach must find it; not scored for settling): 1 hidden role fact.
- **Keep:** 3 unrelated facts.

**Pass rules on `heldout3`:**

| id | rule |
|---|---|
| **R9″** | ≥ 80% of hidden facts reached |
| **R10″** | ≤ 20% of keep facts reached |
| **R12** | ≥ 80% of hidden **must-change** facts end revised or retracted |
| **R13** | ≤ 10% of keep facts end changed |

No further iteration will be tuned on `heldout3`.

## Amendment A3 — v3 run 1 invalidated by a parser bug; re-run v3 unchanged (written before the re-run)

**v3 run 1 (`results-v3/`) is kept on record: R9″ FAIL 56%, R12 FAIL 56%.**

The recorded answers show the model picked **every** hidden held-out fact in all 3 reps
(9/9 per rep), each with the correct link. It wrote ids as `"#3"`, echoing the prompt's
candidate format. `parseReach` read `Number("#3")` as NaN and silently dropped them,
so those facts were never re-opened or re-evaluated. This is an implementation bug,
not model behaviour.

**Fix:** `parseReach` accepts `"#12"`, `"12"` and `12`, with a regression test. No
prompt changed.

**Re-run:** `BENCH_TAG=v3b`, the same prompts, scenarios and pass rules as v3, in
fresh reps. The verdict on `heldout3` comes from v3b. Run 1's re-parsed picks
(27/27) are noted but not used as the verdict, because settling depends on the picks
actually being applied.
