// stale-recovery.mjs — focused C3 integration coverage for stale lease recovery.
// Run: node test/stale-recovery.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); } finally {
    if (prev == null) delete process.env[name];
    else process.env[name] = prev;
  }
}

function makeStore(tag) {
  const dbPath = join(tmpdir(), `plan-ledger-stale-${tag}-${process.pid}-${Date.now().toString(36)}.db`);
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  const store = new Store(dbPath);
  return { store, dbPath };
}

function closeStore(store, dbPath) {
  try { store.close(); } catch {}
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
}

function seedStep(store, title = 'Recover stale lease') {
  const plan = store.createPlan({ title });
  const step = store.addStep(plan.id, {
    title: 'Implement guarded stale recovery',
    context: 'Apply implementation changes and run tests.',
    acceptance_criteria: 'Code patch + passing tests.',
    role: 'architect',
  });
  store.setPlanStatus(plan.id, 'active');
  return { plan, step };
}

// Enforce mode: stale heartbeat closes lease and appends fallback assignment.
{
  const { store, dbPath } = makeStore('stale-timeout');
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'enforce', () => {
    const { plan, step } = seedStep(store);
    const opened = store.openExecutionLease({
      plan_id: plan.id,
      step_id: step.id,
      executor: 'test-stale',
      stale_after_ms: 5_000,
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer', 'debugger'],
      },
      lease_policy: {
        first_artifact_deadline_ms: 60_000,
        heartbeat_interval_ms: 20_000,
        stale_after_ms: 5_000,
        max_auto_reassignments: 2,
      },
      override_reason: 'explicit architect override for test',
    });
    const pastIso = new Date(Date.now() - 30_000).toISOString();
    store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(pastIso, opened.lease.id);
    const reaped = store.reapStaleLeases({
      now_ms: Date.now(),
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer', 'debugger'],
      },
      lease_policy: {
        first_artifact_deadline_ms: 60_000,
        heartbeat_interval_ms: 20_000,
        stale_after_ms: 5_000,
        max_auto_reassignments: 2,
      },
      override_reason: 'explicit architect override for test',
    });
    const afterLease = store.getExecutionLease(opened.lease.id);
    const afterStep = store.getStep(step.id);
    const latestAssignment = afterStep.assignments.at(-1);
    check('stale heartbeat closes lease with lease_timeout reason code',
      reaped.reaped_count === 1
      && afterLease.status === 'closed'
      && afterLease.stale_reason === 'lease_timeout');
    check('stale heartbeat returns step to retryable pending state', afterStep.status === 'pending');
    check('auto-reassignment appends reason-coded fallback assignment with policy snapshot',
      afterStep.assignments.length >= 2
      && latestAssignment.reason.includes('[role_mismatch|lease_timeout]')
      && typeof latestAssignment.dispatch_policy_json === 'string'
      && latestAssignment.dispatch_policy.dispatch_policy?.task_modality === 'implementation');
    check('reassignment reason_code records role_mismatch while retaining lease trigger',
      reaped.reaped[0].recovery.reason_code === 'role_mismatch'
      && /reap:stale_heartbeat/.test(reaped.reaped[0].recovery.lease_trigger || ''));
    check('auto_reassignment_count increments after appended reassignment', afterStep.auto_reassignment_count === 1);
  });
  closeStore(store, dbPath);
}

// First-artifact deadline miss emits artifact_deadline_miss.
{
  const { store, dbPath } = makeStore('artifact-deadline-miss');
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'enforce', () => {
    const { plan, step } = seedStep(store, 'Artifact deadline plan');
    const opened = store.openExecutionLease({
      plan_id: plan.id,
      step_id: step.id,
      executor: 'test-deadline',
      deadline_ms: 30_000,
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer'],
      },
      lease_policy: { first_artifact_deadline_ms: 100, max_auto_reassignments: 2 },
      override_reason: 'deadline recovery policy',
    });
    const reaped = store.reapStaleLeases({
      now_ms: Date.now() + 10_000,
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer'],
      },
      lease_policy: { first_artifact_deadline_ms: 100, max_auto_reassignments: 2 },
      override_reason: 'deadline recovery policy',
    });
    const afterLease = store.getExecutionLease(opened.lease.id);
    check('first-artifact deadline miss emits artifact_deadline_miss',
      reaped.reaped_count === 1
      && reaped.reaped[0].stale_reason === 'artifact_deadline_miss'
      && afterLease.stale_reason === 'artifact_deadline_miss');
  });
  closeStore(store, dbPath);
}

