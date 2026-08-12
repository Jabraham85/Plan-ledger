# Plan-ledger improvement roadmap (evidence-ranked)

Generated for plan #17 step #105.

## Artifacts

- `docs/audits/plan-ledger-improvement-roadmap.json`
- `docs/audits/plan-ledger-improvement-roadmap.md`
- `docs/audits/validate-plan-ledger-roadmap.mjs`

## Scope and evidence

This roadmap ranks material system improvements across:

- data/state integrity and terminalization
- execution leases, dispatch policy, and stale recovery
- evidence and review gates
- recovery and carry-forward hygiene
- CLI/bridge architecture
- board telemetry and status visibility
- local latency

Primary evidence inputs:

- `docs/audits/plan-ledger-cross-plan-census.json`
- `docs/audits/plan-ledger-cross-plan-census.md`
- `docs/audits/plan-ledger-retrospective.json`
- `docs/audits/plan-ledger-retrospective.md`
- `docs/audits/plan-ledger-artifact-verification.json`
- `docs/audits/plan-ledger-artifact-verification.md`
- `docs/audits/plan-ledger-performance-results.json`
- `docs/audits/plan-ledger-performance.md`

Headline facts used for scoring:

- Retrospective outcomes: 1 worked-as-designed, 8 worked-after-correction, 2 partial, 5 stale.
- Repeated pitfalls include completion-contract omissions (10), role/task mismatch (5), terminal-state drift (5), legacy verification gaps, no activity telemetry across 101 steps, deferred/manual gates, and carry-forward hygiene.
- Artifact audit classes: 10 implemented-and-verified, 3 partially-implemented, 1 claim-not-supported, 2 unverifiable.
- Local performance p50/p95 highlights: board startup 103.76/117.28 ms; warm CLI round trip 73.04/76.88 ms; local roster 14.54/16.31 ms.
- External startup latency stays separate: cursor/model calls are roughly 1.0-1.4 seconds p50 and are not mixed into local product latency claims.

## Transparent scoring formula

Each candidate is scored 1-5 per factor:

- observed frequency
- user impact
- risk reduction
- measured time saved
- implementation effort (inverted)
- migration risk (inverted)
- confidence

Weights:

- frequency `0.20`
- impact `0.20`
- risk reduction `0.20`
- time saved `0.15`
- effort inverse `0.10`
- migration inverse `0.10`
- confidence `0.05`

Formula:

`score_0_to_100 = 20 * (0.2*F + 0.2*I + 0.2*R + 0.15*T + 0.1*(6-E) + 0.1*(6-M) + 0.05*C)`

## Ranked candidates (all material areas)

| Rank | ID | Area | Score | Selected R1 | Evidence anchor |
| --- | --- | --- | ---: | --- | --- |
| 1 | C1-evidence-gate | evidence and review gates | 91 | yes | `plan-ledger-retrospective.json#/pitfalls/0` |
| 2 | C2-terminalization-integrity | data/state integrity and automatic terminalization | 84 | yes | `plan-ledger-retrospective.json#/headline_counts/stale`; census inventory contradictions |
| 3 | C4-telemetry-board-observability | board and telemetry | 79 | yes | `plan-ledger-retrospective.json#/pitfalls/4`; census activity=0 |
| 4 | C3-dispatch-lease-recovery | execution leases + dispatch/role resolution | 77 | yes | `plan-ledger-retrospective.json#/pitfalls/1`; `performance-results.json` handoff p50 |
| 5 | C6-legacy-verification-backfill | evidence and review gates | 67 | no | `plan-ledger-retrospective.json#/pitfalls/3` |
| 6 | C5-recovery-carry-forward | recovery and carry-forward | 59 | no | `plan-ledger-retrospective.json#/pitfalls/6` |
| 7 | C8-local-latency-tuning | latency | 55 | no | `performance-results.json#/analysis/top_three_local_bottlenecks/0` |
| 8 | C7-cli-bridge-architecture | CLI/bridge architecture | 54 | no | `performance-results.json#/analysis/fixed_overhead/implied_cli_work_overhead_p50_ms` |

## First release selection (max four)

Release name: **R1 governance-and-recovery foundation**

Selected items:

- `C1-evidence-gate`
- `C2-terminalization-integrity`
- `C3-dispatch-lease-recovery`
- `C4-telemetry-board-observability`

Why this set:

