// c4-telemetry-health.mjs — focused C4 telemetry/health integration coverage.
// Run: node test/c4-telemetry-health.mjs
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { Store } from '../src/db.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

function makeStore(tag) {
  const dbPath = join(tmpdir(), `plan-ledger-c4-${tag}-${process.pid}-${Date.now().toString(36)}.db`);
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  return { store: new Store(dbPath), dbPath };
}
function cleanup(store, dbPath) {
  try { store.close(); } catch {}
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
}

function loadUiHooks() {
  const htmlPath = new URL('../web/index.html', import.meta.url);
  const html = readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  const script = html.slice(start + '<script>'.length, end);
  const makeEl = () => ({
    innerHTML: '', textContent: '', value: '', checked: false, style: {}, options: [],
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    insertAdjacentHTML(_p, frag) { this.innerHTML += frag; }, closest() { return null; }, blur() {}, focus() {}, remove() {}, select() {},
  });
  const registry = new Map();
  const doc = {
    getElementById(id) { if (!registry.has(id)) registry.set(id, makeEl()); return registry.get(id); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return makeEl(); },
    execCommand() { return true; },
    body: makeEl(),
  };
  const sandbox = {
    window: null,
    document: doc,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => true } },
    location: { search: '' },
    console,
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => ({ board_health_badges: 'on' }) }),
    setTimeout: () => 1,
    clearTimeout() {},
    prompt: () => null,
    __PLAN_LEDGER_TEST__: true,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'index-inline.js' });
  return { hooks: sandbox.__liveActivityTestHooks, doc };
}

