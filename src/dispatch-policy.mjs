// dispatch-policy.mjs — deterministic, explainable role selection policy.
// Derives required capabilities from step intent and scores roster roles
// against a documented capability map. Stable sorting + explicit rationale.

import { DEFAULT_STAFF_ROLES } from './roles.mjs';

export const DISPATCH_CAPABILITIES = [
  'behavioral_ux',
  'visual_composition',
  'deterministic_browser_automation',
  'screenshot_capture',
  'server_lifecycle',
  'build_deploy',
  'verification',
  'publishing',
  'data_security',
  'implementation',
];

// 0..3 capability depth per role.
export const ROLE_CAPABILITY_MAP = {
  architect: {
    behavioral_ux: 2, visual_composition: 1, deterministic_browser_automation: 0, screenshot_capture: 0,
    server_lifecycle: 1, build_deploy: 1, verification: 1, publishing: 1, data_security: 2, implementation: 1,
  },
  implementer: {
    behavioral_ux: 1, visual_composition: 1, deterministic_browser_automation: 1, screenshot_capture: 1,
    server_lifecycle: 1, build_deploy: 1, verification: 2, publishing: 1, data_security: 1, implementation: 3,
  },
  'test-engineer': {
    behavioral_ux: 1, visual_composition: 0, deterministic_browser_automation: 3, screenshot_capture: 3,
    server_lifecycle: 2, build_deploy: 1, verification: 3, publishing: 1, data_security: 1, implementation: 1,
  },
  debugger: {
    behavioral_ux: 1, visual_composition: 0, deterministic_browser_automation: 2, screenshot_capture: 1,
    server_lifecycle: 2, build_deploy: 1, verification: 3, publishing: 0, data_security: 2, implementation: 2,
  },
  'refactor-surgeon': {
    behavioral_ux: 0, visual_composition: 0, deterministic_browser_automation: 0, screenshot_capture: 0,
    server_lifecycle: 1, build_deploy: 0, verification: 2, publishing: 0, data_security: 1, implementation: 3,
  },
  'build-devops': {
    behavioral_ux: 0, visual_composition: 0, deterministic_browser_automation: 2, screenshot_capture: 1,
    server_lifecycle: 3, build_deploy: 3, verification: 2, publishing: 3, data_security: 2, implementation: 1,
  },
  'perf-engineer': {
    behavioral_ux: 0, visual_composition: 0, deterministic_browser_automation: 1, screenshot_capture: 0,
    server_lifecycle: 2, build_deploy: 1, verification: 3, publishing: 0, data_security: 1, implementation: 2,
  },
  researcher: {
    behavioral_ux: 1, visual_composition: 1, deterministic_browser_automation: 0, screenshot_capture: 0,
    server_lifecycle: 0, build_deploy: 0, verification: 1, publishing: 1, data_security: 1, implementation: 0,
  },
  'tech-writer': {
    behavioral_ux: 1, visual_composition: 1, deterministic_browser_automation: 0, screenshot_capture: 1,
    server_lifecycle: 0, build_deploy: 0, verification: 1, publishing: 2, data_security: 1, implementation: 0,
  },
  'ui-designer': {
    behavioral_ux: 2, visual_composition: 3, deterministic_browser_automation: 0, screenshot_capture: 1,
    server_lifecycle: 0, build_deploy: 0, verification: 1, publishing: 1, data_security: 0, implementation: 0,
  },
  'ux-architect': {
    behavioral_ux: 3, visual_composition: 1, deterministic_browser_automation: 0, screenshot_capture: 1,
    server_lifecycle: 0, build_deploy: 0, verification: 1, publishing: 1, data_security: 1, implementation: 0,
  },
  'game-designer': {
    behavioral_ux: 2, visual_composition: 1, deterministic_browser_automation: 0, screenshot_capture: 0,
    server_lifecycle: 0, build_deploy: 0, verification: 1, publishing: 1, data_security: 1, implementation: 1,
  },
};

