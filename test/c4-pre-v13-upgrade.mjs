// c4-pre-v13-upgrade.mjs — deterministic legacy activity_events upgrade coverage.
// Run: node test/c4-pre-v13-upgrade.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

function dbPath(tag) {
  return join(tmpdir(), `plan-ledger-c4-legacy-${tag}-${process.pid}-${Date.now().toString(36)}.db`);
}

function cleanup(path) {
  for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
}

function seedLegacyDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE plans (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'draft',
      keywords    TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE steps (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id             INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      idx                 INTEGER NOT NULL,
      title               TEXT NOT NULL,
      context             TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'pending',
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      carry_forward       TEXT NOT NULL DEFAULT '',
      role                TEXT NOT NULL DEFAULT '',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    -- Pre-v13 legacy shape: no step_id / assignment_id / assignment_missing_reason / event_timestamp.
    CREATE TABLE activity_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id     INTEGER NOT NULL,
      event_type      TEXT    NOT NULL DEFAULT 'timeline',
      phase           TEXT    NOT NULL DEFAULT '',
      summary         TEXT    NOT NULL DEFAULT '',
      command_summary TEXT    NOT NULL DEFAULT '',
      metadata        TEXT    NOT NULL DEFAULT '{}',
      created_at      TEXT    NOT NULL
    );
  `);
  const ts = '2026-08-11T00:00:00.000Z';
  db.prepare('INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('legacy project', '', 'active', ts, ts);
  db.prepare('INSERT INTO plans (id, project_id, title, summary, status, keywords, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?, ?, ?)')
    .run('legacy plan', '', 'active', '[]', ts, ts);
  db.prepare('INSERT INTO steps (id, plan_id, idx, title, context, status, acceptance_criteria, carry_forward, role, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('legacy step without activity', '', 'pending', '', '', 'implementer', ts, ts);
  db.exec('PRAGMA user_version = 12');
  db.close();
}

{
  const path = dbPath('upgrade');
  cleanup(path);
  seedLegacyDb(path);

  let store = new Store(path);
  const cols = store.db.prepare("PRAGMA table_info('activity_events')").all().map((r) => r.name);
  check('v13 columns were added to legacy activity_events table',
    cols.includes('step_id')
      && cols.includes('assignment_id')
      && cols.includes('assignment_missing_reason')
      && cols.includes('event_timestamp'));
  const idx = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_activity_events_step_time'"
  ).get();
  check('idx_activity_events_step_time exists after upgrade', idx?.name === 'idx_activity_events_step_time');

  const backfill = store.assessActivityBackfill();
  check('migration inserts exactly one missing-activity marker',
    backfill.marker_runs === 1 && backfill.marker_events === 1 && backfill.steps_missing_any_activity === 0);
  const markerEvent = store.db.prepare(
    "SELECT assignment_id, assignment_missing_reason FROM activity_events WHERE event_type='activity_backfill_missing' LIMIT 1"
  ).get();
  check('marker event keeps null assignment and historical_backfill reason',
    markerEvent && markerEvent.assignment_id == null && markerEvent.assignment_missing_reason === 'historical_backfill');
  const rerun = store.backfillMissingActivityMarkers();
  check('backfill helper is idempotent after migration', rerun.inserted_markers === 0);
  store.close();

  store = new Store(path);
  const reopened = store.assessActivityBackfill();
  check('reopening upgraded DB remains stable and idempotent',
    reopened.marker_runs === 1 && reopened.marker_events === 1 && store.backfillMissingActivityMarkers().inserted_markers === 0);
  store.close();
  cleanup(path);
}

console.log(`\nc4 pre-v13 upgrade regression OK (${pass} checks)`);
