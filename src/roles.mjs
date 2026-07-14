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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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

  const userPath = process.env.PLAN_LEDGER_ROLES || join(homedir(), '.claude', 'plan-roles.json');
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
  // No map entry AND no charter file anywhere → not a roster role at all.
  if (!entry && !charter) return { mode: 'orchestrator', role, reason: 'unknown' };
  return { mode: 'dispatch', role, agent, charter, model: typeof entry?.model === 'string' ? entry.model : null, source };
}