- The repeated highest-frequency failures are evidence omissions, stale-state contradictions, and stalled/mismatched execution paths.
- These four changes work as one chain: enforce completion contract -> reconcile plan state -> auto-recover stale execution -> make all state transitions visible.
- Lower-ranked items (`C7`, `C8`) are useful but do not address the dominant correctness and governance failure modes first.

## Implementation-ready R1 detail

### C1 - Evidence gate

- **Target behavior:** No step can be accepted/done without schema-valid completion payload and required evidence fields.
- **Contracts/schema:** add `completion_payload_v2`; add step/attempt validation fields.
- **Migration/backfill:** annotate historical rows with validation status only; backfill legacy missing payloads as `legacy_unknown` (not `fail`); do not rewrite records.
- **Acceptance tests:** invalid payload rejection, terminalization block on failed validation, legacy missing-payload rows map to 100% `legacy_unknown` and 0 `fail`, validation p95 <= 2 ms.
- **Rollout/rollback:** warn mode -> enforce mode with `PLAN_LEDGER_COMPLETION_GATE`; fast rollback to warn.
- **Budget:** local validation overhead <= 2 ms p95; no external model dependency.

### C2 - Terminalization integrity

- **Target behavior:** every terminal step mutation triggers automatic plan reconciliation in-transaction.
- **Contracts/schema:** add `reconcilePlanTerminalState(planId)` and terminal reason enum.
- **Migration/backfill:** one-shot reconcile for plans #1-#16; preserve historical step content.
- **Acceptance tests:** zero active+all-steps-done contradictions; deferred gate yields partial status; reconcile p95 <= 5 ms.
- **Rollout/rollback:** shadow reconcile logs first; gate with `PLAN_LEDGER_AUTO_TERMINALIZE`.
- **Budget:** reconciliation <= 5 ms p95; board query latency remains in current envelope.

### C3 - Dispatch + lease stale recovery

- **Target behavior:** dispatch uses task-modality policy; stale leases trigger reason-coded auto-reassignment.
- **Contracts/schema:** add dispatch policy contract and lease SLA contract; add reassignment reason codes.
- **Migration/backfill:** initialize new counters only; append-only future assignment evidence.
- **Acceptance tests:** task-fit role score >= 1 point over mismatched role in fixture; stale lease auto-reassignment fires; lease operations p95 <= 2.5 ms.
- **Rollout/rollback:** advisory scoring first, then limited auto-reassign cohort.
- **Budget:** policy eval <= 1 ms p95, lease ops <= 2.5 ms p95; external startup still separated.

### C4 - Telemetry + board visibility

- **Target behavior:** assignment lifecycle always emits activity events and board shows concise health/recovery badges.
- **Contracts/schema:** required activity event fields; add board activity/status endpoint; status badge vocabulary.
- **Migration/backfill:** insert synthetic backfill marker for historical missing activity rows without fabricating timelines.
- **Acceptance tests:** >= 4 ordered lifecycle events; stale lease badge visible within <= 1 refresh cycle; activity append p95 <= 1 ms while board startup remains <= 120 ms p95.
- **Rollout/rollback:** event writes first, then feature-flagged badge rendering.
- **Budget:** event append <= 1 ms p95; no external model dependency.

## Performance budgets and expected benefits

Local budgets:

- Keep board startup <= 120 ms p95 (baseline 117.28 ms p95).
- Keep warm CLI round trip within current budget while governance checks run (baseline 76.88 ms p95).
- Keep lease and activity write paths within low-single-digit ms p95.

Expected directional benefits (not guarantees):

- Evidence-gate rework reduction: about 150 minutes per 16-plan cohort (10 failures x 15 min).
- Terminalization drift triage reduction: about 50 minutes per 16-plan cohort (5 stale plans x 10 min).
- Dispatch stale/mismatch reduction: about 49 minutes per 16-plan cohort (5 incidents x 25% of 38.88-minute p50 first-attempt delay).
- Telemetry-aided diagnosis reduction: about 100 minutes per 16-plan cohort (10 correction episodes x 10 min).

## Validator command and verbatim output

Command:

```text
node "docs/audits/validate-plan-ledger-roadmap.mjs"
```

Verbatim output:

```text
OK: roadmap valid with 8 ranked candidates, 4 selected first-release items, and measurable acceptance checks for every selected item.
```

## Limitations

- This roadmap is constrained to supplied audit artifacts and benchmark reports; no new production instrumentation run was executed here.
- Time-saved numbers are transparent planning estimates, not SLA commitments.
- Historical handoff timings include human/external-agent latency and are intentionally kept separate from local product performance claims.
