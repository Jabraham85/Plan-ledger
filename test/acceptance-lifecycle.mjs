import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/db.mjs';

const root = mkdtempSync(join(tmpdir(), 'ledger-acceptance-generation-'));
process.env.PLAN_LEDGER_COMPLETION_GATE = 'off';
process.env.PLAN_LEDGER_ROLES = join(root, 'no-roles');
const authority = Object.freeze({});
const db = join(root, 'test.db');
let store = new Store(db, { acceptanceAuthority: authority }), checks = 0;
const project = store.createProject({ name: 'Offline lifecycle' });
store.setProjectRoot(project.id, root);
writeFileSync(join(root, 'receipt.txt'), 'fixture receipt');
const sha256 = createHash('sha256').update('fixture receipt').digest('hex');
const contract = { version: 1, criteria: [{ id: 'join', description: 'Membership verified' }] };
const payload = { outcome: 'success', artifacts: ['receipt.txt'], commands: [{ command: 'offline assertion', exit_code: 0, output: 'fixture only' }],
  limitations: ['Offline fixture, no real membership claim'], criteria: [{ id: 'join', status: 'verified', reviewer: 'worker', evidence: [{ path: 'receipt.txt', sha256 }] }] };
const decision = sub => ({ ...sub, reviewer: 'Nova', decision_ref: 'test:independent-review', reason: 'Fixture evidence reviewed separately' });
function fresh() {
  const plan = store.createPlan({ title: 'generation fixture', project_id: project.id });
  const step = store.addStep(plan.id, { title: 'membership', acceptance_contract: contract });
  store.setPlanStatus(plan.id, 'active');
  const sub = store.submitCompletion(step.id, { completion_payload: payload, executor: 'worker' });
  store.acceptCompletion(step.id, decision(sub), { authority });
  store.setPlanStatus(plan.id, 'done');
  return { plan, step, sub, epoch: store.getStep(step.id).acceptance_epoch };
}
function assertInvalidated(f) {
  const step = store.getStep(f.step.id);
  assert.equal(step.acceptance_decision, null);
  assert.ok(step.acceptance_epoch > f.epoch);
  assert.throws(() => store.setStepStatus(step.id, 'done'), /completion_gate_rejected|orchestrator_acceptance_required/);
  assert.throws(() => store.setStepDisposition(step.id, { disposition: 'verified' }), /completion_gate_rejected|orchestrator_acceptance_required/);
  assert.throws(() => store.setPlanStatus(f.plan.id, 'done', { force: true, reason: 'stale bypass' }), /mandatory acceptance/);
  assert.throws(() => store.acceptCompletion(step.id, decision(f.sub), { authority }), /acceptance_submission_stale/);
  const history = step.notes.map(n => { try { return JSON.parse(n.body); } catch { return {}; } });
  assert.ok(history.some(n => n.event === 'orchestrator_acceptance'));
  assert.ok(history.some(n => n.event === 'acceptance_invalidated' && n.prior_decision?.submission_id === f.sub.submission_id));
}
const check = (name, fn) => { fn(); checks++; console.log('ok ' + name); };
try {
  for (const status of ['pending','in_progress','failed','blocked']) check('ordinary status ' + status + ' invalidates acceptance', () => {
    const f = fresh(); store.setStepStatus(f.step.id, status); assertInvalidated(f);
  });
  for (const verdict of ['fail','partial']) check('recorded ' + verdict + ' cannot revive accepted receipt', () => {
    const f = fresh(); store.recordAttempt(f.step.id, { what_tried: 'new membership check', verdict, result: 'membership revoked' }); assertInvalidated(f);
  });
  check('redo invalidates but retains decision provenance', () => { const f = fresh(); store.redoStep(f.step.id, { reason: 'recheck membership' }); assertInvalidated(f); });
  for (const disposition of ['deferred','blocked','not_applicable','legacy_unknown']) check('disposition ' + disposition + ' invalidates acceptance', () => {
    const f = fresh(); store.setStepDisposition(f.step.id, { disposition, reason: 'fresh limitation' }); assertInvalidated(f);
  });
  for (const method of ['claimStep','nextStep','readySteps','openExecutionLease']) check(method + ' invalidates an unreviewed submission', () => {
    const f = fresh(); store.redoStep(f.step.id, { reason: 'new work' });
    const sub = store.submitCompletion(f.step.id, { completion_payload: payload, executor: 'worker' });
    if (method === 'claimStep') store.claimStep(f.step.id);
    else if (method === 'nextStep') store.nextStep(f.plan.id, { claim: true });
    else if (method === 'readySteps') store.readySteps(f.plan.id, { claim: true });
    else store.openExecutionLease({ plan_id: f.plan.id, step_id: f.step.id, executor: 'fixture' });
    assert.throws(() => store.acceptCompletion(f.step.id, decision(sub), { authority }), /acceptance_submission_stale/);
    for (const lease of store.listExecutionLeases({ step_id: f.step.id, status: 'open' })) store.closeExecutionLease(lease.id, { outcome: 'cancelled' });
  });
  check('adopted lease advances the generation', () => {
    const f = fresh(); store.redoStep(f.step.id, { reason: 'adoption' }); store.claimStep(f.step.id);
    const epoch = store.getStep(f.step.id).acceptance_epoch;
    const lease = store.openExecutionLease({ plan_id: f.plan.id, step_id: f.step.id, executor: 'fixture' });
    assert.ok(store.getStep(f.step.id).acceptance_epoch > epoch); store.closeExecutionLease(lease.lease.id, { outcome: 'cancelled' });
  });
  for (const outcome of ['failed','partial','blocked','cancelled','abandoned']) check('lease ' + outcome + ' invalidates accepted work', () => {
    const f = fresh(); store.redoStep(f.step.id, { reason: 'lease fixture' });
    const lease = store.openExecutionLease({ plan_id: f.plan.id, step_id: f.step.id, executor: 'fixture' });
    const sub = store.submitCompletion(f.step.id, { completion_payload: payload, executor: 'worker' });
    store.acceptCompletion(f.step.id, decision(sub), { authority }); f.sub = sub; f.epoch = store.getStep(f.step.id).acceptance_epoch;
    store.closeExecutionLease(lease.lease.id, { outcome }); assertInvalidated(f);
  });
  check('evidence-only completion can await later review without reviving prior acceptance', () => {
    const f = fresh(); store.redoStep(f.step.id, { reason: 'new bounded work' });
    const lease = store.openExecutionLease({ plan_id: f.plan.id, step_id: f.step.id, executor: 'fixture' });
    const sub = store.submitCompletion(f.step.id, { completion_payload: payload, executor: 'worker' });
    store.closeExecutionLease(lease.lease.id, { outcome: 'partial', verification_state: 'pending', terminal_metadata: { awaiting_acceptance: true } });
    assert.equal(store.getStep(f.step.id).status, 'pending'); assert.equal(store.getStep(f.step.id).acceptance_decision, null);
    assert.throws(() => store.acceptCompletion(f.step.id, decision(f.sub), { authority }), /acceptance_submission_stale/);
    store.acceptCompletion(f.step.id, decision(sub), { authority }); store.setPlanStatus(f.plan.id, 'done');
  });
  check('failed close cannot preserve stale submission using review metadata', () => {
    const f = fresh(); store.redoStep(f.step.id, { reason: 'failure after evidence' });
    const lease = store.openExecutionLease({ plan_id: f.plan.id, step_id: f.step.id, executor: 'fixture' });
    const sub = store.submitCompletion(f.step.id, { completion_payload: payload, executor: 'worker' });
    store.closeExecutionLease(lease.lease.id, { outcome: 'failed', verification_state: 'pending', terminal_metadata: { awaiting_acceptance: true } });
    assert.throws(() => store.acceptCompletion(f.step.id, decision(sub), { authority }), /acceptance_submission_stale/);
  });
  check('fresh submission and review restores acceptance after failure and reopen', () => {
    const f = fresh(); store.recordAttempt(f.step.id, { what_tried: 'membership revoked', verdict: 'fail' });
    store.close(); store = new Store(db, { acceptanceAuthority: authority }); assertInvalidated(f);
    const sub = store.submitCompletion(f.step.id, { completion_payload: payload, executor: 'worker' });
    assert.throws(() => store.setPlanStatus(f.plan.id, 'done'), /mandatory acceptance/);
    store.acceptCompletion(f.step.id, decision(sub), { authority }); store.setPlanStatus(f.plan.id, 'done');
    assert.equal(store.getStep(f.step.id).acceptance_decision.submission_id, sub.submission_id);
    assert.notEqual(sub.submission_id, f.sub.submission_id);
  });
  console.log('acceptance lifecycle OK (' + checks + ' scenarios); offline only');
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
