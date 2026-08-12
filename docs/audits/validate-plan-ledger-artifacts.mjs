#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, 'plan-ledger-artifact-verification.json');
const mdPath = resolve(here, 'plan-ledger-artifact-verification.md');
const expectedPlanIds = Array.from({ length: 16 }, (_, i) => i + 1);
const allowedClasses = new Set([
  'implemented-and-verified',
  'implemented-but-regressed',
  'partially-implemented',
  'claim-not-supported',
  'unverifiable',
]);

function fail(errors) {
  console.error(`Artifact verification validation failed: ${errors.join('; ')}`);
  process.exit(1);
}

if (!existsSync(jsonPath)) fail([`missing required artifact: ${jsonPath}`]);
if (!existsSync(mdPath)) fail([`missing required artifact: ${mdPath}`]);

const audit = JSON.parse(readFileSync(jsonPath, 'utf8'));
const errors = [];

if (!Array.isArray(audit.classifications)) errors.push('classifications must be an array');
if (Array.isArray(audit.classifications) && audit.classifications.length !== 16) {
  errors.push(`expected 16 classifications, got ${audit.classifications.length}`);
}

if (Array.isArray(audit.classifications)) {
  const ids = audit.classifications.map((entry) => Number(entry.plan_id)).sort((a, b) => a - b);
  if (JSON.stringify(ids) !== JSON.stringify(expectedPlanIds)) {
    errors.push('plan IDs must be exactly 1..16');
  }
}

for (const entry of audit.classifications || []) {
  if (!allowedClasses.has(entry.classification)) {
    errors.push(`plan #${entry.plan_id} has invalid classification "${entry.classification}"`);
  }
  if (!Array.isArray(entry.checks)) {
    errors.push(`plan #${entry.plan_id} missing checks array`);
    continue;
  }
  if (entry.classification === 'implemented-and-verified') {
    const artifactsOk = Array.isArray(entry.artifacts) && entry.artifacts.length > 0;
    const successfulCheck = entry.checks.some((check) =>
      Number(check.exit_code) === 0 && typeof check.output === 'string' && check.output.trim().length > 0);
    if (!artifactsOk) errors.push(`plan #${entry.plan_id} verified class requires at least one artifact`);
    if (!successfulCheck) errors.push(`plan #${entry.plan_id} verified class requires at least one successful command/inspection`);
  }
  if (entry.classification === 'implemented-but-regressed') {
    const hasRepro = Array.isArray(entry.reproduction_evidence)
      && entry.reproduction_evidence.some((item) =>
        Number(item.exit_code) === 0 && typeof item.output === 'string' && item.output.trim().length > 0);
    if (!hasRepro) errors.push(`plan #${entry.plan_id} regressed class requires reproduction evidence`);
  }
}

const counted = Object.values(audit.classification_counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
if (counted !== 16) errors.push(`classification_counts total must equal 16, got ${counted}`);

if (errors.length) fail(errors);
console.log('Artifact verification validation passed: 16/16 plans classified.');
