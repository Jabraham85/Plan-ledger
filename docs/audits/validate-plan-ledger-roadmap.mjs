#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, 'plan-ledger-improvement-roadmap.json');
const mdPath = resolve(here, 'plan-ledger-improvement-roadmap.md');

const requiredAreas = new Set([
  'data/state integrity and automatic terminalization',
  'execution leases and stale recovery; runner/dispatch and role/model resolution',
  'evidence and review gates',
  'recovery and carry-forward',
  'CLI/bridge architecture',
  'board and telemetry',
  'latency',
]);

function fail(errors) {
  console.error(`Roadmap validation failed: ${errors.join('; ')}`);
  process.exit(1);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMeasurableAcceptance(text) {
  if (!isNonEmptyString(text)) return false;
  return /(<=|>=|==|p50|p95|ms|minute|minutes|count|zero|non-zero|percent|%)/i.test(text);
}

function recomputeScore(weights, input) {
  const F = Number(input.observed_frequency);
  const I = Number(input.user_impact);
  const R = Number(input.risk_reduction);
  const T = Number(input.measured_time_saved);
  const E = Number(input.implementation_effort);
  const M = Number(input.migration_risk);
  const C = Number(input.confidence);
  const weighted =
    weights.observed_frequency * F
    + weights.user_impact * I
    + weights.risk_reduction * R
    + weights.measured_time_saved * T
    + weights.implementation_effort_inverse * (6 - E)
    + weights.migration_risk_inverse * (6 - M)
    + weights.confidence * C;
  return Math.round(20 * weighted);
}

if (!existsSync(jsonPath)) fail([`missing required artifact: ${jsonPath}`]);
const requireMarkdown = process.argv.includes('--require-markdown');
if (requireMarkdown && !existsSync(mdPath)) fail([`missing required artifact: ${mdPath}`]);

const roadmap = JSON.parse(readFileSync(jsonPath, 'utf8'));
const errors = [];

if (!Array.isArray(roadmap.required_evidence_inputs) || roadmap.required_evidence_inputs.length < 8) {
  errors.push('required_evidence_inputs must list all required audit artifacts');
}
if (!Array.isArray(roadmap.candidates) || roadmap.candidates.length < 7) {
  errors.push('candidates must include all material improvement areas');
}

const candidates = Array.isArray(roadmap.candidates) ? roadmap.candidates : [];
const weights = roadmap?.scoring_formula?.weights;
if (!weights) errors.push('scoring_formula.weights missing');

const selected = candidates.filter((candidate) => candidate.selected_for_first_release === true);
if (selected.length === 0) errors.push('at least one first-release candidate is required');
if (selected.length > 4) errors.push(`first-release candidate limit exceeded: ${selected.length} selected (max 4)`);

const areaCoverage = new Set(candidates.map((candidate) => candidate.area));
for (const area of requiredAreas) {
  if (!areaCoverage.has(area)) errors.push(`missing candidate coverage for area "${area}"`);
}

const rankValues = candidates.map((candidate) => Number(candidate.rank));
const uniqueRanks = new Set(rankValues);
if (uniqueRanks.size !== candidates.length) errors.push('candidate ranks must be unique');

const sortedByRank = [...candidates].sort((a, b) => a.rank - b.rank);
for (let i = 0; i < sortedByRank.length; i += 1) {
  if (sortedByRank[i].rank !== i + 1) {
    errors.push(`candidate ranks must be contiguous starting at 1 (first mismatch at rank ${i + 1})`);
    break;
  }
}

for (const candidate of candidates) {
  if (!isNonEmptyString(candidate.id)) errors.push('candidate id missing');
  if (!isNonEmptyString(candidate.name)) errors.push(`candidate ${candidate.id || '(unknown)'} missing name`);
  if (!isNonEmptyString(candidate.area)) errors.push(`candidate ${candidate.id || '(unknown)'} missing area`);
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
    errors.push(`candidate ${candidate.id} must include traceable evidence references`);
  } else {
    for (const evidence of candidate.evidence) {
      if (!isNonEmptyString(evidence.path) || !isNonEmptyString(evidence.fact)) {
        errors.push(`candidate ${candidate.id} has malformed evidence entry`);
      }
    }
  }
  if (!candidate.score_inputs) {
    errors.push(`candidate ${candidate.id} missing score_inputs`);
  } else {
    for (const key of [
      'observed_frequency',
      'user_impact',
      'risk_reduction',
      'measured_time_saved',
      'implementation_effort',
      'migration_risk',
      'confidence',
    ]) {
      const value = Number(candidate.score_inputs[key]);
      if (!Number.isFinite(value) || value < 1 || value > 5) {
        errors.push(`candidate ${candidate.id} score ${key} must be 1..5`);
      }
    }
    if (weights) {
      const recomputed = recomputeScore(weights, candidate.score_inputs);
      if (Math.abs(recomputed - Number(candidate.composite_score)) > 0) {
        errors.push(`candidate ${candidate.id} composite_score mismatch (expected ${recomputed}, got ${candidate.composite_score})`);
      }
    }
  }
  if (!candidate.measured_time_saved_estimate || !isNonEmptyString(candidate.measured_time_saved_estimate.basis)) {
    errors.push(`candidate ${candidate.id} missing measured_time_saved_estimate basis`);
  }
}