const SIGNALS = [
  {
    capability: 'deterministic_browser_automation',
    weight: 3,
    label: 'deterministic browser automation',
    patterns: [/\b(playwright|puppeteer|cypress|selenium|browser automation|headless browser|e2e)\b/i],
  },
  {
    capability: 'screenshot_capture',
    weight: 2,
    label: 'screenshot capture',
    patterns: [/\b(screenshot|screenshots|screen ?shot|screen ?shots|capture image|visual diff|snapshot|snapshots)\b/i],
  },
  {
    capability: 'server_lifecycle',
    weight: 3,
    label: 'server lifecycle',
    patterns: [/\b(start server|stop server|restart server|dev server|local server|port \d+|healthcheck|health check)\b/i],
  },
  {
    capability: 'build_deploy',
    weight: 3,
    label: 'build/deploy',
    patterns: [/\b(build|ci|cd|pipeline|deploy|release|docker|terraform|kubernetes|ecs|ghcr|artifact)\b/i],
  },
  {
    capability: 'verification',
    weight: 3,
    label: 'verification',
    patterns: [/\b(verify|verification|assert|test|qa|regression|acceptance|proof)\b/i, /^VERIFY:\s*(.+)$/gmi],
  },
  {
    capability: 'publishing',
    weight: 3,
    label: 'publishing',
    patterns: [/\b(publish|release note|ship|announce|documentation release|changelog)\b/i],
  },
  {
    capability: 'data_security',
    weight: 3,
    label: 'data/security',
    patterns: [/\b(security|auth|authorization|permission|encryption|pii|secret|credential|compliance|privacy|data migration)\b/i],
  },
  {
    capability: 'visual_composition',
    weight: 3,
    label: 'visual composition',
    patterns: [/\b(ui mock|mockup|visual design|layout|typography|color|spacing|theme|pixel|figma|polish)\b/i],
  },
  {
    capability: 'behavioral_ux',
    weight: 2,
    label: 'behavioral ux',
    patterns: [/\b(user flow|workflow|usability|interaction pattern|information architecture|onboarding|journey|ux)\b/i],
  },
  {
    capability: 'implementation',
    weight: 2,
    label: 'implementation',
    patterns: [/\b(implement|code|refactor|fix|bug|feature|module|function|endpoint|api)\b/i],
  },
];

const MATERIAL_MISMATCH_THRESHOLD = 0.35;
const DISPATCH_MODALITIES = new Set([
  'implementation',
  'verification',
  'design',
  'operations',
  'research',
  'documentation',
  'ux',
  'ui',
  'unknown',
]);
const REQUIRED_ARTIFACT_TYPES = new Set([
  'code_patch',
  'test_report',
  'screenshot',
  'design_spec',
  'release_note',
  'runbook',
  'analysis_note',
  'none',
]);
const FALLBACK_MODALITY = 'unknown';
const FALLBACK_ARTIFACT_TYPE = 'none';
const LEASE_DEFAULTS = {
  first_artifact_deadline_ms: 30 * 60 * 1000,
  heartbeat_interval_ms: 20_000,
  stale_after_ms: 120_000,
  max_auto_reassignments: 1,
};

function roleProfile(role) {
  return ROLE_CAPABILITY_MAP[role] || null;
}

function normalizeRoleList(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((r) => String(r ?? '').trim()).filter(Boolean))];
}

function inferTaskModality(step = {}) {
  const text = normalizedText(step).toLowerCase();
  if (/\b(implement|implementation|code|module|endpoint|api|function|bugfix|feature)\b/.test(text)) return 'implementation';
  if (/\b(test|verify|verification|regression|assert|qa)\b/.test(text)) return 'verification';
  if (/\b(architecture|design doc|adr|contract|schema)\b/.test(text)) return 'design';
  if (/\b(deploy|infra|ci|cd|pipeline|release|terraform|kubernetes|server)\b/.test(text)) return 'operations';
  if (/\b(research|investigate|analysis)\b/.test(text)) return 'research';
  if (/\b(readme|documentation|docs|guide|runbook)\b/.test(text)) return 'documentation';
  if (/\b(workflow|usability|journey|information architecture|ux)\b/.test(text)) return 'ux';
  if (/\b(mockup|visual|layout|typography|color|ui)\b/.test(text)) return 'ui';
  return FALLBACK_MODALITY;
}

function inferArtifactType(step = {}) {
  const text = normalizedText(step).toLowerCase();
  if (/\b(screenshot|snapshot|visual diff|image)\b/.test(text)) return 'screenshot';
  if (/\b(test report|test output|coverage|assertion)\b/.test(text)) return 'test_report';
  if (/\b(design spec|adr|design doc)\b/.test(text)) return 'design_spec';
  if (/\b(release note|changelog)\b/.test(text)) return 'release_note';
  if (/\b(runbook|playbook)\b/.test(text)) return 'runbook';
  if (/\b(analysis|findings|investigation)\b/.test(text)) return 'analysis_note';
  if (/\b(code|patch|refactor|endpoint|function|module)\b/.test(text)) return 'code_patch';
  return FALLBACK_ARTIFACT_TYPE;
}

