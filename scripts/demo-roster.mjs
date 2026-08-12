#!/usr/bin/env node
// scripts/demo-roster.mjs — seed a self-contained demo DB exercising every
// piece of the transparent execution roster: activation snapshot, reasoned
// reassignment, actual provenance from a recorded attempt, drifted context,
// and a reasoned redo. Run this, then point the board at the same DB to
// walk through the UI.

import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';

const dbDir = join(tmpdir(), 'plan-ledger-roster-demo');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'roster-demo.db');

// Fresh every run so the URLs below always land on the same seeded state.
for (const suf of ['', '-wal', '-shm']) {
  const p = dbPath + suf;
  if (existsSync(p)) unlinkSync(p);
}

const store = new Store(dbPath);
const log = (label, value) => console.log(`  ${label.padEnd(28)} ${value}`);

console.log('\n== Seeding demo DB ==');
console.log(`  path: ${dbPath}`);

// 1. Project + plan
const project = store.createProject({ name: 'Roster Demo', description: 'Transparent agent execution roster walkthrough' });
store.setCurrentProject(project.id);
const plan = store.createPlan({ title: 'Ship checkout redesign' });
const planId = plan.id;
log('project id', project.id);
log('plan id', planId);

// 2. Three steps with distinct roles — added to a *draft* plan, so no snapshot yet.
const stepArch = store.addStep(planId, {
  title: 'Design the new checkout API',
  role: 'architect',
  context: 'Draft the API surface for the new checkout endpoint. Cover request/response shapes, error codes, and the migration plan for the legacy `/pay` route.',
});
const stepImpl = store.addStep(planId, {
  title: 'Wire the endpoint into the router',
  role: 'implementer',
  context: 'Wire the new endpoint into the router. Cover happy path + validation errors. Do not touch the legacy route yet.',
});
const stepTest = store.addStep(planId, {
  title: 'Add end-to-end tests',
  role: 'test-engineer',
  context: 'Add end-to-end tests covering the new endpoint. At least one happy-path and one 4xx validation case.',
});
store.setLayman(stepArch.id, 'Design the new checkout API.');
store.setLayman(stepImpl.id, 'Build the endpoint.');
store.setLayman(stepTest.id, 'Write the tests.');
log('step ids', `${stepArch.id} (architect) / ${stepImpl.id} (implementer) / ${stepTest.id} (test-engineer)`);

// 3. Roster snapshot BEFORE activation — should be empty.
const preRoster = store.getPlanRoster(planId, { cwd: process.cwd() });
log('draft snapshotted?', String(preRoster.snapshotted));

// 4. Activate the plan → freezes each step's initial assignment.
store.setPlanStatus(planId, 'active');
const postRoster = store.getPlanRoster(planId, { cwd: process.cwd() });
log('active snapshotted?', String(postRoster.snapshotted));
log('rows in roster', String(postRoster.steps.length));

// 5. Reassign the implementer step with a reason (creates a new revision).
store.assignStep(stepImpl.id, {
  role: 'senior-implementer',
  reason: 'Endpoint touches billing — bump to senior implementer for review discipline.',
  assigned_by: 'demo-seed',
});

// 6. Record an attempt on the architect step with real provenance.
store.recordAttempt(stepArch.id, {
  what_tried: 'Drafted the /v2/checkout OpenAPI spec + a migration path for the legacy /pay route.',
  verdict: 'pass',
  result: 'API spec drafted; migration plan attached in carry-forward.',
  executor: 'cursor-cli',
  role: 'architect',
  agent: 'claude-opus-4-7-thinking-xhigh',
  model: 'claude-opus-4-7-thinking-xhigh',
  model_source: 'runner-cli',
  session_ref: 'demo-session-abc123',
});

// 7. Edit the test step's context AFTER snapshot → drift.
store.updateStep(stepTest.id, {
  context: 'Add end-to-end tests covering the new endpoint. **Now includes** cross-region latency assertions (added after activation — this should trigger drift).',
});

// 8. Redo the implementer step with a reason (returns to pending, note appended).
store.redoStep(stepImpl.id, {
  reason: 'Rework — turned out the endpoint needs an idempotency key. Reassign after review.',
  requested_by: 'demo-seed',
});

console.log('\n== Roster after seed ==');
const finalRoster = store.getPlanRoster(planId, { cwd: process.cwd() });
for (const row of finalRoster.steps) {
  const initial = row.initial ? `${row.initial.role} → ${row.initial.agent}/${row.initial.model || '(model:default)'}` : '(none)';
  const planned = row.planned ? `${row.planned.role} → ${row.planned.agent}/${row.planned.model || '(model:default)'}` : '(none)';
  const actual  = row.actual  ? `${row.actual.agent}/${row.actual.model} (${row.actual.model_source})` : '(no attempt yet)';
  const drift   = row.drift?.context_changed ? ' [DRIFT: context changed]' : '';
  const revs    = row.assignments?.length || 0;
  console.log(`  step #${row.idx} (${row.status})${drift}`);
  console.log(`      initial : ${initial}`);
  console.log(`      planned : ${planned}   (revisions: ${revs})`);
  console.log(`      actual  : ${actual}`);
}

console.log('\n== Ready ==');
console.log('  Start the board pointed at this DB:');
console.log(`  $env:PLAN_LEDGER_DB="${dbPath}"; $env:PLAN_LEDGER_WEB_PORT="4321"; node web/server.mjs`);
console.log('\n  Open http://localhost:4321 and click into "Ship checkout redesign".\n');

store.close();
