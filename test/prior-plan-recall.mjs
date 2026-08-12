// prior-plan-recall.mjs — bounded prior-plan discovery + consultation provenance.
// Run: node test/prior-plan-recall.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store, extractKeywords } from '../src/db.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/ledger-cli.mjs', import.meta.url));
const dbPath = join(tmpdir(), `plan-ledger-recall-${process.pid}.db`);

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

const runCli = (operation, args = {}) => {
  const p = spawnSync(process.execPath, [cliPath, operation, '--input', JSON.stringify(args)], {
    cwd: root,
    env: { ...process.env, PLAN_LEDGER_DB: dbPath, PLAN_LEDGER_NO_OPEN: '1' },
    encoding: 'utf8',
  });
  let body;
  try { body = p.stdout.trim() ? JSON.parse(p.stdout) : null; } catch { body = null; }
  return { ...p, body };
};

try {
  const s = new Store(dbPath);

  check('fresh DB stamped at latest USER_VERSION',
    s.db.prepare('PRAGMA user_version').get().user_version === Store.USER_VERSION);
  check('plan_consultations table exists for backward-safe provenance migration',
    s.db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='plan_consultations'").get()?.ok === 1);

  // Keyword normalization and bounds.
  const kws = extractKeywords('Audit and republish the Diagon Depot governance artifacts and docs', 8);
  check('extractKeywords returns normalized bounded keywords', kws.length <= 8 && kws.every((k) => k === k.toLowerCase()));

  // Fixtures across projects: two overlapping completed plans, one active related, one unrelated done.
  const runtimeProject = s.createProject({ name: 'Runtime Project' });
  const perfProject = s.createProject({ name: 'Perf Project' });

  const doneA = s.createPlan({
    project_id: 1,
    title: 'Diagon Depot reassignment audit trail',
    keywords: ['diagon', 'audit', 'reassignment', 'architect'],
    summary: 'Capture stalled architect handoff provenance and prevent repeat mistakes.',
  });
  const doneAStep = s.addStep(doneA.id, {
    title: 'Persist reassignment audit notes',
    context: 'LONG BODY '.repeat(200),
    carry_forward: 'Carry forward: stalled architect handoff with explicit provenance tags.',
  });
  s.recordAttempt(doneAStep.id, {
    what_tried: 'audited reassignment from stalled architect',
    result: 'kept durable provenance in draft planning flow',
    verdict: 'fail',
  });
  // Fixture-shape a "historically completed" plan whose only recorded attempt
  // failed. The new plan-done gate rejects this cleanly; force with a reason
  // to model the "legacy done plan with unresolved evidence" corpus the
  // prior-plan recall discovery is designed to surface.
  s.setPlanStatus(doneA.id, 'done', { force: true, reason: 'fixture: legacy completed plan with unresolved evidence' });

  const doneB = s.createPlan({
    project_id: 1,
    title: 'Diagon compact prior-plan lessons',
    keywords: ['diagon', 'lessons', 'carry-forward', 'audit'],
    summary: 'Rank completed matches and keep snippets compact.',
  });
  const doneBStep = s.addStep(doneB.id, {
    title: 'Extract compact lesson snippets',
    carry_forward: 'Only return short matching carry-forward snippets.',
  });
  s.recordAttempt(doneBStep.id, {
    what_tried: 'queried metadata-only prior plans',
    result: 'bounded snippets with no step body dump',
    verdict: 'fail',
  });
  s.setPlanStatus(doneB.id, 'done', { force: true, reason: 'fixture: legacy completed plan with unresolved evidence' });

  s.setCurrentProject(runtimeProject.id);
  const activeRelated = s.createPlan({
    project_id: runtimeProject.id,
    title: 'Diagon architect escalation runtime',
    keywords: ['diagon', 'architect', 'stalled', 'escalation', 'governance'],
    summary: 'Active in-flight work that is related but not completed evidence.',
  });
  s.setPlanStatus(activeRelated.id, 'active');

  s.setCurrentProject(perfProject.id);
  const unrelated = s.createPlan({
    project_id: perfProject.id,
    title: 'Optimize particle rendering',
    keywords: ['rendering', 'particle', 'performance'],
    summary: 'Unrelated graphics work.',
  });
  s.setPlanStatus(unrelated.id, 'done', { force: true, reason: 'fixture: unrelated legacy plan' });

  const draft = s.createPlan({
    project_id: perfProject.id,
    title: 'Plan #5 step #24 draft',
    keywords: ['plan-ledger', 'prior-plan'],
  });

  const found = s.plannerStart({
    goal: 'Implement audited reassignment recall from stalled architect with compact lessons',
    keywords: ['Diagon', 'Audit', 'ReAssignment', 'stalled', 'architect', 'carry-forward', 'lessons', 'metadata', 'overflow'],
    max_keywords: 99, // hard-capped internally to 8
    limit: 4,
    draft_plan_id: draft.id,
  });

  check('planner_start hard-caps keyword set to 8', found.keywords.length <= 8);
  check('planner_start discovers two overlapping completed Diagon plans',
    found.completed.some((m) => m.plan_id === doneA.id) && found.completed.some((m) => m.plan_id === doneB.id));
  check('planner_start excludes unrelated completed plans',
    !found.completed.some((m) => m.plan_id === unrelated.id));
  check('planner_start separates related active matches by status',
    found.related_active.some((m) => m.plan_id === activeRelated.id)
      && found.related_active.every((m) => m.status === 'active'));
  check('discovery output is compact and bounded',
    [...found.completed, ...found.related_active].every((m) =>
      m.context === undefined
      && m.steps === undefined
      && Array.isArray(m.snippets)
      && m.snippets.length <= 6
      && m.snippets.every((sn) => sn.text.length <= 160)));
  check('discovery never leaks full step bodies', !JSON.stringify(found).includes('LONG BODY LONG BODY'));
  check('planner_start persists consulted plan ids on the draft',
    Array.isArray(found.consulted)
      && found.consulted.some((c) => c.consulted_plan_id === doneA.id)
      && found.consulted.some((c) => c.consulted_plan_id === activeRelated.id));

  const opened = s.openPlan(draft.id);
  check('openPlan surfaces durable consulted_plans provenance',
    opened.consulted_plans.some((c) => c.consulted_plan_id === doneB.id || c.consulted_plan_id === doneA.id));

  // Create/update pathways also record consulted IDs.
  const created = s.createPlan({
    title: 'Draft created with consulted ids',
    consulted_plan_ids: [doneA.id, activeRelated.id],
    consulted_keywords: ['diagon', 'audit'],
    consulted_goal: 'create-path consultation write',
  });
  check('createPlan pathway persists consulted ids',
    created.consulted_plans.some((c) => c.consulted_plan_id === doneA.id)
      && created.consulted_plans.some((c) => c.consulted_plan_id === activeRelated.id));

  const updated = s.updatePlan(created.id, {
    summary: 'updated draft metadata',
    consulted_plan_ids: [doneB.id],
    consulted_keywords: ['lessons'],
    consulted_goal: 'update-path consultation write',
  });
  check('updatePlan pathway persists consulted ids while editing plan metadata',
    updated.summary === 'updated draft metadata'
      && updated.consulted_plans.some((c) => c.consulted_plan_id === doneB.id));

  s.close();

  // CLI bridge parity: same operation/contract available over JSON CLI.
  const cliFound = runCli('planner_start', {
    goal: 'audited reassignment from stalled architect',
    limit: 4,
  });
  check('CLI planner_start returns completed + related_active buckets', cliFound.status === 0
    && cliFound.body?.ok === true
    && Array.isArray(cliFound.body.result.completed)
    && Array.isArray(cliFound.body.result.related_active));

  const cliUpdate = runCli('update_plan', {
    plan_id: draft.id,
    consulted_plan_ids: [doneA.id],
    consulted_keywords: ['diagon'],
    consulted_goal: 'cli update path',
  });
  check('CLI update_plan records consulted ids', cliUpdate.status === 0
    && cliUpdate.body?.result?.consulted_plans?.some((c) => c.consulted_plan_id === doneA.id));

  console.log(`\nprior-plan-recall regression OK (${pass} checks)`);
} finally {
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
}
