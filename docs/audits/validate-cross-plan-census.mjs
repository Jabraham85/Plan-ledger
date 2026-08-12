#!/usr/bin/env node
// Builds and validates a read-only census of historical plan-ledger evidence.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, 'plan-ledger-cross-plan-census.json');
const markdownPath = resolve(here, 'plan-ledger-cross-plan-census.md');
const dbPath = process.env.PLAN_LEDGER_DB
  || 'C:\\Users\\Jose.Abraham\\Documents\\plan-ledger\\data\\plan-ledger.db';
const historicalPlanIds = Array.from({ length: 16 }, (_, index) => index + 1);
const expected = { plans: 16, steps: 101 };

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function rows(db, sql, ...values) {
  return db.prepare(sql).all(...values);
}

function firstLastElapsed(items, field = 'created_at') {
  const timestamps = items.map((item) => item[field]).filter(Boolean).sort();
  if (!timestamps.length) return { first_at: null, last_at: null, elapsed_ms: null };
  const elapsed = Date.parse(timestamps.at(-1)) - Date.parse(timestamps[0]);
  return {
    first_at: timestamps[0],
    last_at: timestamps.at(-1),
    elapsed_ms: Number.isFinite(elapsed) ? elapsed : null,
  };
}

function textOrUnknown(value) {
  return value === '' || value == null ? 'unknown' : value;
}

function collectStep(db, step) {
  const attempts = rows(db, 'SELECT * FROM attempts WHERE step_id=? ORDER BY id', step.id);
  const assignments = rows(db, 'SELECT * FROM step_assignments WHERE step_id=? ORDER BY revision, id', step.id);
  const notes = rows(db, 'SELECT * FROM notes WHERE step_id=? ORDER BY id', step.id);
  const links = rows(db, 'SELECT * FROM links WHERE from_step_id=? ORDER BY id', step.id);
  const fileRefs = rows(db, 'SELECT * FROM file_refs WHERE step_id=? ORDER BY id', step.id);
  const leases = rows(db, 'SELECT * FROM execution_leases WHERE step_id=? ORDER BY id', step.id);
  const activity = rows(db, 'SELECT * FROM activity_runs WHERE step_id=? ORDER BY id').map((run) => ({
    ...run,
    recent_artifacts: parseJson(run.recent_artifacts, []),
    metadata: parseJson(run.metadata, {}),
    events: rows(db, 'SELECT * FROM activity_events WHERE activity_id=? ORDER BY id', run.id)
      .map((event) => ({ ...event, metadata: parseJson(event.metadata, {}) })),
  }));
  const claimedArtifacts = [
    ...fileRefs.map((ref) => ({ source: 'file_ref', id: ref.id, path: ref.path, role: ref.role, note: ref.note })),
    ...activity.flatMap((run) => run.recent_artifacts.map((artifact) => ({ source: 'activity_run', activity_id: run.id, artifact }))),
  ];
  return {
    source: { step_id: step.id, plan_id: step.plan_id, idx: step.idx },
    status: step.status,
    title: step.title,
    context: step.context,
    tools: parseJson(step.tools, []),
    role: textOrUnknown(step.role),
    acceptance_criteria: step.acceptance_criteria,
    carry_forward: step.carry_forward,
    layman: step.layman,
    lessons: attempts
      .filter((attempt) => attempt.verdict !== 'pass')
      .map((attempt) => ({
        attempt_id: attempt.id,
        verdict: attempt.verdict,
        what_tried: attempt.what_tried,
        result: attempt.result,
        created_at: attempt.created_at,
      })),
    verification_disposition: textOrUnknown(step.verification_disposition),
    disposition_reason: textOrUnknown(step.disposition_reason),
    disposition_at: step.disposition_at || null,
    created_at: step.created_at,
    updated_at: step.updated_at,
    attempts,
    assignments,
    notes,
    links,
    file_refs: fileRefs,
    execution_leases: leases,
    activity_runs: activity,
    claimed_artifacts: claimedArtifacts,
    evidence_availability: {
      attempts: attempts.length ? 'present' : 'absent',
      assignments: assignments.length ? 'present' : 'absent',
      notes: notes.length ? 'present' : 'absent',
      execution_leases: leases.length ? 'present' : 'absent',
      activity_runs: activity.length ? 'present' : 'absent',
      claimed_artifacts: claimedArtifacts.length ? 'present' : 'absent',
    },
    derived: {
      attempts_total: attempts.length,
      verdicts: attempts.map((attempt) => attempt.verdict),
      review_rounds_total: attempts.reduce((total, attempt) => total + Number(attempt.review_rounds || 0), 0),
      attempt_timeline: firstLastElapsed(attempts),
      activity_timeline: firstLastElapsed(activity, 'started_at'),
    },
  };
}

