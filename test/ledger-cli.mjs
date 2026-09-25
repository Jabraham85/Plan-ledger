// ledger-cli.mjs — focused regression for the non-MCP JSON CLI bridge.
// Run: node test/ledger-cli.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalDbIdentity } from '../src/db.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/ledger-cli.mjs', import.meta.url));
const dbPath = join(tmpdir(), `plan-ledger-cli-${process.pid}.db`);
const fakeHome = join(tmpdir(), `plan-ledger-cli-home-${process.pid}`);
const rolesPath = join(tmpdir(), `plan-ledger-cli-roles-${process.pid}.json`);

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

const runCli = (operation, args = {}, extraEnv = {}) => {
  const env = {
    ...process.env,
    PLAN_LEDGER_DB: dbPath,
    PLAN_LEDGER_ROLES: rolesPath,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ...extraEnv,
  };
  const p = spawnSync(process.execPath, [cliPath, operation, '--input', JSON.stringify(args)], {
    cwd: root, env, encoding: 'utf8',
  });
  let body;
  try { body = p.stdout.trim() ? JSON.parse(p.stdout) : null; } catch { body = null; }
  return { ...p, body };
};

const runCliWithOpenStdin = (operation, args = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cliPath, operation, '--input', JSON.stringify(args)], {
    cwd: root,
    env: {
      ...process.env,
      PLAN_LEDGER_DB: dbPath,
      PLAN_LEDGER_ROLES: rolesPath,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    child.kill();
    resolve({ status: null, timedOut: true, stdout, stderr, body: null });
  }, 3000);
  child.on('close', (status) => {
    clearTimeout(timer);
    let body = null;
    try { body = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
    resolve({ status, timedOut: false, stdout, stderr, body });
  });
});

const runCliAsync = (operation, args = {}, extraEnv = {}) => new Promise((resolve) => {
  const env = {
    ...process.env,
    PLAN_LEDGER_DB: dbPath,
    PLAN_LEDGER_ROLES: rolesPath,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ...extraEnv,
  };
  const child = spawn(process.execPath, [cliPath, operation, '--input', JSON.stringify(args)], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => {
    let body;
    try { body = stdout.trim() ? JSON.parse(stdout) : null; } catch { body = null; }
    resolve({ status, stdout, stderr, body });
  });
});