export function normalizeDispatchPolicyInput(input = {}, step = {}) {
  const errors = [];
  const warnings = [];
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const modality = String(raw.task_modality ?? inferTaskModality(step)).trim().toLowerCase();
  const artifact = String(raw.required_artifact_type ?? inferArtifactType(step)).trim().toLowerCase();
  const preferred = String(raw.preferred_role ?? step.role ?? '').trim();
  const fallback = normalizeRoleList(raw.fallback_roles);
  if (!DISPATCH_MODALITIES.has(modality)) {
    errors.push({ code: 'dispatch_policy_invalid_task_modality', message: `unsupported task_modality "${modality}"` });
  }
  if (!REQUIRED_ARTIFACT_TYPES.has(artifact)) {
    errors.push({ code: 'dispatch_policy_invalid_required_artifact_type', message: `unsupported required_artifact_type "${artifact}"` });
  }
  if (!Array.isArray(raw.fallback_roles) && raw.fallback_roles != null) {
    warnings.push({ code: 'dispatch_policy_fallback_roles_coerced', message: 'fallback_roles must be an array; value ignored' });
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized: {
      task_modality: DISPATCH_MODALITIES.has(modality) ? modality : FALLBACK_MODALITY,
      required_artifact_type: REQUIRED_ARTIFACT_TYPES.has(artifact) ? artifact : FALLBACK_ARTIFACT_TYPE,
      preferred_role: preferred,
      fallback_roles: fallback,
    },
  };
}

export function normalizeLeasePolicyInput(input = {}) {
  const errors = [];
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const toInt = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  };
  const heartbeat = toInt(raw.heartbeat_interval_ms, LEASE_DEFAULTS.heartbeat_interval_ms, 1_000, 60_000);
  const stale = toInt(raw.stale_after_ms, Math.max(30_000, heartbeat * 3), 5_000, 24 * 60 * 60 * 1000);
  const firstArtifact = toInt(raw.first_artifact_deadline_ms, LEASE_DEFAULTS.first_artifact_deadline_ms, 5_000, 24 * 60 * 60 * 1000);
  const maxAuto = toInt(raw.max_auto_reassignments, LEASE_DEFAULTS.max_auto_reassignments, 0, 10);
  if (stale <= heartbeat) {
    errors.push({ code: 'lease_policy_invalid_stale_after', message: 'stale_after_ms must be greater than heartbeat_interval_ms' });
  }
  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      first_artifact_deadline_ms: firstArtifact,
      heartbeat_interval_ms: heartbeat,
      stale_after_ms: stale,
      max_auto_reassignments: maxAuto,
    },
  };
}

function normalizedText({ title = '', context = '', acceptance_criteria = '', tools = [] } = {}) {
  const toolText = Array.isArray(tools) ? tools.join(' ') : '';
  return `${title}\n${context}\n${acceptance_criteria}\n${toolText}`;
}

function baselineCapabilities(text) {
  const out = [];
  const add = (capability, weight, evidence) => {
    const existing = out.find((x) => x.capability === capability);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      if (evidence && !existing.evidence.includes(evidence)) existing.evidence.push(evidence);
      return;
    }
    out.push({ capability, weight, evidence: evidence ? [evidence] : [] });
  };
  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      if (!pattern.test(text)) continue;
      add(signal.capability, signal.weight, signal.label);
      break;
    }
  }
  if (!out.length) add('implementation', 1, 'default implementation baseline');
  return out;
}

function modalityCapabilities(task_modality) {
  switch (task_modality) {
    case 'implementation':
      return [{ capability: 'implementation', weight: 5, evidence: ['task modality: implementation'] }, { capability: 'verification', weight: 1, evidence: ['implementation quality gate'] }];
    case 'verification':
      return [{ capability: 'verification', weight: 5, evidence: ['task modality: verification'] }, { capability: 'deterministic_browser_automation', weight: 2, evidence: ['verification automation'] }];
    case 'design':
      return [{ capability: 'behavioral_ux', weight: 3, evidence: ['task modality: design'] }, { capability: 'visual_composition', weight: 2, evidence: ['design composition'] }];
    case 'operations':
      return [{ capability: 'server_lifecycle', weight: 4, evidence: ['task modality: operations'] }, { capability: 'build_deploy', weight: 4, evidence: ['operations rollout'] }];
    case 'research':
      return [{ capability: 'verification', weight: 2, evidence: ['task modality: research'] }, { capability: 'publishing', weight: 2, evidence: ['research output'] }];
    case 'documentation':
      return [{ capability: 'publishing', weight: 4, evidence: ['task modality: documentation'] }];
    case 'ux':
      return [{ capability: 'behavioral_ux', weight: 4, evidence: ['task modality: ux'] }];
    case 'ui':
      return [{ capability: 'visual_composition', weight: 4, evidence: ['task modality: ui'] }, { capability: 'screenshot_capture', weight: 1, evidence: ['ui validation artifacts'] }];
    default:
      return [];
  }
}

