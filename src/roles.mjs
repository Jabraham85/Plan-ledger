// roles.mjs — role-map resolver: turns a step's abstract `role` into a concrete
// dispatch target (agent + charter + model) through user-editable JSON config.
// Design: docs/ROLE_MAP_DESIGN.md. No deps beyond node:fs/os/path.
//
// Layers (first that defines the role key wins for the WHOLE entry):
//   1. <cwd>/.plan-roles.json           `roles`            (repo-local, git-versioned)
//   2. user file `projects.<name>.roles`                    (per plan-ledger project)
//   3. user file `roles`                                    (global)
//   4. default charter chain: <cwd>/.claude/agents/<role>.md, ~/.claude/agents/<role>.md
// User file: ~/.claude/plan-roles.json, replaced wholesale by $PLAN_LEDGER_ROLES
// (same test-isolation pattern as $PLAN_LEDGER_DB). Absent files = today's behavior.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_STAFF_ROLES = [
  'architect', 'implementer', 'test-engineer', 'debugger', 'refactor-surgeon',
  'build-devops', 'perf-engineer', 'researcher', 'tech-writer', 'ui-designer',
  'ux-architect', 'game-designer',
];

// Account-scoped Cursor models are discovered with `agent --list-models` when
// that CLI is installed. This fallback mirrors the model catalog enabled in the
// current Cursor environment and keeps the Staff page useful offline.
export const CURSOR_MODEL_FALLBACK = [
  'claude-4-sonnet',
  'claude-4.5-haiku-thinking',
  'claude-opus-4-7-thinking-xhigh',
  'claude-opus-4-8-thinking-high',
  'claude-sonnet-5-thinking-high',
  'composer-2.5-fast',
  'gemini-2.5-flash',
  'gpt-5-mini',
  'gpt-5.3-codex',
  'gpt-5.4-nano-medium',
  'gpt-5.6-sol-medium',
  'gpt-5.6-terra-medium',
];

export const RECOMMENDED_STAFF_MODELS = {
  architect: 'claude-opus-4-8-thinking-high',
  implementer: 'gpt-5.3-codex',
  'test-engineer': 'gpt-5.3-codex',
  debugger: 'gpt-5.3-codex',
  'refactor-surgeon': 'gpt-5.3-codex',
  'build-devops': 'composer-2.5-fast',
  'perf-engineer': 'claude-sonnet-5-thinking-high',
  researcher: 'gpt-5.6-terra-medium',
  'tech-writer': 'gpt-5.4-nano-medium',
  'ui-designer': 'claude-sonnet-5-thinking-high',
  'ux-architect': 'claude-sonnet-5-thinking-high',
  'game-designer': 'claude-opus-4-8-thinking-high',
};

export const DEFAULT_ROLE_CONTEXT = {
  architect: 'Design before coding. Define boundaries, contracts, trade-offs, migration safety, and an ordered implementation path. Do not implement unless explicitly asked.',
  implementer: 'Implement an agreed design with focused, production-ready changes. Preserve existing behavior outside scope and verify the result.',
  'test-engineer': 'Build deterministic tests, fixtures, and assertions around behavior and edge cases. Distinguish product defects from test-harness defects.',
  debugger: 'Reproduce first, isolate the root cause with evidence, make the smallest safe fix, and add a red-then-green regression test.',
  'refactor-surgeon': 'Restructure without behavior changes. Keep tests green, reduce duplication and complexity, and avoid unrelated feature work.',
  'build-devops': 'Own build, CI, packaging, deployment, and developer tooling. Make automation repeatable, observable, and safe to retry.',
  'perf-engineer': 'Profile before optimizing. Change measured bottlenecks only and report reproducible before/after evidence.',
  researcher: 'Research across multiple credible sources. Cite findings, separate fact from inference, and label uncertainty. Do not implement code.',
  'tech-writer': 'Write concise, accurate documentation. Verify every command, path, and symbol against the product or repository.',
  'ui-designer': 'Own visual hierarchy, layout, typography, color, and interaction polish. Produce implementable visual guidance.',
  'ux-architect': 'Own flows, information architecture, states, navigation, inputs, and usability. Separate behavioral UX from visual styling.',
  'game-designer': 'Design mechanics, progression, economy, and balance as testable, numbers-first systems mapped to data-driven implementation.',
};

export function userRolesPath() {
  return process.env.PLAN_LEDGER_ROLES || join(homedir(), '.claude', 'plan-roles.json');
}

