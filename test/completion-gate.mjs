// completion-gate.mjs — focused C1 validator + gate regressions.
// Run: node test/completion-gate.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/db.mjs';
import { validateCompletionPayload } from '../src/completion-validator.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

function makeDb(label) {
  const path = join(tmpdir(), `plan-ledger-c1-${label}-${process.pid}-${Date.now().toString(36)}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  return path;
}
function cleanupDb(path) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}
function withEnv(name, value, fn) {
  const prior = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); }
  finally {
    if (prior == null) delete process.env[name];
    else process.env[name] = prior;
  }
}

const VALID_PAYLOAD = {
  contract_version: 2,
  outcome: 'success',
  artifacts: [{ path: 'docs/audits/evidence.json', kind: 'file', note: 'evidence bundle' }],
  commands: [{ command: 'node test/execution-governance.mjs', exit_code: 0, output_redacted: true }],
  limitations: ['none'],
};

// Deterministic validator error codes + redacted-output pass path.
{
  const missing = validateCompletionPayload(null, { claimed_pass: true });
  check('validator returns completion_json_missing for null payload',
    missing.ok === false && missing.errors.some((e) => e.code === 'completion_json_missing'));

  const invalid = validateCompletionPayload({
    contract_version: 2,
    outcome: 'success',
    artifacts: [],
    commands: [{ command: 'npm test', exit_code: 0, output: '' }],
    limitations: [],
  }, { claimed_pass: true });
  check('validator emits explicit missing-evidence codes',
    invalid.ok === false
      && invalid.errors.some((e) => e.code === 'completion_artifact_missing')
      && invalid.errors.some((e) => e.code === 'completion_output_missing'));

  const redacted = validateCompletionPayload(VALID_PAYLOAD, { claimed_pass: true });
  check('validator accepts output_redacted command evidence',
    redacted.ok === true && redacted.normalizedPayload.commands[0].output_redacted === true);
}

// Enforce mode: invalid pass must not mutate terminal state or payload fields.
{
  const dbPath = makeDb('enforce');
  withEnv('PLAN_LEDGER_COMPLETION_GATE', 'enforce', () => {
    const store = new Store(dbPath);
    const plan = store.createPlan({ title: 'C1 enforce gate plan' });
    const step = store.addStep(plan.id, { title: 'gate step' });
    store.setPlanStatus(plan.id, 'active');
    let blocked = false;
    try {
      store.recordAttempt(step.id, { what_tried: 'claimed pass without payload', verdict: 'pass' });
    } catch (error) {
      blocked = /completion_gate_rejected:completion_json_missing/.test(error.message);
    }
    check('enforce mode rejects pass with missing payload', blocked === true);
    const after = store.getStep(step.id);
    check('enforce rejection leaves step non-terminal and payload untouched',
      after.status === 'pending' && after.completion_payload_json === '' && after.attempts_total === 0);
    check('enforce rejection leaves plan state unchanged', store.openPlan(plan.id).status === 'active');
    store.close();
  });
  cleanupDb(dbPath);
}

// Warn mode: invalid payload is annotated as validation failure, but not persisted as success evidence.
{
  const dbPath = makeDb('warn');
  withEnv('PLAN_LEDGER_COMPLETION_GATE', 'warn', () => {
    const store = new Store(dbPath);
    const plan = store.createPlan({ title: 'C1 warn plan' });
    const step = store.addStep(plan.id, { title: 'warn step' });
    store.setPlanStatus(plan.id, 'active');
    const done = store.recordAttempt(step.id, {
      what_tried: 'warn mode pass with invalid payload',
      verdict: 'pass',
      completion_payload: { contract_version: 2, outcome: 'success', artifacts: [], commands: [], limitations: [] },
    });
    const attempt = done.attempts.at(-1);
    check('warn mode keeps pass workflow but stores validation fail metadata',
      done.status === 'done' && attempt.validation_status === 'fail' && attempt.validation_errors.some((e) => e.code === 'completion_artifact_missing'));
    check('warn mode does not fabricate success payload on invalid evidence', done.completion_payload_json === '');
    store.close();
  });
  cleanupDb(dbPath);
}

// Off mode: backward-compatible behavior with legacy_unknown annotation.
{
  const dbPath = makeDb('off');
  withEnv('PLAN_LEDGER_COMPLETION_GATE', 'off', () => {
    const store = new Store(dbPath);
    const plan = store.createPlan({ title: 'C1 off plan' });
    const step = store.addStep(plan.id, { title: 'off step' });
    store.setPlanStatus(plan.id, 'active');
    const done = store.recordAttempt(step.id, {
      what_tried: 'off mode pass without payload',
      verdict: 'pass',
    });
    const attempt = done.attempts.at(-1);
    check('off mode keeps pass completion backward compatible',
      done.status === 'done' && attempt.validation_status === 'legacy_unknown');
    store.close();
  });
  cleanupDb(dbPath);
}

// Valid payload persists normalized payload + supports C2 auto-terminalization.
{
  const dbPath = makeDb('valid-auto');
  withEnv('PLAN_LEDGER_COMPLETION_GATE', 'enforce', () => withEnv('PLAN_LEDGER_AUTO_TERMINALIZE', 'enforce', () => {
    const store = new Store(dbPath);
    const plan = store.createPlan({ title: 'C1 + C2 compatibility plan' });
    const step = store.addStep(plan.id, { title: 'only step' });
    store.setPlanStatus(plan.id, 'active');
    const done = store.recordAttempt(step.id, {
      what_tried: 'valid completion with redacted output',
      verdict: 'pass',
      completion_payload: VALID_PAYLOAD,
    });
    check('valid payload is normalized and persisted on step',
      done.completion_payload_present === true
        && done.completion_payload.contract_version === 2
        && done.attempts.at(-1).validation_status === 'pass');
    check('C2 auto-terminalization still runs after gated pass', store.openPlan(plan.id).status === 'done');
    store.close();
  }));
  cleanupDb(dbPath);
}

// Migration/backfill: legacy rows become legacy_unknown (never fail), additive and idempotent.
{
  const dbPath = makeDb('migration');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      completion_lock TEXT NOT NULL DEFAULT '',
      terminal_state_reason TEXT NOT NULL DEFAULT '',
      terminalized_at TEXT NOT NULL DEFAULT '',
      state_integrity_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      context TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]',
      role TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      carry_forward TEXT NOT NULL DEFAULT '',
      layman TEXT NOT NULL DEFAULT '',
      verification_disposition TEXT NOT NULL DEFAULT 'legacy_unknown',
      disposition_reason TEXT NOT NULL DEFAULT '',
      disposition_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      step_id INTEGER NOT NULL,
      what_tried TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '',
      verdict TEXT NOT NULL DEFAULT 'pass',
      role TEXT NOT NULL DEFAULT '',
      review_rounds INTEGER NOT NULL DEFAULT 0,
      executor TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      model_source TEXT NOT NULL DEFAULT '',
      session_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    PRAGMA user_version = 9;
  `);
  const ts = new Date().toISOString();
  legacy.prepare("INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (1,'General','', 'active', ?, ?)").run(ts, ts);
  legacy.prepare("INSERT INTO settings (key, value) VALUES ('current_project', '1')").run();
  const p = legacy.prepare("INSERT INTO plans (project_id, title, status, created_at, updated_at) VALUES (1, 'legacy', 'active', ?, ?)").run(ts, ts);
  const planId = Number(p.lastInsertRowid);
  const s = legacy.prepare("INSERT INTO steps (plan_id, idx, title, status, verification_disposition, created_at, updated_at) VALUES (?,1,'legacy-step','done','legacy_unknown',?,?)").run(planId, ts, ts);
  const stepId = Number(s.lastInsertRowid);
  legacy.prepare("INSERT INTO attempts (step_id, what_tried, verdict, created_at) VALUES (?,?,?,?)").run(stepId, 'legacy pass', 'pass', ts);
  legacy.close();

  const store1 = new Store(dbPath);
  const summary1 = store1.assessCompletionBackfill();
  const colsStep = store1.db.prepare('PRAGMA table_info(steps)').all().map((row) => row.name);
  const colsAttempt = store1.db.prepare('PRAGMA table_info(attempts)').all().map((row) => row.name);
  check('migration adds completion payload columns additively',
    colsStep.includes('completion_payload_json') && colsStep.includes('completion_validated_at'));
  check('migration adds validation columns additively',
    colsAttempt.includes('validation_status') && colsAttempt.includes('validation_errors_json'));
  check('legacy attempts backfill to 100% legacy_unknown and 0 fail',
    summary1.total_attempts >= 1 && summary1.by_validation_status.legacy_unknown === summary1.total_attempts && summary1.by_validation_status.fail === 0);
  store1.close();

  const store2 = new Store(dbPath);
  const summary2 = store2.assessCompletionBackfill();
  check('migration is idempotent on reopen',
    summary2.by_validation_status.legacy_unknown === summary1.by_validation_status.legacy_unknown
      && summary2.by_validation_status.fail === 0);
  store2.close();
  cleanupDb(dbPath);
}

console.log(`\ncompletion-gate regression OK (${pass} checks)`);
