// planner-v2-e2e.mjs — deterministic end-to-end proof for planner v2 governance.
// Run: node test/planner-v2-e2e.mjs
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';
import { createBoardServer } from '../web/board.mjs';
import {
  runDispatchPreflight,
  parseCompletionContract,
  evaluateCompletionContract,
  detectNoncomplianceEscalation,
  withBoundedRetry,
  atomicOutcome,
  runWithHeartbeat,
} from '../scripts/execution-governance.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    set_interval(fn, ms) {
      const t = { fn, ms, next: now + ms, active: true };
      timers.add(t);
      return t;
    },
    clear_interval(t) { if (t) t.active = false; },
    advance(ms) {
      const target = now + ms;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let next = null;
        for (const t of timers) {
          if (!t.active) continue;
          if (t.next <= target && (!next || t.next < next.next)) next = t;
        }
        if (!next) break;
        now = next.next;
        next.fn();
        next.next += next.ms;
      }
      now = target;
    },
  };
}

const dbPath = join(tmpdir(), `plan-ledger-planner-v2-e2e-${process.pid}.db`);
const artifactPath = join(tmpdir(), `plan-ledger-planner-v2-artifact-${process.pid}.txt`);
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
rmSync(artifactPath, { force: true });

const store = new Store(dbPath);
let server = null;
try {
  const donePlan = store.createPlan({
    title: 'Completed prior-plan audit',
    keywords: ['audit', 'planner', 'governance'],
    summary: 'Completed evidence for planner v2 prior-plan discovery.',
  });
  store.setPlanStatus(donePlan.id, 'done');
  const activePlan = store.createPlan({
    title: 'Active prior-plan in progress',
    keywords: ['audit', 'planner', 'active'],
    summary: 'In-flight related work; should never be labeled completed evidence.',
  });
  store.setPlanStatus(activePlan.id, 'active');
  const draftPlan = store.createPlan({
    title: 'Planner v2 draft',
    keywords: ['planner-v2', 'governance'],
  });

  const discovery = store.plannerStart({
    goal: 'planner v2 governance and audit preflight',
    keywords: ['planner', 'audit', 'governance', 'active', 'completed'],
    draft_plan_id: draftPlan.id,
    limit: 5,
  });
  check('planner_start discovery separates completed and active matches',
    discovery.completed.some((m) => m.plan_id === donePlan.id)
    && discovery.related_active.some((m) => m.plan_id === activePlan.id)
    && discovery.related_active.every((m) => m.status === 'active'));
  check('planner_start records consulted plan ids on draft plan',
    store.openPlan(draftPlan.id).consulted_plans.some((c) => c.consulted_plan_id === donePlan.id)
    && store.openPlan(draftPlan.id).consulted_plans.some((c) => c.consulted_plan_id === activePlan.id));

  const governedPlan = store.createPlan({ title: 'Planner v2 execution', keywords: ['planner-v2', 'execution'] });
  const governedStep = store.addStep(governedPlan.id, {
    title: 'Governed dispatch step',
    context: 'VERIFY: node -v\nREQUIRES_PATH: must-exist.marker',
    acceptance_criteria: 'Run governance preflight and completion gates',
    role: 'implementer',
  });
  store.setPlanStatus(governedPlan.id, 'active');

  const preflight = await runDispatchPreflight({
    cwd: process.cwd(),
    requested_model: 'missing-model',
    context: store.getStep(governedStep.id).context,
    acceptance: store.getStep(governedStep.id).acceptance_criteria,
    model_catalog: { models: ['available-model'], source: 'test' },
    path_exists: () => false,
    check_port: async () => false,
  });
  check('failed preflight blocks work before dispatch', preflight.ok === false && preflight.checks.some((c) => c.ok === false));
  store.recordAttempt(governedStep.id, {
    what_tried: `[governance:preflight] ${preflight.summary}`,
    result: preflight.checks.map((c) => `${c.ok ? 'ok' : 'fail'} ${c.name}`).join(', '),
    verdict: 'fail',
    role: 'implementer',
    executor: 'planner-v2-e2e',
  });
  check('failed preflight leaves step non-done', store.getStep(governedStep.id).status === 'failed');

  const clock = fakeClock();
  let heartbeatCount = 0;
  const runKey = { plan_id: governedPlan.id, step_id: governedStep.id, run_id: 'planner-v2-run-1', session_ref: 'planner-v2-session-1' };
  store.startActivity({
    ...runKey,
    role: 'implementer',
    agent: 'general-purpose',
    requested_model: 'gpt-5.6-sol-medium',
    actual_model: 'gpt-5.6-sol-medium',
    model_source: 'runner-cli',
    phase: 'dispatch',
    status: 'in_progress',
    action_summary: 'dispatch started',
    progress_completed: 1,
    progress_total: 4,
  });
  await runWithHeartbeat(async () => {
    clock.advance(125000);
  }, {
    interval_ms: 60000,
    now: clock.now,
    set_interval: clock.set_interval,
    clear_interval: clock.clear_interval,
    on_heartbeat: ({ elapsed_ms }) => {
      heartbeatCount++;
      store.upsertActivityHeartbeat({
        ...runKey,
        phase: 'execute',
        status: 'in_progress',
        action_summary: `quiet work heartbeat ${Math.round(elapsed_ms / 1000)}s`,
        progress_completed: 2,
        progress_total: 4,
        metadata: { elapsed_ms },
      });
    },
  });
  check('heartbeat cadence emits at least once per minute during quiet work', heartbeatCount >= 2);
  check('activity heartbeat is visible in current activity feed',
    store.listCurrentActivity({ plan_id: governedPlan.id, step_id: governedStep.id }).length === 1);

  const unsupportedParse = parseCompletionContract('COMPLETION_JSON: {"contract_version":1,"verdict":"pass","summary":"claimed pass without evidence","artifacts":[],"commands":[],"unresolved_gaps":[]}');
  const unsupportedEval = evaluateCompletionContract({ completion_parse: unsupportedParse, cwd: process.cwd() });
  check('unsupported artifact/command pass claim is rejected', unsupportedEval.verdict === 'fail' && /unsupported claim/i.test(unsupportedEval.summary));

  const escalation = detectNoncomplianceEscalation({
    attempts: [{ what_tried: '[governance:noncompliance] missing COMPLETION_JSON evidence contract' }],
    nextNoncompliant: true,
  });
  check('repeated noncompliance recommends reassignment', escalation.escalate === true && /reassign/i.test(escalation.recommendation));

  let partialPublishThrew = false;
  try {
    atomicOutcome([{ ok: true }, { ok: false }], { label: 'publish' });
  } catch (error) {
    partialPublishThrew = /partial outcome/i.test(String(error.message));
  }
  check('atomic partial publish fails fast', partialPublishThrew === true);

  let transientAttempts = 0;
  const retryResult = await withBoundedRetry(async () => {
    transientAttempts++;
    if (transientAttempts < 3) throw new Error('temporary network timeout');
    return 'ok';
  }, { retries: 3, sleep: async () => {} });
  check('transient retry path eventually succeeds', retryResult === 'ok' && transientAttempts === 3);

  writeFileSync(artifactPath, 'planner-v2 artifact proof', 'utf8');
  const completionText = `COMPLETION_JSON: ${JSON.stringify({
    contract_version: 1,
    verdict: 'pass',
    summary: 'Verified completion with artifact and command proof',
    artifacts: [{ path: artifactPath, kind: 'file', note: 'e2e proof artifact' }],
    commands: [{ command: 'node -v', exit_code: 0 }],
    unresolved_gaps: [],
    session_id: runKey.session_ref,
  })}`;
  const finalEval = evaluateCompletionContract({
    completion_parse: parseCompletionContract(completionText),
    required_artifacts: [artifactPath],
    verify_commands: ['node -v'],
    cwd: process.cwd(),
  });
  check('eventual completion passes verification gates', finalEval.verdict === 'pass' && finalEval.artifact_count >= 1);
  store.recordAttempt(governedStep.id, {
    what_tried: '[orchestrator:inject] verified completion',
    result: finalEval.summary,
    verdict: 'pass',
    role: 'implementer',
    executor: 'planner-v2-e2e',
    agent: 'general-purpose',
    model: 'gpt-5.6-sol-medium',
    model_source: 'runner-cli',
    session_ref: runKey.session_ref,
  });
  store.upsertActivityHeartbeat({
    ...runKey,
    phase: 'review',
    status: 'completed',
    outcome: 'success',
    verification_state: 'passed',
    action_summary: 'verified completion recorded',
    progress_completed: 4,
    progress_total: 4,
    artifact_count: finalEval.artifact_count,
    file_count: finalEval.file_count,
  });
  store.appendActivityEvent({
    ...runKey,
    event_type: 'terminal',
    phase: 'review',
    summary: 'completion verified and persisted',
    status: 'completed',
  });
  check('final step status is done after verified completion', store.getStep(governedStep.id).status === 'done');

  server = createBoardServer({ store, html: '<html><body>planner-v2</body></html>', dbPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const uiCurrent = await (await fetch(`http://127.0.0.1:${port}/api/activity/current?plan_id=${governedPlan.id}&step_id=${governedStep.id}&include_events=true`)).json();
  const uiRecentWithEvents = await (await fetch(`http://127.0.0.1:${port}/api/activity/recent?plan_id=${governedPlan.id}&step_id=${governedStep.id}&include_events=true&limit=5`)).json();
  check('UI route exposes live structured state',
    Array.isArray(uiCurrent)
    && Array.isArray(uiRecentWithEvents)
    && uiRecentWithEvents.length >= 1
    && uiRecentWithEvents[0].session_ref === runKey.session_ref
    && uiRecentWithEvents[0].requested_model === 'gpt-5.6-sol-medium'
    && uiRecentWithEvents[0].events.some((e) => e.event_type === 'terminal'));
  const uiRecent = await (await fetch(`http://127.0.0.1:${port}/api/activity/recent?plan_id=${governedPlan.id}&step_id=${governedStep.id}&limit=5`)).json();
  check('recent activity route exposes completed verified run', uiRecent[0].status === 'completed'
    && uiRecent[0].verification_state === 'passed'
    && uiRecent[0].outcome === 'success');

  console.log(`\nplanner-v2-e2e regression OK (${pass} checks)`);
} finally {
  if (server) server.close();
  store.close();
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  rmSync(artifactPath, { force: true });
}
