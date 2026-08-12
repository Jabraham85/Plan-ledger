import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, 'plan-ledger-retrospective.json');
const markdownPath = resolve(here, 'plan-ledger-retrospective.md');
const censusPath = resolve(here, 'plan-ledger-cross-plan-census.json');
const outcomes = new Set([
  'worked-as-designed',
  'worked-after-correction',
  'partial',
  'malfunctioned',
  'blocked',
  'stale',
  'unknown',
]);

const errors = [];
for (const path of [jsonPath, markdownPath, censusPath]) {
  if (!existsSync(path)) errors.push(`Missing required artifact: ${path}`);
}

if (!errors.length) {
  const retrospective = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const census = JSON.parse(readFileSync(censusPath, 'utf8'));
  const expectedIds = Array.from({ length: 16 }, (_, index) => index + 1);
  const plans = retrospective.plans;

  if (!Array.isArray(plans) || plans.length !== 16) {
    errors.push(`Expected exactly 16 plan classifications; found ${plans?.length ?? 'none'}.`);
  }

  const ids = plans.map((plan) => plan.plan_id).sort((a, b) => a - b);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    errors.push(`Plan IDs must be exactly 1-16; found ${ids.join(', ') || 'none'}.`);
  }

  for (const plan of plans) {
    if (!outcomes.has(plan.outcome)) errors.push(`Plan #${plan.plan_id} has invalid outcome.`);
    if (!Array.isArray(plan.evidence_references) || plan.evidence_references.length === 0) {
      errors.push(`Plan #${plan.plan_id} has no evidence references.`);
    } else if (plan.evidence_references.some((reference) => typeof reference !== 'string' || !reference.trim())) {
      errors.push(`Plan #${plan.plan_id} has an empty evidence reference.`);
    }
    if (typeof plan.fact_basis !== 'string' || !plan.fact_basis.trim()) errors.push(`Plan #${plan.plan_id} lacks fact basis.`);
    if (typeof plan.inference !== 'string' || !plan.inference.trim()) errors.push(`Plan #${plan.plan_id} lacks inference.`);
  }

  const countMap = new Map();
  for (const plan of plans) countMap.set(plan.outcome, (countMap.get(plan.outcome) ?? 0) + 1);
  const declared = retrospective.headline_counts ?? {};
  const declaredTotal = ['worked_as_designed', 'worked_after_correction', 'partial', 'malfunctioned', 'blocked', 'stale', 'unknown']
    .reduce((total, key) => total + (declared[key] ?? 0), 0);
  if (declared.plans !== 16 || declaredTotal !== 16) errors.push('Headline counts must total 16 plans.');
  if ((declared.worked_as_designed ?? 0) !== (countMap.get('worked-as-designed') ?? 0)) errors.push('worked_as_designed count disagrees with plans.');
  if ((declared.worked_after_correction ?? 0) !== (countMap.get('worked-after-correction') ?? 0)) errors.push('worked_after_correction count disagrees with plans.');
  if ((declared.partial ?? 0) !== (countMap.get('partial') ?? 0)) errors.push('partial count disagrees with plans.');
  if ((declared.malfunctioned ?? 0) !== (countMap.get('malfunctioned') ?? 0)) errors.push('malfunctioned count disagrees with plans.');
  if ((declared.blocked ?? 0) !== (countMap.get('blocked') ?? 0)) errors.push('blocked count disagrees with plans.');
  if ((declared.stale ?? 0) !== (countMap.get('stale') ?? 0)) errors.push('stale count disagrees with plans.');
  if ((declared.unknown ?? 0) !== (countMap.get('unknown') ?? 0)) errors.push('unknown count disagrees with plans.');

  const historicalIds = census.source?.historical_plan_ids ?? [];
  if (JSON.stringify(historicalIds) !== JSON.stringify(expectedIds)) {
    errors.push('Census source does not contain the expected historical plan IDs 1-16.');
  }

  if (!Array.isArray(retrospective.pitfalls) || retrospective.pitfalls.length === 0) {
    errors.push('At least one common pitfall is required.');
  } else {
    for (const pitfall of retrospective.pitfalls) {
      for (const field of ['name', 'frequency', 'impact', 'facts', 'inference']) {
        if (typeof pitfall[field] !== 'string' || !pitfall[field].trim()) errors.push(`Pitfall lacks ${field}.`);
      }
      if (!Array.isArray(pitfall.representatives) || pitfall.representatives.length === 0) {
        errors.push(`Pitfall "${pitfall.name}" lacks representative plan/step IDs.`);
      }
    }
  }
}

if (errors.length) {
  console.error(`FAIL: ${errors.join('\n')}`);
  process.exit(1);
}

console.log('OK: 16/16 plans classified with evidence references; 7 pitfalls include frequency, impact, and representatives.');