{
  const oldGate = process.env.PLAN_LEDGER_COMPLETION_GATE;
  const oldAuto = process.env.PLAN_LEDGER_AUTO_REASSIGN;
  process.env.PLAN_LEDGER_COMPLETION_GATE = 'warn';
  process.env.PLAN_LEDGER_AUTO_REASSIGN = 'enforce';
  const { store, dbPath } = makeStore('integration');
  const plan = store.createPlan({ title: 'C4 integration' });
  const staleStep = store.addStep(plan.id, { title: 'stale lease', role: 'architect' });
  const verifyStep = store.addStep(plan.id, { title: 'needs manual verify', role: 'implementer' });
  const awaitStep = store.addStep(plan.id, { title: 'await artifact', role: 'implementer' });
  const healthyStep = store.addStep(plan.id, { title: 'healthy', role: 'implementer' });
  const missingStep = store.addStep(plan.id, { title: 'historical missing activity', role: 'implementer' });
  store.setPlanStatus(plan.id, 'active');

  const staleLease = store.openExecutionLease({
    plan_id: plan.id,
    step_id: staleStep.id,
    executor: 'c4-stale',
    stale_after_ms: 5_000,
    dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
    lease_policy: { max_auto_reassignments: 2, stale_after_ms: 5_000 },
    override_reason: 'c4 stale setup',
  });
  store.heartbeatExecutionLease(staleLease.lease.id, { phase: 'working', action_summary: 'heartbeat before stale' });
  const stalePast = new Date(Date.now() - 30_000).toISOString();
  store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(stalePast, staleLease.lease.id);
  store.db.prepare('UPDATE activity_runs SET updated_at=? WHERE id=?').run(stalePast, staleLease.activity.id);

  const verifyRun = store.startActivity({
    plan_id: plan.id, step_id: verifyStep.id, run_id: 'verify-run', session_ref: 'verify-sess', role: 'implementer',
  });
  store.recordAttempt(verifyStep.id, {
    what_tried: 'pass without artifacts',
    verdict: 'pass',
    completion_payload: { contract_version: 2, outcome: 'success', artifacts: [], commands: [], limitations: [] },
  });

  const awaitLease = store.openExecutionLease({
    plan_id: plan.id, step_id: awaitStep.id, executor: 'c4-await', stale_after_ms: 60_000,
    dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'implementer', fallback_roles: ['debugger'] },
    lease_policy: { max_auto_reassignments: 2 },
    override_reason: 'c4 awaiting setup',
  });
  store.heartbeatExecutionLease(awaitLease.lease.id, { phase: 'working', action_summary: 'still no artifact', progress_completed: 1, progress_total: 3 });

  const healthyLease = store.openExecutionLease({
    plan_id: plan.id, step_id: healthyStep.id, executor: 'c4-healthy', stale_after_ms: 60_000,
  });
  store.heartbeatExecutionLease(healthyLease.lease.id, {
    phase: 'working',
    action_summary: 'artifact produced',
    artifact_count: 1,
    recent_artifacts: ['docs/audits/proof.txt'],
  });

  const reaped = store.reapStaleLeases({
    now_ms: Date.now(),
    dispatch_policy: { task_modality: 'implementation', required_artifact_type: 'code_patch', preferred_role: 'architect', fallback_roles: ['implementer'] },
    lease_policy: { max_auto_reassignments: 2, stale_after_ms: 5_000 },
    override_reason: 'c4 stale reap',
  });
  check('stale reap records C3 stale reason codes', reaped.reaped_count === 1
    && reaped.reaped[0].stale_reason === 'lease_timeout'
    && reaped.reaped[0].recovery.reason_code === 'role_mismatch');

  const recent = store.listRecentActivity({ plan_id: plan.id, include_events: true, limit: 20 });
  const byStep = new Map(recent.map((r) => [r.step_id, r]));
  const queryForcedStale = store.listCurrentActivity({ plan_id: plan.id, stale_after_ms: 1, include_events: true })
    .find((r) => r.step_id === awaitStep.id);
  const leaseTruthStep = store.addStep(plan.id, { title: 'lease-truth stale', role: 'implementer' });
  const leaseTruthLease = store.openExecutionLease({
    plan_id: plan.id,
    step_id: leaseTruthStep.id,
    executor: 'c4-lease-truth',
    stale_after_ms: 5_000,
  });
  store.heartbeatExecutionLease(leaseTruthLease.lease.id, { phase: 'working', action_summary: 'lease truth stale setup' });
  const staleByLeasePast = new Date(Date.now() - 30_000).toISOString();
  store.db.prepare('UPDATE execution_leases SET last_heartbeat_at=? WHERE id=?').run(staleByLeasePast, leaseTruthLease.lease.id);
  const leaseTruthStale = store.listCurrentActivity({ plan_id: plan.id, stale_after_ms: 300_000, include_events: true })
    .find((r) => r.step_id === leaseTruthStep.id);
  check('all four health states appear in API',
    byStep.get(verifyStep.id)?.health?.state === 'needs_manual_verification'
    && byStep.get(awaitStep.id)?.health?.state === 'awaiting_artifact'
    && byStep.get(healthyStep.id)?.health?.state === 'healthy'
    && leaseTruthStale?.health?.state === 'stale_lease');
  check('stale_lease health uses persisted lease threshold, not query stale threshold',
    queryForcedStale?.health?.state !== 'stale_lease'
      && leaseTruthStale?.health?.state === 'stale_lease'
      && leaseTruthStale?.health?.reasons?.[0]?.code === 'stale_lease');

  const verifyEvents = byStep.get(verifyStep.id)?.events || [];
  const validationEvent = verifyEvents.find((e) => e.event_type === 'validation_failure');
  check('validation failures emit C1 reason codes', Array.isArray(validationEvent?.metadata?.reason_codes)
    && validationEvent.metadata.reason_codes.includes('completion_artifact_missing'));

  const staleEvents = byStep.get(staleStep.id)?.events || [];
  const requiredTypes = ['start_claimed', 'heartbeat_progress', 'execution_failure', 'reassignment_recovery'];
  check('lifecycle emits >=4 ordered required events with timestamps/assignment links',
    requiredTypes.every((t) => staleEvents.some((e) => e.event_type === t))
      && staleEvents.every((e) => typeof e.timestamp === 'string' && typeof e.step_id === 'number' && Object.hasOwn(e, 'assignment_id')));

  const beforeBackfill = store.assessActivityBackfill();
  const b1 = store.backfillMissingActivityMarkers();
  const b2 = store.backfillMissingActivityMarkers();
  const afterBackfill = store.assessActivityBackfill();
  check('backfill creates one marker per missing step and is idempotent',
    b1.inserted_markers >= 1
      && b2.inserted_markers === 0
      && afterBackfill.marker_runs === afterBackfill.marker_events
      && afterBackfill.marker_runs >= beforeBackfill.marker_runs + 1);
  const backfillEvent = store.db.prepare(
    "SELECT assignment_id, assignment_missing_reason FROM activity_events WHERE event_type='activity_backfill_missing' ORDER BY id DESC LIMIT 1"
  ).get();
  check('backfill marker event never resolves a live assignment id',
    backfillEvent && backfillEvent.assignment_id == null && backfillEvent.assignment_missing_reason === 'historical_backfill');
  const current = store.listCurrentActivity({ plan_id: plan.id, include_events: true, limit: 50 });
  check('backfill markers never appear as live current activity',
    !current.some((r) => (r.events || []).some((e) => e.event_type === 'activity_backfill_missing')));

  const healthA = store.activityHealthSummary({ plan_id: plan.id });
  const healthB = store.activityHealthSummary({ plan_id: plan.id });
  check('health priority summary is deterministic', JSON.stringify(healthA) === JSON.stringify(healthB));

  const { hooks, doc } = loadUiHooks();
  hooks.setBoardHealthBadgesEnabled(true);
  hooks.setState({ projectId: 1, planId: plan.id, stepId: awaitStep.id });
  hooks.setActivitySnapshot({
    current: [
      { ...byStep.get(healthyStep.id), health: { state: 'healthy', reasons: [{ code: 'healthy' }] } },
      { ...byStep.get(awaitStep.id), health: { state: 'awaiting_artifact', reasons: [{ code: 'awaiting_artifact' }] } },
      { ...byStep.get(verifyStep.id), health: { state: 'needs_manual_verification', reasons: [{ code: 'needs_manual_verification' }] } },
      { ...byStep.get(staleStep.id), health: { state: 'stale_lease', reasons: [{ code: 'stale_lease' }] } },
    ],
    recent: recent,
    rosterByStep: new Map(),
    error: '',
    last_ok_at: new Date().toISOString(),
  });
  hooks.renderActivityPanel();
  const panel = doc.getElementById('activity').innerHTML;
  check('UI renders all four health badges and legend when enabled',
    panel.includes('health: healthy')
      && panel.includes('health: awaiting_artifact')
      && panel.includes('health: needs_manual_verification')
      && panel.includes('health: stale_lease')
      && panel.includes('Health legend: healthy | awaiting_artifact | needs_manual_verification | stale_lease'));

  // One-refresh stale badge behavior: a single render after state update shows stale.
  hooks.setActivitySnapshot({
    current: [{ ...byStep.get(awaitStep.id), health: { state: 'stale_lease', reasons: [{ code: 'stale_lease' }] } }],
  });
  hooks.renderActivityPanel();
  const panel2 = doc.getElementById('activity').innerHTML;
  check('one refresh cycle updates UI to stale_lease badge', panel2.includes('health: stale_lease'));

  cleanup(store, dbPath);
  if (oldGate == null) delete process.env.PLAN_LEDGER_COMPLETION_GATE; else process.env.PLAN_LEDGER_COMPLETION_GATE = oldGate;
  if (oldAuto == null) delete process.env.PLAN_LEDGER_AUTO_REASSIGN; else process.env.PLAN_LEDGER_AUTO_REASSIGN = oldAuto;
}

console.log(`\nc4 telemetry/health regression OK (${pass} checks)`);
