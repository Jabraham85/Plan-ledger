// terminalization-reconciliation.mjs — focused C2 reconciliation coverage.
// Run: node test/terminalization-reconciliation.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

function makeStore(name) {
  const path = join(tmpdir(), `plan-ledger-c2-${name}-${process.pid}-${Date.now().toString(36)}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const store = new Store(path);
  store.currentProject = () => store.getProject(store.currentProjectId());
  return { store, path };
}
function cleanup(store, path) {
  try { store.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}
function withMode(mode, fn) {
  const prev = process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
  if (mode == null) delete process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
  else process.env.PLAN_LEDGER_AUTO_TERMINALIZE = mode;
  try { fn(); } finally {
    if (prev == null) delete process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
    else process.env.PLAN_LEDGER_AUTO_TERMINALIZE = prev;
  }
}

// 1) final terminal mutation auto-reconciles in enforce mode.
withMode('enforce', () => {
  const { store, path } = makeStore('enforce-autodone');
  const plan = store.createPlan({ title: 'enforce auto done' });
  const s1 = store.addStep(plan.id, { title: 'step one' });
  const s2 = store.addStep(plan.id, { title: 'step two' });
  store.setPlanStatus(plan.id, 'active');
  store.recordAttempt(s1.id, { what_tried: 'complete one', verdict: 'pass' });
  const afterFirst = store.openPlan(plan.id);
  check('plan remains active before final terminal mutation', afterFirst.status === 'active');
  store.recordAttempt(s2.id, { what_tried: 'complete two', verdict: 'pass' });
  const afterFinal = store.openPlan(plan.id);
  check('enforce mode auto-terminalizes active plan to done', afterFinal.status === 'done');
  check('done auto-terminalization stamps explicit metadata',
    afterFinal.terminal_state_reason === 'reconcile_done' && typeof afterFinal.terminalized_at === 'string' && afterFinal.terminalized_at.length > 0);
  cleanup(store, path);
});

// 2) deterministic one-shot diagnostic/backfill clears eligible contradictions.
withMode('enforce', () => {
  const { store, path } = makeStore('diagnostic-backfill');
  const makeEligibleContradiction = (title) => {
    const p = store.createPlan({ title });
    const a = store.addStep(p.id, { title: `${title} step A` });
    const b = store.addStep(p.id, { title: `${title} step B` });
    store.setPlanStatus(p.id, 'active');
    store.recordAttempt(a.id, { what_tried: `${title} A`, verdict: 'pass' }, { reconcile: false });
    store.recordAttempt(b.id, { what_tried: `${title} B`, verdict: 'pass' }, { reconcile: false });
    store.setPlanStatus(p.id, 'active');
    return p.id;
  };
  const p1 = makeEligibleContradiction('eligible one');
  const p2 = makeEligibleContradiction('eligible two');
  const blocked = store.createPlan({ title: 'blocked contradiction control' });
  const blockedStep = store.addStep(blocked.id, { title: 'still pending' });
  store.setPlanStatus(blocked.id, 'active');
  const diag = store.reconcileTerminalizationDiagnostic({ strict: true });
  check('diagnostic sees seeded eligible contradictions',
    diag.contradiction_count_before === 2 && diag.scanned_active_plans === 3);
  check('diagnostic reconciles only eligible contradictions', diag.reconciled_to_done === 2 && diag.contradiction_count_after === 0);
  check('blocked active plan remains active', store.openPlan(blocked.id).status === 'active' && store.getStep(blockedStep.id).status === 'pending');
  check('eligible plans become done after diagnostic backfill', store.openPlan(p1).status === 'done' && store.openPlan(p2).status === 'done');
  cleanup(store, path);
});

// 3) strict blockers prevent done reconciliation (steps/activity/lease/disposition).
withMode('enforce', () => {
  const { store, path } = makeStore('blockers');
  const plan = store.createPlan({ title: 'reconcile blockers' });
  const step1 = store.addStep(plan.id, { title: 'active blocker' });
  const step2 = store.addStep(plan.id, { title: 'missing disposition blocker' });
  const step3 = store.addStep(plan.id, { title: 'open lease blocker' });
  store.setPlanStatus(plan.id, 'active');
  store.db.prepare("UPDATE steps SET status='done', verification_disposition='' WHERE id=?").run(step2.id);
  const lease = store.openExecutionLease({ plan_id: plan.id, step_id: step3.id, executor: 'blocker' });
  const assessment = store.assessPlanReconciliation(plan.id);
  const codes = new Set(assessment.blockers.map((b) => b.code));
  check('assessment includes steps_active blocker', codes.has('steps_active'));
  check('assessment includes disposition_missing blocker', codes.has('disposition_missing'));
  check('assessment includes lease_open blocker', codes.has('lease_open'));
  check('assessment includes activity_non_terminal blocker', codes.has('activity_non_terminal'));
  check('blocked reconciliation does not mark plan done', store.openPlan(plan.id).status === 'active');
  store.closeExecutionLease(lease.lease.id, { outcome: 'cancelled', close_reason: 'cleanup blocker lease' });
  cleanup(store, path);
});

// 4) deferred/manual verification yields explicit partial reason.
withMode('enforce', () => {
  const { store, path } = makeStore('deferred');
  const plan = store.createPlan({ title: 'deferred gate plan' });
  const step = store.addStep(plan.id, { title: 'manual verify step' });
  store.setPlanStatus(plan.id, 'active');
  store.setStepDisposition(step.id, { disposition: 'deferred', reason: 'awaiting manual signoff' });
  store.setStepStatus(step.id, 'done');
  const after = store.openPlan(plan.id);
  const assessment = store.assessPlanReconciliation(plan.id);
  check('deferred gate keeps plan from auto-done', after.status === 'active');
  check('deferred gate stores explicit partial terminal reason', after.terminal_state_reason === 'partial_due_to_deferred_gate');
  check('assessment reports partial_due_to_deferred_gate result', assessment.result_code === 'reconcile_partial_due_to_deferred_gate');
  cleanup(store, path);
});

// 5) off + shadow modes do not mutate plan status.
for (const mode of ['off', 'shadow']) {
  withMode(mode, () => {
    const { store, path } = makeStore(`mode-${mode}`);
    const plan = store.createPlan({ title: `${mode} mode` });
    const step = store.addStep(plan.id, { title: 'single step' });
    store.setPlanStatus(plan.id, 'active');
    store.recordAttempt(step.id, { what_tried: `${mode} pass`, verdict: 'pass' });
    const after = store.openPlan(plan.id);
    check(`${mode} mode keeps status unchanged`, after.status === 'active');
    cleanup(store, path);
  });
}

// 6) migration is additive + idempotent.
{
  const path = join(tmpdir(), `plan-ledger-c2-migration-${process.pid}-${Date.now().toString(36)}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const storeA = new Store(path);
  const cols = storeA.db.prepare('PRAGMA table_info(plans)').all().map((r) => r.name);
  const versionA = storeA.db.prepare('PRAGMA user_version').get().user_version;
  const created = storeA.createPlan({ title: 'migration additive probe' });
  check('migration adds terminalization metadata columns',
    cols.includes('terminal_state_reason') && cols.includes('terminalized_at') && cols.includes('state_integrity_version'));
  check('new plan receives additive state_integrity_version default',
    created.state_integrity_version === 1 && created.terminal_state_reason === '' && created.terminalized_at === '');
  storeA.close();
  const storeB = new Store(path);
  const versionB = storeB.db.prepare('PRAGMA user_version').get().user_version;
  check('migration is idempotent across reopen', versionA === versionB && versionB >= 9);
  cleanup(storeB, path);
}

console.log(`\nterminalization-reconciliation regression OK (${pass} checks)`);