function artifactCapabilities(required_artifact_type) {
  switch (required_artifact_type) {
    case 'code_patch':
      return [{ capability: 'implementation', weight: 3, evidence: ['artifact type: code_patch'] }];
    case 'test_report':
      return [{ capability: 'verification', weight: 3, evidence: ['artifact type: test_report'] }];
    case 'screenshot':
      return [{ capability: 'screenshot_capture', weight: 3, evidence: ['artifact type: screenshot'] }];
    case 'design_spec':
      return [{ capability: 'behavioral_ux', weight: 2, evidence: ['artifact type: design_spec'] }, { capability: 'visual_composition', weight: 2, evidence: ['artifact type: design_spec'] }];
    case 'release_note':
      return [{ capability: 'publishing', weight: 3, evidence: ['artifact type: release_note'] }];
    case 'runbook':
      return [{ capability: 'publishing', weight: 2, evidence: ['artifact type: runbook'] }, { capability: 'server_lifecycle', weight: 2, evidence: ['artifact type: runbook'] }];
    case 'analysis_note':
      return [{ capability: 'verification', weight: 2, evidence: ['artifact type: analysis_note'] }];
    default:
      return [];
  }
}

export function deriveRequiredCapabilities(step = {}) {
  const normalizedPolicy = normalizeDispatchPolicyInput(step.dispatch_policy, step);
  const text = normalizedText(step);
  const merged = [];
  const add = (capability, weight, evidence = []) => {
    const existing = merged.find((item) => item.capability === capability);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      for (const item of evidence) if (item && !existing.evidence.includes(item)) existing.evidence.push(item);
      return;
    }
    merged.push({ capability, weight, evidence: [...evidence] });
  };
  for (const entry of modalityCapabilities(normalizedPolicy.normalized.task_modality)) {
    add(entry.capability, entry.weight, entry.evidence);
  }
  for (const entry of artifactCapabilities(normalizedPolicy.normalized.required_artifact_type)) {
    add(entry.capability, entry.weight, entry.evidence);
  }
  for (const entry of baselineCapabilities(text)) {
    add(entry.capability, Math.min(entry.weight, 2), entry.evidence);
  }
  if (!merged.length) add('implementation', 1, ['default implementation baseline']);
  const required = merged.sort((a, b) =>
    b.weight - a.weight || a.capability.localeCompare(b.capability));
  return {
    required_capabilities: required,
    dispatch_policy: normalizedPolicy.normalized,
    dispatch_policy_validation: {
      ok: normalizedPolicy.ok,
      errors: normalizedPolicy.errors,
      warnings: normalizedPolicy.warnings,
    },
    analyzed_text: {
      title: String(step.title ?? ''),
      context: String(step.context ?? ''),
      acceptance_criteria: String(step.acceptance_criteria ?? ''),
      tools: Array.isArray(step.tools) ? step.tools.map((x) => String(x)) : [],
    },
  };
}

function scoreRole(role, requiredCapabilities) {
  const profile = roleProfile(role);
  if (!profile) {
    return {
      role,
      score: 0,
      normalized_score: 0,
      known_role: false,
      matched: [],
      missing: requiredCapabilities.map((c) => c.capability),
      rationale: `No capability profile exists for role "${role}".`,
    };
  }
  let totalWeight = 0;
  let weightedScore = 0;
  const matched = [];
  const missing = [];
  for (const req of requiredCapabilities) {
    const depth = Number(profile[req.capability] || 0);
    totalWeight += req.weight;
    weightedScore += req.weight * (depth / 3);
    if (depth > 0) matched.push({ capability: req.capability, depth, weight: req.weight });
    else missing.push(req.capability);
  }
  const normalized = totalWeight ? Number((weightedScore / totalWeight).toFixed(4)) : 0;
  return {
    role,
    score: Number(weightedScore.toFixed(4)),
    normalized_score: normalized,
    known_role: true,
    matched,
    missing,
    rationale: matched.length
      ? `Matches ${matched.length}/${requiredCapabilities.length} required capabilities.`
      : 'No required capabilities matched.',
  };
}

function deterministicSort(scores) {
  return [...scores].sort((a, b) =>
    b.normalized_score - a.normalized_score
    || b.score - a.score
    || a.role.localeCompare(b.role));
}

