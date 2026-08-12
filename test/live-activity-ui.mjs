// live-activity-ui.mjs — deterministic coverage for the plan-level Live Activity
// experience in web/index.html. Rather than re-implementing the UI logic, this
// loads the REAL inline <script> from index.html into a Node `vm` context with
// a minimal DOM/fetch/localStorage/timer shim, then drives the actual exported
// functions (window.__liveActivityTestHooks, only populated when
// window.__PLAN_LEDGER_TEST__ is set — production page load is unaffected).
//
// Proves: refresh interval is bounded to <=10s, status distinctions
// (active/blocked/verifying/stale/failed/done), provenance fields (agent/role/
// model/model source/session, dispatch rationale/warnings/alternatives/
// override, reassignment history), timeline + accessibility semantics,
// reconnect/error retention of last-known data, configurable stale threshold
// persistence, no duplicate concurrent polls, and that private chain-of-thought
// content is never rendered (only the static privacy disclaimer may name it).
//
// Run: node test/live-activity-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };

// ---- extract the single inline <script> block (the whole board is one file) ----
const scriptTagCount = (html.match(/<script/g) || []).length;
check('index.html has exactly one inline <script> block (extraction assumption holds)', scriptTagCount === 1);
function extractScript(src) {
  const start = src.indexOf('<script>');
  const end = src.lastIndexOf('</script>');
  if (start === -1 || end === -1) throw new Error('could not locate the inline <script> block in web/index.html');
  return src.slice(start + '<script>'.length, end);
}
const scriptSrc = extractScript(html);

// ---- minimal DOM shim: enough surface for the whole script to parse + run ----
function makeElement(id) {
  const classes = new Set();
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    style: {},
    dataset: {},
    options: [],
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const has = classes.has(c);
        const next = force === undefined ? !has : !!force;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { el[`attr_${k}`] = v; },
    getAttribute(k) { return el[`attr_${k}`] ?? null; },
    removeAttribute() {},
    appendChild() {},
    insertAdjacentHTML(_pos, frag) { el.innerHTML += frag; },
    insertAdjacentElement() {},
    querySelector() { return makeElement(`${id}__q`); },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    focus() {}, blur() {}, click() {}, remove() {}, scrollIntoView() {}, select() {},
  };
  return el;
}
function makeDocument() {
  const registry = new Map();
  return {
    _registry: registry,
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement(id));
      return registry.get(id);
    },
    querySelector() { return makeElement('__docQuery__'); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) { return makeElement(`__created_${tag}__`); },
    execCommand() { return false; },
    body: makeElement('body'),
    documentElement: makeElement('documentElement'),
  };
}
function makeLocalStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}
function makeTimers() {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    setTimeoutMock: (fn, delay) => { const id = nextId++; calls.push({ id, fn, delay }); return id; },
    clearTimeoutMock: (id) => { const i = calls.findIndex((c) => c.id === id); if (i >= 0) calls.splice(i, 1); },
  };
}
function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

// ---- boot a fresh instance of the real script in an isolated vm context ----
function loadLiveActivityModule({ seedLocalStorage = {} } = {}) {
  const sandbox = {};
  const routerRef = { current: async () => jsonResponse(200, {}) };
  const timers = makeTimers();
  const documentShim = makeDocument();
  const localStorageShim = makeLocalStorage(seedLocalStorage);
  sandbox.window = sandbox;
  sandbox.document = documentShim;
  sandbox.localStorage = localStorageShim;
  sandbox.console = console;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.fetch = (path, opts) => routerRef.current(path, opts);
  sandbox.setTimeout = timers.setTimeoutMock;
  sandbox.clearTimeout = timers.clearTimeoutMock;
  sandbox.location = { search: '', href: 'http://127.0.0.1/', pathname: '/' };
  sandbox.navigator = { clipboard: { writeText: async () => true } };
  sandbox.prompt = () => null;
  sandbox.alert = () => {};
  sandbox.__PLAN_LEDGER_TEST__ = true;
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox, { filename: 'index.html-inline-script.js' });
  const hooks = sandbox.__liveActivityTestHooks;
  if (!hooks) throw new Error('window.__liveActivityTestHooks was not exposed — the test guard in index.html is missing or broken');
  return { hooks, documentShim, timers, routerRef, localStorageShim };
}

