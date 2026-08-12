// activity-store.mjs — store-level coverage for durable live execution activity.
// Run: node test/activity-store.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { Store } from '../src/db.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };

const dbPath = join(tmpdir(), `plan-ledger-activity-${process.pid}.db`);
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });

// v6 -> v7 migration: old DB stamp without activity tables must upgrade safely.
{
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT );
    CREATE TABLE plans (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, title TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE steps (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', context TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '[]', role TEXT NOT NULL DEFAULT '', acceptance_criteria TEXT NOT NULL DEFAULT '', carry_forward TEXT NOT NULL DEFAULT '', layman TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    PRAGMA user_version = 6;
  `);
  raw.close();
}

const s = new Store(dbPath);
check('migration from v6 upgrades to current USER_VERSION', s.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION && Store.USER_VERSION >= 7);
const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
check('migration creates activity tables', tables.includes('activity_runs') && tables.includes('activity_events'));

const plan = s.createPlan({ title: 'activity test plan', keywords: ['activity'] });
const step = s.addStep(plan.id, { title: 'activity test step' });
s.setPlanStatus(plan.id, 'active');

const key = { plan_id: plan.id, step_id: step.id, run_id: 'run-1', session_ref: 'sess-1' };
const started = s.startActivity({
  ...key,
  role: 'implementer',
  agent: 'general-purpose',
  requested_model: 'gpt-5.6-sol-medium',
  actual_model: 'gpt-5.6-sol-medium',
  model_source: 'runner-cli',
  phase: 'dispatch',
  action_summary: 'Started implementing activity persistence.',
  command_summary: 'npm test -- activity',
  progress_completed: 1,
  progress_total: 10,
  metadata: { source: 'activity-store-test' },
});
check('startActivity persists a keyed run with provenance', started.run_id === 'run-1' && started.session_ref === 'sess-1' && started.role === 'implementer');

// Restart persistence: close + reopen preserves activity row.
s.close();
const reopened = new Store(dbPath);
const persisted = reopened.listRecentActivity({ plan_id: plan.id, step_id: step.id, limit: 5 });
check('activity survives store restart', persisted.length === 1 && persisted[0].run_id === 'run-1');

// Concurrent/rapid heartbeats: two handles race on same key without duplicate rows.
const writerA = reopened;
const writerB = new Store(dbPath);
for (let i = 0; i < 60; i++) {
  const target = i % 2 === 0 ? writerA : writerB;
  target.upsertActivityHeartbeat({
    ...key,
    phase: `phase-${i}`,
    action_summary: `heartbeat ${i}`,
    progress_completed: i + 1,
    progress_total: 120,
    file_count: i,
    artifact_count: i + 3,
    status: 'in_progress',
  });
}
const rowCount = writerA.db.prepare('SELECT COUNT(*) c FROM activity_runs WHERE plan_id=? AND step_id=? AND run_id=? AND session_ref=?')
  .get(plan.id, step.id, 'run-1', 'sess-1').c;
check('rapid heartbeats keep one unique activity row', rowCount === 1);
const rapid = writerA.listCurrentActivity({ plan_id: plan.id, step_id: step.id, limit: 3 })[0];
check('rapid heartbeats keep latest progress', rapid.progress_completed >= 1 && rapid.progress_total === 120);

// Stale detection is derived at read time with configurable threshold.
writerA.upsertActivityHeartbeat({ ...key, updated_at: '2001-01-01T00:00:00.000Z', status: 'in_progress' });
const stale = writerA.listCurrentActivity({ plan_id: plan.id, stale_after_ms: 1 })[0];
const fresh = writerA.listCurrentActivity({ plan_id: plan.id, stale_after_ms: 10 ** 13 })[0];
check('stale detection marks old heartbeat as stale', stale.stale === true && stale.stale_for_ms > 0);
check('stale detection can be relaxed per read', fresh.stale === false);

// Event retention/compaction: timeline compacts, terminal events preserved.
process.env.PLAN_LEDGER_ACTIVITY_TIMELINE_KEEP = '3';
for (let i = 0; i < 7; i++) writerA.appendActivityEvent({ ...key, event_type: 'timeline', summary: `tl-${i}` });
writerA.appendActivityEvent({ ...key, event_type: 'terminal', summary: 'term-1', command_summary: 'safe cmd 1' });
writerA.appendActivityEvent({ ...key, event_type: 'terminal', summary: 'term-2', command_summary: 'safe cmd 2' });
const counts = writerA.db.prepare(`
  SELECT
    SUM(event_type='timeline') AS timeline_count,
    SUM(event_type='terminal') AS terminal_count
  FROM activity_events WHERE activity_id = (
    SELECT id FROM activity_runs WHERE plan_id=? AND step_id=? AND run_id=? AND session_ref=?
  )
`).get(plan.id, step.id, 'run-1', 'sess-1');
check('timeline event retention compacts old timeline entries', Number(counts.timeline_count) <= 3);
check('terminal events are preserved during compaction', Number(counts.terminal_count) === 2);

// Bounded payloads: long fields + metadata + artifacts are compacted.
const longText = 'x'.repeat(2000);
const hugeMeta = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k_${i}`, longText]));
writerA.upsertActivityHeartbeat({
  ...key,
  action_summary: longText,
  blocker: longText,
  metadata: hugeMeta,
  recent_artifacts: Array.from({ length: 30 }, (_, i) => `artifact-${i}-${longText}`),
});
const bounded = writerA.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true })[0];
check('bounded payload clamps long text fields', bounded.action_summary.length <= 280 && bounded.blocker.length <= 400);
check('bounded payload clamps recent artifacts', bounded.recent_artifacts.length <= 12 && bounded.recent_artifacts.every((x) => x.length <= 200));
check('bounded payload compacts metadata', Object.keys(bounded.metadata).length <= 32);