function collectCensus() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const plans = historicalPlanIds.map((planId) => {
      const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
      if (!plan) throw new Error(`required historical plan #${planId} is absent`);
      const steps = rows(db, 'SELECT * FROM steps WHERE plan_id=? ORDER BY idx, id', planId).map((step) => collectStep(db, step));
      const planFileRefs = rows(db, 'SELECT * FROM file_refs WHERE plan_id=? AND step_id IS NULL ORDER BY id', planId);
      const consultations = rows(db, 'SELECT * FROM plan_consultations WHERE plan_id=? ORDER BY id', planId)
        .map((record) => ({ ...record, keywords: parseJson(record.keywords, []) }));
      const closedSteps = steps.filter((step) => ['done', 'skipped', 'blocked'].includes(step.status));
      const allDone = steps.length > 0 && steps.every((step) => step.status === 'done');
      const inconsistencies = [];
      if (plan.status === 'active' && allDone) inconsistencies.push('active_plan_all_steps_done');
      if (plan.status === 'done' && closedSteps.length !== steps.length) inconsistencies.push('done_plan_has_nonterminal_steps');
      if (plan.status === 'done' && steps.some((step) => step.verification_disposition === 'unknown')) {
        inconsistencies.push('done_plan_has_missing_verification_disposition');
      }
      return {
        source: { plan_id: plan.id, project_id: plan.project_id },
        title: plan.title,
        keywords: parseJson(plan.keywords, []),
        summary: plan.summary,
        status: plan.status,
        completion_lock: textOrUnknown(plan.completion_lock),
        created_at: plan.created_at,
        updated_at: plan.updated_at,
        plan_file_refs: planFileRefs,
        consultations,
        steps,
        reconciliation: {
          step_count: steps.length,
          done_count: steps.filter((step) => step.status === 'done').length,
          closed_count: closedSteps.length,
          all_steps_done: allDone,
          status_completion_inconsistencies: inconsistencies,
        },
      };
    });
    const allPlans = rows(db, `
      SELECT p.id, p.project_id, p.title, p.status, p.updated_at,
        COUNT(s.id) AS steps, COALESCE(SUM(s.status='done'), 0) AS done
      FROM plans p LEFT JOIN steps s ON s.plan_id=p.id
      GROUP BY p.id ORDER BY p.id
    `);
    const projects = rows(db, 'SELECT * FROM projects WHERE id BETWEEN 1 AND 8 ORDER BY id');
    return {
      audit_schema_version: 1,
      generated_at: new Date().toISOString(),
      source: {
        kind: 'sqlite_read_only',
        db_path: dbPath,
        historical_plan_ids: historicalPlanIds,
        scope: 'plans #1 through #16; current plan #17 excluded',
      },
      expected,
      ledger_surface: {
        plans_1_to_16: allPlans.filter((plan) => plan.id >= 1 && plan.id <= 16),
        projects_1_to_8: projects,
      },
      reconciliation: {
        represented_plans: plans.length,
        represented_steps: plans.reduce((total, plan) => total + plan.steps.length, 0),
        status_completion_inconsistencies: plans.flatMap((plan) =>
          plan.reconciliation.status_completion_inconsistencies.map((code) => ({ plan_id: plan.source.plan_id, code }))),
      },
      plans,
    };
  } finally {
    db.close();
  }
}