function describeAlternatives(scores, selectedRole, limit = 3) {
  return scores
    .filter((x) => x.role !== selectedRole)
    .slice(0, Math.max(0, limit))
    .map((x) => ({
      role: x.role,
      normalized_score: x.normalized_score,
      rationale: x.rationale,
      missing: x.missing,
    }));
}

export function evaluateDispatchPolicy({
  step = {},
  explicit_role = '',
  candidate_roles = DEFAULT_STAFF_ROLES,
  resolved_model = '',
  available_models = [],
  override_reason = '',
  dispatch_policy = null,
} = {}) {
  const explicitRole = String(explicit_role ?? '').trim();
  const policyInput = normalizeDispatchPolicyInput(dispatch_policy ?? step.dispatch_policy, {
    ...step,
    role: explicitRole || step.role || '',
  });
  const { required_capabilities } = deriveRequiredCapabilities({
    ...step,
    dispatch_policy: policyInput.normalized,
  });
  const candidates = [...new Set(candidate_roles.map((x) => String(x).trim()).filter(Boolean))];
  const scores = deterministicSort(candidates.map((role) => scoreRole(role, required_capabilities)));
  const best = scores[0] || null;
  const selected_role = explicitRole || (best?.role || '');
  const selectedScore = scores.find((x) => x.role === selected_role)
    || scoreRole(selected_role, required_capabilities);
  const bestScore = best?.normalized_score ?? 0;
  const selectedNormalized = selectedScore.normalized_score ?? 0;
  const knownSelected = !!selectedScore.known_role;
  const scoreGap = Number((bestScore - selectedNormalized).toFixed(4));
  const materialMismatch = !!explicitRole
    && best
    && best.role !== explicitRole
    && knownSelected
    && scoreGap >= MATERIAL_MISMATCH_THRESHOLD;
  const warnings = [];
  const reasons = [];
  if (explicitRole && !knownSelected) {
    reasons.push({
      code: 'dispatch_role_unknown',
      severity: 'error',
      message: `explicit role "${explicitRole}" has no documented capability profile`,
    });
  }
  if (materialMismatch) {
    reasons.push({
      code: 'dispatch_role_material_mismatch',
      severity: 'warn',
      message: `explicit role "${explicitRole}" materially mismatches derived capabilities; best fit is "${best.role}"`,
      details: { explicit_role: explicitRole, best_role: best?.role ?? '', score_gap: scoreGap },
    });
  }
  const model = String(resolved_model ?? '').trim();
  if (model && Array.isArray(available_models) && available_models.length && !available_models.includes(model)) {
    reasons.push({
      code: 'dispatch_model_unavailable',
      severity: 'error',
      message: `resolved model "${model}" is not in the available model catalog`,
      details: { resolved_model: model },
    });
  }
  if (policyInput.errors.length) {
    for (const err of policyInput.errors) reasons.push({ code: err.code, severity: 'error', message: err.message });
  }
  if (materialMismatch && !String(override_reason ?? '').trim()) {
    reasons.push({
      code: 'dispatch_override_reason_required',
      severity: 'error',
      message: 'material role mismatch requires an explicit override reason',
    });
  }
  for (const reason of reasons) {
    warnings.push(reason.message);
  }
  for (const warning of policyInput.warnings) {
    warnings.push(warning.message);
  }

  return {
    version: 'dispatch-policy-v2',
    dispatch_policy: policyInput.normalized,
    dispatch_policy_valid: policyInput.ok,
    dispatch_policy_errors: policyInput.errors,
    explicit_role: explicitRole,
    selected_role,
    selection_mode: explicitRole ? 'explicit' : 'automatic',
    automatic_selection_allowed: !explicitRole,
    required_capabilities,
    selected_score: {
      role: selectedScore.role,
      normalized_score: selectedScore.normalized_score,
      matched: selectedScore.matched,
      missing: selectedScore.missing,
      rationale: selectedScore.rationale,
      known_role: selectedScore.known_role,
    },
    best_match: best ? {
      role: best.role,
      normalized_score: best.normalized_score,
      rationale: best.rationale,
    } : null,
    alternatives: describeAlternatives(scores, selected_role),
    warnings,
    reason_codes: [...new Set(reasons.map((r) => r.code))],
    reasons,
    material_mismatch: materialMismatch,
    requires_override_reason: materialMismatch,
    override_reason: String(override_reason ?? '').trim(),
    available_models_checked: Array.isArray(available_models) ? available_models.length : 0,
  };
}
