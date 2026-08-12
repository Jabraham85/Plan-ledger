# Plan-ledger R1 implementation design (C1-C4)

Status: implementation-ready design for plan 18 step 108.  
Scope: architecture, schema/data migration order, execution matrix, deterministic contracts, rollout, observability, and validation only.  
Non-goal: implementing C1-C4 in this step.

## Inputs and inspected code

Primary evidence inputs:

- `docs/audits/plan-ledger-improvement-roadmap.json`
- `docs/audits/plan-ledger-improvement-roadmap.md`
- `docs/audits/plan-ledger-artifact-verification.json`
- `docs/audits/plan-ledger-performance-results.json`

Implementation surfaces inspected:

- `src/db.mjs`
- `src/server.mjs`
- `src/ledger-cli.mjs`
- `src/dispatch-policy.mjs`
- `src/supervisor.mjs`
- `src/roles.mjs`
- `scripts/execution-governance.mjs`
- `web/server.mjs`
- `web/board.mjs`
- `web/app.mjs`
- `test/runner-unit.mjs`
- `test/dispatch-policy.mjs`
- `test/execution-governance.mjs`
- `test/live-activity-ui.mjs`
- `test/execution-lifecycle.mjs`
- `test/mcp-e2e.mjs`
- `test/board-routes.mjs`
- `test/ledger-cli.mjs`
- `benchmarks/non-planner-latency.mjs`

## Current baseline and conservative alignment

R1 roadmap intent (C1-C4) is still valid, but implementation assumptions need conservative alignment to current code:

1. C1 assumes a new completion payload persisted on `steps`/`attempts`; current code already has strong gating logic in `scripts/execution-governance.mjs` and verification disposition in `src/db.mjs`, but no first-class persisted completion contract record.
2. C2 assumes a new `reconcilePlanTerminalState(planId)` API; current system has `assessPlanTerminalization()` + done-gate enforcement (`setPlanStatus('done')`) but not auto-terminalization on every terminal step mutation.
3. C3 mostly maps to existing lease lifecycle primitives (`openExecutionLease`, `heartbeatExecutionLease`, `closeExecutionLease`, `reapStaleLeases`) and dispatch policy mismatch signaling in `src/dispatch-policy.mjs`; reason-code normalization is still incomplete across surfaces.
4. C4 assumes `/api/activity/latest`; current board/server contract already uses `/api/activity/current` and `/api/activity/recent`, and UI status states are derived in `web/index.html`/`test/live-activity-ui.mjs`.

Design decision: preserve current route names and step/plan status semantics, add new behavior behind feature flags, and avoid data rewrites that fabricate historical evidence.

## C1-C4 mapping to exact modules/functions/schema objects

### C1 - Evidence gate (machine-checkable completion contract)

Reusable existing behavior:

- `scripts/execution-governance.mjs`
  - `parseCompletionContract()`
  - `evaluateCompletionContract()`
  - `detectNoncomplianceEscalation()`
- `test/execution-governance.mjs` and `test/runner-unit.mjs` already enforce unsupported pass rejection patterns.

Required changes:

- `src/db.mjs`
  - Add `steps.completion_payload_json TEXT NOT NULL DEFAULT ''`.
  - Add `steps.completion_validated_at TEXT NOT NULL DEFAULT ''`.
  - Add `attempts.validation_status TEXT NOT NULL DEFAULT 'legacy_unknown'` with allowed values restricted to `pass|fail|legacy_unknown`.
  - Add `attempts.validation_errors_json TEXT NOT NULL DEFAULT ''`.
- `scripts/execution-governance.mjs`
  - Add deterministic error code emitter for `evaluateCompletionContract()` (see code table below).
- `src/db.mjs::recordAttempt()`
  - Persist C1 validation fields distinctly from attempt outcome fields. Validation status remains `pass|fail|legacy_unknown` and is never replaced with attempt outcome states such as `partial|blocked|cancelled`.
- `src/server.mjs` + `src/ledger-cli.mjs`
  - Extend `record_attempt` input schema/operation to carry completion contract evaluation fields for runner/dispatcher write paths.

### C2 - Terminalization integrity (auto-reconcile)

Reusable existing behavior:

- `src/db.mjs`
  - `setPlanStatus()` done-gate with `assessPlanTerminalization()` and blocker codes:
    - `steps_active`
    - `disposition_missing`
    - `lease_open`
    - `activity_non_terminal`
  - `setStepStatus()`, `recordAttempt()`, `setStepDisposition()`.
- `test/execution-lifecycle.mjs` already verifies blocker paths and forced close audit behavior.

Required changes:

