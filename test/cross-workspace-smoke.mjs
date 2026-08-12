// cross-workspace-smoke.mjs — end-to-end proof that the global /plan-ledger
// bridge works from a fresh workspace directory that lives OUTSIDE this repo.
// No MCP; no repo-cwd assumptions; only the tested JSON CLI bridge.
//
// Exercises the full reliability contract in one flow:
//   1. Create a fresh sibling workspace + a fresh DB path.
//   2. Invoke the CLI bridge from that workspace cwd for every operation
//      (create project, create plan, add step, approve, open+close lease with
//      an atomic recorded attempt, verify plan-done invariants pass).
//   3. Publish a reliability summary: counts of open leases, non-terminal
//      activity, incomplete dispositions across every plan in the DB. Fails
//      loudly if any are non-zero (the whole point of the release gate).
//
// Run: node test/cross-workspace-smoke.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/ledger-cli.mjs', import.meta.url));

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

const workspace = mkdtempSync(join(tmpdir(), 'plan-ledger-xws-'));
const dbPath = join(workspace, 'ledger.db');

const runCli = (operation, args = {}) => {
  const p = spawnSync(process.execPath, [cliPath, operation, '--input', JSON.stringify(args)], {
    cwd: workspace, // NOT the repo — proves the bridge does not need the repo cwd
    env: { ...process.env, PLAN_LEDGER_DB: dbPath, PLAN_LEDGER_NO_OPEN: '1' },
    encoding: 'utf8',
  });
  let body = null;
  try { body = p.stdout.trim() ? JSON.parse(p.stdout) : null; } catch { body = { raw_stdout: p.stdout }; }
  if (p.status !== 0) console.error(`[cli] ${operation} failed:`, p.stderr || p.stdout);
  return { status: p.status, body, stderr: p.stderr };
};