export function listCursorModels() {
  const envModels = String(process.env.PLAN_LEDGER_CURSOR_MODELS ?? '')
    .split(',').map((model) => model.trim()).filter(Boolean);
  if (envModels.length) return { models: [...new Set(envModels)].sort(), source: 'environment' };

  try {
    const installedAgent = process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'cursor-agent', 'agent.cmd') : null;
    const useInstalledAgent = !!installedAgent && existsSync(installedAgent);
    const command = useInstalledAgent ? `"${installedAgent}" --list-models` : 'agent --list-models';
    const result = spawnSync(command, {
      encoding: 'utf8', timeout: 5000, windowsHide: true, shell: true,
    });
    if (!result.error && result.status === 0) {
      const raw = String(result.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
      let models = [];
      try {
        const parsed = JSON.parse(raw);
        const values = Array.isArray(parsed) ? parsed : (parsed.models ?? []);
        models = values.map((value) => typeof value === 'string' ? value : (value.id ?? value.model ?? ''));
      } catch {
        models = raw.split(/\r?\n/)
          .map((line) => line.trim().match(/^([a-z0-9][a-z0-9._:[\]=-]+)\s+-\s+/i)?.[1] ?? '')
          .filter(Boolean);
      }
      models = [...new Set(models.filter(Boolean))].sort();
      if (models.length) return { models, source: 'cursor-account' };
    }
  } catch (e) {
    console.warn(`[Staff:models] Cursor model discovery failed: ${e.message}`);
  }
  return { models: CURSOR_MODEL_FALLBACK, source: 'bundled-fallback' };
}

/** Read + parse one map file. Missing file → {}. Malformed JSON → one console.warn
 *  (stderr — never stdout, the MCP transport lives there) and {}; dispatch must
 *  never crash on config. Re-read on every resolution — sub-KB file, no caching. */
export function loadRoleMap(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return {}; }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.warn(`plan-ledger: malformed role map at ${path} — layer skipped (${e.message})`);
    return {};
  }
}

function globalRoleDetails(role, doc = loadRoleMap(userRolesPath())) {
  const entry = normalizeEntry(doc.roles?.[role]);
  const declared = userRolesPath();
  const fallbackPath = join(homedir(), '.claude', 'agents', `${role}.md`);
  const charter = expandCharter(entry.charter, declared) ?? (existsSync(fallbackPath) ? fallbackPath : null);
  let charter_context = '';
  if (charter) {
    try { charter_context = readFileSync(charter, 'utf8'); }
    catch (e) { console.warn(`[Staff:context] cannot read ${charter}: ${e.message}`); }
  }
  return {
    global_context: typeof entry.context === 'string' && entry.context.trim()
      ? entry.context.trim() : (DEFAULT_ROLE_CONTEXT[role] ?? ''),
    global_charter: charter,
    charter_context,
  };
}

// Project-wide staff is stored in the existing user role map so every plan,
// MCP dispatch, runner, and board view resolves the same role → model choice.
// Reads include the standard roster plus custom project/global roles.
export function listProjectStaff(projectName) {
  projectName = String(projectName ?? '').trim();
  if (!projectName) throw new Error('project name is required');
  const path = userRolesPath();
  const doc = loadRoleMap(path);
  const projectRoles = doc.projects?.[projectName]?.roles;
  const globalRoles = doc.roles;
  const names = new Set(DEFAULT_STAFF_ROLES);
  if (globalRoles && typeof globalRoles === 'object') Object.keys(globalRoles).forEach((role) => names.add(role));
  if (projectRoles && typeof projectRoles === 'object') Object.keys(projectRoles).forEach((role) => names.add(role));
  const catalog = listCursorModels();

  return {
    project_name: projectName,
    models: catalog.models,
    models_source: catalog.source,
    roles: [...names].sort().map((role) => {
      const configured = !!projectRoles && Object.prototype.hasOwnProperty.call(projectRoles, role);
      const resolved = resolveRole(role, { cwd: null, projectName });
      return {
        role,
        model: resolved.mode === 'dispatch' ? (resolved.model ?? '') : '',
        recommended_model: RECOMMENDED_STAFF_MODELS[role] ?? '',
        configured,
        source: resolved.mode === 'dispatch' ? resolved.source : resolved.reason,
        ...globalRoleDetails(role, doc),
      };
    }),
  };
}

function readWritableRoleMap(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('root must be a JSON object');
    return doc;
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    console.error(`[Staff:save] cannot read ${path}: ${e.message}`);
    throw new Error(`cannot update staff: role map is invalid (${e.message})`);
  }
}

function writeRoleMap(path, doc, operation) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
    console.log(`[Staff:${operation}] saved ${path}`);
  } catch (e) {
    try { unlinkSync(temp); } catch {}
    console.error(`[Staff:${operation}] failed: ${e.message}`);
    throw new Error(`cannot save staff assignment (${e.message})`);
  }
}

function projectRolesIn(doc, projectName) {
  doc.projects = doc.projects && typeof doc.projects === 'object' && !Array.isArray(doc.projects)
    ? doc.projects : {};
  const project = doc.projects[projectName] && typeof doc.projects[projectName] === 'object'
    ? doc.projects[projectName] : {};
  project.roles = project.roles && typeof project.roles === 'object' && !Array.isArray(project.roles)
    ? project.roles : {};
  doc.projects[projectName] = project;
  return project.roles;
}

