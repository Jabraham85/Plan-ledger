import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/db.mjs';
import { prepareCloudDispatch, requestCloudDispatch, bindCloudDispatch, reconcileCloudDispatch, cancelCloudDispatch, submitCloudDispatch, readCloudDispatch } from '../src/cloud-dispatch.mjs';
import { createBoardServer } from '../web/board.mjs';
const root = mkdtempSync(join(tmpdir(), 'ledger-cloud-bridge-'));
process.env.PLAN_LEDGER_ROLES = join(root, 'no-roles');
process.env.PLAN_LEDGER_COMPLETION_GATE = 'off';
const db = join(root, 'test.db'), authority = Object.freeze({});
let store = new Store(db, { acceptanceAuthority: authority }), checks = 0, serial = 0;
const project = store.createProject({ name: 'Offline cloud route fixture' }); store.setProjectRoot(project.id, root);
writeFileSync(join(root, 'fixture.txt'), 'known fixture');
const sha256 = createHash('sha256').update('known fixture').digest('hex');
const payload = { outcome: 'success', artifacts: ['fixture.txt'], commands: [{ command: 'read fixture', exit_code: 0, output: 'known fixture' }], limitations: ['Offline adapter test'], criteria: [{ id: 'read', status: 'verified', reviewer: 'worker', evidence: [{ path: 'fixture.txt', sha256 }] }] };
function fresh() {
  const plan = store.createPlan({ title: 'One bounded fixture task', project_id: project.id });
  const step = store.addStep(plan.id, { title: 'Read known fixture', context: 'Read only', acceptance_contract: { version: 1, criteria: [{ id: 'read', description: 'Read actual fixture and return its hash' }] } });
  store.setPlanStatus(plan.id, 'active');
  const args = { step_id: step.id, client_key: 'fixture-' + ++serial, authorization: { source_ref: 'test:fixture-only', user_instruction: 'Exercise offline bridge only', granted_actions: ['read fixture'], constraints: ['no remote calls'] } };
  return { plan, step, args };
}
const obs = (status, n, extra = {}) => ({ status, thread_id: 'offline-fixture-thread-' + n, turn_id: 'offline-fixture-turn-' + n, source_ref: 'test:mock-cloud-response', tool_name: 'cloud_threads.fixture', observed_at: '2026-10-11T12:00:00Z', ...extra });
const check = (name, fn) => { fn(); checks++; console.log('ok ' + name); };
try {
  const f = fresh(); let r = prepareCloudDispatch(store, f.args);
  check('prepare has packet but no fabricated remote identity or lease', () => { assert.equal(r.phase, 'prepared'); assert.deepEqual(r.identity, {}); assert.equal(r.lease_id, null); assert.equal(r.execution_route, 'cloud-parent'); });
  check('stable client key recovers exact request without duplication', () => assert.equal(prepareCloudDispatch(store, f.args).request_id, r.request_id));
  check('another active request for same step rejects', () => assert.throws(() => prepareCloudDispatch(store, { ...f.args, client_key: 'different' }), /dispatch_already_owned/));
  r = requestCloudDispatch(store, { request_id: r.request_id });
  check('request owns one lease but does not claim a remote start', () => { assert.equal(r.phase, 'requested'); assert.deepEqual(r.identity, {}); assert.equal(store.listExecutionLeases({ step_id: f.step.id, status: 'open' }).length, 1); });
  check('unconfirmed evidence and second create request reject', () => {
    assert.throws(() => submitCloudDispatch(store, { request_id: r.request_id, completion_payload: payload, report_source_ref: 'test:report' }), /completion_unconfirmed/);
    assert.throws(() => requestCloudDispatch(store, { request_id: r.request_id }), /reconcile_before_retry/);
  });
  r = reconcileCloudDispatch(store, { request_id: r.request_id, observation: obs('unknown', 1, { thread_id: undefined, turn_id: undefined }) });
  store.close(); store = new Store(db, { acceptanceAuthority: authority });
  check('uncertain create survives reopen and cannot blindly retry', () => { assert.equal(readCloudDispatch(store, { request_id: r.request_id }).phase, 'reconciling'); assert.throws(() => requestCloudDispatch(store, { request_id: r.request_id }), /reconcile_before_retry/); });
  r = bindCloudDispatch(store, { request_id: r.request_id, observation: obs('created', 1, { turn_id: undefined }) });
  check('bind preserves observed thread and leaves unavailable turn absent', () => { assert.equal(r.identity.thread_id, 'offline-fixture-thread-1'); assert.equal(r.identity.turn_id, undefined); assert.equal(r.phase, 'requested'); });
  r = reconcileCloudDispatch(store, { request_id: r.request_id, observation: obs('running', 1, { api_key: 'fixture-sensitive-field-must-be-dropped' }) });
  check('running observation starts and heartbeats without retaining arbitrary fields', () => { assert.equal(r.phase, 'started'); assert.equal(r.identity.turn_id, 'offline-fixture-turn-1'); assert.ok(!JSON.stringify(r).includes('fixture-sensitive')); });
  check('mismatched identity and missing provenance reject', () => {
    assert.throws(() => reconcileCloudDispatch(store, { request_id: r.request_id, observation: obs('running', 2) }), /identity_mismatch/);
    assert.throws(() => reconcileCloudDispatch(store, { request_id: r.request_id, observation: { status: 'running', thread_id: 'x' } }), /source_ref_required/);
  });
  r = reconcileCloudDispatch(store, { request_id: r.request_id, observation: obs('completed', 1) });
  check('remote completion releases lease but does not accept criteria', () => { assert.equal(r.phase, 'completed'); assert.equal(store.getStep(f.step.id).status, 'pending'); assert.equal(store.getStep(f.step.id).acceptance_decision, null); assert.throws(() => store.setPlanStatus(f.plan.id, 'done'), /mandatory acceptance/); assert.throws(() => prepareCloudDispatch(store, { ...f.args, client_key: 'before-report' }), /pending_acceptance/); });
  check('same terminal observation is idempotent and conflict rejects', () => { assert.equal(reconcileCloudDispatch(store, { request_id: r.request_id, observation: obs('completed', 1) }).phase, 'completed'); assert.throws(() => reconcileCloudDispatch(store, { request_id: r.request_id, observation: obs('cancelled', 1) }), /terminal_observation_conflict/); });
  r = submitCloudDispatch(store, { request_id: r.request_id, completion_payload: payload, report_source_ref: 'test:actual-fixture-report' });
  check('worker evidence remains pending until separate capability acceptance', () => {
    assert.equal(r.submission.status, 'pending_review');
    assert.throws(() => store.recordAttempt(f.step.id, { what_tried: 'self', verdict: 'pass', completion_payload: payload }), /orchestrator_acceptance_required/);
    assert.throws(() => prepareCloudDispatch(store, { ...f.args, client_key: 'premature-redo' }), /pending_acceptance/);
    store.acceptCompletion(f.step.id, { ...r.submission, reviewer: 'Nova', decision_ref: 'test:review', reason: 'Independent fixture review' }, { authority });
    store.setPlanStatus(f.plan.id, 'done');
  });
  const g = fresh(); let c = requestCloudDispatch(store, { request_id: prepareCloudDispatch(store, g.args).request_id });
  c = bindCloudDispatch(store, { request_id: c.request_id, observation: obs('running', 3) });
  c = cancelCloudDispatch(store, { request_id: c.request_id, reason: 'Stop fixture' });
  check('cancellation request is intent and keeps ownership until confirmed', () => { assert.equal(c.phase, 'reconciling'); assert.equal(c.cancellation_requested, true); assert.equal(c.remote_outcome, ''); assert.equal(store.listExecutionLeases({ step_id: g.step.id, status: 'open' }).length, 1); });
  c = reconcileCloudDispatch(store, { request_id: c.request_id, observation: obs('cancelled', 3) });
  check('confirmed cancellation closes without completion evidence', () => { assert.equal(c.remote_outcome, 'cancelled'); assert.equal(store.listExecutionLeases({ step_id: g.step.id, status: 'open' }).length, 0); assert.notEqual(store.getStep(g.step.id).status, 'done'); });
  const h = fresh(); let stale = prepareCloudDispatch(store, h.args); store.updateStep(h.step.id, { context: 'changed after prepare' });
  check('stale prepared context refuses launch', () => assert.throws(() => requestCloudDispatch(store, { request_id: stale.request_id }), /packet_stale/));
  const j = fresh(); let drift = requestCloudDispatch(store, { request_id: prepareCloudDispatch(store, j.args).request_id });
  store.redoStep(j.step.id, { reason: 'Independent scope reset' }); const epoch = store.getStep(j.step.id).acceptance_epoch;
  drift = reconcileCloudDispatch(store, { request_id: drift.request_id, observation: obs('completed', 4) });
  check('stale remote completion requires recovery and preserves newer work', () => { assert.equal(drift.phase, 'reconciling'); assert.equal(store.getStep(j.step.id).acceptance_epoch, epoch); assert.equal(drift.remote_outcome, ''); });
  const cli = spawnSync(process.execPath, [resolve('src/ledger-cli.mjs'), 'cloud_dispatch_status', '--input', JSON.stringify({ request_id: r.request_id })], { encoding: 'utf8', env: { ...process.env, PLAN_LEDGER_DB: db } });
  check('JSON CLI reads the same persisted request', () => { assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).result.request_id, r.request_id); });

  const journey = fresh();
  const stepId = journey.step.id;
  const planId = journey.plan.id;
  const fixture = createBoardServer({ store, html: '<html></html>' });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const read = async path => {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const stepReview = async () => (await read(`/api/steps/${stepId}`)).planner_review;
  const handoff = () => read(`/api/plans/${planId}/handoff`);
  const submitFixture = (prepared, n) => {
    const request = requestCloudDispatch(store, { request_id: prepared.request_id });
    reconcileCloudDispatch(store, { request_id: request.request_id, observation: obs('completed', n) });
    return submitCloudDispatch(store, { request_id: request.request_id, completion_payload: payload, report_source_ref: 'test:observed-report' });
  };
  try {
    assert.equal((await stepReview()).state, 'needs_evidence');
    const first = submitFixture(prepareCloudDispatch(store, journey.args), 5);
    const pending = await stepReview();
    assert.equal(pending.state, 'awaiting_review');
    assert.equal(pending.criteria[0].status, 'submitted');
    assert.equal(pending.submission.submission_id, first.submission.submission_id);
    assert.equal((await handoff()).ready, false);
    const qa = { ...first.submission, reviewer: 'Nova', decision_ref: 'test:independent-review', reason: 'Independent output was missing',
      feedback: [{ criterion_id: 'read', observation: 'Only the worker claim was available', next_action: 'Record the independent read' }] };
    assert.throws(() => store.requestCompletionRevision(stepId, qa, { authority: {} }), /orchestrator_authority_required/);
    assert.throws(() => store.requestCompletionRevision(stepId, { ...qa, reviewer: 'cloud-parent-worker' }, { authority }), /independent_reviewer_required/);
    assert.throws(() => store.requestCompletionRevision(stepId, { ...qa, payload_digest: '0'.repeat(64) }, { authority }), /acceptance_submission_stale/);
    const forge = await fetch(`${origin}/api/steps/${stepId}/attempts`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ what_tried: '[planner] QA requested revision', result: JSON.stringify(qa), verdict: 'partial' }) });
    assert.equal(forge.status, 400);
    assert.equal((await stepReview()).submission.submission_id, first.submission.submission_id);
    const correction = store.requestCompletionRevision(stepId, qa, { authority });
    const revised = await stepReview();
    assert.equal(revised.state, 'revision_requested');
    assert.equal(revised.criteria[0].feedback.next_action, 'Record the independent read');
    assert.equal(revised.revision.attempt_id, correction.attempt_id);
    assert.throws(() => store.acceptCompletion(stepId, qa, { authority }), /acceptance_submission_stale/);
    for (let index = 0; index < 11; index++) {
      store.recordAttempt(stepId, { what_tried: 'Fixture preflight', result: 'Local retry prerequisite missing', verdict: 'fail' });
    }
    assert.ok(!store.getStep(stepId).attempts.some(attempt => attempt.id === correction.attempt_id));
    assert.equal((await stepReview()).revision.attempt_id, correction.attempt_id);
    assert.throws(() => prepareCloudDispatch(store, { ...journey.args, client_key: 'expanded-review', owned_paths: ['out-of-scope.txt'] }), /dispatch_review_scope_changed/);
    assert.throws(() => prepareCloudDispatch(store, { ...journey.args, client_key: 'changed-pilot', pilot_version: 2 }), /dispatch_review_scope_changed/);
    assert.throws(() => prepareCloudDispatch(store, { ...journey.args, client_key: 'changed-result-contract', result_evidence_contract: {
      version: 1, kind: 'sha256_fixture', input_path: 'another-fixture.txt', observability_policy: 'supported_task_outputs_only',
      raw_trace_required: false, side_effect_assertion: 'unseen_activity_not_verified',
    } }), /dispatch_review_scope_changed/);
    const retry = prepareCloudDispatch(store, { ...journey.args, client_key: 'revised-review' });
    assert.equal(retry.packet.prior_review.submission_id, first.submission.submission_id);
    assert.deepEqual(retry.packet.authorization, first.packet.authorization);
    assert.deepEqual(retry.packet.scope, first.packet.scope);
    assert.equal(retry.lease_id, null);
    assert.equal(retry.ownership.state, 'not_claimed');
    check('board and cloud bridge preserve review provenance through a scoped revision', () => assert.equal((store.getStep(stepId)).status, 'failed'));

    const freshReport = submitFixture(retry, 6);
    assert.notEqual(freshReport.submission.submission_id, first.submission.submission_id);
    assert.equal((await stepReview()).state, 'awaiting_review');
    assert.throws(() => store.requestCompletionRevision(stepId, qa, { authority }), /acceptance_submission_stale/);
    store.acceptCompletion(stepId, { ...freshReport.submission, reviewer: 'Nova', decision_ref: 'test:verified-correction', reason: 'Independent read verified output' }, { authority });
    assert.equal((await stepReview()).state, 'accepted');
    const verified = await handoff();
    assert.equal(verified.ready, true);
    assert.equal(verified.steps[0].review.submission_id, freshReport.submission.submission_id);
    assert.equal(verified.steps[0].criteria[0].evidence[0].sha256, sha256);
    writeFileSync(join(root, 'fixture.txt'), 'changed after review');
    assert.equal((await stepReview()).state, 'evidence_changed');
    check('fresh acceptance enables the board handoff, and changed evidence withdraws it', () => assert.ok(verified.ready));
    assert.equal((await handoff()).ready, false);
    store.redoStep(stepId, { reason: 'Start new work after the accepted correction' });
    assert.equal((await stepReview()).revision, null);
  } finally {
    await new Promise(resolve => fixture.close(resolve));
  }
  console.log('cloud dispatch bridge OK (' + checks + ' scenarios); observations are offline fixtures, no remote tasks');
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
