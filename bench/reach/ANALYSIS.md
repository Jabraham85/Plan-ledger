# Model-assisted reach — analysis

2026-09-23. Hypotheses: `PREREG.md` (plus Amendments A1–A3, each written before its
run). Model: DeepSeek v4-pro. Total spend: $0.14 over five runs.

## The problem

The frog rule's lexical sweep only re-opens facts that **name** the subject. In
`bench/revision` it missed "the prince kissed **her** hand" and "the heist went
unnoticed by the police".

## The fix, as shipped

1. **Reach.** One model call per high-impact fact (`reach()` in
   `scripts/reevaluate.mjs`).
   - **Input:** the new fact, what was recorded about the subject by name (its roles
     and titles), and every other live fact, neighbours first.
   - **Output:** `REACH: [{"id", "why"}]`, e.g. "'she' is Coach Lindqvist".
2. **The link travels.** The picked facts turn suspect, with the link stored in their
   suspect event. The re-evaluation prompt shows it ("this fact refers to X
   indirectly: …"), and the normal settling rounds fix them.

## Results

| version | held-out set | hidden reached | false alarms | must-change fixed | unrelated changed | verdict |
|---|---|---|---|---|---|---|
| v1 (twist only) | 1 | 14/18 (78%) | 0/27 | — | — | R9 **FAIL** by 2 points |
| v2 (+ what was known) | 2 | **18/18** | **0/27** | (9/18 settled, descriptive) | — | R9′ R10′ **PASS** |
| v3 run 1 (+ link) | 3 | 15/27 | 0/27 | 10/18 | 0/27 | **FAIL: parser bug** (A3) |
| **v3b (same, parser fixed)** | 3 | **27/27** | **0/27** | **18/18** | **0/27** | R9″ R10″ R12 R13 **all PASS** |

Development data under v3b: 39/42 reached, 0/72 false alarms.

## What each step taught

- **v1 → v2: roles need context.** "The shopkeeper" can't be recognised as Anna
  unless the model is told Anna ran the shop. Pronouns worked from the start.
- **v2 → v3: a found link must be passed on.** Reach knew "the presiding judge is
  Okafor", but the re-evaluator didn't, so it confirmed stale facts. Storing the link
  with the suspect event fixed settling: 18/18 must-change facts on new held-out data.
- **v3 run 1: parse the model's words, not your own format.** The model echoed the
  prompt's `#12` ids. The old parser silently dropped them, and the run failed on 2 of
  3 stories that the model had actually solved. It is kept on record, fixed with a
  regression test, and re-run.
- **Label honesty:** a pure role fact ("the head coach runs training") can stay true
  under the role's next holder, so it is `either` for settling (A2). The only
  remaining development miss, "the shopkeeper greeted every customer" after "Anna was
  abroad", is exactly that case, and arguably correct to leave.

## Limits

- The stories are short, with 6–8 facts each. Reach shows the model every live fact
  in the project, capped at 80, neighbours first. A large brain would need a
  retrieval step in front of it.
- One model family, and my labels.
- R12 counts "revised or retracted". It doesn't judge the wording of each revision,
  but the recorded revisions read correctly (e.g. "he wrote the weekly book column").