export function applyRecommendedStaff(projectName) {
  projectName = String(projectName ?? '').trim();
  if (!projectName) throw new Error('project name is required');
  const path = userRolesPath();
  const doc = readWritableRoleMap(path);
  const roles = projectRolesIn(doc, projectName);
  for (const [role, model] of Object.entries(RECOMMENDED_STAFF_MODELS)) {
    if (!Object.prototype.hasOwnProperty.call(roles, role)) roles[role] = { model };
  }
  writeRoleMap(path, doc, 'defaults');
  return listProjectStaff(projectName);
}

// Write one project-scoped role/model assignment atomically. An empty model
// deliberately stores {}: the role remains project staff and uses the client's
// default model. remove=true deletes only this project's override.
export function setProjectStaffRole(projectName, { role, model = '', remove = false } = {}) {
  projectName = String(projectName ?? '').trim();
  role = String(role ?? '').trim();
  model = String(model ?? '').trim();
  if (!projectName) throw new Error('project name is required');
  if (!role) throw new Error('role is required');
  if (['__proto__', 'prototype', 'constructor'].includes(projectName)
      || ['__proto__', 'prototype', 'constructor'].includes(role)) {
    throw new Error('reserved project or role name');
  }

  const path = userRolesPath();
  const doc = readWritableRoleMap(path);
  const roles = projectRolesIn(doc, projectName);
  if (remove) delete roles[role];
  else {
    const current = normalizeEntry(roles[role]);
    delete current.disabled;
    if (model) current.model = model;
    else delete current.model;
    roles[role] = current;
  }
  writeRoleMap(path, doc, 'save');
  return listProjectStaff(projectName);
}

// Entry value forms: "agent-name" → {agent}; false → {disabled:true}; object → as-is
// ({} is legal: "defaults, but pin this role as known"). Anything else → {}.
function normalizeEntry(v) {
  if (typeof v === 'string') return { agent: v };
  if (v === false) return { disabled: true };
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  return {};
}

// `~/` expands to the home dir; relative paths resolve against the directory of
// the file that declared the entry. A declared-but-missing charter falls back to
// the default chain (returns null here).
function expandCharter(p, declaredIn) {
  if (!p || typeof p !== 'string') return null;
  let abs = p === '~' || p.startsWith('~/') || p.startsWith('~\\')
    ? join(homedir(), p.slice(1)) : p;
  if (!isAbsolute(abs)) abs = resolve(declaredIn ? dirname(declaredIn) : process.cwd(), abs);
  return existsSync(abs) ? abs : null;
}

// Default charter chain — project shadows user, matching Claude Code's own
// .claude/agents resolution (absorbs "Option C", ROLE_MAP_DESIGN.md §5.3).
function defaultCharter(role, cwd) {
  for (const p of [cwd ? join(cwd, '.claude', 'agents', `${role}.md`) : null,
                   join(homedir(), '.claude', 'agents', `${role}.md`)]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve a step's role to a dispatch decision.
 * @param {string} role  step.role ('' allowed)
 * @param {object} opts
 * @param {string|null} opts.cwd          repo root for the repo-local layer; null = skip that layer
 * @param {string|null} opts.projectName  plan-ledger project name for the user file's projects section
 * @returns {{ mode:'dispatch', role:string, agent:string, charter:string|null,
 *             model:string|null, source:'project-file'|'user-project'|'user'|'default' }
 *         | { mode:'orchestrator', role:string, reason:'untagged'|'disabled'|'unknown' }}
 */
export function resolveRole(role, { cwd = null, projectName = null } = {}) {
  role = String(role ?? '').trim();
  if (!role) return { mode: 'orchestrator', role, reason: 'untagged' };

  const userPath = userRolesPath();
  const user = loadRoleMap(userPath);
  const repoPath = cwd ? join(cwd, '.plan-roles.json') : null;
  const repo = repoPath ? loadRoleMap(repoPath) : {};

  const layers = [
    { roles: repo.roles, source: 'project-file', file: repoPath },
    { roles: projectName ? user.projects?.[projectName]?.roles : null, source: 'user-project', file: userPath },
    { roles: user.roles, source: 'user', file: userPath },
  ];
  let entry = null, source = 'default', declaredIn = null;
  for (const l of layers) {
    if (l.roles && typeof l.roles === 'object' && Object.prototype.hasOwnProperty.call(l.roles, role)) {
      entry = normalizeEntry(l.roles[role]);
      source = l.source;
      declaredIn = l.file;
      break;
    }
  }

  if (entry?.disabled) return { mode: 'orchestrator', role, reason: 'disabled' };
  const agent = typeof entry?.agent === 'string' && entry.agent ? entry.agent : role;
  const charter = expandCharter(entry?.charter, declaredIn) ?? defaultCharter(role, cwd);
  const global = globalRoleDetails(role, user);
  // No map entry, global staff context, or charter file anywhere → not a roster role.
  if (!entry && !charter && !global.global_context) return { mode: 'orchestrator', role, reason: 'unknown' };
  return {
    mode: 'dispatch', role, agent, charter,
    model: typeof entry?.model === 'string' ? entry.model : null,
    global_context: global.global_context,
    source,
  };
}