// Overall deadline remains lease_timeout and is independent of first-artifact deadline.
{
  const { store, dbPath } = makeStore('overall-deadline');
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'enforce', () => {
    const { plan, step } = seedStep(store, 'Overall deadline plan');
    const opened = store.openExecutionLease({
      plan_id: plan.id,
      step_id: step.id,
      executor: 'test-overall-deadline',
      deadline_ms: 100,
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer'],
      },
      lease_policy: { first_artifact_deadline_ms: 60_000, max_auto_reassignments: 2 },
      override_reason: 'overall deadline policy',
    });
    const reaped = store.reapStaleLeases({ now_ms: Date.now() + 10_000 });
    const afterLease = store.getExecutionLease(opened.lease.id);
    check('overall deadline breach emits lease_timeout (not artifact_deadline_miss)',
      reaped.reaped_count === 1
      && reaped.reaped[0].reason === 'reap:deadline_exceeded'
      && reaped.reaped[0].stale_reason === 'lease_timeout'
      && afterLease.stale_reason === 'lease_timeout');
  });
  closeStore(store, dbPath);
}

// First-artifact deadline does not fire after artifact evidence is present.
{
  const { store, dbPath } = makeStore('artifact-before-deadline');
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'enforce', () => {
    const { plan, step } = seedStep(store, 'Artifact before deadline plan');
    const opened = store.openExecutionLease({
      plan_id: plan.id,
      step_id: step.id,
      executor: 'test-artifact-before',
      deadline_ms: 60_000,
      lease_policy: { first_artifact_deadline_ms: 100, stale_after_ms: 300_000, max_auto_reassignments: 2 },
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer'],
      },
      override_reason: 'artifact arrives before deadline',
    });
    store.heartbeatExecutionLease(opened.lease.id, {
      artifact_count: 1,
      recent_artifacts: ['docs/audits/evidence.txt'],
      action_summary: 'first artifact produced',
    });
    const reaped = store.reapStaleLeases({ now_ms: Date.now() + 10_000 });
    const afterLease = store.getExecutionLease(opened.lease.id);
    check('artifact evidence before deadline suppresses artifact_deadline_miss',
      reaped.reaped_count === 0 && afterLease.status === 'open');
  });
  closeStore(store, dbPath);
}