try {
  writeFileSync(rolesPath, JSON.stringify({
    roles: { implementer: { agent: 'general-purpose', model: 'gpt-5.3-codex' } },
    projects: { CLIProject: { roles: { implementer: { model: 'gpt-5.6-sol-medium' } } } },
  }));

  const project = runCli('create_project', { name: 'CLIProject', description: 'bridge test' });
  check('create_project exits 0', project.status === 0 && project.body?.ok === true);
  check('defaultDbPath honors PLAN_LEDGER_DB override', project.body.db_path === dbPath);
  const projectId = project.body.result.id;
  check('create_project returns a numeric id', Number.isInteger(projectId) && projectId > 0);
  const flaggedInput = await runCliWithOpenStdin('list_projects', {});
  check('--input does not wait for an open stdin pipe', flaggedInput.timedOut === false
    && flaggedInput.status === 0 && flaggedInput.body?.ok === true);

  const setCurrent = runCli('set_current_project', { project_id: projectId });
  check('set_current_project switches context', setCurrent.body.result.id === projectId && setCurrent.body.result.name === 'CLIProject');

  const plan = runCli('create_plan', {
    title: 'CLI bridge draft plan',
    summary: 'ensure bridge operations cover skill needs',
    keywords: ['cli', 'bridge'],
  });
  check('create_plan succeeds', plan.status === 0 && plan.body.ok === true && plan.body.result.status === 'draft');
  const planId = plan.body.result.id;

  const priorDone = runCli('create_plan', { title: 'Diagon audit hardening', keywords: ['diagon', 'audit', 'reassignment'] });
  const priorActive = runCli('create_plan', { title: 'Diagon active escalation', keywords: ['diagon', 'stalled', 'architect'] });
  runCli('set_plan_status', { plan_id: priorDone.body.result.id, status: 'done' });
  runCli('set_plan_status', { plan_id: priorActive.body.result.id, status: 'active' });
  const priorDoneStep = runCli('add_step', { plan_id: priorDone.body.result.id, title: 'capture audit notes', carry_forward: 'stalled architect handoff captured' });
  runCli('record_attempt', {
    step_id: priorDoneStep.body.result.id,
    what_tried: 'audited reassignment workflow',
    result: 'preserved provenance and handoff context',
    verdict: 'fail',
  });
  const discovery = runCli('planner_start', {
    goal: 'Recover from stalled architect audit reassignment',
    keywords: ['Diagon', 'Audit', 'ReAssignment', 'stalled', 'architect', 'handoff', 'provenance', 'board', 'ignored-extra'],
    limit: 3,
    max_keywords: 8,
    draft_plan_id: planId,
  });
  check('planner_start enforces max 8 normalized keywords', discovery.body.result.keywords.length <= 8
    && discovery.body.result.keywords.every((k) => k === k.toLowerCase()));
  check('planner_start separates completed vs active matches', discovery.body.result.completed.some((m) => m.plan_id === priorDone.body.result.id)
    && discovery.body.result.related_active.some((m) => m.plan_id === priorActive.body.result.id));
  check('planner_start records consulted plan provenance on the draft', discovery.body.result.consulted.some((c) => c.consulted_plan_id === priorDone.body.result.id)
    && discovery.body.result.consulted.some((c) => c.consulted_plan_id === priorActive.body.result.id));

  const updatePlan = runCli('update_plan', {
    plan_id: planId,
    summary: 'CLI bridge draft plan with prior-plan provenance',
    consulted_plan_ids: [priorDone.body.result.id],
    consulted_keywords: ['diagon', 'audit'],
    consulted_goal: 'refresh consulted ids after draft edits',
  });
  check('update_plan persists consulted ids while editing metadata', updatePlan.body.result.summary.includes('prior-plan provenance')
    && updatePlan.body.result.consulted_plans.some((c) => c.consulted_plan_id === priorDone.body.result.id));

  const stepA = runCli('add_step', {
    plan_id: planId,
    title: 'Author draft step',
    context: 'Write the first draft step body',
    role: 'implementer',
    acceptance_criteria: 'Step body written',
  });
  const stepB = runCli('add_step', {
    plan_id: planId,
    title: 'Execute after dependency',
    context: 'Run only after step A done',
    role: 'implementer',
    acceptance_criteria: 'Execution completed',
  });
  const stepAId = stepA.body.result.id;
  const stepBId = stepB.body.result.id;
  check('add_step creates two ordered steps', stepA.body.result.idx === 1 && stepB.body.result.idx === 2);

  const link = runCli('link_items', {
    from_step_id: stepBId,
    to_step_id: stepAId,
    relation: 'builds_on',
    note: 'B depends on A',
  });
  check('link_items persists dependency edge', link.body.result.relation === 'builds_on' && link.body.result.to_step_id === stepAId);

  const draftNext = runCli('next_step', { plan_id: planId, claim: true, executor: 'cli-test' });
  check('next_step on draft returns awaiting_approval', draftNext.body.result.awaiting_approval === true && draftNext.body.result.plan.status === 'draft');

  const approved = runCli('approve_plan', { plan_id: planId });
  check('approve_plan explicitly activates draft plan', approved.body.result.activated === true && approved.body.result.plan.status === 'active');

  const activeNext = runCli('next_step', { plan_id: planId, claim: true, executor: 'cli-test' });
  check('next_step claim returns first step in progress', activeNext.body.result.id === stepAId && activeNext.body.result.status === 'in_progress');

  const ready = runCli('ready_steps', { plan_id: planId, claim: true, executor: 'cli-test' });
  check('ready_steps excludes dependency-blocked step', Array.isArray(ready.body.result.steps) && ready.body.result.steps.length === 0);

  const attempt = runCli('record_attempt', {
    step_id: stepAId,
    what_tried: 'Executed first step with CLI bridge',
    result: 'First step completed',
    verdict: 'pass',
    role: 'implementer',
    review_rounds: 1,
    executor: 'runner-cli',
    agent: 'general-purpose',
    model: 'gpt-5.3-codex',
    model_source: 'runner-cli',
    session_ref: 'sess-cli-1',
    layman: 'Completed step A successfully.',
  });
  check('record_attempt stores execution provenance', attempt.body.result.attempts.at(-1).model === 'gpt-5.3-codex'
    && attempt.body.result.attempts.at(-1).session_ref === 'sess-cli-1');
  check('record_attempt pass marks step done', attempt.body.result.status === 'done');

  const nextAfterDep = runCli('next_step', { plan_id: planId });
  check('next_step advances after dependency satisfied', nextAfterDep.body.result.id === stepBId);

  const setStep = runCli('set_step_status', { step_id: stepBId, status: 'in_progress' });
  check('set_step_status updates step status', setStep.body.result.status === 'in_progress');
  const setPlan = runCli('set_plan_status', { plan_id: planId, status: 'blocked' });
  check('set_plan_status updates plan status', setPlan.body.result.status === 'blocked');
  const reconcileRead = runCli('assess_plan_reconciliation', { plan_id: planId, source: 'cli-test' });
  check('assess_plan_reconciliation returns result payload', reconcileRead.status === 0
    && typeof reconcileRead.body.result.result_code === 'string' && Array.isArray(reconcileRead.body.result.blockers));

  const assigned = runCli('assign_step', {
    step_id: stepBId,
    role: 'implementer',
    reason: 'Keep same specialist but audit reassignment',
    assigned_by: 'cli-test',
  });
  check('assign_step appends assignment revision', assigned.body.result.assignments.length >= 2);

  const roster = runCli('get_plan_roster', { plan_id: planId, cwd: root });
  check('get_plan_roster returns planned assignment data', roster.body.result.steps[0].planned.role === 'implementer');

  const startedActivity = runCli('start_activity', {
    plan_id: planId,
    step_id: stepAId,
    run_id: 'cli-run-1',
    session_ref: 'cli-session-1',
    role: 'implementer',
    agent: 'general-purpose',
    requested_model: 'gpt-5.3-codex',
    actual_model: 'gpt-5.3-codex',
    model_source: 'runner-cli',
    phase: 'dispatch',
    action_summary: 'CLI start activity',
    command_summary: 'node test',
    progress_completed: 1,
    progress_total: 3,
  });
  check('start_activity creates a structured activity run', startedActivity.body.result.run_id === 'cli-run-1'
    && startedActivity.body.result.session_ref === 'cli-session-1');
  const heartbeatActivity = runCli('heartbeat_activity', {
    plan_id: planId,
    step_id: stepAId,
    run_id: 'cli-run-1',
    session_ref: 'cli-session-1',
    phase: 'verify',
    status: 'in_progress',
    progress_completed: 2,
    progress_total: 3,
    recent_artifacts: ['artifact-a', 'artifact-b'],
  });
  check('heartbeat_activity upserts progress on the same key', heartbeatActivity.body.result.phase === 'verify'
    && heartbeatActivity.body.result.progress_completed === 2);
  const appendEvent = runCli('append_activity_event', {
    plan_id: planId,
    step_id: stepAId,
    run_id: 'cli-run-1',
    session_ref: 'cli-session-1',
    event_type: 'terminal',
    summary: 'terminal output',
    command_summary: 'safe terminal command',
  });
  check('append_activity_event appends a terminal event', Number.isInteger(appendEvent.body.result.event_id) && appendEvent.body.result.event_type === 'terminal');
  const currentActivity = runCli('list_current_activity', { plan_id: planId, step_id: stepAId, include_events: true, events_limit: 5 });
  check('list_current_activity returns keyed run + events', currentActivity.body.result.length === 1
    && currentActivity.body.result[0].events.some((e) => e.event_type === 'terminal'));
  const recentActivity = runCli('list_recent_activity', { plan_id: planId, limit: 10 });
  check('list_recent_activity returns activity history', recentActivity.body.result.some((r) => r.run_id === 'cli-run-1'));

  const staff = runCli('list_project_staff', { project_id: projectId });
  check('list_project_staff resolves project role/model view', staff.body.result.project_name === 'CLIProject'
    && staff.body.result.roles.some((r) => r.role === 'implementer' && typeof r.model === 'string'));

  const boardList = runCli('board', { command: 'list' });
  check('board list returns text interface', typeof boardList.body.result.text === 'string' && boardList.body.result.mode === 'list');
  const boardShow = runCli('board', { command: 'show', plan_id: planId });
  check('board show renders plan tree text', boardShow.body.result.mode === 'show' && boardShow.body.result.text.includes(`#${planId}`));

  let fakeBoardMetaReqs = 0;
  const expectedDbIdentity = canonicalDbIdentity(dbPath);
  const fakeBoard = createServer((req, res) => {
    if (req.url === '/api/meta') {
      fakeBoardMetaReqs++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'plan-ledger-board',
        api_version: 1,
        db_path: dbPath,
        db_identity: expectedDbIdentity,
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise((resolve) => fakeBoard.listen(0, '127.0.0.1', resolve));
  const fakePort = fakeBoard.address().port;

  const boardOpen = await runCliAsync('board', {
    command: 'open',
    project_id: projectId,
    plan_id: planId,
    step_id: stepAId,
  }, {
    PLAN_LEDGER_WEB_PORT: String(fakePort),
    PLAN_LEDGER_NO_OPEN: '1',
  });
  check('board open reuses an already healthy board', boardOpen.status === 0
    && boardOpen.body.result.mode === 'open'
    && boardOpen.body.result.reused_existing === true
    && boardOpen.body.result.started_server === false);
  check('board open composes deep-link URL with ids', /project_id=\d+/.test(boardOpen.body.result.url)
    && /plan_id=\d+/.test(boardOpen.body.result.url)
    && /step_id=\d+/.test(boardOpen.body.result.url));
  check('board open honors PLAN_LEDGER_NO_OPEN suppression', boardOpen.body.result.open_suppressed === true
    && boardOpen.body.result.opened_browser === false);

  const boardOpenBadIds = await runCliAsync('board', {
    command: 'launch',
    project_id: 'not-a-number',
    plan_id: -4,
    step_id: stepAId,
  }, {
    PLAN_LEDGER_WEB_PORT: String(fakePort),
    PLAN_LEDGER_NO_OPEN: '1',
  });
  check('board launch ignores invalid query ids safely', boardOpenBadIds.status === 0
    && boardOpenBadIds.body.result.url.includes(`step_id=${stepAId}`)
    && !boardOpenBadIds.body.result.url.includes('project_id=')
    && !boardOpenBadIds.body.result.url.includes('plan_id=')
    && boardOpenBadIds.body.result.ignored_query_params.project_id
    && boardOpenBadIds.body.result.ignored_query_params.plan_id);
  check('board open probes board metadata endpoint', fakeBoardMetaReqs > 0);
  fakeBoard.close();

  const mismatchedBoard = createServer((req, res) => {
    if (req.url === '/api/meta') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'plan-ledger-board',
        api_version: 1,
        db_path: '/tmp/other-ledger.db',
        db_identity: 'different-db-identity',
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise((resolve) => mismatchedBoard.listen(0, '127.0.0.1', resolve));
  const mismatchPort = mismatchedBoard.address().port;
  const mismatch = await runCliAsync('board', { command: 'open' }, {
    PLAN_LEDGER_WEB_PORT: String(mismatchPort),
    PLAN_LEDGER_NO_OPEN: '1',
  });
  check('board open rejects healthy board with mismatched DB identity', mismatch.status !== 0
    && mismatch.body?.ok === false
    && /different DB identity/i.test(mismatch.body.error.message));
  check('board mismatch rejection returns expected and found identities', mismatch.body.error.details
    && mismatch.body.error.details.expected_db_identity
    && mismatch.body.error.details.found_db_identity === 'different-db-identity');
  mismatchedBoard.close();

  // the brain over the bridge: a Cursor agent can read what the brain holds and write back what it verified
  {
    const bp = runCli('create_plan', { title: 'Brain bridge plan' }).body.result.id;
    const bs = runCli('add_step', { plan_id: bp, title: 'wire the export button', context: 'src/export.js' }).body.result.id;
    const put = runCli('absorb_findings', { step_id: bs, source: 'cursor', findings: [
      { kind: 'fact', subject: 'module:export', claim: 'Export writes CSV through src/export.js writeCsv()', evidence: ['src/export.js:12'] }] });
    check('absorb_findings over the bridge records a fact', put.status === 0 && put.body?.ok === true);
    const q = runCli('query_findings', { query: 'export csv' });
    const list = (r) => Array.isArray(r) ? r : (r?.findings ?? []);
    const hit = list(q.body?.result).find((f) => /writeCsv/.test(f.claim));
    check('query_findings finds it', q.status === 0 && !!hit);
    const r = runCli('recall', { query: 'export csv' });
    check('recall runs over the bridge', r.status === 0 && r.body?.ok === true);
    const s = runCli('suspect_findings', {});
    check('suspect_findings runs over the bridge', s.status === 0 && s.body?.ok === true);
    const gone = runCli('retract_finding', { finding_id: hit.id, reason: 'bridge test' });
    const after = runCli('query_findings', { query: 'export csv' });
    check('retract_finding removes it from the live brain', gone.status === 0 && !list(after.body?.result).some((f) => f.id === hit.id));
  }

  const bad = runCli('unknown_operation', {});
  check('unknown operation exits nonzero with stderr', bad.status !== 0 && /\[plan-ledger-cli\]/.test(bad.stderr));
  check('unknown operation emits JSON error payload', bad.body?.ok === false && /unknown operation/i.test(bad.body.error.message));

  console.log(`\nledger-cli regression OK (${pass} checks)`);
} finally {
  rmSync(rolesPath, { force: true });
  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}