try {
  check('workspace directory created outside the repo', existsSync(workspace));

  const project = runCli('create_project', { name: `Cross-workspace smoke ${Date.now()}` });
  check('create_project from a foreign workspace cwd', project.status === 0 && project.body?.result?.id > 0);
  const projectId = project.body.result.id;

  const setCur = runCli('set_current_project', { project_id: projectId });
  check('set_current_project scopes further calls', setCur.status === 0);

  const plan = runCli('create_plan', {
    title: 'Full lifecycle smoke',
    keywords: ['smoke', 'lifecycle', 'cross-workspace'],
    summary: 'End-to-end test: create → approve → lease → close → done.',
  });
  check('create_plan (starts as draft)', plan.status === 0 && plan.body?.result?.status === 'draft');
  const planId = plan.body.result.id;

  const step = runCli('add_step', {
    plan_id: planId,
    title: 'Write the smoke evidence file',
    context: 'Prove the plan can be executed via the bridge alone.',
    acceptance_criteria: 'Lease opens, closes with pass, plan can be done.',
    role: 'implementer',
  });
  check('add_step returns the created step id', step.status === 0 && step.body?.result?.id > 0);
  const stepId = step.body.result.id;

  // Draft approval boundary: next_step must refuse to hand out work.
  const draftProbe = runCli('next_step', { plan_id: planId, claim: true, executor: 'smoke-executor' });
  check('draft plan: next_step(claim) refuses to execute',
    draftProbe.status === 0 && draftProbe.body?.result?.awaiting_approval === true);

  const approved = runCli('approve_plan', { plan_id: planId });
  check('approve_plan activates the draft',
    approved.status === 0 && (approved.body?.result?.plan?.status === 'active' || approved.body?.result?.status === 'active'));

  // Open lease → simulate real work with a heartbeat → close atomically
  // with a passing attempt. `disposition` defaults to `verified` for
  // step_verdict='pass', which lets the plan-done gate close cleanly.
  const lease = runCli('open_execution_lease', {
    plan_id: planId, step_id: stepId, executor: 'smoke-executor',
    requested_model: 'test-model', actual_model: 'test-model',
    model_source: 'cross-workspace-smoke',
    action_summary: 'Cross-workspace smoke: opening lease for the smoke step',
  });
  check('open_execution_lease from bridge succeeds', lease.status === 0 && lease.body?.result?.lease?.status === 'open');
  const leaseId = lease.body.result.lease.id;

  const beat = runCli('heartbeat_execution_lease', {
    lease_id: leaseId,
    phase: 'execute',
    action_summary: 'Cross-workspace smoke: heartbeat mid-work',
    progress_completed: 1,
    progress_total: 2,
  });
  check('heartbeat_execution_lease refreshes the lease', beat.status === 0 && beat.body?.result?.lease?.status === 'open');

  const close = runCli('close_execution_lease', {
    lease_id: leaseId,
    outcome: 'success',
    step_verdict: 'pass',
    terminal_summary: 'Cross-workspace smoke: verified pass',
    attempt: {
      what_tried: 'wrote smoke evidence via the bridge',
      result: 'lease closed cleanly with disposition=verified',
      executor: 'smoke-executor',
      role: 'implementer',
      model: 'test-model',
      model_source: 'cross-workspace-smoke',
    },
  });
  check('close_execution_lease terminalizes atomically',
    close.status === 0
      && close.body?.result?.lease?.status === 'closed'
      && close.body?.result?.step?.status === 'done'
      && close.body?.result?.step?.verification_disposition === 'verified');

  // Reliability invariants — the entire point of the release gate.
  const gate = runCli('assess_plan_terminalization', { plan_id: planId });
  check('assess_plan_terminalization reports ok:true', gate.status === 0 && gate.body?.result?.ok === true);

  const done = runCli('set_plan_status', { plan_id: planId, status: 'done' });
  check('set_plan_status(done) succeeds without force', done.status === 0 && done.body?.result?.status === 'done');

  const leases = runCli('list_execution_leases', { plan_id: planId, status: 'open' });
  check('no open leases remain after the smoke',
    leases.status === 0 && (leases.body?.result?.length ?? -1) === 0);

  const currentActivity = runCli('list_current_activity', { plan_id: planId });
  check('no non-terminal activity remains after the smoke',
    currentActivity.status === 0 && (currentActivity.body?.result?.length ?? -1) === 0);

  // Publish a reliability summary. This is the "reliability release gate" line
  // the plan asked for — never call the run release-ready unless every counter
  // below is zero across every plan in this DB.
  const allProjects = runCli('list_projects', {});
  const projects = allProjects.body?.result || [];
  let openLeases = 0, nonTerminalActivity = 0, incompleteDispositions = 0, plansSeen = 0;
  for (const proj of projects) {
    const plansRes = runCli('list_plans', { project_id: proj.id, all: true });
    for (const p of (plansRes.body?.result || [])) {
      plansSeen++;
      const l = runCli('list_execution_leases', { plan_id: p.id, status: 'open' });
      openLeases += (l.body?.result || []).length;
      const a = runCli('list_current_activity', { plan_id: p.id });
      nonTerminalActivity += (a.body?.result || []).length;
      const open = runCli('open_plan', { plan_id: p.id });
      for (const st of (open.body?.result?.steps || [])) {
        if (['done', 'skipped', 'blocked'].includes(st.status)) {
          const full = runCli('get_step', { step_id: st.id });
          const disp = full.body?.result?.verification_disposition || '';
          if (!disp) incompleteDispositions++;
        }
      }
    }
  }
  console.log(`\nreliability summary (${plansSeen} plan(s) in ${dbPath}):`);
  console.log(`  open_leases              = ${openLeases}`);
  console.log(`  non_terminal_activity    = ${nonTerminalActivity}`);
  console.log(`  incomplete_dispositions  = ${incompleteDispositions}`);
  check('reliability summary: no open leases', openLeases === 0);
  check('reliability summary: no non-terminal activity', nonTerminalActivity === 0);
  check('reliability summary: no incomplete dispositions', incompleteDispositions === 0);

  console.log(`\ncross-workspace-smoke OK (${pass} checks)`);
  console.log('release-ready: every reliability counter above is zero.');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