// Limit enforcement + advisory/off modes.
{
  const { store, dbPath } = makeStore('limits-modes');
  const { plan, step } = seedStep(store, 'Modes plan');
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'enforce', () => {
    const first = store.openExecutionLease({
      plan_id: plan.id, step_id: step.id, executor: 'lim-1', stale_after_ms: 5_000, override_reason: 'limit test baseline override',
    });
    store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(new Date(Date.now() - 30_000).toISOString(), first.lease.id);
    store.reapStaleLeases({
      now_ms: Date.now(),
      dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
      lease_policy: { max_auto_reassignments: 1 },
      override_reason: 'first enforced retry',
    });
    const afterFirst = store.getStep(step.id);
    check('first enforced reassignment succeeds under max limit', afterFirst.auto_reassignment_count === 1 && afterFirst.assignments.length >= 2);

    const second = store.openExecutionLease({
      plan_id: plan.id, step_id: step.id, executor: 'lim-2', stale_after_ms: 5_000, override_reason: 'limit test second override',
    });
    store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(new Date(Date.now() - 30_000).toISOString(), second.lease.id);
    const limited = store.reapStaleLeases({
      now_ms: Date.now(),
      dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
      lease_policy: { max_auto_reassignments: 1 },
      override_reason: 'second enforced retry',
    });
    const afterSecond = store.getStep(step.id);
    check('max_auto_reassignments is enforced and returns deterministic manual recovery',
      limited.reaped[0].recovery.reason === 'max_auto_reassignments_exhausted'
      && afterSecond.auto_reassignment_count === 1);
  });

  // enforce mode: append failure rolls back close/reset/reassignment/count atomically.
  const rollbackStep = store.addStep(plan.id, {
    title: 'Rollback enforce step',
    context: 'Implementation task with stale lease for rollback check.',
    acceptance_criteria: 'rollback coverage',
    role: 'architect',
  });
  store.snapshotStepAssignment(rollbackStep.id, { assigned_by: 'test' });
  const rollbackOpen = store.openExecutionLease({
    plan_id: plan.id,
    step_id: rollbackStep.id,
    executor: 'rollback',
    stale_after_ms: 5_000,
    dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
    lease_policy: { max_auto_reassignments: 2 },
    override_reason: 'rollback precheck',
  });
  store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(new Date(Date.now() - 30_000).toISOString(), rollbackOpen.lease.id);
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'enforce', () => {
    const originalAppend = store._appendAssignment;
    try {
      store._appendAssignment = function injectedAppendFailure() {
        throw new Error('injected assignment append failure');
      };
      const before = store.getStep(rollbackStep.id);
      const res = store.reapStaleLeases({
        now_ms: Date.now(),
        dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
        lease_policy: { max_auto_reassignments: 2 },
        override_reason: 'rollback test',
      });
      const afterLease = store.getExecutionLease(rollbackOpen.lease.id);
      const after = store.getStep(rollbackStep.id);
      check('enforce stale recovery rollback preserves pre-state when append fails',
        typeof res.reaped[0].error === 'string'
        && res.reaped[0].error.includes('injected assignment append failure')
        && afterLease.status === 'open'
        && after.status === 'in_progress'
        && after.assignments.length === before.assignments.length
        && after.auto_reassignment_count === before.auto_reassignment_count);
    } finally {
      store._appendAssignment = originalAppend;
    }
  });

  const advisoryStep = store.addStep(plan.id, {
    title: 'Advisory mode step',
    context: 'Implementation task with stale lease.',
    acceptance_criteria: 'No mutation in advisory mode.',
    role: 'architect',
  });
  store.snapshotStepAssignment(advisoryStep.id, { assigned_by: 'test' });
  const advisoryOpen = store.openExecutionLease({
    plan_id: plan.id, step_id: advisoryStep.id, executor: 'adv', stale_after_ms: 5_000, override_reason: 'advisory mode override',
  });
  store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(new Date(Date.now() - 30_000).toISOString(), advisoryOpen.lease.id);
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'advisory', () => {
    const before = store.getStep(advisoryStep.id);
    const res = store.reapStaleLeases({
      now_ms: Date.now(),
      dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
      lease_policy: { max_auto_reassignments: 2 },
      override_reason: 'advisory proposal',
    });
    const after = store.getStep(advisoryStep.id);
    check('advisory mode reports proposal but does not mutate assignment history/count',
      res.reaped[0].recovery.action === 'proposed_only'
      && after.assignments.length === before.assignments.length
      && after.auto_reassignment_count === before.auto_reassignment_count);
  });

  const offStep = store.addStep(plan.id, {
    title: 'Off mode step',
    context: 'Implementation task with stale lease.',
    acceptance_criteria: 'No mutation in off mode.',
    role: 'architect',
  });
  store.snapshotStepAssignment(offStep.id, { assigned_by: 'test' });
  const offOpen = store.openExecutionLease({
    plan_id: plan.id, step_id: offStep.id, executor: 'off', stale_after_ms: 5_000, override_reason: 'off mode override',
  });
  store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(new Date(Date.now() - 30_000).toISOString(), offOpen.lease.id);
  withEnv('PLAN_LEDGER_AUTO_REASSIGN', 'off', () => {
    const before = store.getStep(offStep.id);
    const res = store.reapStaleLeases({
      now_ms: Date.now(),
      dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
      lease_policy: { max_auto_reassignments: 2 },
    });
    const after = store.getStep(offStep.id);
    check('off mode does not mutate assignment history/count',
      res.reaped[0].recovery.action === 'disabled'
      && after.assignments.length === before.assignments.length
      && after.auto_reassignment_count === before.auto_reassignment_count);
  });
  closeStore(store, dbPath);
}