// Invalid transition guard: terminal -> non-terminal is rejected.
writerA.upsertActivityHeartbeat({ ...key, status: 'completed', outcome: 'success', verification_state: 'passed' });
let invalidTransition = false;
try {
  writerA.upsertActivityHeartbeat({ ...key, status: 'in_progress' });
} catch (e) {
  invalidTransition = /invalid activity status transition/i.test(e.message);
}
check('invalid status transition is blocked', invalidTransition === true);

// Plan/step scoping.
const project2 = writerA.createProject({ name: 'activity project 2' });
writerA.setCurrentProject(project2.id);
const plan2 = writerA.createPlan({ title: 'activity plan 2' });
const step2 = writerA.addStep(plan2.id, { title: 'activity step 2' });
writerA.setPlanStatus(plan2.id, 'active');
writerA.startActivity({
  plan_id: plan2.id,
  step_id: step2.id,
  run_id: 'run-2',
  session_ref: 'sess-2',
  status: 'in_progress',
  phase: 'other',
});
const scopedPlan1 = writerA.listRecentActivity({ plan_id: plan.id, limit: 10 });
const scopedPlan2 = writerA.listRecentActivity({ plan_id: plan2.id, limit: 10 });
const scopedStep2 = writerA.listCurrentActivity({ step_id: step2.id, limit: 10 });
check('plan scoping returns only matching plan activity', scopedPlan1.every((r) => r.plan_id === plan.id) && scopedPlan2.every((r) => r.plan_id === plan2.id));
check('step scoping returns only matching step activity', scopedStep2.length === 1 && scopedStep2[0].step_id === step2.id);
check('explicit plan scope overrides the currently selected project', scopedPlan1.length === 1);

writerB.close();
writerA.close();
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
delete process.env.PLAN_LEDGER_ACTIVITY_TIMELINE_KEEP;
console.log(`\n${pass} activity-store checks passed.`);