- `src/db.mjs`
  - Add new internal helper: `reconcilePlanTerminalState(planId, { source, strict })`.
  - Invoke after terminal mutations in:
    - `recordAttempt()`
    - `setStepStatus()`
    - `closeExecutionLease()`
    - `setStepDisposition()`
  - Add columns to `plans`:
    - `terminal_state_reason TEXT NOT NULL DEFAULT ''`
    - `terminalized_at TEXT NOT NULL DEFAULT ''`
    - `state_integrity_version INTEGER NOT NULL DEFAULT 1`
- `src/server.mjs` + `src/ledger-cli.mjs`
  - Expose a read-only reconciliation summary operation for diagnostics (no forced mutation route needed initially).

### C3 - Dispatch/lease recovery and deterministic mismatch handling

Reusable existing behavior:

- `src/dispatch-policy.mjs::evaluateDispatchPolicy()` already computes:
  - `material_mismatch`
  - `requires_override_reason`
  - alternatives and warnings
- `src/supervisor.mjs` + `src/db.mjs` already implement lease SLA primitives and reaper contract.
- `src/roles.mjs` provides resolved model/catalog pathways.

Required changes:

- `src/db.mjs`
  - Add `execution_leases.stale_reason TEXT NOT NULL DEFAULT ''`.
  - Add `steps.auto_reassignment_count INTEGER NOT NULL DEFAULT 0`.
  - Add `step_assignments.dispatch_policy_json TEXT NOT NULL DEFAULT ''`.
- `src/supervisor.mjs`
  - Normalize close/reap reason codes to strict enum (below).
- `src/ledger-cli.mjs` + `src/server.mjs`
  - Return structured mismatch reason payload for dispatch policy override checks.

### C4 - Telemetry/board observability and health states

Reusable existing behavior:

- `src/db.mjs` activity tables (`activity_runs`, `activity_events`) and activity APIs.
- `web/board.mjs` routes:
  - `/api/activity/current`
  - `/api/activity/recent`
  - lease lifecycle endpoints.
- `test/live-activity-ui.mjs` already validates UI states: `active|blocked|verifying|stale|failed|done`.

Required changes:

- Keep `/api/activity/current` and `/api/activity/recent`; do not introduce `/api/activity/latest`.
- Add formal board health state derivation payload in API responses:
  - `healthy`
  - `awaiting_artifact`
  - `stale_lease`
  - `needs_manual_verification`
- `src/db.mjs`
  - Backfill one synthetic marker event type only:
    - `activity_backfill_missing`
  - Never synthesize full historical timelines.
- `web/index.html` render logic
  - Map deterministic server-side health state to existing UI badges without changing current status semantics.

## Deterministic error and reason code contract

### Evidence validation codes (C1)

- `completion_json_missing`
- `completion_json_invalid`
- `completion_verdict_unsupported`
- `completion_artifact_missing`
- `completion_command_failed`
- `completion_pass_unsupported_no_evidence`
- `completion_output_missing`
- `completion_contract_version_unsupported`

### Terminalization/reconciliation codes (C2)

- Preserve existing blocker codes:
  - `steps_active`
  - `disposition_missing`
  - `lease_open`
  - `activity_non_terminal`
- Add reconcile result codes:
  - `reconcile_done`
  - `reconcile_partial_due_to_deferred_gate`
  - `reconcile_blocked`
  - `reconcile_stale_dormant`
  - `reconcile_noop`

### Role/model mismatch and override codes (C3)

- `dispatch_role_material_mismatch`
- `dispatch_model_unavailable`
- `dispatch_role_unknown`
- `dispatch_role_disabled`
- `dispatch_override_reason_required`

### Lease recovery codes (C3)

- Preserve and standardize existing reasons:
  - `lease_reap_stale_heartbeat` (maps from `reap:stale_heartbeat`)
  - `lease_reap_deadline_exceeded` (maps from `reap:deadline_exceeded`)
  - `lease_cancelled_child_exit`
  - `lease_cancelled_supervisor_error`
  - `lease_cancelled_manual`

### Board health codes (C4)

- `healthy`
- `awaiting_artifact`
- `stale_lease`
- `needs_manual_verification`
- `telemetry_unavailable`

## Migration order and rollback-safe data handling

Order (single release train, additive and rollback-safe):

1. Add new nullable/defaulted columns in `attempts`, `plans`, `execution_leases`, `steps`, and `step_assignments`.
2. Deploy read/write code paths in warn mode (feature flags default to non-blocking where applicable).
3. Backfill historical records:
   - Missing completion payload provenance -> `attempts.validation_status='legacy_unknown'` (never `fail`).
   - Missing closed-step disposition remains handled as `legacy_unknown`/existing rules.
   - Missing historical activity gets only one synthetic marker `activity_backfill_missing`; do not fabricate detailed event history.
4. Enable enforce modes after validation thresholds pass.

Rollback safety:

