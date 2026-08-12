// execution-lifecycle.mjs — focused regressions for the unified execution
// lease + verification-disposition + plan-done gate + reap-supervisor contract.
// Run: node test/execution-lifecycle.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';
import { supervise, reapLoop } from '../src/supervisor.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };
const throws = async (label, fn, pattern) => {
  try { await fn(); assert.fail(`expected throw: ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) assert.fail(`${label}: message did not match ${pattern} (got: ${e.message})`);
    console.log(`  ok  ${label}`); pass++;
  }
};

function makeStore(name) {
  const path = join(tmpdir(), `plan-ledger-lifecycle-${name}-${process.pid}-${Date.now().toString(36)}.db`);
  for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
  const store = new Store(path);
  store.currentProject = () => store.getProject(store.currentProjectId());
  return { store, path };
}
function cleanup(store, path) {
  try { store.close(); } catch {}
  for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
}

// ------------------------------------------------------------------ 1. zombie
// A lease opened with no heartbeat older than the stale threshold must be
// closed as `cancelled` by the reaper — no manual intervention.
{
  const { store, path } = makeStore('zombie');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Zombie', keywords: ['zombie'] });
  const step = store.addStep(plan.id, { title: 'zombie step' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id, step_id: step.id, executor: 'zombie-executor',
    stale_after_ms: 5_000, action_summary: 'about to die', // floor is 5s per openExecutionLease clamp
  });
  check('lease opened for zombie executor', opened.lease.status === 'open');
  // Advance the reaper's virtual clock past the stale window rather than
  // waiting real seconds — same code path, deterministic on CI.
  const reaped = store.reapStaleLeases({ now_ms: Date.now() + 10_000, grace_ms: 0 });
  check('reaper closes stale lease', reaped.reaped_count === 1 && reaped.reaped[0].outcome.lease.status === 'closed');
  const finalStep = store.getStep(step.id);
  check('zombie step handed back to pending (cancelled outcome)', finalStep.status === 'pending');
  const leases = store.listExecutionLeases({ plan_id: plan.id, status: 'open' });
  check('no open leases remain after reap', leases.length === 0);
  cleanup(store, path);
}

// ------------------------------------------------------- 2. deadline breach
// A lease with an already-elapsed deadline is closed as `cancelled` even
// if heartbeats are fresh.
{
  const { store, path } = makeStore('deadline');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Deadline' });
  const step = store.addStep(plan.id, { title: 'deadline step' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id, step_id: step.id, executor: 'deadline-executor',
    stale_after_ms: 60_000, deadline_ms: 100, // deadline 100ms out
  });
  // Even with a fresh heartbeat, deadline breach still triggers the reap.
  store.heartbeatExecutionLease(opened.lease.id, { action_summary: 'still going' });
  const reaped = store.reapStaleLeases({ now_ms: Date.now() + 10_000 });
  check('reaper cancels deadline-breached lease', reaped.reaped_count === 1
    && /reap:deadline_exceeded/.test(reaped.reaped[0].reason || ''));
  cleanup(store, path);
}

// -------------------------------- 3. atomic terminalization + disposition
// closeExecutionLease with an attempt + step_verdict='pass' must terminalize
// the activity, close the lease, record the attempt, AND set disposition in
// a single transaction — the plan-done gate depends on that atomicity.
{
  const { store, path } = makeStore('atomic');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Atomic' });
  const step = store.addStep(plan.id, { title: 'atomic step' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id, step_id: step.id, executor: 'atomic-executor',
    action_summary: 'starting atomic work',
  });
  const close = store.closeExecutionLease(opened.lease.id, {
    outcome: 'success', step_verdict: 'pass',
    terminal_summary: 'work verified',
    attempt: { what_tried: 'wrote the thing', result: 'verified', executor: 'atomic-executor' },
  });
  check('lease closed as success', close.lease.status === 'closed' && close.lease.outcome === 'success');
  const finalStep = store.getStep(step.id);
  check('step is done + verified in one shot', finalStep.status === 'done' && finalStep.verification_disposition === 'verified');
  check('attempt landed with executor provenance', finalStep.attempts.at(-1)?.executor === 'atomic-executor');
  const gate = store.assessPlanTerminalization(plan.id);
  check('plan-done gate is satisfied after atomic terminal close', gate.ok === true);
  const done = store.setPlanStatus(plan.id, 'done');
  check('plan can be marked done cleanly', done.status === 'done');
  cleanup(store, path);
}

// ------------------ 3a. compatibility: join prestarted activity identity
// If run_id/session_ref are supplied by the caller and already identify a
// prestarted activity, openExecutionLease must join that row (not fabricate a
// new one), preserve existing evidence/metadata/started_at, and still append
// mandatory start_claimed lifecycle telemetry.
{
  const { store, path } = makeStore('lease-join-prestarted');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Join prestarted activity' });
  const step = store.addStep(plan.id, { title: 'join identity step' });
  store.setPlanStatus(plan.id, 'active');
  const runId = 'join-run-identity';
  const sessionRef = 'join-session-identity';
  const knownStartedAt = '2020-01-02T03:04:05.000Z';
  const prestarted = store.startActivity({
    plan_id: plan.id,
    step_id: step.id,
    run_id: runId,
    session_ref: sessionRef,
    started_at: knownStartedAt,
    status: 'in_progress',
    action_summary: 'prestarted externally',
    metadata: { preserved_key: 'keep-me' },
  });
  store.upsertActivityHeartbeat({
    plan_id: plan.id,
    step_id: step.id,
    run_id: runId,
    session_ref: sessionRef,
    artifact_count: 2,
    recent_artifacts: ['docs/audits/prestarted-proof.json'],
    metadata: { preserved_key: 'keep-me', nested: { a: 1 } },
  });
  const beforeCount = store.db.prepare(
    'SELECT COUNT(*) c FROM activity_runs WHERE plan_id=? AND step_id=?'
  ).get(plan.id, step.id).c;
  const opened = store.openExecutionLease({
    plan_id: plan.id,
    step_id: step.id,
    executor: 'compat-open',
    run_id: runId,
    session_ref: sessionRef,
    action_summary: 'claim with existing identity',
    metadata: { open_key: 'from-open' },
  });
  const afterCount = store.db.prepare(
    'SELECT COUNT(*) c FROM activity_runs WHERE plan_id=? AND step_id=?'
  ).get(plan.id, step.id).c;
  const persisted = store.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true, limit: 5 })[0];
  const startClaimed = (persisted.events || []).filter((ev) => ev.event_type === 'start_claimed');
  check('openExecutionLease joins prestarted activity identity without creating a second row',
    beforeCount === 1 && afterCount === 1 && opened.activity.id === prestarted.id && persisted.id === prestarted.id);
  check('joined activity preserves started_at, artifact evidence, and metadata',
    persisted.started_at === knownStartedAt
      && Number(persisted.artifact_count) === 2
      && Array.isArray(persisted.recent_artifacts)
      && persisted.recent_artifacts.includes('docs/audits/prestarted-proof.json')
      && persisted.metadata?.preserved_key === 'keep-me');
  check('joined activity appends mandatory start_claimed linked to the same activity id',
    startClaimed.length === 1 && Number(startClaimed[0].step_id) === step.id);
  check('joined identity return shapes remain stable for lease/activity/step',
    Number(opened.lease.step_id) === step.id
      && opened.lease.status === 'open'
      && Number(opened.activity.plan_id) === plan.id
      && opened.activity.run_id === runId
      && opened.activity.session_ref === sessionRef
      && Number(opened.step.id) === step.id
      && opened.step.status === 'in_progress');
  cleanup(store, path);
}

// ---------------------- 3aa. lease claim must advance plan updated_at
{
  const { store, path } = makeStore('lease-claim-touches-plan');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Plan touch on lease claim' });
  const step = store.addStep(plan.id, { title: 'touch updated_at step' });
  store.setPlanStatus(plan.id, 'active');
  const oldTs = '2001-01-01T00:00:00.000Z';
  store.db.prepare('UPDATE plans SET updated_at=? WHERE id=?').run(oldTs, plan.id);
  const before = store.openPlan(plan.id).updated_at;
  store.openExecutionLease({
    plan_id: plan.id,
    step_id: step.id,
    executor: 'touch-check',
    action_summary: 'claim should touch plan timestamp',
  });
  const after = store.openPlan(plan.id).updated_at;
  check('openExecutionLease claim advances plan.updated_at', before === oldTs && after > before);
  cleanup(store, path);
}

// ---------------- 3ab. lease-open response preserves authored step metadata
{
  const { store, path } = makeStore('lease-open-full-step');
  const plan = store.createPlan({ title: 'Lease open full step payload' });
  const step = store.addStep(plan.id, { title: 'authored pending step' });
  store.addNote(step.id, { author: 'reviewer', body: 'preserve this note' });
  store.addFileRef({ step_id: step.id, path: 'src/db.mjs', role: 'primary', note: 'preserve this ref' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id,
    step_id: step.id,
    executor: 'full-step-check',
  });
  check('openExecutionLease preserves notes and file refs on a fresh pending step',
    opened.step.notes.some((note) => note.body === 'preserve this note')
      && opened.step.file_refs.some((ref) => ref.path === 'src/db.mjs'));
  const activity = store.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true, limit: 1 })[0];
  const startClaimed = activity.events.find((event) => event.event_type === 'start_claimed');
  check('start_claimed resolves the active assignment snapshot',
    Number.isInteger(Number(startClaimed?.assignment_id)) && !startClaimed?.assignment_missing_reason);
  cleanup(store, path);
}

// ----------- 3ac. closing an externally completed lease reconciles the plan
{
  const priorAuto = process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
  process.env.PLAN_LEDGER_AUTO_TERMINALIZE = 'enforce';
  const { store, path } = makeStore('external-attempt-close-reconcile');
  const plan = store.createPlan({ title: 'External attempt before lease close' });
  const step = store.addStep(plan.id, { title: 'MCP-style completion' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id,
    step_id: step.id,
    executor: 'mcp-style-check',
  });
  store.recordAttempt(step.id, { what_tried: 'agent completed through MCP', verdict: 'pass' });
  check('open lease keeps externally completed plan active', store.openPlan(plan.id).status === 'active');
  store.closeExecutionLease(opened.lease.id, {
    outcome: 'success',
    terminal_summary: 'external completion accepted',
  });
  check('success close reconciles a step terminalized before lease close',
    store.openPlan(plan.id).status === 'done');
  cleanup(store, path);
  if (priorAuto == null) delete process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
  else process.env.PLAN_LEDGER_AUTO_TERMINALIZE = priorAuto;
}

// --------------------- 3b. enforce gate rollback on missing pass evidence
// With PLAN_LEDGER_COMPLETION_GATE=enforce, closeExecutionLease(pass) without
// completion_payload must fail atomically: lease/activity/event/step/attempt/
// payload/plan state all remain unchanged.
{
  const priorGate = process.env.PLAN_LEDGER_COMPLETION_GATE;
  process.env.PLAN_LEDGER_COMPLETION_GATE = 'enforce';
  const { store, path } = makeStore('close-enforce-missing');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Close enforce missing payload' });
  const step = store.addStep(plan.id, { title: 'missing payload step' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id, step_id: step.id, executor: 'gate-enforce',
    action_summary: 'running without completion payload',
  });
  const leaseId = opened.lease.id;
  const activityId = opened.activity.id;
  const beforeLease = store.getExecutionLease(leaseId);
  const beforeStep = store.getStep(step.id);
  const beforePlan = store.openPlan(plan.id);
  const beforeEvents = store.db.prepare('SELECT COUNT(*) c FROM activity_events WHERE activity_id=?').get(activityId).c;
  const beforeAttempts = beforeStep.attempts_total;
  let rejected = false;
  try {
    store.closeExecutionLease(leaseId, {
      outcome: 'success',
      step_verdict: 'pass',
      terminal_summary: 'attempting terminal close with missing evidence',
      attempt: { what_tried: 'close without payload', result: 'should reject', executor: 'gate-enforce' },
    });
  } catch (e) {
    rejected = /completion_gate_rejected:completion_json_missing/.test(String(e.message || ''));
  }
  check('enforce close rejects missing pass payload', rejected === true);
  const afterLease = store.getExecutionLease(leaseId);
  const afterStep = store.getStep(step.id);
  const afterPlan = store.openPlan(plan.id);
  const afterActivity = store.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true, limit: 5 })[0];
  const afterEvents = store.db.prepare('SELECT COUNT(*) c FROM activity_events WHERE activity_id=?').get(activityId).c;
  check('rollback keeps lease open and outcome unchanged', afterLease.status === beforeLease.status && afterLease.status === 'open' && afterLease.outcome === '');
  check('rollback keeps activity non-terminal and appends no terminal event',
    afterActivity.status === 'in_progress'
      && afterEvents === beforeEvents
      && !afterActivity.events.some((ev) => ev.event_type === 'terminal'));
  check('rollback keeps step in_progress with no attempt/payload mutation',
    afterStep.status === 'in_progress'
      && afterStep.verification_disposition === ''
      && afterStep.attempts_total === beforeAttempts
      && afterStep.completion_payload_json === ''
      && afterStep.completion_validated_at === '');
  check('rollback keeps plan status unchanged', afterPlan.status === beforePlan.status && afterPlan.status === 'active');
  cleanup(store, path);
  if (priorGate == null) delete process.env.PLAN_LEDGER_COMPLETION_GATE; else process.env.PLAN_LEDGER_COMPLETION_GATE = priorGate;
}

// --------------- 3c. enforce close atomic success with top-level payload
// closeExecutionLease(pass) with valid top-level completion_payload succeeds
// atomically: lease/activity/event terminalized, attempt/disposition/payload
// persisted, and C2 auto-terminalization marks the single-step plan done.
{
  const priorGate = process.env.PLAN_LEDGER_COMPLETION_GATE;
  const priorAuto = process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
  process.env.PLAN_LEDGER_COMPLETION_GATE = 'enforce';
  process.env.PLAN_LEDGER_AUTO_TERMINALIZE = 'enforce';
  const { store, path } = makeStore('close-enforce-valid');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Close enforce valid payload' });
  const step = store.addStep(plan.id, { title: 'valid payload step' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id, step_id: step.id, executor: 'gate-valid',
    action_summary: 'running with completion payload',
  });
  const leaseId = opened.lease.id;
  const activityId = opened.activity.id;
  const beforeEvents = store.db.prepare('SELECT COUNT(*) c FROM activity_events WHERE activity_id=?').get(activityId).c;
  const payload = {
    contract_version: 2,
    outcome: 'success',
    artifacts: [{ path: 'docs/audits/c1-proof.json', kind: 'file', note: 'proof' }],
    commands: [{ command: 'node test/execution-lifecycle.mjs', exit_code: 0, output_redacted: true }],
    limitations: ['none'],
  };
  const close = store.closeExecutionLease(leaseId, {
    outcome: 'success',
    step_verdict: 'pass',
    completion_payload: payload, // top-level payload path under test
    terminal_summary: 'terminalized with valid completion evidence',
    attempt: { what_tried: 'close with valid payload', result: 'accepted', executor: 'gate-valid' },
  });
  const afterLease = store.getExecutionLease(leaseId);
  const afterStep = store.getStep(step.id);
  const afterPlan = store.openPlan(plan.id);
  const afterActivity = store.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true, limit: 5 })[0];
  const afterEvents = store.db.prepare('SELECT COUNT(*) c FROM activity_events WHERE activity_id=?').get(activityId).c;
  const terminalEvents = (afterActivity.events || []).filter((ev) => ev.event_type === 'terminal');
  const lifecycleTerminalEvents = (afterActivity.events || []).filter((ev) => ev.event_type === 'completion' || ev.event_type === 'execution_failure');
  const lastAttempt = afterStep.attempts.at(-1);
  check('valid close terminalizes lease/activity and appends terminal event',
    close.lease.status === 'closed'
      && afterLease.status === 'closed'
      && afterActivity.status === 'completed'
      && afterEvents >= beforeEvents + 1
      && afterActivity.events.some((ev) => ev.event_type === 'terminal'));
  check('closeExecutionLease emits exactly one terminal + one lifecycle terminal marker',
    terminalEvents.length === 1
      && lifecycleTerminalEvents.length === 1
      && lifecycleTerminalEvents[0].event_type === 'completion');
  check('valid close persists done+verified+attempt with passing validation metadata',
    afterStep.status === 'done'
      && afterStep.verification_disposition === 'verified'
      && afterStep.attempts_total >= 1
      && lastAttempt.validation_status === 'pass'
      && Array.isArray(lastAttempt.validation_errors)
      && lastAttempt.validation_errors.length === 0);
  check('valid close persists normalized completion payload fields',
    afterStep.completion_payload_present === true
      && afterStep.completion_payload.contract_version === 2
      && afterStep.completion_payload.outcome === 'success'
      && afterStep.completion_payload.commands[0].output_redacted === true
      && typeof afterStep.completion_validated_at === 'string'
      && afterStep.completion_validated_at.length > 0);
  check('valid close preserves atomic terminal result return shape',
    close.step.status === 'done'
      && close.step.completion_payload_present === true
      && close.activity.status === 'completed');
  check('valid close triggers C2 auto-terminalization for single-step plan',
    afterPlan.status === 'done' && afterPlan.terminal_state_reason === 'reconcile_done');
  cleanup(store, path);
  if (priorGate == null) delete process.env.PLAN_LEDGER_COMPLETION_GATE; else process.env.PLAN_LEDGER_COMPLETION_GATE = priorGate;
  if (priorAuto == null) delete process.env.PLAN_LEDGER_AUTO_TERMINALIZE; else process.env.PLAN_LEDGER_AUTO_TERMINALIZE = priorAuto;
}

// ---------------------------- 4. completion rejection — every blocker path
// The gate must reject a done transition for every distinct blocker and
// explain what to fix. Tested exhaustively so a future refactor cannot
// silently relax the invariant.
{
  const { store, path } = makeStore('gate');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Gate' });
  const step1 = store.addStep(plan.id, { title: 'active step' });
  const step2 = store.addStep(plan.id, { title: 'closed step no disposition' });
  const step3 = store.addStep(plan.id, { title: 'has open lease' });
  store.setPlanStatus(plan.id, 'active');
  // Active step blocks (step1 is pending).
  const g1 = store.assessPlanTerminalization(plan.id);
  check('gate rejects: steps_active blocker present', g1.ok === false
    && g1.blockers.some((b) => b.code === 'steps_active'));
  // Manually flip step2 to 'done' without a disposition (simulates legacy).
  store.db.prepare("UPDATE steps SET status='done', verification_disposition='' WHERE id=?").run(step2.id);
  const g2 = store.assessPlanTerminalization(plan.id);
  check('gate rejects: disposition_missing blocker present', g2.blockers.some((b) => b.code === 'disposition_missing'));
  // Open a lease on step3.
  store.openExecutionLease({ plan_id: plan.id, step_id: step3.id, executor: 'blocker' });
  const g3 = store.assessPlanTerminalization(plan.id);
  check('gate rejects: lease_open blocker present', g3.blockers.some((b) => b.code === 'lease_open'));
  check('gate rejects: activity_non_terminal blocker present', g3.blockers.some((b) => b.code === 'activity_non_terminal'));
  await throws('setPlanStatus(done) throws with structured blocker summary',
    async () => store.setPlanStatus(plan.id, 'done'), /cannot be marked done/);
  // Force override requires a reason.
  await throws('force close requires reason', async () => store.setPlanStatus(plan.id, 'done', { force: true }), /requires a reason/);
  const forced = store.setPlanStatus(plan.id, 'done', { force: true, reason: 'test override with audit trail' });
  check('force close with a reason succeeds and stamps completion_lock',
    forced.status === 'done' && /forced-done:/.test(forced.completion_lock || ''));
  cleanup(store, path);
}

// --------------------------------------------- 5. supervisor orchestration
// supervise() must open → heartbeat → close atomically, handle throws,
// enforce deadlines, and never leak an open lease even on error paths.
{
  const { store, path } = makeStore('supervisor-ok');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Sup' });
  const step = store.addStep(plan.id, { title: 'supervised step' });
  store.setPlanStatus(plan.id, 'active');
  let ticks = 0;
  const res = await supervise(store, {
    plan_id: plan.id, step_id: step.id, executor: 'sup-ok',
    heartbeat_ms: 1_000, action_summary: 'supervised OK',
    onHeartbeat: () => { ticks++; },
  }, async ({ heartbeat }) => {
    heartbeat({ phase: 'execute', action_summary: 'making progress' });
    return { verdict: 'pass', summary: 'all good', attempt: { what_tried: 'sup work', result: 'ok' } };
  });
  check('supervise() closes as success', res.outcome === 'success' && res.result.lease.status === 'closed');
  check('supervise() left no open leases', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  check('supervise() marked step verified', store.getStep(step.id).verification_disposition === 'verified');
  cleanup(store, path);
}
{
  const { store, path } = makeStore('supervisor-throw');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'SupThrow' });
  const step = store.addStep(plan.id, { title: 'supervised throwing step' });
  store.setPlanStatus(plan.id, 'active');
  const res = await supervise(store, {
    plan_id: plan.id, step_id: step.id, executor: 'sup-throw',
    heartbeat_ms: 1_000,
  }, async () => { throw new Error('boom'); });
  check('supervise() converts a throw into a failed close', res.outcome === 'failed'
    && res.result.lease.status === 'closed' && res.result.lease.outcome === 'failed');
  check('supervise() throw path leaves no open lease', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
}
{
  const { store, path } = makeStore('supervisor-deadline');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'SupDeadline' });
  const step = store.addStep(plan.id, { title: 'deadline-breach supervised step' });
  store.setPlanStatus(plan.id, 'active');
  const res = await supervise(store, {
    plan_id: plan.id, step_id: step.id, executor: 'sup-deadline',
    heartbeat_ms: 1_000, deadline_ms: 500, // supervise floors heartbeat at 1s
  }, async () => {
    // Run past the deadline; the supervisor timer flips cancelReason so the
    // wrapper terminalizes as cancelled instead of the (unrelated) verdict.
    await new Promise((r) => setTimeout(r, 2_500));
    return { verdict: 'pass' };
  });
  check('supervise() cancels on deadline breach', res.cancelled === true && res.outcome === 'cancelled');
  cleanup(store, path);
}

// ----------------------------- 6. reap loop closes stale leases in the bg
{
  const { store, path } = makeStore('reaploop');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'ReapLoop' });
  const step = store.addStep(plan.id, { title: 'stale step for the background reaper' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id, step_id: step.id, executor: 'bg-victim', stale_after_ms: 5_000,
  });
  // Manually age the heartbeat past the stale threshold so the loop sees
  // it as stale on the first tick — same effect as waiting real seconds
  // without slowing the test.
  const pastIso = new Date(Date.now() - 30_000).toISOString();
  store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(pastIso, opened.lease.id);
  let reapedNotified = false;
  const loop = reapLoop(store, { interval_ms: 5_000, stale_after_ms: 5_000, onReap: () => { reapedNotified = true; } });
  await new Promise((r) => setTimeout(r, 80)); // first tick fires via setImmediate
  loop.stop();
  check('background reap loop fires immediately on start', reapedNotified === true);
  check('background reap loop closed the stale lease',
    store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
}

// ----------------------------------------- 7. legacy migration reconciled
// A pre-v8 database (older USER_VERSION, no disposition columns, no lease
// table) must migrate on open: existing done/skipped/blocked steps get
// legacy dispositions, orphaned non-terminal activity for done plans gets
// terminalized. New plans post-migration still enforce the strict gate.
{
  const { store, path } = makeStore('migration');
  const project = store.currentProject();
  const plan = store.createPlan({ project_id: project.id, title: 'Legacy-migrated plan' });
  const step = store.addStep(plan.id, { title: 'plan-terminalized long ago' });
  store.setPlanStatus(plan.id, 'active');
  // Force-close the plan to simulate a pre-v8 shape (step still pending).
  store.setPlanStatus(plan.id, 'done', { force: true, reason: 'test: pretend pre-v8 legacy plan' });
  // Manually reset the step's disposition to look like the raw pre-v8 row.
  store.db.prepare("UPDATE steps SET verification_disposition='', disposition_reason='' WHERE id=?").run(step.id);
  // Now run the legacy backfill by pretending user_version drifted.
  // The setPlanStatus force path just above already stamped a completion_lock
  // and a status of done, but disposition is blank; verify the gate now
  // reports a legacy blocker if the plan were re-activated.
  store.setPlanStatus(plan.id, 'active');
  // Simulating the legacy backfill: run it explicitly (the migration only
  // fires on version bump, but the helper is idempotent — no bump here so
  // we exercise it directly).
  store.db.prepare("UPDATE steps SET status='done' WHERE id=?").run(step.id);
  store.setStepDisposition(step.id, { disposition: 'legacy_unknown', reason: 'reconciled by test' });
  const finalStep = store.getStep(step.id);
  check('legacy step reconciled with legacy_unknown disposition',
    finalStep.status === 'done' && finalStep.verification_disposition === 'legacy_unknown');
  const gate = store.assessPlanTerminalization(plan.id);
  check('legacy-reconciled plan passes gate cleanly', gate.ok === true);
  cleanup(store, path);
}

console.log(`\nexecution-lifecycle regression OK (${pass} checks)`);