for (const candidate of selected) {
  if (!isNonEmptyString(candidate.target_behavior)) errors.push(`selected ${candidate.id} missing target_behavior`);
  if (!Array.isArray(candidate.contracts_and_api_changes) || candidate.contracts_and_api_changes.length === 0) {
    errors.push(`selected ${candidate.id} missing contracts_and_api_changes`);
  }
  if (!Array.isArray(candidate.schema_changes) || candidate.schema_changes.length === 0) {
    errors.push(`selected ${candidate.id} missing schema_changes`);
  }
  if (!Array.isArray(candidate.migration_and_backfill) || candidate.migration_and_backfill.length === 0) {
    errors.push(`selected ${candidate.id} missing migration_and_backfill`);
  }
  if (!Array.isArray(candidate.tests) || candidate.tests.length === 0) {
    errors.push(`selected ${candidate.id} missing tests`);
  } else {
    for (const test of candidate.tests) {
      if (!hasMeasurableAcceptance(test.measurable_acceptance)) {
        errors.push(`selected ${candidate.id} test "${test?.name || '(unnamed)'}" lacks measurable acceptance`);
      }
    }
  }
  if (!Array.isArray(candidate.rollout) || candidate.rollout.length === 0) {
    errors.push(`selected ${candidate.id} missing rollout`);
  }
  if (!Array.isArray(candidate.rollback) || candidate.rollback.length === 0) {
    errors.push(`selected ${candidate.id} missing rollback`);
  }
  if (!candidate.performance_budget || !isNonEmptyString(candidate.performance_budget.local_latency)) {
    errors.push(`selected ${candidate.id} missing local performance budget`);
  }
  if (!candidate.performance_budget || !isNonEmptyString(candidate.performance_budget.external_latency_policy)) {
    errors.push(`selected ${candidate.id} missing external latency separation policy`);
  }
  if (!Array.isArray(candidate.risks) || candidate.risks.length === 0) {
    errors.push(`selected ${candidate.id} missing risks`);
  }
  if (!Array.isArray(candidate.dependencies) || candidate.dependencies.length === 0) {
    errors.push(`selected ${candidate.id} missing dependencies`);
  }
  if (!Array.isArray(candidate.non_goals) || candidate.non_goals.length === 0) {
    errors.push(`selected ${candidate.id} missing non_goals`);
  }
}

const c1 = candidates.find((candidate) => candidate.id === 'C1-evidence-gate');
if (!c1) {
  errors.push('missing required candidate C1-evidence-gate');
} else {
  const schemaText = Array.isArray(c1.schema_changes) ? c1.schema_changes.join(' ') : '';
  const migrationText = Array.isArray(c1.migration_and_backfill) ? c1.migration_and_backfill.join(' ') : '';
  const testsText = Array.isArray(c1.tests)
    ? c1.tests.map((test) => `${test.name || ''} ${test.measurable_acceptance || ''}`).join(' ')
    : '';

  if (!/legacy_unknown/.test(schemaText)) {
    errors.push('C1 schema must include legacy_unknown validation status');
  }
  if (/validation_status='fail'[\s\S]*no machine-checkable payload|no machine-checkable payload[\s\S]*validation_status='fail'/.test(migrationText)) {
    errors.push('C1 migration must not classify legacy missing payload as fail');
  }
  if (!/legacy_unknown/.test(migrationText) || !/not\s+`?fail`?/i.test(migrationText)) {
    errors.push('C1 migration must explicitly require legacy_unknown (not fail) for legacy missing payload');
  }
  if (!/legacy/i.test(testsText) || !/unknown/i.test(testsText) || !/0\s+rows?\s+to\s+`?fail`?/i.test(testsText)) {
    errors.push('C1 tests must assert legacy missing payload rows map to unknown and not fail');
  }
}

const firstReleaseIds = roadmap?.first_release?.selected_candidate_ids;
if (!Array.isArray(firstReleaseIds) || firstReleaseIds.length !== selected.length) {
  errors.push('first_release.selected_candidate_ids must match selected candidate count');
}
if (Array.isArray(firstReleaseIds)) {
  for (const id of firstReleaseIds) {
    if (!selected.some((candidate) => candidate.id === id)) {
      errors.push(`first_release references non-selected id ${id}`);
    }
  }
}

if (errors.length) fail(errors);

console.log(`OK: roadmap valid with ${candidates.length} ranked candidates, ${selected.length} selected first-release items, and measurable acceptance checks for every selected item.`);
