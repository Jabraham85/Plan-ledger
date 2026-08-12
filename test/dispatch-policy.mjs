// dispatch-policy.mjs — deterministic dispatch policy regression coverage.
// Run: node test/dispatch-policy.mjs
import assert from 'node:assert/strict';
import { evaluateDispatchPolicy } from '../src/dispatch-policy.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

// Regression: browser automation + screenshot + server work must NOT prefer ui-designer.
{
  const step = {
    title: 'Capture browser screenshots from local server',
    context: 'Use Playwright deterministic browser automation, start dev server on port 4319, capture screenshots.',
    acceptance_criteria: 'Screenshots captured and verification checks pass.',
    tools: ['playwright', 'node'],
  };
  const p = evaluateDispatchPolicy({
    step,
    explicit_role: 'ui-designer',
    resolved_model: 'gpt-5.6-sol-medium',
    available_models: ['gpt-5.6-sol-medium', 'claude-sonnet-5-thinking-high'],
  });
  check('explicit role is preserved as authoritative', p.selected_role === 'ui-designer' && p.selection_mode === 'explicit');
  check('material mismatch requires audited override reason', p.material_mismatch === true && p.requires_override_reason === true);
  check('best match is test/build role, not ui-designer', ['test-engineer', 'build-devops'].includes(p.best_match?.role));
  check('required capabilities include automation/screenshot/server',
    p.required_capabilities.some((c) => c.capability === 'deterministic_browser_automation')
    && p.required_capabilities.some((c) => c.capability === 'screenshot_capture')
    && p.required_capabilities.some((c) => c.capability === 'server_lifecycle'));
}

// C3 contract: implementation modality must score implementer >=1 above architect.
{
  const p = evaluateDispatchPolicy({
    step: {
      title: 'Implement dispatch recovery transaction',
      context: 'Apply the code changes in source files and add deterministic tests.',
      acceptance_criteria: 'Code patch and tests both pass.',
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'implementer',
        fallback_roles: ['debugger', 'architect'],
      },
    },
    explicit_role: 'implementer',
    candidate_roles: ['implementer', 'architect'],
  });
  const scores = new Map([
    ['selected', p.selected_score?.normalized_score ?? 0],
    ['best', p.best_match?.normalized_score ?? 0],
  ]);
  const implementer = p.selected_role === 'implementer' ? scores.get('selected') : scores.get('best');
  const architectPolicy = evaluateDispatchPolicy({
    step: {
      title: 'Implement dispatch recovery transaction',
      context: 'Apply the code changes in source files and add deterministic tests.',
      acceptance_criteria: 'Code patch and tests both pass.',
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer'],
      },
    },
    explicit_role: 'architect',
    candidate_roles: ['implementer', 'architect'],
  });
  check('implementation modality scores implementer >=1 point above architect',
    (implementer * 10) - ((architectPolicy.selected_score?.normalized_score ?? 0) * 10) >= 1);
}

// UI composition/review should still select ui-designer.
{
  const p = evaluateDispatchPolicy({
    step: {
      title: 'Refine dashboard visual polish',
      context: 'Improve layout, typography, spacing, and color hierarchy for the board view.',
      acceptance_criteria: 'Visual composition review approved.',
      tools: ['figma'],
    },
    explicit_role: 'ui-designer',
  });
  check('ui composition remains ui-designer', p.material_mismatch === false && p.selected_role === 'ui-designer');
}

// Automatic selection is only used when no explicit role exists.
{
  const p = evaluateDispatchPolicy({
    step: {
      title: 'Automate browser checks',
      context: 'Run playwright e2e and attach screenshot evidence.',
      acceptance_criteria: 'Tests pass with screenshots.',
      tools: ['playwright'],
    },
    explicit_role: '',
  });
  check('automatic selection is used with unassigned role', p.selection_mode === 'automatic' && p.automatic_selection_allowed === true);
  check('automatic selector recommends execution role', ['test-engineer', 'build-devops'].includes(p.selected_role));
}

// Model availability signal surfaces in policy warnings.
{
  const p = evaluateDispatchPolicy({
    step: { title: 'Run deterministic verification', context: 'Verify behavior', acceptance_criteria: 'all pass' },
    explicit_role: 'test-engineer',
    resolved_model: 'missing-model',
    available_models: ['gpt-5.6-sol-medium'],
  });
  check('unavailable model warning is explicit', p.warnings.some((w) => /model "missing-model".*not in the available model catalog/i.test(w)));
  check('unavailable model emits structured reason code', p.reason_codes.includes('dispatch_model_unavailable'));
}

// Unknown/custom explicit roles are preserved but marked as unscored.
{
  const p = evaluateDispatchPolicy({
    step: { title: 'Custom role test', context: 'Implement API fix', acceptance_criteria: 'fix merged' },
    explicit_role: 'security-reviewer',
  });
  check('unknown explicit role remains selected', p.selected_role === 'security-reviewer' && p.selection_mode === 'explicit');
  check('unknown role emits transparent warning', p.selected_score.known_role === false && p.warnings.some((w) => /no documented capability profile/i.test(w)));
}

// C3 contract: material mismatch requires a durable override reason.
{
  const noReason = evaluateDispatchPolicy({
    step: {
      title: 'Implement guarded stale lease recovery',
      context: 'Implementation work with code patch output.',
      acceptance_criteria: 'Tests pass and data remains append-only.',
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer'],
      },
    },
    explicit_role: 'architect',
  });
  check('material mismatch requires override reason code', noReason.reason_codes.includes('dispatch_override_reason_required'));
  const withReason = evaluateDispatchPolicy({
    step: {
      title: 'Implement guarded stale lease recovery',
      context: 'Implementation work with code patch output.',
      acceptance_criteria: 'Tests pass and data remains append-only.',
      dispatch_policy: {
        task_modality: 'implementation',
        required_artifact_type: 'code_patch',
        preferred_role: 'architect',
        fallback_roles: ['implementer'],
      },
    },
    explicit_role: 'architect',
    override_reason: 'legacy charter constraints for this run',
  });
  check('override reason clears missing-override code', !withReason.reason_codes.includes('dispatch_override_reason_required'));
}

// Stable deterministic output.
{
  const input = {
    step: {
      title: 'Publish release build',
      context: 'Build artifact and publish release notes.',
      acceptance_criteria: 'publish complete',
      tools: ['github-actions'],
    },
    explicit_role: '',
    resolved_model: 'composer-2.5-fast',
    available_models: ['composer-2.5-fast'],
  };
  const a = evaluateDispatchPolicy(input);
  const b = evaluateDispatchPolicy(input);
  check('policy output is deterministic for same input', JSON.stringify(a) === JSON.stringify(b));
  check('transparent rationale includes alternatives', !!a.selected_score?.rationale && Array.isArray(a.alternatives) && a.alternatives.length >= 1);
}

console.log(`\n${pass} dispatch-policy checks passed.`);