// =====================================================================
// 1) Refresh interval: resilient bounded polling, never more than 10s.
// =====================================================================
{
  const { hooks, timers } = loadLiveActivityModule();
  check('ACTIVITY_POLL_MS satisfies the "update within 10s" requirement', hooks.ACTIVITY_POLL_MS > 0 && hooks.ACTIVITY_POLL_MS <= 10000);
  hooks.scheduleActivityPoll(999999);
  const clamped = timers.calls.at(-1);
  check('scheduleActivityPoll clamps an oversized delay down to the bounded interval', clamped && clamped.delay === hooks.ACTIVITY_POLL_MS);
  hooks.scheduleActivityPoll(0);
  const immediate = timers.calls.at(-1);
  check('scheduleActivityPoll allows an immediate (0ms) refresh (plan/step open, live toggle)', immediate && immediate.delay === 0);
}

// =====================================================================
// 2) Status distinctions: active / blocked / verifying / stale / failed / done.
// =====================================================================
{
  const { hooks } = loadLiveActivityModule();
  const base = { status: 'in_progress', outcome: 'pending', verification_state: 'pending', blocker: '', stale: false };
  check('active: in-progress run with no blocker/stale/verify flag', hooks.deriveUiStatus({ ...base }) === 'active');
  check('blocked: explicit blocked status', hooks.deriveUiStatus({ ...base, status: 'blocked' }) === 'blocked');
  check('blocked: blocker text alone also blocks (even if status lags)', hooks.deriveUiStatus({ ...base, blocker: 'waiting on approval' }) === 'blocked');
  check('verifying: verification_state running', hooks.deriveUiStatus({ ...base, verification_state: 'running' }) === 'verifying');
  check('stale: heartbeat flagged stale on a non-terminal run', hooks.deriveUiStatus({ ...base, stale: true }) === 'stale');
  check('failed: failed status', hooks.deriveUiStatus({ ...base, status: 'failed', outcome: 'failed' }) === 'failed');
  check('done: completed + passed verification + success outcome', hooks.deriveUiStatus({ ...base, status: 'completed', outcome: 'success', verification_state: 'passed' }) === 'done');
  const map = { active: 'b-in_progress', blocked: 'b-blocked', verifying: 'b-active', stale: 'b-skipped', failed: 'b-failed', done: 'b-done' };
  for (const [status, cls] of Object.entries(map)) {
    check(`statusBadge(${status}) renders a distinct badge class (${cls})`, hooks.statusBadge(status).includes(`badge ${cls}`) && hooks.statusBadge(status).includes(`>${status}<`));
  }
}

