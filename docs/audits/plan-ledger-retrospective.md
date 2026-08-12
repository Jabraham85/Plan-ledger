# Plan-ledger cross-plan retrospective

## Scope and method

This retrospective classifies each historical plan (#1–#16) once, using only
`docs/audits/plan-ledger-cross-plan-census.json` and its companion Markdown.
The current audit plan (#17) is excluded. “Stale” describes ledger state; it
does not assert that a product or agent failed. “Worked after correction” means
the plan completed only after a documented material correction, reassignment,
rescue, or failed/partial attempt.

## Headline findings

- **1/16** worked as designed (#1).
- **8/16** worked after correction (#3–#6, #9–#10, #12–#13).
- **2/16** are partial (#14–#15), with explicit deferred/manual verification.
- **5/16** are stale (#2, #7, #8, #11, #16).
- **0/16** are classified malfunctioned, blocked, or unknown at the plan level.

The most consequential repeated issue is not an evidenced product failure: it
is incomplete execution evidence. Ten failed/partial attempts explicitly cite
missing terminal evidence, missing `COMPLETION_JSON`, absent artifacts, or
unreturned wrappers. The evidence record also has **0 activity rows across 101
steps**, so silent execution/state-machine behavior cannot be reconstructed
reliably.

## Plan classifications

| Plan | Outcome | Fact basis | Evidence |
| --- | --- | --- | --- |
| #1 | worked-as-designed | Done 3/3; one pass attempt per step. | census JSON plan #1; census MD “Plan #1” |
| #2 | stale | Active 0/4; no attempts, leases, or activity. | census JSON plan #2; census MD “Plan #2” |
| #3 | worked-after-correction | Done 8/8; #12 had two failed capture attempts before orchestrator repair. | census JSON plan #3 steps #12, #14; census MD “Plan #3” |
| #4 | worked-after-correction | Done 8/8; security/implementation corrections and a stalled runner were recovered. | census JSON plan #4 steps #19, #22; census MD “Plan #4” |
| #5 | worked-after-correction | Done 6/6; #24 and #28 artifact-free specialist timeouts were reassigned. | census JSON plan #5 steps #24, #28; census MD “Plan #5” |
| #6 | worked-after-correction | Done 8/8; #30–#34 repeatedly lacked required evidence/terminal reports before checklist recovery. | census JSON plan #6 steps #30–#34; census MD “Plan #6” |
| #7 | stale | Draft 0/4 with no execution evidence. | census JSON plan #7; census MD “Plan #7” |
| #8 | stale | All five steps done but plan still active; census flags `active_plan_all_steps_done`. | census JSON plan #8; census MD “Plan #8” |
| #9 | worked-after-correction | Done 7/7; #48, #50, #51, and #52 record partial/noncompliant or failed dispatches, then correction. | census JSON plan #9 steps #48, #50, #51, #52; census MD “Plan #9” |
| #10 | worked-after-correction | Done 6/6; #58 performance dispatch made no artifact, then implementer built benchmark evidence. | census JSON plan #10 step #58; census MD “Plan #10” |
| #11 | stale | Three of four done; #63 remains in progress without attempts, leases, or activity. | census JSON plan #11; census MD “Plan #11” |
| #12 | worked-after-correction | Done 8/8 and verified; multiple steps record acceptance/review corrections. | census JSON plan #12 steps #66, #71; census MD “Plan #12” |
| #13 | worked-after-correction | Done 8/8; #73 recovered from AWS-auth block and #74 remediated ENI rollout capacity. | census JSON plan #13 steps #73, #74; census MD “Plan #13” |
| #14 | partial | All steps done, but #79 is deferred and retains a manual viewport-QA gate. | census JSON plan #14 steps #76, #79; census MD “Plan #14” |
| #15 | partial | All steps done, but #88 records a blocked reshoot and #92 defers full re-audit after changed footage. | census JSON plan #15 steps #88, #92; census MD “Plan #15” |
| #16 | stale | All eight steps verified but plan remains active; census flags `active_plan_all_steps_done`. | census JSON plan #16; census MD “Plan #16” |

## Common pitfalls

| Pitfall | Frequency | Impact | Representative IDs | Facts | Inference |
| --- | ---: | --- | --- | --- | --- |
| Completion-contract/evidence omissions | 10 documented failed or partial attempts | High | #5/#24, #6/#30–#34, #9/#48/#50/#51/#52 | Records explicitly cite missing `COMPLETION_JSON`, terminal output, artifacts, or acceptance items. | Require a deterministic checklist and evidence validator before accepting research/audit work. |
| Role/model mismatch or stalled specialist dispatch | 5 recoveries | High | #5/#24, #5/#28, #9/#52, #10/#58, #3/#12 | Nominal specialist dispatches made no usable artifact or missed implementation needs; implementer/orchestrator recovery succeeded. | Dispatch should weigh proven artifact-producing task fit over title alone. |
| Terminal-state drift | 5 plans | Medium | #2, #7, #8, #11, #16 | #8/#16 are active with all steps done; #2/#7 have never started; #11 has an inactive final step. | Automatically assess terminalization after every terminal event. |
| Legacy verification/artifact provenance gap | 54 `legacy_unknown` done steps; 101/101 zero claimed artifacts | High | #1/#1, #3/#12, #11/#60 | Census reports these values directly. | Treat historical passes as useful, but not artifact-verified proof without backfill. |
| Activity/lease observability gap | 0 activity records across 101 steps | Medium | #12/#65, #14/#76, #15/#86, #16/#94 | Later plans have leases; no plan has activity rows. | Missing telemetry limits root-cause analysis; it is not evidence of inactivity. |
| Deferred/manual verification | 2 plans | High | #14/#79, #15/#92 | Both records name outstanding verification work and use deferred disposition. | Keep the parent plan visibly partial until a named owner supplies evidence. |
| Carry-forward hygiene | 1 explicit malformed value | Low | #15/#91 | Carry-forward is literally `undefined`. | Validate carry-forward shape and require a next-owner summary. |

## What worked

Facts:

- Focused reassignment worked repeatedly: #5/#24 and #5/#28 reassigned
  artifact-free specialist work to implementers; #10/#58 did the same for
  benchmark construction.
- Manual rescue did not have to discard useful work: #3/#12 preserved good
  screenshots while replacing invalid captures; #9/#48–#51 preserved partial
  documents and applied narrow corrections.
- Explicit checks constrained overclaiming: #6 recovered with a 27-row
  machine-checkable checklist; #14 and #15 recorded residual manual/deferred
  gates instead of claiming unconditional completion.

Inference:

- The most reliable recovery loop is: preserve valid partial artifacts, state a
  short correction list, assign a task-fit executor, then run deterministic
  acceptance checks.

## Silent malfunctions, blocks, and stale state

Facts:

- #8 and #16 have all steps complete but retain active plan status.
- #14 has complete step status but deferred visual QA; #15 has packaged media
  but deferred final re-audit and residual quality concerns.
- #13/#73 was temporarily blocked by expired AWS credentials, then recovered.
- #4/#22 and #5/#24/#28 include runner/stall behavior with no timely usable
  report.

Inference:

- State-machine malfunction cannot be concluded from the activity gap because
  the census records no activity for any plan. Status drift, however, is
  directly observable and should be handled separately from execution failure.

## Limitations

- This is a read-only analysis of the supplied census. It did not inspect
  product worktrees, external services, media, or the production database.
- Claimed artifacts are ledger claims; the census does not prove their paths
  still exist.
- Missing attempts, leases, activity, roles, models, or artifacts mean missing
  recorded evidence, not automatic failure.
- One plan-level classification necessarily compresses mixed step-level
  outcomes; the JSON artifact retains the per-plan fact basis and references.

## Validation

Run:

```text
node docs/audits/validate-plan-ledger-retrospective.mjs
```

Expected successful output:

```text
OK: 16/16 plans classified with evidence references; 7 pitfalls include frequency, impact, and representatives.
```
