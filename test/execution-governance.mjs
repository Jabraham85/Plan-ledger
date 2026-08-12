// execution-governance.mjs — focused tests for dispatch governance helpers.
// Run: node test/execution-governance.mjs
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';
import {
  runDispatchPreflight,
  parseCompletionContract,
  evaluateCompletionContract,
  detectNoncomplianceEscalation,
  withBoundedRetry,
  atomicOutcome,
  runWithHeartbeat,
  safeActivitySummary,
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
      // deterministic timer pump in timestamp order
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

// failed preflight blocks dispatch work before artifact/evidence checks
{
  const preflight = await runDispatchPreflight({
    cwd: process.cwd(),
    requested_model: 'missing-model',
    context: 'REQUIRES_PATH: no/such/file\nVERIFY: npm test',
    model_catalog: { models: ['good-model'], source: 'test' },
    path_exists: () => false,
    check_port: async () => false,
  });
  check('preflight fails when workspace/model/dependencies/readiness are invalid', preflight.ok === false && preflight.checks.some((c) => c.name === 'workspace_repo'));
}

// fake process heartbeat cadence (simulate >60s child run via fake clock)
{
  const c = fakeClock();
  let heartbeats = 0;
  await runWithHeartbeat(async () => {
    c.advance(125000); // 125s simulated run -> should trigger at 60s and 120s
  }, {
    interval_ms: 60000,
    on_heartbeat: ({ elapsed_ms }) => { if (elapsed_ms >= 60000) heartbeats++; },
    now: c.now,
    set_interval: c.set_interval,
    clear_interval: c.clear_interval,
  });
  check('heartbeat pump emits updates at least every 60s', heartbeats >= 2);
}

// completion contract artifact rejection + evidence pass
{
  const tmp = join(tmpdir(), `pl-governance-artifact-${process.pid}.txt`);
  rmSync(tmp, { force: true });
  const missing = parseCompletionContract('COMPLETION_JSON: {"verdict":"pass","summary":"done","artifacts":[{"path":"missing.file"}],"commands":[{"command":"echo ok","exit_code":0}],"unresolved_gaps":[]}');
  const missingEval = evaluateCompletionContract({ completion_parse: missing, cwd: process.cwd() });
  check('pass claim is rejected when declared artifacts do not exist', missingEval.verdict === 'fail' && /missing artifacts/i.test(missingEval.summary));

  writeFileSync(tmp, 'ok');
  const ok = parseCompletionContract(`COMPLETION_JSON: {"verdict":"pass","summary":"done","artifacts":[{"path":"${tmp.replace(/\\/g, '\\\\')}"}],"commands":[{"command":"echo ok","exit_code":0}],"unresolved_gaps":[]}`);
  const okEval = evaluateCompletionContract({ completion_parse: ok, cwd: process.cwd() });
  check('evidence-backed pass is accepted', okEval.verdict === 'pass' && okEval.artifact_count >= 1);
  rmSync(tmp, { force: true });
}

// repeated noncompliance escalation
{
  const esc = detectNoncomplianceEscalation({
    attempts: [{ what_tried: '[governance:noncompliance] missing completion contract' }],
    nextNoncompliant: true,
  });
  check('second noncompliance triggers reassign recommendation', esc.escalate === true && /reassign/i.test(esc.recommendation));
}

// bounded transient retry helper
{
  let tries = 0;
  const value = await withBoundedRetry(async () => {
    tries++;
    if (tries < 3) throw new Error('temporary network timeout');
    return 'ok';
  }, {
    retries: 3,
    sleep: async () => {},
  });
  check('transient retry retries and eventually succeeds', value === 'ok' && tries === 3);
}

// atomic-outcome helper rejects partial publish/upload outcomes
{
  let threw = false;
  try { atomicOutcome([{ ok: true }, { ok: false }], { label: 'publish-upload' }); } catch (e) { threw = /partial outcome/i.test(e.message); }
  check('atomic outcome helper rejects partial success', threw === true);
}

// activity terminal state + provenance and no chain-of-thought capture
{
  const dbPath = join(tmpdir(), `plan-ledger-governance-activity-${process.pid}.db`);
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  const s = new Store(dbPath);
  const plan = s.createPlan({ title: 'governance activity plan' });
  const step = s.addStep(plan.id, { title: 'governance activity step' });
  s.setPlanStatus(plan.id, 'active');
  s.startActivity({
    plan_id: plan.id, step_id: step.id, run_id: 'gov-run', session_ref: 'sess-1',
    phase: 'dispatch', status: 'in_progress', requested_model: 'gpt-5.6-sol-medium', model_source: 'runner-cli',
    action_summary: safeActivitySummary('<thinking>hidden</thinking> external summary'),
  });
  s.upsertActivityHeartbeat({
    plan_id: plan.id, step_id: step.id, run_id: 'gov-run', session_ref: 'sess-1',
    phase: 'review', status: 'completed', outcome: 'success', verification_state: 'passed',
  });
  s.appendActivityEvent({
    plan_id: plan.id, step_id: step.id, run_id: 'gov-run', session_ref: 'sess-1',
    event_type: 'terminal', summary: safeActivitySummary('finalized without internal reasoning leak'),
    metadata: { command: 'npm test', exit_code: 0 },
  });
  const recent = s.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true, limit: 5 });
  check('activity terminal status/provenance persisted', recent[0].status === 'completed'
    && recent[0].requested_model === 'gpt-5.6-sol-medium'
    && recent[0].events.some((e) => e.event_type === 'terminal'));
  check('activity summaries redact chain-of-thought markers', !recent[0].action_summary.includes('<thinking>') && !/chain-of-thought/i.test(recent[0].action_summary));
  s.close();
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
}

console.log(`\n${pass} execution-governance checks passed.`);