// =====================================================================
// 3) Current-activity card: full provenance contract + no chain-of-thought.
// =====================================================================
{
  const { hooks } = loadLiveActivityModule();
  const run = {
    run_id: 'run-abc', plan_id: 5, step_id: 28,
    agent: 'ui-designer', role: 'ui-designer',
    requested_model: 'gpt-5.6-sol-medium', actual_model: 'gpt-5.6-sol-medium',
    model_source: 'runner-cli', session_ref: 'sess-42',
    phase: 'implementing', status: 'in_progress', outcome: 'pending', verification_state: 'pending',
    action_summary: 'Refactoring renderActivityPanel <thinking>secret plan</thinking> without exposing chain-of-thought reasoning',
    command_summary: 'node test/live-activity-ui.mjs',
    blocker: '', progress_completed: 3, progress_total: 7, file_count: 4, artifact_count: 2,
    recent_artifacts: ['web/index.html', 'test/live-activity-ui.mjs'],
    started_at: new Date(Date.now() - 65000).toISOString(),
    updated_at: new Date(Date.now() - 3000).toISOString(),
    ended_at: '', stale: false, stale_for_ms: 0,
    metadata: {
      dispatch_policy: {
        selected_role: 'ui-designer', selection_mode: 'automatic',
        selected_score: { normalized_score: 0.82, rationale: 'best capability match' },
        alternatives: [{ role: 'implementer', normalized_score: 0.61 }],
        warnings: ['secondary candidate available'],
        override_reason: '',
      },
    },
    events: [],
  };
  hooks.setActivitySnapshot({
    rosterByStep: new Map([[28, {
      step_id: 28, idx: 3, title: 'Build live activity UI', role: 'ui-designer',
      assignments: [{ revision: 1, role: 'ui-designer', reason: 'board: rotate specialist', resolution_source: 'role-map', created_at: '2026-07-01T00:00:00.000Z' }],
      dispatch_policy: { override_reason: '' }, // live re-resolution preview — no real override_reason yet
    }]]),
    recent: [run],
  });
  const cardHtml = hooks.buildActivityCard(run);
  check('shows agent/role', cardHtml.includes('ui-designer / ui-designer'));
  check('shows requested + actual model, model source, session', cardHtml.includes('requested gpt-5.6-sol-medium') && cardHtml.includes('actual gpt-5.6-sol-medium') && cardHtml.includes('runner-cli') && cardHtml.includes('sess-42'));
  check('shows step title and index', cardHtml.includes('Build live activity UI') && cardHtml.includes('idx 3'));
  check('shows phase', cardHtml.includes('implementing'));
  check('shows safe sanitized action/command summary', cardHtml.includes('node test/live-activity-ui.mjs'));
  check('shows elapsed time and fresh heartbeat state', /elapsed \/ heartbeat/.test(cardHtml) && cardHtml.includes('fresh'));
  check('shows completed/total progress', cardHtml.includes('3/7'));
  check('shows file/artifact counts and recent artifacts', cardHtml.includes('4 files') && cardHtml.includes('2 artifacts') && cardHtml.includes('web/index.html'));
  check('shows blocker (none) and verification state', cardHtml.includes('none · pending'));
  check('shows dispatch rationale sourced from the run AS DISPATCHED (not the live re-resolution preview)', cardHtml.includes('best capability match') && cardHtml.includes('(as dispatched)'));
  check('shows dispatch warnings', cardHtml.includes('secondary candidate available'));
  check('shows dispatch alternatives with normalized scores', cardHtml.includes('implementer (0.61)'));
  check('shows reassignment/retry history with the recorded reason', cardHtml.includes('rev 1: ui-designer (board: rotate specialist)') && /retries \d/.test(cardHtml));
  check('shows terminal outcome placeholder while still pending', cardHtml.includes('pending'));
  check('current-state actions are real keyboard-focusable <a> elements, not click-only divs', /<a class="link" href="#"[^>]*>open plan<\/a>/.test(cardHtml) && /<a class="link" href="#"[^>]*>open step<\/a>/.test(cardHtml));
  check('never renders the private chain-of-thought content itself', !cardHtml.includes('secret plan') && !cardHtml.includes('<thinking'));
  check('sanitizeTelemetryText redacts <thinking> blocks and "chain-of-thought" mentions in place', cardHtml.includes('[redacted]') && !cardHtml.toLowerCase().includes('chain-of-thought'));
}