// Enforce material-mismatch override reason before assign/open mutations.
{
  const { store, dbPath } = makeStore('mismatch-enforcement');
  const plan = store.createPlan({ title: 'Mismatch enforcement plan' });
  const step = store.addStep(plan.id, {
    title: 'Mismatch guarded step',
    context: 'Implement source changes and produce a code patch artifact.',
    acceptance_criteria: 'Implementation complete.',
    role: 'architect',
  });
  const openRejected = (() => {
    try {
      store.openExecutionLease({
        plan_id: plan.id,
        step_id: step.id,
        executor: 'mismatch-open',
        dispatch_policy: {
          task_modality: 'implementation',
          required_artifact_type: 'code_patch',
          preferred_role: 'architect',
          fallback_roles: ['implementer'],
        },
        lease_policy: { max_auto_reassignments: 1 },
      });
      return false;
    } catch (e) {
      return /dispatch_override_reason_required/.test(String(e.message || ''));
    }
  })();
  const stepAfterOpenReject = store.getStep(step.id);
  check('openExecutionLease rejects material mismatch without override before mutation',
    openRejected === true
    && stepAfterOpenReject.status === 'pending'
    && store.listExecutionLeases({ step_id: step.id }).length === 0);

  store.setPlanStatus(plan.id, 'active');
  const beforeAssign = store.getStep(step.id);
  const assignRejected = (() => {
    try {
      store.assignStep(step.id, {
        role: 'architect',
        reason: 'retry architect',
        assigned_by: 'test',
        dispatch_policy: {
          task_modality: 'implementation',
          required_artifact_type: 'code_patch',
          preferred_role: 'architect',
          fallback_roles: ['implementer'],
        },
      });
      return false;
    } catch (e) {
      return /dispatch_override_reason_required/.test(String(e.message || ''));
    }
  })();
  const afterAssignReject = store.getStep(step.id);
  check('assignStep rejects material mismatch without override before mutation',
    assignRejected === true
    && afterAssignReject.role === beforeAssign.role
    && afterAssignReject.assignments.length === beforeAssign.assignments.length);
  closeStore(store, dbPath);
}

// Migration is additive/idempotent and preserves historical assignment rows.
{
  const { store, dbPath } = makeStore('migration-idempotent');
  const { plan, step } = seedStep(store, 'Migration plan');
  store.assignStep(step.id, {
    role: 'debugger',
    reason: 'historical reassignment',
    assigned_by: 'tester',
    override_reason: 'migration fixture reassignment',
  });
  const beforeRows = store.getStep(step.id).assignments.map((a) => ({ id: a.id, revision: a.revision, reason: a.reason }));
  const beforeVersion = store.db.prepare('PRAGMA user_version').get().user_version;
  store.close();

  const reopenA = new Store(dbPath);
  const midRows = reopenA.getStep(step.id).assignments.map((a) => ({ id: a.id, revision: a.revision, reason: a.reason }));
  const midVersion = reopenA.db.prepare('PRAGMA user_version').get().user_version;
  reopenA.close();
  const reopenB = new Store(dbPath);
  const afterRows = reopenB.getStep(step.id).assignments.map((a) => ({ id: a.id, revision: a.revision, reason: a.reason }));
  const afterVersion = reopenB.db.prepare('PRAGMA user_version').get().user_version;
  check('migration remains additive/idempotent and does not rewrite historical assignments',
    beforeVersion <= midVersion
    && midVersion === afterVersion
    && JSON.stringify(beforeRows) === JSON.stringify(midRows)
    && JSON.stringify(midRows) === JSON.stringify(afterRows));
  closeStore(reopenB, dbPath);
}

console.log(`\n${pass} stale-recovery checks passed.`);