- Rollback is flag-first, not schema-first.
- No destructive migration and no column drop in R1.
- Old binaries continue to function because new columns are optional/defaulted and ignored by older code.

## Feature flags, staged rollout, observability, rollback triggers

Feature flags:

- `PLAN_LEDGER_COMPLETION_GATE=off|warn|enforce`
- `PLAN_LEDGER_AUTO_TERMINALIZE=off|shadow|enforce`
- `PLAN_LEDGER_DISPATCH_POLICY_ENFORCE=off|warn|enforce`
- `PLAN_LEDGER_BOARD_HEALTH_BADGES=off|on`

Stage plan:

1. Stage A (warn/shadow):
   - C1 warn-only, C2 shadow reconcile logging, C3 mismatch warnings only, C4 event writes and API health state fields.
2. Stage B (limited enforce):
   - Enable C1 enforce + C2 enforce for internal cohort.
   - Enable C3 auto-reassignment max 1.
   - Enable C4 badges in board.
3. Stage C (general enforce):
   - Remove cohort restriction after passing release criteria below.

Rollback triggers:

- >2% false-positive completion-gate rejections in 20 internal completions.
- Any observed incorrect plan terminalization (`done` while blockers still present).
- Auto-reassignment churn (`auto_reassignment_count > 2` for same step in short window).
- Board startup p95 breach >120 ms for two consecutive benchmark runs.

Observability requirements:

- Persist and expose `steps.completion_payload_json`, `steps.completion_validated_at`, `attempts.validation_status`, and `attempts.validation_errors_json`.
- Emit reconcile outcome counters by code.
- Emit lease close/reap counters by standardized reason code.
- Surface board health-state distribution and stale-run counts.

## Dependency and execution matrix (plan 18 alignment)

Execution order:

1. This design artifact (current step).
2. C2 and C1 implementation can start immediately after design (parallel allowed).
3. C3 starts after C1 lands (depends on C1 error/evidence contract shape).
4. C4 starts after C1 + C3 land (depends on both validation and lease/mismatch reason codes).
5. Cross-cutting validation runs after C1-C4 are merged.

Matrix:

| Item | Depends on | Blocks |
|---|---|---|
| C1 | design | C3, C4, final validation |
| C2 | design | final validation |
| C3 | C1 | C4, final validation |
| C4 | C1 + C3 | final validation |
| cross-cutting validation | C1 + C2 + C3 + C4 | release sign-off |

## Verification ownership and exact commands

Ownership:

- C1: implementer + test-engineer (`execution-governance`, `runner-unit`)
- C2: implementer + debugger (`execution-lifecycle`, terminalization gates)
- C3: implementer + build-devops (`dispatch-policy`, lease/reaper paths)
- C4: implementer + test-engineer (`live-activity-ui`, board routes), replacing ui-designer ownership due to the audited no-artifact stall pattern.

Required verification commands:

- `node test/runner-unit.mjs`
- `node test/dispatch-policy.mjs`
- `node test/execution-governance.mjs`
- `node test/live-activity-ui.mjs`
- `node test/execution-lifecycle.mjs`
- `node test/mcp-e2e.mjs`
- `node test/board-routes.mjs`
- `node test/ledger-cli.mjs`

Concrete benchmark runner command (R1 acceptance):

- `node benchmarks/non-planner-latency.mjs --run-label "r1-governance" --samples 40 --external-samples 10 --out "docs/audits/.r1-governance-bench.json"`

Budget checks this command must satisfy in the generated output:

- evidence validation path: `<= 2 ms p95` (new C1 benchmark id to add in harness extension)
- reconcile path: `<= 5 ms p95` (new C2 benchmark id to add in harness extension)
- lease operations: `<= 2.5 ms p95` (`execution_lease_open|heartbeat|close`)
- board startup: `<= 120 ms p95` (`board_server_startup`)

## Data compatibility and non-fabrication guarantees

- Historical missing completion payloads are represented as `legacy_unknown` and not reclassified to `fail`.
- Historical activity is not fabricated; only a synthetic backfill marker event is allowed where no activity rows exist.
- Existing API consumers remain compatible because route names and baseline status vocabulary are preserved.
- New fields are additive and optional for old clients.

## Deterministic validation checks for round-1 corrections

The validation script/check must fail unless all of the following are true in this design note:

1. C1 schema includes exactly these accepted fields:
   - `steps.completion_payload_json`
   - `steps.completion_validated_at`
   - `attempts.validation_status`
   - `attempts.validation_errors_json`
2. `attempts.validation_status` is explicitly restricted to `pass|fail|legacy_unknown`.
3. The design explicitly states validation status is distinct from attempt outcomes and must not use `partial|blocked|cancelled` as validation statuses.
4. C4 ownership is explicitly `implementer + test-engineer` and explicitly replaces `ui-designer` ownership due to audited no-artifact stall behavior.