// =====================================================================
// 4) Full panel render: timeline, accessibility, privacy copy, reconnect retention.
// =====================================================================
{
  const { hooks, documentShim } = loadLiveActivityModule();
  hooks.setState({ projectId: 1, planId: 5, stepId: 28 });
  const run = {
    run_id: 'run-abc', plan_id: 5, step_id: 28, agent: 'ui-designer', role: 'ui-designer',
    requested_model: 'gpt-5.6-sol-medium', actual_model: 'gpt-5.6-sol-medium', model_source: 'runner-cli', session_ref: 'sess-42',
    phase: 'implementing', status: 'in_progress', outcome: 'pending', verification_state: 'pending',
    action_summary: 'Drafting Live Activity card <thinking>secret plan</thinking>',
    command_summary: '', blocker: '', progress_completed: 3, progress_total: 7, file_count: 4, artifact_count: 2,
    recent_artifacts: [], started_at: new Date(Date.now() - 30000).toISOString(), updated_at: new Date().toISOString(),
    ended_at: '', stale: false, stale_for_ms: 0, metadata: {}, events: [{ event_type: 'timeline', phase: 'implementing', summary: 'wrote buildActivityCard', command_summary: '', created_at: new Date().toISOString() }],
  };
  hooks.setActivitySnapshot({
    current: [run], recent: [run],
    rosterByStep: new Map([[28, { step_id: 28, idx: 3, title: 'Build live activity UI', role: 'ui-designer', assignments: [], dispatch_policy: null }]]),
    error: '', last_ok_at: new Date().toISOString(),
  });
  hooks.renderActivityPanel();
  const panel1 = documentShim.getElementById('activity').innerHTML;

  check('current-state region lists every active run as an accessible list', panel1.includes('<ul class="liveCards" role="list" aria-label="Current activity">'));
  check('timeline is a semantic, accessible ordered list', panel1.includes('<ol class="timeline" role="list" aria-label="Recent activity timeline">'));
  check('timeline includes the run\'s safe event summary', panel1.includes('wrote buildActivityCard'));
  check('connection status is an accessible live region', panel1.includes('id="activityConn"') && panel1.includes('role="status"') && panel1.includes('aria-live="polite"'));
  check('privacy copy clarifies operational telemetry vs private reasoning (may name the excluded concept)', panel1.includes('operational telemetry only') && panel1.includes("never shows the agent's private reasoning or chain-of-thought"));
  check('never renders the private reasoning content itself in the full panel', !panel1.includes('secret plan') && !panel1.includes('<thinking'));

  const announceAfterFirst = documentShim.getElementById('activityAnnounce').textContent;
  check('a material status announcement was made for screen readers', announceAfterFirst.includes('activity status'));

  // Re-render with identical data: must not blank/duplicate the live announcement.
  hooks.renderActivityPanel();
  check('re-rendering unchanged status does not spam/blank the aria-live announcement', documentShim.getElementById('activityAnnounce').textContent === announceAfterFirst);

  // Reconnect/error state: last-known data must survive a fetch failure.
  hooks.setActivitySnapshot({ error: 'fetch failed: network unreachable' });
  hooks.renderActivityPanel();
  const panel2 = documentShim.getElementById('activity').innerHTML;
  check('reconnect/error banner is shown and named as reconnecting (not a generic crash)', panel2.includes('reconnect:') && panel2.includes('network unreachable') && panel2.includes('showing last data'));
  check('last known activity card/timeline is retained across the reconnect state (not erased)', panel2.includes('Build live activity UI') && panel2.includes('wrote buildActivityCard'));

  // Status change (e.g. run becomes blocked) must re-announce.
  const blockedRun = { ...run, status: 'blocked', blocker: 'waiting on reviewer' };
  hooks.setActivitySnapshot({ error: '', current: [blockedRun], recent: [blockedRun] });
  hooks.renderActivityPanel();
  const announceAfterBlock = documentShim.getElementById('activityAnnounce').textContent;
  check('a status change (active -> blocked) triggers a fresh announcement', announceAfterBlock !== announceAfterFirst && announceAfterBlock.includes('blocked'));
}