function renderMarkdown(census) {
  const lines = [
    '# Plan-ledger cross-plan evidence census',
    '',
    `Generated: ${census.generated_at}`,
    `Source: read-only SQLite at \`${census.source.db_path}\`. Current plan #17 is excluded.`,
    '',
    `Reconciliation: **${census.reconciliation.represented_plans}/${expected.plans} plans** and **${census.reconciliation.represented_steps}/${expected.steps} steps**.`,
    '',
    '## Plan inventory',
    '',
    '| Plan | Project | Status | Done/Steps | Attempts | Leases | Activity | Inconsistencies |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const plan of census.plans) {
    const steps = plan.steps;
    const attempts = steps.reduce((total, step) => total + step.attempts.length, 0);
    const leases = steps.reduce((total, step) => total + step.execution_leases.length, 0);
    const activity = steps.reduce((total, step) => total + step.activity_runs.length, 0);
    const issues = plan.reconciliation.status_completion_inconsistencies.join(', ') || 'none';
    lines.push(`| #${plan.source.plan_id} | #${plan.source.project_id} | ${plan.status} | ${plan.reconciliation.done_count}/${steps.length} | ${attempts} | ${leases} | ${activity} | ${issues} |`);
  }
  lines.push('', '## Step evidence', '');
  for (const plan of census.plans) {
    lines.push(`### Plan #${plan.source.plan_id}: ${plan.title}`, '', '| Step | Status | Disposition | Attempts / verdicts | Review rounds | Leases | Activity | Claimed artifacts |', '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |');
    for (const step of plan.steps) {
      const verdicts = step.derived.verdicts.join(', ') || 'unknown';
      lines.push(`| #${step.source.step_id} (${step.source.idx}) | ${step.status} | ${step.verification_disposition} | ${step.derived.attempts_total} / ${verdicts} | ${step.derived.review_rounds_total} | ${step.execution_leases.length} | ${step.activity_runs.length} | ${step.claimed_artifacts.length} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Evidence limitations',
    '',
    '- Empty evidence collections are recorded as `absent`; the census does not infer missing attempts, leases, activity, artifacts, roles, models, or verification.',
    '- `claimed_artifacts` are ledger claims from file references and activity telemetry. This audit does not verify that a referenced path exists.',
    '- Full traceable records, including timestamps, attempts, assignments, lessons/carry-forward, blockers, lease/activity rows, and source IDs, are in the companion JSON.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function generate() {
  const census = collectCensus();
  writeFileSync(jsonPath, `${JSON.stringify(census, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderMarkdown(census), 'utf8');
  return census;
}

function validate(census) {
  const errors = [];
  if (census?.expected?.plans !== expected.plans || census?.expected?.steps !== expected.steps) errors.push('unexpected declared expected totals');
  const plans = census?.plans;
  if (!Array.isArray(plans) || plans.length !== expected.plans) errors.push(`expected ${expected.plans} plan records`);
  const ids = Array.isArray(plans) ? plans.map((plan) => plan?.source?.plan_id).sort((a, b) => a - b) : [];
  if (JSON.stringify(ids) !== JSON.stringify(historicalPlanIds)) errors.push('plan IDs do not exactly equal #1 through #16');
  const steps = Array.isArray(plans) ? plans.flatMap((plan) => plan.steps || []) : [];
  if (steps.length !== expected.steps) errors.push(`expected ${expected.steps} step records, got ${steps.length}`);
  const uniqueStepIds = new Set(steps.map((step) => step?.source?.step_id));
  if (uniqueStepIds.size !== steps.length) errors.push('duplicate or missing step source IDs');
  for (const plan of plans || []) {
    const surface = census.ledger_surface.plans_1_to_16.find((item) => item.id === plan.source.plan_id);
    if (!surface) errors.push(`missing ledger surface row for plan #${plan.source.plan_id}`);
    else if (surface.status !== plan.status || Number(surface.project_id) !== Number(plan.source.project_id)) errors.push(`surface mismatch for plan #${plan.source.plan_id}`);
    if (surface && (Number(surface.steps) !== plan.steps.length || Number(surface.done) !== plan.reconciliation.done_count)) {
      errors.push(`step reconciliation mismatch for plan #${plan.source.plan_id}`);
    }
    for (const step of plan.steps || []) {
      for (const required of ['attempts', 'assignments', 'notes', 'execution_leases', 'activity_runs', 'claimed_artifacts']) {
        if (!Array.isArray(step[required])) errors.push(`step #${step?.source?.step_id} lacks ${required} array`);
      }
    }
  }
  if (census?.reconciliation?.represented_plans !== expected.plans) errors.push('top-level represented plan total mismatch');
  if (census?.reconciliation?.represented_steps !== expected.steps) errors.push('top-level represented step total mismatch');
  return errors;
}

const generateRequested = process.argv.includes('--generate');
const census = generateRequested ? generate() : existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;
const errors = validate(census);
if (errors.length) {
  console.error(`Census validation failed: ${errors.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`Census validation passed: ${expected.plans}/${expected.plans} plans and ${expected.steps}/${expected.steps} steps.`);
}
