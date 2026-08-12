# R1 Rollout and Rollback Runbook (C1-C4)

This runbook describes the actual feature flags and durable-data behavior implemented in the current codebase.

## Flag stages

- C2 terminalization: `PLAN_LEDGER_AUTO_TERMINALIZE=off -> shadow -> enforce`
- C1 completion gate: `PLAN_LEDGER_COMPLETION_GATE=off -> warn -> enforce`
- C3 stale recovery: `PLAN_LEDGER_AUTO_REASSIGN=off -> advisory -> enforce`
- C4 board health badges: `PLAN_LEDGER_BOARD_HEALTH_BADGES=off -> on`

## Recommended rollout order

1. Deploy additive schema/app code with conservative defaults (`shadow`/`warn`/`off`/`off`).
2. Enable C4 event writes first (already always-on in code paths), then turn on UI badges with `PLAN_LEDGER_BOARD_HEALTH_BADGES=on`.
3. Move C2 from `off` to `shadow`; watch reconcile result codes and blocker mix.
4. Move C1 from `off` to `warn`; verify validation failures are surfaced and tracked.
5. Move C3 from `off` to `advisory`; verify proposed recoveries before enforcement.
6. Move C2/C1/C3 to enforce modes only after release validation is green.

## Monitoring signals

- Completion validation status mix: `pass | fail | legacy_unknown` via `assess_completion_backfill`.
- Reconciliation blockers/result codes via `assess_plan_reconciliation` and `assess_plan_terminalization`.
- Lease stale reasons and recovery actions through execution lease/activity telemetry.
- Health state distribution: `healthy | awaiting_artifact | stale_lease | needs_manual_verification`.
- Release lane command: `npm run validate:r1-release`.

## Stop conditions

- New false-positive completion gate failures that block valid pass attempts.
- Any plan incorrectly moved to `done` while strict blockers remain.
- Auto-reassignment churn (`max_auto_reassignments` exhausted repeatedly on the same step).
- Local C4 perf budget failures (append/startup/meta/plans/detail p95 over budget).

## Rollback procedure

1. First rollback is flag-only:
   - `PLAN_LEDGER_AUTO_REASSIGN=off`
   - `PLAN_LEDGER_COMPLETION_GATE=warn` (or `off` for emergency)
   - `PLAN_LEDGER_AUTO_TERMINALIZE=shadow` (or `off`)
   - `PLAN_LEDGER_BOARD_HEALTH_BADGES=off`
2. Re-run `npm run validate:r1-release` or targeted suites to confirm stabilization.
3. Only perform code rollback if behavior remains incorrect with conservative flags.

## Schema compatibility and durable data

- Current migrations are additive/idempotent; no destructive column drops are required for rollback.
- Historical `legacy_unknown` must be preserved as historical ambiguity; rollback must not rewrite these rows.
- Historical `activity_backfill_missing` markers are append-only audit evidence; rollback must not rewrite/remove them.

## Mandatory writes that are not flag-disableable

- Activity event/run writes in execution paths are mandatory in current implementation.
- C4 backfill marker semantics (`activity_backfill_missing`) are part of durable telemetry history.
- There is no implemented activity sampling flag. Do not claim sampling-based rollback.
- Disabling these mandatory writes requires code rollback, not environment toggles.