// =====================================================================
// 5) Empty/no-scope state and per-status card classes render distinctly.
// =====================================================================
{
  const { hooks, documentShim } = loadLiveActivityModule();
  hooks.setState({ projectId: 1, planId: null, stepId: null });
  hooks.setActivitySnapshot({ current: [], recent: [] });
  hooks.renderActivityPanel();
  check('with no plan selected and no activity, the panel prompts to select a plan (never blank/erroring)', documentShim.getElementById('activity').innerHTML.includes('Select a plan to scope live activity.'));

  const statuses = ['active', 'blocked', 'verifying', 'stale', 'failed', 'done'];
  for (const status of statuses) {
    const overrides = {
      active: {}, blocked: { status: 'blocked', blocker: 'x' },
      verifying: { verification_state: 'running' }, stale: { stale: true, stale_for_ms: 305000 },
      failed: { status: 'failed', outcome: 'failed' }, done: { status: 'completed', outcome: 'success', verification_state: 'passed' },
    }[status];
    const run = { run_id: `run-${status}`, plan_id: 5, step_id: 28, agent: 'a', role: 'r', status: 'in_progress', outcome: 'pending', verification_state: 'pending', blocker: '', stale: false, stale_for_ms: 0, progress_completed: 0, progress_total: 0, file_count: 0, artifact_count: 0, recent_artifacts: [], started_at: new Date().toISOString(), updated_at: new Date().toISOString(), ended_at: '', metadata: {}, events: [], ...overrides };
    hooks.setActivitySnapshot({ rosterByStep: new Map(), recent: [run] });
    const cardHtml = hooks.buildActivityCard(run);
    check(`buildActivityCard renders a distinct "${status}" card`, cardHtml.includes(`actCard st-${status}`));
  }
}

// =====================================================================
// 6) Configurable stale threshold: bounds + persistence across reloads.
// =====================================================================
{
  const { hooks, localStorageShim } = loadLiveActivityModule();
  check('default stale threshold is a sane positive duration', hooks.ACTIVITY_STALE_DEFAULT_MS > 0);
  check('saveStaleMs clamps below the 5s floor up to 5s', hooks.saveStaleMs(1) === 5000);
  check('saveStaleMs clamps above the 1h ceiling down to 1h', hooks.saveStaleMs(999999999) === 3600000);
  hooks.setStaleMs(45000);
  check('setStaleMs updates the live threshold used by scopeQuery()', hooks.getStaleMs() === 45000);
  check('the configured threshold persists to localStorage', localStorageShim._store.get('planLedgerActivityStaleMs') === '45000');
  hooks.setState({ planId: 5, stepId: 28 });
  const q = hooks.scopeQuery();
  check('scopeQuery sends the configured stale threshold to the server on every poll', q.get('stale_after_ms') === '45000');

  const { hooks: hooks2 } = loadLiveActivityModule({ seedLocalStorage: { planLedgerActivityStaleMs: '90000' } });
  check('a previously-saved stale threshold is restored on the next page load', hooks2.getStaleMs() === 90000);
}

// =====================================================================
// 7) Polling integration: no duplicate concurrent polls / race conditions.
// =====================================================================
{
  const { hooks, routerRef, timers } = loadLiveActivityModule();
  hooks.setState({ projectId: 1, planId: null, stepId: null }); // no roster/live fetch, just current+recent
  let fetchCalls = 0;
  const resolvers = [];
  routerRef.current = async () => {
    fetchCalls++;
    return new Promise((resolve) => resolvers.push(() => resolve(jsonResponse(200, []))));
  };
  const inFlightBefore = hooks.getActivityPollInFlight();
  const first = hooks.runActivityPoll();
  check('runActivityPoll flips the in-flight guard synchronously before awaiting network calls', inFlightBefore === false && hooks.getActivityPollInFlight() === true);
  const callsBeforeSecond = fetchCalls;
  hooks.runActivityPoll(); // concurrent call while the first is still in flight
  check('a concurrent poll while one is in flight starts no additional fetches (no duplicate/racing polls)', fetchCalls === callsBeforeSecond);
  const rescheduled = timers.calls.at(-1);
  check('the concurrent call still reschedules the next bounded refresh instead of silently dropping it', rescheduled && rescheduled.delay === hooks.ACTIVITY_POLL_MS);
  resolvers.forEach((r) => r());
  await first;
  check('the in-flight guard clears once the poll settles', hooks.getActivityPollInFlight() === false);
}

console.log(`\n${pass} live-activity-ui checks passed.`);
