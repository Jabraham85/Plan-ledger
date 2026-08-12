// board-routes.mjs — HTTP-level coverage for the roster/assignment/redo routes
// added in v5. Boots the real board server on 127.0.0.1 with a temp DB and
// drives it with fetch, exercising the JSON contract clients (the web UI, the
// runner-observer) actually see. Run: node test/board-routes.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { Store, canonicalDbIdentity } from '../src/db.mjs';
import { createBoardServer } from '../web/board.mjs';

const dbPath = join(tmpdir(), `plan-ledger-board-${process.pid}.db`);
const rolesPath = join(tmpdir(), `plan-ledger-board-roles-${process.pid}.json`);
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
rmSync(rolesPath, { force: true });
const previousRolesPath = process.env.PLAN_LEDGER_ROLES;
process.env.PLAN_LEDGER_ROLES = rolesPath;
const store = new Store(dbPath);

// A tiny stand-in for web/index.html so the factory has something to hand out
// for GET /. The tests only hit /api/* routes, but the factory needs it.
const server = createBoardServer({ store, html: '<html><body>test</body></html>' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// Seed: create a plan with a step, activate it (which snapshots), then exercise
// the roster/assignment/redo endpoints.
const plan = store.createPlan({ title: 'board roster plan', keywords: ['board'] });
const step = store.addStep(plan.id, { title: 'board roster step', context: 'ctx-a', role: 'implementer' });
store.setPlanStatus(plan.id, 'active');

// Board metadata endpoint identifies plan-ledger and emits canonical DB identity
// used by CLI reuse safety checks.
{
  const meta = await req('GET', '/api/meta');
  check('GET meta: identifies plan-ledger board', meta.status === 200 && meta.data.service === 'plan-ledger-board');
  check('GET meta: exposes canonical db identity', meta.data.db_identity === canonicalDbIdentity(dbPath));
  check('GET meta: exposes board-health badge flag', meta.data.board_health_badges === 'off' || meta.data.board_health_badges === 'on');
}

// Deep-link bootstrap contract: opening a plan returns project_id and opening a
// step returns plan_id, so the board can switch project before selecting plan/step.
{
  const p = await req('GET', `/api/plans/${plan.id}`);
  const s = await req('GET', `/api/steps/${step.id}`);
  check('deep-link contract: plan includes project_id', p.status === 200 && Number.isInteger(p.data.project_id) && p.data.project_id > 0);
  check('deep-link contract: step includes plan_id', s.status === 200 && s.data.plan_id === plan.id);
}

// Structured activity routes: start/heartbeat/event/current/recent.
{
  const started = await req('POST', '/api/activity/start', {
    plan_id: plan.id,
    step_id: step.id,
    run_id: 'board-run-1',
    session_ref: 'board-session-1',
    role: 'implementer',
    requested_model: 'gpt-5.6-sol-medium',
    actual_model: 'gpt-5.6-sol-medium',
    model_source: 'runner-cli',
    phase: 'dispatch',
    action_summary: 'Board started activity',
  });
  check('POST /api/activity/start creates a run', started.status === 200 && started.data.run_id === 'board-run-1');
  const hb = await req('POST', '/api/activity/heartbeat', {
    plan_id: plan.id,
    step_id: step.id,
    run_id: 'board-run-1',
    session_ref: 'board-session-1',
    phase: 'working',
    progress_completed: 2,
    progress_total: 5,
    verification_state: 'running',
  });
  check('POST /api/activity/heartbeat updates run progress', hb.status === 200 && hb.data.progress_completed === 2);
  const staleProbe = await req('POST', '/api/activity/heartbeat', {
    plan_id: plan.id,
    step_id: step.id,
    run_id: 'board-run-1',
    session_ref: 'board-session-1',
    updated_at: '2001-01-01T00:00:00.000Z',
    status: 'in_progress',
  });
  check('POST /api/activity/heartbeat accepts explicit updated_at for stale probe', staleProbe.status === 200);
  const ev = await req('POST', '/api/activity/events', {
    plan_id: plan.id,
    step_id: step.id,
    run_id: 'board-run-1',
    session_ref: 'board-session-1',
    event_type: 'terminal',
    summary: 'terminal line',
    command_summary: 'safe command',
  });
  check('POST /api/activity/events appends event', ev.status === 200 && Number.isInteger(ev.data.event_id));
  const timeline = await req('POST', '/api/activity/events', {
    plan_id: plan.id,
    step_id: step.id,
    run_id: 'board-run-1',
    session_ref: 'board-session-1',
    event_type: 'timeline',
    phase: 'verify',
    summary: 'timeline line',
    command_summary: 'verify --quick',
  });
  check('POST /api/activity/events appends timeline event', timeline.status === 200 && Number.isInteger(timeline.data.event_id));
  const current = await req('GET', `/api/activity/current?plan_id=${plan.id}&step_id=${step.id}&include_events=true`);
  check('GET /api/activity/current returns active structured activity', current.status === 200
    && current.data.length === 1 && current.data[0].events.some((e) => e.event_type === 'terminal'));
  const terminalEvent = current.data[0].events.find((e) => e.event_type === 'terminal');
  check('activity events expose deterministic lifecycle contract fields',
    terminalEvent
      && terminalEvent.step_id === step.id
      && Object.hasOwn(terminalEvent, 'assignment_id')
      && typeof terminalEvent.timestamp === 'string'
      && terminalEvent.timestamp.length > 0
      && typeof terminalEvent.metadata === 'object');
  check('GET /api/activity/current includes provenance fields', current.data[0].requested_model === 'gpt-5.6-sol-medium'
    && current.data[0].actual_model === 'gpt-5.6-sol-medium'
    && current.data[0].model_source === 'runner-cli'
    && current.data[0].session_ref === 'board-session-1');
  check('GET /api/activity/current includes server-derived health payload',
    typeof current.data[0].health?.state === 'string' && Array.isArray(current.data[0].health?.reasons));
  const stale = await req('GET', `/api/activity/current?plan_id=${plan.id}&step_id=${step.id}&stale_after_ms=1`);
  check('GET /api/activity/current marks stale heartbeat with threshold override', stale.status === 200
    && stale.data[0].stale === true && stale.data[0].stale_for_ms > 0);
  await req('POST', '/api/activity/heartbeat', {
    plan_id: plan.id,
    step_id: step.id,
    run_id: 'board-run-1',
    session_ref: 'board-session-1',
    status: 'completed',
    outcome: 'success',
    verification_state: 'passed',
  });
  const recent = await req('GET', `/api/activity/recent?plan_id=${plan.id}&limit=5`);
  check('GET /api/activity/recent returns structured activity history', recent.status === 200
    && recent.data.some((r) => r.run_id === 'board-run-1'));
  const fromRecent = recent.data.find((r) => r.run_id === 'board-run-1');
  check('GET /api/activity/recent preserves terminal status + verification', fromRecent.status === 'completed'
    && fromRecent.outcome === 'success' && fromRecent.verification_state === 'passed');
  const recentWithEvents = await req('GET', `/api/activity/recent?plan_id=${plan.id}&include_events=true&events_limit=8&limit=5`);
  const evTypes = (recentWithEvents.data.find((r) => r.run_id === 'board-run-1')?.events || []).map((e) => e.event_type);
  check('GET /api/activity/recent timeline includes terminal + timeline events', evTypes.includes('terminal') && evTypes.includes('timeline'));
}

// GET /api/plans/:id/roster returns the full transparency view
{
  const r = await req('GET', `/api/plans/${plan.id}/roster`);
  check('GET roster: 200 OK', r.status === 200);
  check('GET roster: snapshotted after activation', r.data.snapshotted === true && r.data.steps.length === 1);
  const row = r.data.steps[0];
  check('GET roster: initial + planned present, live populated, no execution yet',
    row.initial !== null && row.planned !== null
      && row.initial.role === 'implementer'
      && row.live && typeof row.live.resolution_source === 'string'
      && row.actual === null);
  check('GET roster: dispatch policy rationale/alternatives are present',
    row.dispatch_policy && typeof row.dispatch_policy.selected_role === 'string'
      && Array.isArray(row.dispatch_policy.alternatives)
      && Array.isArray(row.dispatch_policy.warnings));
}

// PATCH /api/steps/:id/assignment appends a revision with a reason
{
  const missing = await req('PATCH', `/api/steps/${step.id}/assignment`, { role: 'debugger' });
  check('PATCH assignment: 400 without a reason', missing.status === 400 && /reason/i.test(missing.data.error));

  const ok = await req('PATCH', `/api/steps/${step.id}/assignment`,
    { role: 'debugger', reason: 'board: rotate specialist', assigned_by: 'board-user' });
  check('PATCH assignment: 200 with a reason', ok.status === 200);

  const roster = await req('GET', `/api/plans/${plan.id}/roster`);
  const revs = roster.data.steps[0].assignments;
  check('PATCH assignment: appended a new revision (planned reflects it)',
    revs.length === 2
      && revs[1].role === 'debugger' && revs[1].reason === 'board: rotate specialist'
      && revs[1].assigned_by === 'board-user'
      && roster.data.steps[0].planned.role === 'debugger');
}

// Record an actual attempt with structured provenance; the roster surfaces it.
{
  const rec = await req('POST', `/api/steps/${step.id}/attempts`,
    { what_tried: 'board provenance probe', verdict: 'pass',
      agent: 'general-purpose', model: 'claude-opus-4', model_source: 'runner-cli', session_ref: 'board-sess-1' });
  check('POST attempt: 200 records provenance', rec.status === 200);

  const roster = await req('GET', `/api/plans/${plan.id}/roster`);
  const actual = roster.data.steps[0].actual;
  check('roster: actual execution provenance is aggregated for the UI',
    actual?.model === 'claude-opus-4' && actual?.model_source === 'runner-cli'
      && actual?.session_ref === 'board-sess-1');
}

// POST /api/steps/:id/redo requires a reason, resets to pending, appends a note
{
  const missing = await req('POST', `/api/steps/${step.id}/redo`, {});
  check('POST redo: 400 without a reason', missing.status === 400 && /reason/i.test(missing.data.error));

  const ok = await req('POST', `/api/steps/${step.id}/redo`,
    { reason: 'board: retry with sharper acceptance', assigned_by: 'reviewer' });
  check('POST redo: 200 with a reason', ok.status === 200);

  const s = await req('GET', `/api/steps/${step.id}`);
  check('POST redo: step is back to pending, attempts + assignment revisions kept, review note appended',
    s.data.status === 'pending'
      && s.data.attempts.length === 1
      && s.data.assignments.length === 2
      && s.data.notes.some((n) => n.body.includes('[redo]') && /sharper acceptance/.test(n.body)));
}

// Draft plans expose "not yet snapshotted" via the roster contract — the UI
// uses `snapshotted:false` to render the pre-activation preview.
{
  const draft = store.createPlan({ title: 'board draft plan', keywords: ['draft'] });
  store.addStep(draft.id, { title: 'draft step', role: 'implementer' });
  const r = await req('GET', `/api/plans/${draft.id}/roster`);
  check('GET roster on draft: snapshotted:false, initial/planned null', r.status === 200
    && r.data.snapshotted === false
    && r.data.steps[0].initial === null && r.data.steps[0].planned === null
    && r.data.steps[0].live && r.data.steps[0].live.role === 'implementer');
}

// Project staff is a project-wide role → model map shared by every plan.
{
  const projectId = store.currentProjectId();
  const initial = await req('GET', `/api/projects/${projectId}/staff`);
  check('GET staff: standard project roster is available',
    initial.status === 200 && initial.data.project_name === store.getProject(projectId).name
      && initial.data.roles.length >= 12
      && initial.data.models.includes('gpt-5.3-codex')
      && initial.data.roles.some((r) => r.role === 'implementer'
        && /production-ready/.test(r.global_context)
        && r.recommended_model === 'gpt-5.3-codex'));

  const saved = await req('PATCH', `/api/projects/${projectId}/staff`,
    { role: 'implementer', model: 'gpt-5-mini' });
  const implementer = saved.data.roles.find((r) => r.role === 'implementer');
  check('PATCH staff: project model assignment is returned',
    saved.status === 200 && implementer.model === 'gpt-5-mini' && implementer.configured === true);

  const roleFile = JSON.parse(readFileSync(rolesPath, 'utf8'));
  check('PATCH staff: assignment persists in the project role map',
    roleFile.projects?.[store.getProject(projectId).name]?.roles?.implementer?.model === 'gpt-5-mini');

  const custom = await req('PATCH', `/api/projects/${projectId}/staff`,
    { role: 'security-reviewer', model: 'claude-sonnet-5' });
  check('PATCH staff: custom staff role can be added',
    custom.data.roles.some((r) => r.role === 'security-reviewer' && r.model === 'claude-sonnet-5'));

  const reset = await req('PATCH', `/api/projects/${projectId}/staff`,
    { role: 'security-reviewer', remove: true });
  check('PATCH staff: removing a custom assignment removes it from the staff list',
    !reset.data.roles.some((r) => r.role === 'security-reviewer'));

  const defaults = await req('POST', `/api/projects/${projectId}/staff/defaults`, {});
  check('POST staff defaults: applies researched role-specific model choices',
    defaults.status === 200
      && defaults.data.roles.find((r) => r.role === 'architect')?.model === 'claude-opus-4-8-thinking-high'
      && defaults.data.roles.find((r) => r.role === 'build-devops')?.model === 'composer-2.5-fast'
      && defaults.data.roles.find((r) => r.role === 'implementer')?.model === 'gpt-5-mini');
}

// Real-HTML contract: the board must actually serve the Live Activity
// experience (not the test-only stub used above) with a refresh loop bounded
// to <=10s, an accessible current-state region, a configurable stale
// threshold, reconnect/error copy that never implies data loss, and the
// privacy boundary between operational telemetry and private reasoning.
// This is a deterministic string contract on the exact bytes served over
// HTTP — it fails the moment any of that wiring regresses or is stubbed out.
{
  const realHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const realServer = createBoardServer({ store, html: realHtml });
  await new Promise((resolve) => realServer.listen(0, '127.0.0.1', resolve));
  const realPort = realServer.address().port;
  const page = await fetch(`http://127.0.0.1:${realPort}/`);
  const pageHtml = await page.text();

  check('GET / serves the real Live Activity script, not a stub', page.status === 200
    && pageHtml.includes('function renderActivityPanel') && pageHtml.includes('function buildActivityCard'));
  const pollMatch = pageHtml.match(/ACTIVITY_POLL_MS\s*=\s*(\d+)/);
  check('served page bounds the activity refresh loop to <=10s', !!pollMatch
    && Number(pollMatch[1]) > 0 && Number(pollMatch[1]) <= 10000);
  check('served page exposes an accessible Live Activity region', pageHtml.includes('id="activity"')
    && pageHtml.includes('role="region"') && pageHtml.includes('aria-label="Live activity"'));
  check('served page exposes a configurable, persisted stale threshold control', pageHtml.includes('id="staleThresholdInput"')
    && pageHtml.includes('aria-label="Stale threshold in seconds"') && pageHtml.includes('planLedgerActivityStaleMs'));
  check('served page carries reconnect/error copy that never implies lost data', pageHtml.includes('id="activityConn"')
    && pageHtml.includes('showing last data'));
  check('served page states the operational-telemetry-only privacy boundary', pageHtml.includes('operational telemetry only')
    && pageHtml.includes("never shows the agent's private reasoning or chain-of-thought"));
  check('served page redacts chain-of-thought / <thinking> content via sanitizeTelemetryText before display', pageHtml.includes('function sanitizeTelemetryText')
    && pageHtml.includes('chain[- ]of[- ]thought'));
  check('served page renders the timeline and current-activity list with accessible list semantics', pageHtml.includes('aria-label="Current activity"')
    && pageHtml.includes('aria-label="Recent activity timeline"'));
  check('served page announces status changes via a screen-reader live region', pageHtml.includes('id="activityAnnounce"')
    && pageHtml.includes('aria-live="polite"'));

  realServer.close();
}

server.close();
store.close();
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
rmSync(rolesPath, { force: true });
if (previousRolesPath == null) delete process.env.PLAN_LEDGER_ROLES;
else process.env.PLAN_LEDGER_ROLES = previousRolesPath;
console.log(`\n${pass} board-route checks passed.`);
