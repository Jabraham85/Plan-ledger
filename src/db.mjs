// db.mjs — SQLite-backed store for plan-ledger.
// Uses Node's built-in node:sqlite (no native deps). Synchronous API.
//
// Progressive disclosure is enforced here, not in the caller:
//   level 0  listPlans()      -> title + keywords + status         (cheap index)
//   level 1  openPlan(id)     -> plan detail + ordered step index   (titles/status only)
//   level 2  getStep(id)      -> full step context + attempts + links
// Keeping the levels separate is the whole point: the agent pulls only
// what the current step needs and lets everything else stay on disk.

import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { DEFAULT_STAFF_ROLES, listCursorModels, resolveRole } from './roles.mjs';
import {
  evaluateDispatchPolicy,
  normalizeDispatchPolicyInput,
  normalizeLeasePolicyInput,
} from './dispatch-policy.mjs';
import { validateCompletionPayload } from './completion-validator.mjs';

// The ONE default DB location, shared by every entry point (MCP server, board,
// packaged exe, runner, scripts). $PLAN_LEDGER_DB overrides; otherwise the
// homedir install convention — deliberately NOT import.meta-relative, which is
// undefined inside the packaged SEA exe (see context.mjs REPO note).
export function defaultDbPath() {
  return process.env.PLAN_LEDGER_DB
    || join(homedir(), 'Documents', 'plan-ledger', 'data', 'plan-ledger.db');
}

// Canonical file identity used by board reuse checks. resolve() normalizes path
// syntax, realpath resolves symlinks when the file exists, and Windows folds
// case so equivalent paths compare equal.
export function canonicalDbIdentity(dbPath = defaultDbPath()) {
  const resolved = resolve(String(dbPath));
  let canonical = resolved;
  try {
    canonical = typeof realpathSync.native === 'function'
      ? realpathSync.native(resolved)
      : realpathSync(resolved);
  } catch {
    // File may not exist yet; resolved absolute path is still stable.
  }
  const slashed = canonical.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

// SCHEMA conventions (audit-enforced): new columns must be added with a
// NOT NULL DEFAULT so migrations backfill old rows without a rewrite; and never
// return a raw `SELECT *` row to a tool caller — shape an explicit object (drop
// internal columns, keep the payload stable) so schema growth can't leak fields.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'active',  -- active | archived
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS plans (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title            TEXT    NOT NULL,
  keywords         TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
  summary          TEXT    NOT NULL DEFAULT '',      -- one-paragraph "what/why", shown on open
  status           TEXT    NOT NULL DEFAULT 'draft', -- draft | active | done | abandoned | blocked
  completion_lock  TEXT    NOT NULL DEFAULT '',      -- '' if organic; audit reason when done was forced
  terminal_state_reason TEXT NOT NULL DEFAULT '',    -- reconcile_done | reconcile_partial_due_to_deferred_gate | reconcile_blocked | reconcile_noop
  terminalized_at  TEXT    NOT NULL DEFAULT '',      -- when the plan auto-terminalized to done
  state_integrity_version INTEGER NOT NULL DEFAULT 1, -- additive reconciliation schema marker
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id                  INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  idx                      INTEGER NOT NULL,          -- 1-based order within the plan
  title                    TEXT    NOT NULL,
  status                   TEXT    NOT NULL DEFAULT 'pending', -- pending | in_progress | done | failed | blocked | skipped
  context                  TEXT    NOT NULL DEFAULT '',        -- everything needed to do THIS step
  tools                    TEXT    NOT NULL DEFAULT '[]',      -- JSON array of tool/MCP names this step uses
  role                     TEXT    NOT NULL DEFAULT '',        -- subagent role that executes this step (e.g. implementer)
  acceptance_criteria      TEXT    NOT NULL DEFAULT '',        -- how we know the step passed
  carry_forward            TEXT    NOT NULL DEFAULT '',        -- notes written FOR this step by the previous one
  layman                   TEXT    NOT NULL DEFAULT '',        -- plain-English "what was done + thoughts" (distinct from what_tried)
  verification_disposition TEXT    NOT NULL DEFAULT '',        -- '' | verified | not_applicable | deferred | blocked | legacy_unknown
  disposition_reason       TEXT    NOT NULL DEFAULT '',        -- human/audited justification for the disposition
  disposition_at           TEXT    NOT NULL DEFAULT '',        -- when the disposition was recorded
  completion_payload_json  TEXT    NOT NULL DEFAULT '',        -- validated completion_payload_v2 JSON
  completion_validated_at  TEXT    NOT NULL DEFAULT '',        -- when completion payload was validated
  auto_reassignment_count  INTEGER NOT NULL DEFAULT 0,         -- successful C3 auto-reassignment count
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_plan ON steps(plan_id, idx);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id       INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  what_tried    TEXT    NOT NULL,
  result        TEXT    NOT NULL DEFAULT '',
  verdict       TEXT    NOT NULL DEFAULT 'fail',  -- pass | fail | partial
  role          TEXT    NOT NULL DEFAULT '',      -- subagent role that executed the attempt
  review_rounds INTEGER NOT NULL DEFAULT 0,       -- orchestrator send-back rounds before acceptance
  executor      TEXT    NOT NULL DEFAULT '',      -- who drove it (e.g. runner-mcp | runner-inject | orchestrator)
  agent         TEXT    NOT NULL DEFAULT '',      -- resolved concrete agent (e.g. general-purpose, gpt-5.3-codex)
  model         TEXT    NOT NULL DEFAULT '',      -- concrete model that actually served the call
  model_source  TEXT    NOT NULL DEFAULT '',      -- provenance: role-map | runner-cli | telemetry | self-report | user | unknown
  session_ref   TEXT    NOT NULL DEFAULT '',      -- optional link to a chat transcript / run id
  validation_status TEXT NOT NULL DEFAULT 'legacy_unknown', -- pass | fail | legacy_unknown
  validation_errors_json TEXT NOT NULL DEFAULT '', -- deterministic validator errors (JSON array)
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_step ON attempts(step_id);

-- Append-only history of a step's dispatch assignment (role + resolved agent/model/charter).
-- The FIRST row per step captures the plan-time snapshot when the plan went active (or when
-- the step was added to an already-active plan). Later rows record reassignments — each
-- carries the reason for the change and who made it (see docs/ROLES.md).
CREATE TABLE IF NOT EXISTS step_assignments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id            INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  role               TEXT    NOT NULL DEFAULT '',
  agent              TEXT    NOT NULL DEFAULT '',
  model              TEXT    NOT NULL DEFAULT '',
  charter            TEXT    NOT NULL DEFAULT '',
  resolution_source  TEXT    NOT NULL DEFAULT '',  -- project-file | user-project | user | default | untagged | disabled | unknown
  context_snapshot   TEXT    NOT NULL DEFAULT '',
  dispatch_policy_json TEXT  NOT NULL DEFAULT '',  -- normalized dispatch policy snapshot
  reason             TEXT    NOT NULL DEFAULT '',  -- '' for the initial snapshot; required for later revisions
  assigned_by        TEXT    NOT NULL DEFAULT '',  -- '' | user | orchestrator | runner | plan-activation
  revision           INTEGER NOT NULL DEFAULT 1,   -- 1-based; contiguous per step
  created_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_step_assignments_step ON step_assignments(step_id, revision);

-- Append-only review/feedback thread on a step — distinct from attempts (work
-- records) and links (graph edges). The back-and-forth discussion, not a log.
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id     INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  author      TEXT    NOT NULL DEFAULT '',
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_step ON notes(step_id);

-- A directed edge: a step "builds_on"/"references" another plan or step.
-- Lets the agent walk back to what a step is built upon without loading history.
CREATE TABLE IF NOT EXISTS links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_step_id INTEGER REFERENCES steps(id) ON DELETE CASCADE,
  to_plan_id   INTEGER REFERENCES plans(id) ON DELETE CASCADE,
  to_step_id   INTEGER REFERENCES steps(id) ON DELETE CASCADE,
  relation     TEXT    NOT NULL DEFAULT 'references', -- references | builds_on | blocks | supersedes
  note         TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_step_id);

-- Cited files for a step/plan: surfaced (path + role + note) but NOT read until the
-- agent expands one. Progressive disclosure for files — always known, loaded on demand.
CREATE TABLE IF NOT EXISTS file_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id     INTEGER REFERENCES steps(id) ON DELETE CASCADE,  -- NULL = plan-level
  path        TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'reference',  -- primary | dependency | related | reference
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filerefs_step ON file_refs(step_id);
CREATE INDEX IF NOT EXISTS idx_filerefs_plan ON file_refs(plan_id);

-- Reusable rules / tool references the user toggles on/off. Enabled ones get
-- folded into the copy-context blob so guidance never "sticks too long" in a chat.
CREATE TABLE IF NOT EXISTS refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL DEFAULT 'rule',  -- rule | tool
  name        TEXT    NOT NULL,
  body        TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,        -- 0/1
  plan_id     INTEGER REFERENCES plans(id) ON DELETE CASCADE,    -- set = plan-scoped
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE, -- set (plan_id NULL) = project-scoped; both NULL = global
  keywords    TEXT    NOT NULL DEFAULT '[]',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_plan ON refs(plan_id);

-- Code knowledge graph, scoped per plan. Absorbs a graphify (NetworkX node-link)
-- graph so steps can be grounded in a compact code subgraph instead of raw files.
CREATE TABLE IF NOT EXISTS graph_nodes (
  plan_id         INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  node_id         TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  file_type       TEXT,
  source_file     TEXT,
  source_location TEXT,
  community       INTEGER,
  kind            TEXT,
  degree          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_gnodes_plan ON graph_nodes(plan_id);
CREATE INDEX IF NOT EXISTS idx_gnodes_deg ON graph_nodes(plan_id, degree DESC);

CREATE TABLE IF NOT EXISTS graph_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  src         TEXT    NOT NULL,
  tgt         TEXT    NOT NULL,
  relation    TEXT    NOT NULL DEFAULT 'related',
  confidence  TEXT    NOT NULL DEFAULT 'EXTRACTED',  -- EXTRACTED | INFERRED | AMBIGUOUS
  weight      REAL    NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_gedges_plan ON graph_edges(plan_id);

-- Prior-plan provenance: which already-existing plans a NEW draft consulted during
-- its planning preflight (cross-project keyword discovery). Append-only per draft,
-- deduped per (draft, consulted) pair. status_at_consult freezes the prior plan's
-- status at the moment it was consulted so "was completed evidence" survives even if
-- the prior plan later changes; relation labels completed vs related-active matches.
CREATE TABLE IF NOT EXISTS plan_consultations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id           INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,      -- the draft that consulted
  consulted_plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,             -- a prior plan it consulted
  status_at_consult TEXT    NOT NULL DEFAULT '',    -- prior plan's status when consulted (done | active | ...)
  relation          TEXT    NOT NULL DEFAULT 'prior-art', -- completed | related-active | prior-art
  keywords          TEXT    NOT NULL DEFAULT '[]',  -- JSON array: the bounded keyword set that surfaced it
  note              TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL,
  UNIQUE(plan_id, consulted_plan_id)
);
CREATE INDEX IF NOT EXISTS idx_consult_plan ON plan_consultations(plan_id);

-- Durable live execution activity keyed by plan/step/run/session. This tracks
-- operational telemetry (who/what/when/progress/artifacts/blockers/verification)
-- and explicitly excludes chain-of-thought text.
CREATE TABLE IF NOT EXISTS activity_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id             INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id             INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  run_id              TEXT    NOT NULL DEFAULT '',
  session_ref         TEXT    NOT NULL DEFAULT '',
  role                TEXT    NOT NULL DEFAULT '',
  agent               TEXT    NOT NULL DEFAULT '',
  requested_model     TEXT    NOT NULL DEFAULT '',
  actual_model        TEXT    NOT NULL DEFAULT '',
  model_source        TEXT    NOT NULL DEFAULT '',
  phase               TEXT    NOT NULL DEFAULT '',
  action_summary      TEXT    NOT NULL DEFAULT '',
  command_summary     TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL DEFAULT 'in_progress', -- queued | in_progress | blocked | completed | failed | cancelled
  outcome             TEXT    NOT NULL DEFAULT '',            -- success | failed | partial | blocked | cancelled | unknown
  verification_state  TEXT    NOT NULL DEFAULT 'pending',     -- pending | running | passed | failed | skipped | not_applicable
  blocker             TEXT    NOT NULL DEFAULT '',
  progress_completed  INTEGER NOT NULL DEFAULT 0,
  progress_total      INTEGER NOT NULL DEFAULT 0,
  file_count          INTEGER NOT NULL DEFAULT 0,
  artifact_count      INTEGER NOT NULL DEFAULT 0,
  recent_artifacts    TEXT    NOT NULL DEFAULT '[]',          -- compact JSON array of recent artifacts
  metadata            TEXT    NOT NULL DEFAULT '{}',          -- compact JSON object (bounded)
  started_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  ended_at            TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_key ON activity_runs(plan_id, step_id, run_id, session_ref);
CREATE INDEX IF NOT EXISTS idx_activity_updated ON activity_runs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_step_started ON activity_runs(step_id, started_at DESC);

-- Append-only activity timeline / terminal stream. Timeline events can be
-- compacted; terminal events are preserved.
CREATE TABLE IF NOT EXISTS activity_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id         INTEGER NOT NULL REFERENCES activity_runs(id) ON DELETE CASCADE,
  event_type          TEXT    NOT NULL DEFAULT 'timeline', -- timeline | terminal | lifecycle markers
  step_id             INTEGER NOT NULL DEFAULT 0 REFERENCES steps(id) ON DELETE CASCADE,
  assignment_id       INTEGER REFERENCES step_assignments(id) ON DELETE SET NULL,
  assignment_missing_reason TEXT NOT NULL DEFAULT '',
  event_timestamp     TEXT    NOT NULL DEFAULT '',
  phase               TEXT    NOT NULL DEFAULT '',
  summary             TEXT    NOT NULL DEFAULT '',
  command_summary     TEXT    NOT NULL DEFAULT '',
  metadata            TEXT    NOT NULL DEFAULT '{}',
  created_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_events_activity ON activity_events(activity_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_events_type ON activity_events(activity_id, event_type, id);

-- Execution leases: the single lifecycle primitive tying a claimed step to a
-- concrete executor + activity run + heartbeat + deadline + terminal outcome.
-- One OPEN lease per step at a time (partial unique index below). Runners,
-- MCP interactive paths, board writes, and the CLI all funnel through the
-- same lease API so telemetry, deadlines, and terminal closure are unavoidable.
CREATE TABLE IF NOT EXISTS execution_leases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id           INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id           INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  activity_id       INTEGER REFERENCES activity_runs(id) ON DELETE SET NULL,
  executor          TEXT    NOT NULL DEFAULT '',        -- e.g. runner-mcp | runner-inject | cursor-interactive | ci
  run_id            TEXT    NOT NULL DEFAULT '',        -- correlates with activity_runs.run_id
  session_ref       TEXT    NOT NULL DEFAULT '',
  role              TEXT    NOT NULL DEFAULT '',
  agent             TEXT    NOT NULL DEFAULT '',
  requested_model   TEXT    NOT NULL DEFAULT '',
  actual_model      TEXT    NOT NULL DEFAULT '',
  model_source      TEXT    NOT NULL DEFAULT '',
  child_pid         INTEGER,                            -- OS pid when supervised locally; null for external sessions
  claimed_at        TEXT    NOT NULL,
  first_artifact_deadline_at TEXT NOT NULL DEFAULT '', -- first evidence deadline; separate from overall deadline
  deadline_at       TEXT    NOT NULL DEFAULT '',        -- ISO deadline; '' means no explicit deadline (still stale-checked)
  last_heartbeat_at TEXT    NOT NULL,
  stale_after_ms    INTEGER NOT NULL DEFAULT 120000,    -- reap threshold if no heartbeat within this window
  status            TEXT    NOT NULL DEFAULT 'open',    -- open | closed | cancelled
  outcome           TEXT    NOT NULL DEFAULT '',        -- '' | success | failed | partial | blocked | cancelled
  close_reason      TEXT    NOT NULL DEFAULT '',        -- audit reason (agent report | reap:stale | reap:deadline | manual | ...)
  stale_reason      TEXT    NOT NULL DEFAULT '',        -- role_mismatch | lease_timeout | artifact_deadline_miss
  closed_at         TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_leases_plan   ON execution_leases(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_leases_step   ON execution_leases(step_id, status);
CREATE INDEX IF NOT EXISTS idx_leases_open   ON execution_leases(status, last_heartbeat_at);
-- Only ONE open lease per step (partial unique) — prevents two supervisors from
-- silently owning the same step even if both went through the CAS claim path.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leases_open_per_step ON execution_leases(step_id) WHERE status='open';

-- Reusable plan skeletons. instantiate_template clones a template's steps into a plan.
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL DEFAULT '',
  keywords    TEXT    NOT NULL DEFAULT '[]',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS template_steps (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id         INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  idx                 INTEGER NOT NULL,
  title               TEXT    NOT NULL,
  context             TEXT    NOT NULL DEFAULT '',
  tools               TEXT    NOT NULL DEFAULT '[]',
  role                TEXT    NOT NULL DEFAULT '',
  acceptance_criteria TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tsteps_tpl ON template_steps(template_id, idx);
`;

const PLAN_STATUS = new Set(['draft', 'active', 'done', 'abandoned', 'blocked']);
const STEP_STATUS = new Set(['pending', 'in_progress', 'done', 'failed', 'blocked', 'skipped']);
const VERDICTS = new Set(['pass', 'fail', 'partial']);
const RELATIONS = new Set(['references', 'builds_on', 'blocks', 'supersedes']);
const REF_KINDS = new Set(['rule', 'tool']);
const FILE_ROLES = new Set(['primary', 'dependency', 'related', 'reference']);
const ACTIVITY_STATUS = new Set(['queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']);
const ACTIVITY_TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
const ACTIVITY_OUTCOME = new Set(['', 'success', 'failed', 'partial', 'blocked', 'cancelled', 'unknown']);
const ACTIVITY_EVENT_TYPES = new Set([
  'timeline',
  'terminal',
  'start_claimed',
  'heartbeat_progress',
  'validation_failure',
  'execution_failure',
  'reassignment_recovery',
  'completion',
  'activity_backfill_missing',
]);
const ACTIVITY_VERIFICATION = new Set(['pending', 'running', 'passed', 'failed', 'skipped', 'not_applicable']);
const BOARD_HEALTH_STATES = new Set(['stale_lease', 'needs_manual_verification', 'awaiting_artifact', 'healthy']);
// Execution lease lifecycle. `open` = a supervisor owns the step right now;
// `closed` = terminalized cleanly (with outcome); `cancelled` = reaped or
// forcibly aborted. Transitions are one-way (open → closed | cancelled).
const LEASE_STATUS = new Set(['open', 'closed', 'cancelled']);
const LEASE_OUTCOME = new Set(['', 'success', 'failed', 'partial', 'blocked', 'cancelled', 'abandoned']);
const ATTEMPT_VALIDATION_STATUS = new Set(['pass', 'fail', 'legacy_unknown']);
// Verification dispositions for closed step states (done | skipped | blocked).
// A plan cannot transition to `done` while any of its steps has a blank
// disposition on a closed status — that is the "verification is first-class"
// contract. `legacy_unknown` preserves ambiguity for pre-lifecycle rows
// (they are ALLOWED for completion but visibly flagged as unaudited).
const STEP_DISPOSITION = new Set(['', 'verified', 'not_applicable', 'deferred', 'blocked', 'legacy_unknown']);
const STEP_DISPOSITION_TERMINAL = new Set(['verified', 'not_applicable', 'deferred', 'blocked', 'legacy_unknown']);
// Dispositions that can accompany a passing verdict — a step marked pass without
// evidence of verification (e.g. `deferred`) violates the disposition contract.
const STEP_DISPOSITION_PASS = new Set(['verified', 'not_applicable']);
const AUTO_TERMINALIZE_MODES = new Set(['off', 'shadow', 'enforce']);
const COMPLETION_GATE_MODES = new Set(['off', 'warn', 'enforce']);
const AUTO_REASSIGN_MODES = new Set(['off', 'advisory', 'enforce']);
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you',
  'are', 'was', 'not', 'but', 'use', 'used', 'using', 'via', 'run', 'add', 'get', 'set', 'its',
  'has', 'have', 'will', 'can', 'per', 'than', 'then', 'when', 'what', 'which', 'our', 'out', 'off',
  'all', 'any', 'one', 'two', 'step', 'plan', 'steps', 'plans', 'node']);
// Exported so the RAG ranker (src/rag/rank.mjs) and expander (src/rag/expand.mjs)
// tokenize identically to the ledger's getLessons/recall — one lexical contract.
export const tokenize = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w));

function resolveAutoReassignMode() {
  const raw = String(process.env.PLAN_LEDGER_AUTO_REASSIGN ?? 'off').trim().toLowerCase();
  return AUTO_REASSIGN_MODES.has(raw) ? raw : 'off';
}

// Shared IDF-weighted lexical ranker for getLessons + recall. `entries` is
// [{ doc, toks:Set }]; returns [{ doc, score }] for score > 0, best first,
// capped at `limit`. `tieBreak(aDoc, bDoc)` orders equal scores (default: stable).
function idfRank(entries, qToks, limit, tieBreak = () => 0) {
  const N = entries.length, df = new Map();
  for (const e of entries) for (const t of e.toks) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + N / (df.get(t) || 1));
  return entries
    .map((e) => ({ doc: e.doc, score: qToks.reduce((s, t) => s + (e.toks.has(t) ? idf(t) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || tieBreak(a.doc, b.doc))
    .slice(0, limit);
}

const now = () => new Date().toISOString();
const jsonArr = (v) => {
  if (v == null) return '[]';
  if (Array.isArray(v)) return JSON.stringify(v.map(String));
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return JSON.stringify(p.map(String)); } catch {}
    // comma-separated fallback
    return JSON.stringify(v.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return '[]';
};
const parseArr = (s) => { try { return JSON.parse(s ?? '[]'); } catch { return []; } };
const parseObj = (s) => {
  try {
    const v = JSON.parse(s ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const clamp = (v, max = 240) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clampInt = (v, min = 0, max = 1_000_000_000) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.trunc(n)));
};
function sanitizeMetadata(value, depth = 0) {
  if (depth > 4) return undefined;
  if (value == null) return undefined;
  if (typeof value === 'string') return clamp(value, 240);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, 20)) {
      const s = sanitizeMetadata(item, depth + 1);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    let c = 0;
    for (const [k, v] of Object.entries(value)) {
      if (c >= 32) break;
      const key = clamp(k, 64);
      if (!key) continue;
      const s = sanitizeMetadata(v, depth + 1);
      if (s !== undefined) {
        out[key] = s;
        c++;
      }
    }
    return out;
  }
  return clamp(value, 120);
}
function sanitizeMetadataJson(value) {
  const base = sanitizeMetadata(value, 0);
  const obj = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  let text = JSON.stringify(obj);
  if (text.length > 4096) text = JSON.stringify({ truncated: true, preview: text.slice(0, 3900) });
  return text;
}
function sanitizeRecentArtifacts(value) {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(value.map((x) => clamp(x, 200)).filter(Boolean).slice(0, 12));
}
function staleStatus(status, updatedAt, staleAfterMs, nowMs = Date.now()) {
  if (!['queued', 'in_progress', 'blocked'].includes(status)) return { stale: false, stale_for_ms: 0 };
  const ts = Date.parse(updatedAt || '');
  if (!Number.isFinite(ts)) return { stale: false, stale_for_ms: 0 };
  const age = Math.max(0, nowMs - ts);
  return { stale: age > staleAfterMs, stale_for_ms: age };
}
function canTransitionActivityStatus(fromStatus, toStatus) {
  if (!fromStatus || fromStatus === toStatus) return true;
  if (ACTIVITY_TERMINAL_STATUS.has(fromStatus)) return false;
  if (fromStatus === 'queued') return ['in_progress', 'blocked', 'cancelled', 'queued'].includes(toStatus);
  if (fromStatus === 'in_progress') return ['in_progress', 'blocked', 'completed', 'failed', 'cancelled'].includes(toStatus);
  if (fromStatus === 'blocked') return ['blocked', 'in_progress', 'failed', 'cancelled'].includes(toStatus);
  return false;
}
function resolveAutoTerminalizeMode(envValue = process.env.PLAN_LEDGER_AUTO_TERMINALIZE) {
  const raw = String(envValue ?? '').trim().toLowerCase();
  if (raw === 'on') return 'enforce';
  if (!raw) return 'shadow'; // conservative default: diagnose, no status mutation
  return AUTO_TERMINALIZE_MODES.has(raw) ? raw : 'shadow';
}
function resolveCompletionGateMode(envValue = process.env.PLAN_LEDGER_COMPLETION_GATE) {
  const raw = String(envValue ?? '').trim().toLowerCase();
  if (raw === 'on') return 'enforce';
  if (!raw) return 'warn'; // conservative rollout default: annotate, don't block
  return COMPLETION_GATE_MODES.has(raw) ? raw : 'warn';
}

// Bounded keyword set from a free-text goal (or an explicit keyword list). Uses the
// SAME tokenize() lexical contract as recall/getLessons so discovery ranks the way
// the rest of the ledger does, dedupes preserving first-seen order, and caps at
// `max` so a preflight query can never balloon. Exported for the planner-start
// operation and for tests that assert the bound holds.
export function extractKeywords(input, max = 8) {
  const text = Array.isArray(input) ? input.join(' ') : String(input ?? '');
  const seen = new Set();
  const out = [];
  for (const t of tokenize(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export class Store {
  constructor(dbPath) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db_path = dbPath;
    this.db_identity = canonicalDbIdentity(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 3000;'); // board + MCP + CLI share the file
    this.db.exec('PRAGMA journal_size_limit = 4194304;'); // cap the -wal file at ~4MB after checkpoints
    this._stmts = new Map();
    this.db.exec(SCHEMA);
    this._migrate();
  }

  // Run fn inside BEGIN/COMMIT with ROLLBACK on throw. Nest-safe: an inner _tx
  // joins the outer transaction (SQLite has no nested BEGIN). Mirrors the
  // importGraph atomicity pattern for every multi-statement write.
  _tx(fn) {
    if (this._inTx) return fn();
    this._inTx = true;
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    } finally {
      this._inTx = false;
    }
  }

  _prep(key, sql) {
    const existing = this._stmts.get(key);
    if (existing) return existing;
    const stmt = this.db.prepare(sql);
    this._stmts.set(key, stmt);
    return stmt;
  }

  // Fold the WAL back into the main file and truncate it (no-op on :memory:).
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {} }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._stmts?.clear();
    this.checkpoint(); // don't leave a fat -wal behind
    this.db.close();
  }

  // Numbered, PRAGMA user_version-gated migrations. Version 1 stamps the 2026-07
  // project/role/provenance state; upstream versions 2–3 added the layman field
  // and notes thread. Version 4 enforces contiguous (plan_id, idx) uniqueness
  // after repairing any legacy duplicates. Version 5 (2026-07) adds the
  // step_assignments audit table plus attempts.agent/model/model_source/session_ref
  // for planned-vs-actual execution transparency. Version 6 (2026-07) adds the
  // plan_consultations table (prior-plan discovery provenance). Version 7 (2026-07)
  // adds durable execution activity tables (activity_runs/activity_events) for
  // structured live run telemetry + heartbeats. Version 8 (2026-07) makes the
  // execution lifecycle unavoidable: execution_leases table + verification
  // disposition columns on steps + plans.completion_lock. Legacy done steps get
  // an audited `legacy_unknown` disposition (never silently upgraded to
  // "verified"), orphaned activity attached to already-done plans is closed with
  // an audit event, and setPlanStatus('done') becomes gated on those invariants.
  // Version 9 (2026-08) adds additive terminalization-integrity plan metadata:
  // terminal_state_reason, terminalized_at, and state_integrity_version.
  // Version 10 (2026-08) adds completion evidence gate storage:
  // steps.completion_payload_json/completion_validated_at and
  // attempts.validation_status/validation_errors_json.
  // Version 11 (2026-08) adds C3 dispatch/lease recovery fields:
  // step_assignments.dispatch_policy_json, execution_leases.stale_reason, and
  // steps.auto_reassignment_count.
  // Version 12 (2026-08) separates first-artifact and overall lease deadlines:
  // execution_leases.first_artifact_deadline_at.
  static USER_VERSION = 13;

  _migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    const hasCol = (t, c) => this.db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
    const ts = now();
    this.db.prepare("INSERT OR IGNORE INTO projects (id, name, description, status, created_at, updated_at) VALUES (1, 'General', 'Default project (plans created before the project layer existed).', 'active', ?, ?)").run(ts, ts);
    if (!hasCol('plans', 'project_id')) this.db.exec('ALTER TABLE plans ADD COLUMN project_id INTEGER');
    this.db.prepare('UPDATE plans SET project_id = 1 WHERE project_id IS NULL').run();
    if (!hasCol('refs', 'project_id')) this.db.exec('ALTER TABLE refs ADD COLUMN project_id INTEGER');
    // Role-based dispatch: which subagent role executes a step (added 2026-07; '' = orchestrator decides).
    if (!hasCol('steps', 'role')) this.db.exec("ALTER TABLE steps ADD COLUMN role TEXT NOT NULL DEFAULT ''");
    if (!hasCol('template_steps', 'role')) this.db.exec("ALTER TABLE template_steps ADD COLUMN role TEXT NOT NULL DEFAULT ''");
    // Attempt provenance: which role/executor produced an attempt + review rounds (added 2026-07).
    if (!hasCol('attempts', 'role')) this.db.exec("ALTER TABLE attempts ADD COLUMN role TEXT NOT NULL DEFAULT ''");
    if (!hasCol('attempts', 'review_rounds')) this.db.exec('ALTER TABLE attempts ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0');
    if (!hasCol('attempts', 'executor')) this.db.exec("ALTER TABLE attempts ADD COLUMN executor TEXT NOT NULL DEFAULT ''");
    // Actual-execution provenance columns on attempts (v5, 2026-07): distinguish planned
    // dispatch configuration from what actually served the call. Missing values are
    // left blank rather than fabricated — a downstream UI treats '' as "unknown".
    if (!hasCol('attempts', 'agent')) this.db.exec("ALTER TABLE attempts ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    if (!hasCol('attempts', 'model')) this.db.exec("ALTER TABLE attempts ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    if (!hasCol('attempts', 'model_source')) this.db.exec("ALTER TABLE attempts ADD COLUMN model_source TEXT NOT NULL DEFAULT ''");
    if (!hasCol('attempts', 'session_ref')) this.db.exec("ALTER TABLE attempts ADD COLUMN session_ref TEXT NOT NULL DEFAULT ''");
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('current_project', '1')").run();

    // Layman box: plain-English per-step field, distinct from what_tried (added 2026-07).
    if (!hasCol('steps', 'layman')) this.db.exec("ALTER TABLE steps ADD COLUMN layman TEXT NOT NULL DEFAULT ''");
    // notes table (review/feedback thread) needs no hasCol backfill — it's a brand-new
    // table, so `CREATE TABLE IF NOT EXISTS` in SCHEMA (executed every boot, above)
    // already creates it on an old-shape DB; only the version stamp bump is needed here.
    // v6: plan_consultations (prior-plan discovery provenance) is likewise a brand-new
    // table created by SCHEMA above on any DB shape — no backfill, just the stamp bump.

    // ---- numbered migrations (gate on v, wrap in _tx, bump the stamp) ----
    // v4: repair any duplicate/gap (plan_id, idx) values then enforce uniqueness.
    // Legacy DBs written before update_step preserved the idx invariant may hold
    // duplicates; renumber steps per plan by (idx, id) to a contiguous 1..N run
    // before laying down the UNIQUE index, otherwise the index creation would fail.
    // This must be v4 (not v2): upstream databases may already be stamped v3
    // without having this invariant.
    const hasStepIdxInvariant = this.db.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='uq_steps_plan_idx'"
    ).get();
    if (v < 4 || !hasStepIdxInvariant) this._tx(() => {
      const planIds = this.db.prepare('SELECT DISTINCT plan_id FROM steps').all().map((r) => r.plan_id);
      const readSteps = this.db.prepare('SELECT id FROM steps WHERE plan_id=? ORDER BY idx, id');
      const setIdx = this.db.prepare('UPDATE steps SET idx=? WHERE id=?');
      for (const pid of planIds) {
        const rows = readSteps.all(pid);
        // Two-phase renumber (temporarily push idx to negative space) so the
        // running index never briefly collides with an existing sibling once
        // the UNIQUE constraint is live.
        for (let i = 0; i < rows.length; i++) setIdx.run(-(i + 1), rows[i].id);
        for (let i = 0; i < rows.length; i++) setIdx.run(i + 1, rows[i].id);
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_steps_plan_idx ON steps(plan_id, idx)');
    });

    // v8: verification disposition + plan completion lock + execution leases + reconciliation.
    if (!hasCol('steps', 'verification_disposition')) this.db.exec("ALTER TABLE steps ADD COLUMN verification_disposition TEXT NOT NULL DEFAULT ''");
    if (!hasCol('steps', 'disposition_reason'))       this.db.exec("ALTER TABLE steps ADD COLUMN disposition_reason TEXT NOT NULL DEFAULT ''");
    if (!hasCol('steps', 'disposition_at'))           this.db.exec("ALTER TABLE steps ADD COLUMN disposition_at TEXT NOT NULL DEFAULT ''");
    if (!hasCol('plans', 'completion_lock'))          this.db.exec("ALTER TABLE plans ADD COLUMN completion_lock TEXT NOT NULL DEFAULT ''");
    if (!hasCol('plans', 'terminal_state_reason'))    this.db.exec("ALTER TABLE plans ADD COLUMN terminal_state_reason TEXT NOT NULL DEFAULT ''");
    if (!hasCol('plans', 'terminalized_at'))          this.db.exec("ALTER TABLE plans ADD COLUMN terminalized_at TEXT NOT NULL DEFAULT ''");
    if (!hasCol('plans', 'state_integrity_version'))  this.db.exec('ALTER TABLE plans ADD COLUMN state_integrity_version INTEGER NOT NULL DEFAULT 1');
    if (!hasCol('steps', 'completion_payload_json'))  this.db.exec("ALTER TABLE steps ADD COLUMN completion_payload_json TEXT NOT NULL DEFAULT ''");
    if (!hasCol('steps', 'completion_validated_at'))  this.db.exec("ALTER TABLE steps ADD COLUMN completion_validated_at TEXT NOT NULL DEFAULT ''");
    if (!hasCol('steps', 'auto_reassignment_count')) this.db.exec('ALTER TABLE steps ADD COLUMN auto_reassignment_count INTEGER NOT NULL DEFAULT 0');
    if (!hasCol('attempts', 'validation_status'))     this.db.exec("ALTER TABLE attempts ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'legacy_unknown'");
    if (!hasCol('attempts', 'validation_errors_json')) this.db.exec("ALTER TABLE attempts ADD COLUMN validation_errors_json TEXT NOT NULL DEFAULT ''");
    if (!hasCol('step_assignments', 'dispatch_policy_json')) this.db.exec("ALTER TABLE step_assignments ADD COLUMN dispatch_policy_json TEXT NOT NULL DEFAULT ''");
    if (!hasCol('execution_leases', 'stale_reason'))  this.db.exec("ALTER TABLE execution_leases ADD COLUMN stale_reason TEXT NOT NULL DEFAULT ''");
    if (!hasCol('execution_leases', 'first_artifact_deadline_at')) this.db.exec("ALTER TABLE execution_leases ADD COLUMN first_artifact_deadline_at TEXT NOT NULL DEFAULT ''");
    if (!hasCol('activity_events', 'step_id')) this.db.exec('ALTER TABLE activity_events ADD COLUMN step_id INTEGER NOT NULL DEFAULT 0');
    if (!hasCol('activity_events', 'assignment_id')) this.db.exec('ALTER TABLE activity_events ADD COLUMN assignment_id INTEGER');
    if (!hasCol('activity_events', 'assignment_missing_reason')) this.db.exec("ALTER TABLE activity_events ADD COLUMN assignment_missing_reason TEXT NOT NULL DEFAULT ''");
    if (!hasCol('activity_events', 'event_timestamp')) this.db.exec("ALTER TABLE activity_events ADD COLUMN event_timestamp TEXT NOT NULL DEFAULT ''");

    if (v < 8) this._tx(() => {
      const nowTs = now();
      // Legacy done steps: preserve the ambiguity ("this predates verified
      // disposition tracking") instead of silently upgrading to verified.
      const legacyDone = this.db.prepare(
        "UPDATE steps SET verification_disposition='legacy_unknown', disposition_reason='backfill: pre-lifecycle era (v7->v8)', disposition_at=? WHERE status='done' AND (verification_disposition='' OR verification_disposition IS NULL)"
      ).run(nowTs).changes;
      // Legacy skipped steps: skipped implies not-applicable by convention.
      const legacySkipped = this.db.prepare(
        "UPDATE steps SET verification_disposition='not_applicable', disposition_reason='backfill: skipped step reconciled (v7->v8)', disposition_at=? WHERE status='skipped' AND (verification_disposition='' OR verification_disposition IS NULL)"
      ).run(nowTs).changes;
      // Legacy blocked steps that already sit inside a done/abandoned plan should
      // not block re-completion — record them as `blocked` disposition so the
      // gate treats them as intentionally deferred with audit trail.
      const legacyBlocked = this.db.prepare(
        "UPDATE steps SET verification_disposition='blocked', disposition_reason='backfill: blocked step reconciled (v7->v8)', disposition_at=? WHERE status='blocked' AND (verification_disposition='' OR verification_disposition IS NULL) AND plan_id IN (SELECT id FROM plans WHERE status IN ('done','abandoned'))"
      ).run(nowTs).changes;
      // Orphaned activity: any non-terminal run inside a done/abandoned plan is
      // closed with an audit trail. Terminal event carries `reason=legacy_reconcile`.
      const orphanRuns = this.db.prepare(
        "SELECT id, plan_id, step_id, run_id, session_ref FROM activity_runs WHERE status IN ('queued','in_progress','blocked') AND plan_id IN (SELECT id FROM plans WHERE status IN ('done','abandoned'))"
      ).all();
      const closeRun = this.db.prepare(
        "UPDATE activity_runs SET status='cancelled', outcome='cancelled', ended_at=?, updated_at=? WHERE id=?"
      );
      for (const r of orphanRuns) {
        closeRun.run(nowTs, nowTs, r.id);
        this._appendLifecycleEvent(r.id, r.step_id, {
          event_type: 'terminal',
          phase: 'reconcile',
          summary: 'legacy reconcile: non-terminal activity inside already-closed plan',
          metadata: { reason: 'legacy_reconcile', run_id: r.run_id, session_ref: r.session_ref },
          assignment_missing_reason: 'legacy_reconcile',
          timestamp: nowTs,
        });
      }
      if (legacyDone || legacySkipped || legacyBlocked || orphanRuns.length) {
        console.warn(`plan-ledger: v8 reconciliation — legacy_unknown=${legacyDone}, skipped=>not_applicable=${legacySkipped}, blocked=${legacyBlocked}, orphaned_activity_closed=${orphanRuns.length}`);
      }
    });

    if (v < 9) this._tx(() => {
      this.db.prepare("UPDATE plans SET terminal_state_reason='' WHERE terminal_state_reason IS NULL").run();
      this.db.prepare("UPDATE plans SET terminalized_at='' WHERE terminalized_at IS NULL").run();
      this.db.prepare('UPDATE plans SET state_integrity_version=1 WHERE state_integrity_version IS NULL OR state_integrity_version < 1').run();
    });

    if (v < 10) this._tx(() => {
      this.db.prepare("UPDATE steps SET completion_payload_json='' WHERE completion_payload_json IS NULL").run();
      this.db.prepare("UPDATE steps SET completion_validated_at='' WHERE completion_validated_at IS NULL").run();
      this.db.prepare(
        "UPDATE attempts SET validation_status='legacy_unknown' WHERE validation_status IS NULL OR validation_status='' OR validation_status NOT IN ('pass','fail','legacy_unknown')"
      ).run();
      this.db.prepare("UPDATE attempts SET validation_errors_json='' WHERE validation_errors_json IS NULL").run();
    });

    if (v < 11) this._tx(() => {
      this.db.prepare('UPDATE steps SET auto_reassignment_count=0 WHERE auto_reassignment_count IS NULL OR auto_reassignment_count < 0').run();
      this.db.prepare("UPDATE step_assignments SET dispatch_policy_json='' WHERE dispatch_policy_json IS NULL").run();
      this.db.prepare("UPDATE execution_leases SET stale_reason='' WHERE stale_reason IS NULL").run();
    });

    if (v < 12) this._tx(() => {
      this.db.prepare("UPDATE execution_leases SET first_artifact_deadline_at='' WHERE first_artifact_deadline_at IS NULL").run();
    });

    if (v < 13) this._tx(() => {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_activity_step_started ON activity_runs(step_id, started_at DESC)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_activity_events_step_time ON activity_events(step_id, event_timestamp, id)');
      this.db.prepare('UPDATE activity_events SET step_id=(SELECT step_id FROM activity_runs ar WHERE ar.id=activity_events.activity_id) WHERE step_id IS NULL OR step_id=0').run();
      this.db.prepare("UPDATE activity_events SET event_timestamp=COALESCE(NULLIF(event_timestamp,''), created_at) WHERE event_timestamp IS NULL OR event_timestamp=''").run();
      this.db.prepare("UPDATE activity_events SET assignment_missing_reason='no_assignment_snapshot' WHERE assignment_id IS NULL AND (assignment_missing_reason IS NULL OR assignment_missing_reason='')").run();
      this.backfillMissingActivityMarkers();
    });

    // Self-healing index creation for already-migrated ledgers: if user_version
    // is already >=13 but indexes are missing, recreate them after additive
    // columns are present. This keeps pre-existing DBs openable and consistent.
    if (hasCol('activity_runs', 'step_id') && hasCol('activity_runs', 'started_at')) {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_activity_step_started ON activity_runs(step_id, started_at DESC)');
    }
    if (hasCol('activity_events', 'step_id') && hasCol('activity_events', 'event_timestamp')) {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_activity_events_step_time ON activity_events(step_id, event_timestamp, id)');
    }

    if (v < Store.USER_VERSION) this.db.exec(`PRAGMA user_version = ${Store.USER_VERSION}`);
  }

  // ---- projects (top level: project → plan → step) -----------------------

  currentProjectId() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='current_project'").get();
    return row ? Number(row.value) : 1;
  }
  setCurrentProject(id) {
    if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(id)) throw new Error(`no project with id ${id}`);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('current_project', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(id));
    return this.getProject(id);
  }
  createProject({ name, description } = {}) {
    if (!name || !String(name).trim()) throw new Error('project name is required');
    const ts = now();
    const info = this.db.prepare('INSERT INTO projects (name, description, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(String(name).trim(), String(description ?? ''), 'active', ts, ts);
    return this.getProject(Number(info.lastInsertRowid));
  }
  // Common project shape (identity + plan counts); callers add their extras
  // (getProject: timestamps, listProjects: the `current` flag).
  _projectRow(p) {
    const c = this.db.prepare("SELECT COUNT(*) n, SUM(status='done') done FROM plans WHERE project_id=?").get(p.id);
    return { id: p.id, name: p.name, description: p.description, status: p.status, plans: c.n ?? 0, plans_done: c.done ?? 0 };
  }
  getProject(id) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) throw new Error(`no project with id ${id}`);
    return { ...this._projectRow(p), created_at: p.created_at, updated_at: p.updated_at };
  }
  listProjects() {
    const cur = this.currentProjectId();
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all()
      .map((p) => ({ ...this._projectRow(p), current: p.id === cur }));
  }
  // Owning project's NAME for a plan — the key into the role map's user-file
  // `projects.<name>.roles` layer (src/roles.mjs). null when the plan or its
  // project is missing (resolver then skips that layer).
  projectNameForPlan(planId) {
    const row = this.db.prepare(
      'SELECT p.name FROM projects p JOIN plans l ON l.project_id = p.id WHERE l.id = ?').get(planId);
    return row?.name ?? null;
  }
  setProjectStatus(id, status) {
    if (!['active', 'archived'].includes(status)) throw new Error(`bad project status: ${status} (active|archived)`);
    const info = this.db.prepare('UPDATE projects SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
    if (info.changes === 0) throw new Error(`no project with id ${id}`);
    return this.getProject(id);
  }

  // The next plan to work in a project: the oldest non-done/abandoned plan that still
  // has an uncompleted step. null when the project is fully worked. Drives continuous runs.
  nextPlan(projectId) {
    // Default to the CURRENT project. (Bug fixed here: a null projectId used to bind NULL
    // into "project_id IS NULL OR project_id=?", which matched only legacy NULL-project
    // rows — none exist post-migration — so callers without a project saw "fully worked".
    // _migrate() backfills project_id on every boot, so plain equality is correct.)
    const pid = projectId ?? this.currentProjectId();
    // 'blocked' plans are waiting on a human — skip them so the autopilot advances to the next workable plan.
    const rows = this.db.prepare("SELECT id FROM plans WHERE project_id=? AND status NOT IN ('done','abandoned','blocked') ORDER BY id").all(pid);
    for (const r of rows) {
      const n = this.nextStep(r.id);
      // Skip a plan whose only remaining work is either blocked (needs a human)
      // OR already in_progress (another executor owns it) — treating an
      // in-progress plan as "workable" is what previously let two runners
      // stampede the same step and reported a plan as picked up when it was
      // busy. Consult n?.done shape too (nextStep returns null when complete).
      if (n && !n.all_blocked && !n.all_in_progress) return this.openPlan(r.id);
    }
    return null;
  }

  // ---- plans -------------------------------------------------------------

  createPlan({ title, keywords, summary, project_id,
    consulted_plan_ids = null, consulted_keywords = null, consulted_goal = '', consulted_note = '' }) {
    if (!title || !String(title).trim()) throw new Error('title is required');
    const pid = project_id ?? this.currentProjectId();
    if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(pid)) throw new Error(`no project with id ${pid}`);
    const ts = now();
    const info = this.db
      .prepare('INSERT INTO plans (project_id, title, keywords, summary, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(pid, String(title).trim(), jsonArr(keywords), String(summary ?? ''), 'draft', ts, ts);
    const id = Number(info.lastInsertRowid);
    if (Array.isArray(consulted_plan_ids) && consulted_plan_ids.length) {
      this.recordPlanConsultation(id, {
        consulted_plan_ids,
        keywords: consulted_keywords ?? keywords ?? [],
        goal: consulted_goal,
        note: consulted_note,
      });
    }
    return this.openPlan(id);
  }

  // Plan metadata updates (title/keywords/summary) plus optional consulted-plan
  // provenance writes for draft-plan authoring flows. Status transitions remain on
  // setPlanStatus() to preserve existing activation/blocked semantics.
  updatePlan(id, fields = {}) {
    this._mustPlan(id, '*');
    const allowed = {};
    if (fields.title != null) {
      const t = String(fields.title).trim();
      if (!t) throw new Error('title is required');
      allowed.title = t;
    }
    if (fields.keywords != null) allowed.keywords = jsonArr(fields.keywords);
    if (fields.summary != null) allowed.summary = String(fields.summary);
    const keys = Object.keys(allowed);
    if (keys.length) {
      const set = keys.map((k) => `${k}=?`).join(', ');
      this.db.prepare(`UPDATE plans SET ${set}, updated_at=? WHERE id=?`).run(...keys.map((k) => allowed[k]), now(), id);
    }
    if (Array.isArray(fields.consulted_plan_ids) && fields.consulted_plan_ids.length) {
      this.recordPlanConsultation(id, {
        consulted_plan_ids: fields.consulted_plan_ids,
        keywords: fields.consulted_keywords ?? fields.keywords ?? [],
        goal: fields.consulted_goal ?? '',
        note: fields.consulted_note ?? '',
      });
    }
    return this.openPlan(id);
  }

  // level 0 — the cheap surface index. No step bodies, ever.
  // Scoped to the CURRENT project by default (projects don't mix); pass `all:true`
  // for every project, or an explicit `project_id`.
  listPlans({ status, query, project_id, all } = {}) {
    const pid = project_id ?? this.currentProjectId();
    let rows = this.db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all();
    if (!all) rows = rows.filter((r) => (r.project_id ?? 1) === pid);
    if (status) rows = rows.filter((r) => r.status === status);
    if (query) {
      const q = String(query).toLowerCase();
      rows = rows.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        parseArr(r.keywords).some((k) => String(k).toLowerCase().includes(q)));
    }
    return rows.map((r) => {
      const counts = this.db
        .prepare("SELECT COUNT(*) n, SUM(status='done') done FROM steps WHERE plan_id=?")
        .get(r.id);
      return {
        id: r.id,
        project_id: r.project_id ?? 1,
        title: r.title,
        keywords: parseArr(r.keywords),
        status: r.status,
        steps: counts.n ?? 0,
        done: counts.done ?? 0,
        updated_at: r.updated_at,
      };
    });
  }

  // level 1 — open a plan: its detail + an ordered step *index* (titles/status only).
  openPlan(id) {
    const p = this._mustPlan(id, '*');
    const steps = this.db
      .prepare('SELECT id, idx, title, status FROM steps WHERE plan_id=? ORDER BY idx, id')
      .all(id);
    return {
      id: p.id,
      project_id: p.project_id ?? 1,
      title: p.title,
      keywords: parseArr(p.keywords),
      summary: p.summary,
      status: p.status,
      completion_lock: p.completion_lock ?? '', // populated only when done was force-closed
      terminal_state_reason: p.terminal_state_reason ?? '',
      terminalized_at: p.terminalized_at ?? '',
      state_integrity_version: Number(p.state_integrity_version ?? 1) || 1,
      created_at: p.created_at,
      updated_at: p.updated_at,
      steps, // index only — call getStep(id) for a step's full context
      file_refs: this.listFileRefs({ plan_id: p.id, plan_level: true }), // plan-level cited files
      consulted_plans: this.listConsultedPlans(p.id), // prior plans this draft consulted (surface only)
      health: this.activityHealthSummary({ plan_id: p.id }),
    };
  }

  // Reliability contract: transitioning to `done` is gated on the execution
  // lifecycle being closed. A plan can move to `done` only if every step is in
  // a closed state (done | skipped | blocked) with an explicit disposition, no
  // execution lease is open, and no activity run remains non-terminal. The
  // `force: true, reason: '...'` escape hatch records a `completion_lock` audit
  // string so a forced closure is never invisible.
  setPlanStatus(id, status, { force = false, reason = '' } = {}) {
    if (!PLAN_STATUS.has(status)) throw new Error(`bad plan status: ${status}`);
    const prev = this._mustPlan(id, 'status');
    if (status === 'done') {
      const guard = this._assessPlanTerminalization(id);
      if (!guard.ok && !force) {
        const err = new Error(`plan #${id} cannot be marked done: ${guard.summary}`);
        err.details = guard;
        throw err;
      }
      if (!guard.ok && force) {
        if (!String(reason || '').trim()) throw new Error('force-closing a plan requires a reason (audit trail)');
      }
    }
    const forcedLock = status === 'done' && force && String(reason || '').trim()
      ? `forced-done: ${String(reason).trim().slice(0, 200)} (${now()})`
      : null;
    const info = forcedLock
      ? this.db.prepare('UPDATE plans SET status=?, completion_lock=?, updated_at=? WHERE id=?').run(status, forcedLock, now(), id)
      : this.db.prepare('UPDATE plans SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
    if (info.changes === 0) throw new Error(`no plan with id ${id}`);
    // Transition into `active` is the natural "start executing" boundary — freeze
    // every unsnapshotted step's dispatch assignment now. Snapshots are idempotent
    // per-step (skipped when a row already exists), so re-activating a plan does
    // not clobber history. Any error here MUST NOT block the status change: the
    // status write already committed, and snapshot() only reads config files.
    if (status === 'active' && prev.status !== 'active') {
      try { this._snapshotPlanAssignments(id); } catch (e) {
        console.warn(`plan-ledger: snapshot on activation of plan ${id} failed (${e.message}); status still set`);
      }
    }
    return this.openPlan(id);
  }

  // Explain-only: dry-run the plan-done gate so UIs/tests can render exactly
  // what would block completion right now, without attempting the transition.
  assessPlanTerminalization(planId) {
    this._mustPlan(planId);
    return this._assessPlanTerminalization(planId);
  }

  _assessPlanTerminalization(planId) {
    const steps = this.db.prepare(
      'SELECT id, idx, title, status, verification_disposition FROM steps WHERE plan_id=? ORDER BY idx, id'
    ).all(planId);
    const blockers = [];
    const activeSteps = steps.filter((s) => ['pending', 'in_progress', 'failed'].includes(s.status));
    if (activeSteps.length) {
      blockers.push({
        code: 'steps_active',
        detail: `${activeSteps.length} step(s) still active`,
        step_ids: activeSteps.map((s) => s.id),
      });
    }
    const needsDisposition = steps.filter((s) =>
      ['done', 'skipped', 'blocked'].includes(s.status) && !STEP_DISPOSITION_TERMINAL.has(s.verification_disposition ?? ''));
    if (needsDisposition.length) {
      blockers.push({
        code: 'disposition_missing',
        detail: `${needsDisposition.length} closed step(s) have no verification disposition`,
        step_ids: needsDisposition.map((s) => s.id),
      });
    }
    const openLeases = this.db.prepare(
      "SELECT id, step_id, executor, last_heartbeat_at FROM execution_leases WHERE plan_id=? AND status='open'"
    ).all(planId);
    if (openLeases.length) {
      blockers.push({
        code: 'lease_open',
        detail: `${openLeases.length} execution lease(s) still open`,
        lease_ids: openLeases.map((l) => l.id),
        step_ids: openLeases.map((l) => l.step_id),
      });
    }
    const liveActivity = this.db.prepare(
      "SELECT id, step_id, status FROM activity_runs WHERE plan_id=? AND status IN ('queued','in_progress','blocked')"
    ).all(planId);
    if (liveActivity.length) {
      blockers.push({
        code: 'activity_non_terminal',
        detail: `${liveActivity.length} activity run(s) not terminalized`,
        activity_ids: liveActivity.map((a) => a.id),
        step_ids: [...new Set(liveActivity.map((a) => a.step_id))],
      });
    }
    return {
      ok: blockers.length === 0,
      summary: blockers.length ? blockers.map((b) => `${b.code}: ${b.detail}`).join('; ') : 'plan ready for done',
      blockers,
    };
  }

  assessPlanReconciliation(planId, { source = 'assess_plan_reconciliation', strict = true } = {}) {
    const plan = this._mustPlan(planId, 'id, status, completion_lock, terminal_state_reason, terminalized_at, state_integrity_version');
    const guard = this._assessPlanTerminalization(planId);
    const deferredRows = this.db.prepare(
      "SELECT id FROM steps WHERE plan_id=? AND status IN ('done','skipped','blocked') AND verification_disposition IN ('deferred','blocked') ORDER BY id"
    ).all(planId);
    const deferredGateStepIds = deferredRows.map((r) => r.id);
    const activeContradictionEligible = plan.status === 'active' && guard.ok && deferredGateStepIds.length === 0;
    const blockers = [...guard.blockers];
    if (!guard.ok) {
      // Keep existing strict blockers as the canonical done-gate source.
    } else if (deferredGateStepIds.length) {
      blockers.push({
        code: 'deferred_manual_gate',
        detail: `${deferredGateStepIds.length} step(s) require deferred/manual verification before done`,
        step_ids: deferredGateStepIds,
      });
    }
    const resultCode = !guard.ok
      ? 'reconcile_blocked'
      : deferredGateStepIds.length
        ? 'reconcile_partial_due_to_deferred_gate'
        : activeContradictionEligible
          ? 'reconcile_done'
          : 'reconcile_noop';
    return {
      plan_id: plan.id,
      source: String(source ?? ''),
      strict: !!strict,
      mode: resolveAutoTerminalizeMode(),
      plan_status: plan.status,
      completion_lock: plan.completion_lock ?? '',
      state_integrity_version: Number(plan.state_integrity_version ?? 1) || 1,
      terminal_state_reason: plan.terminal_state_reason ?? '',
      terminalized_at: plan.terminalized_at ?? '',
      guard_ok: guard.ok,
      result_code: resultCode,
      active_contradiction_eligible: activeContradictionEligible,
      deferred_gate_step_ids: deferredGateStepIds,
      blockers,
      summary: blockers.length
        ? blockers.map((b) => `${b.code}: ${b.detail}`).join('; ')
        : (resultCode === 'reconcile_done'
          ? 'active plan is eligible for auto-terminalization'
          : 'no blockers detected'),
    };
  }

  reconcilePlanTerminalState(planId, { source = 'mutation', strict = true } = {}) {
    const mode = resolveAutoTerminalizeMode();
    const plan = this._mustPlan(planId, 'id, status, terminal_state_reason, terminalized_at, state_integrity_version');
    const assessment = this.assessPlanReconciliation(planId, { source, strict });
    const result = {
      ...assessment,
      mode,
      applied: false,
      mutated: false,
    };
    if (mode === 'off') return result;
    if (mode === 'shadow') return result;

    const nowTs = now();
    const set = [];
    const values = [];
    const nextVersion = Math.max(2, Number(plan.state_integrity_version ?? 1) || 1);
    const setIfChanged = (field, value) => {
      if (plan[field] !== value) {
        set.push(`${field}=?`);
        values.push(value);
      }
    };

    if (plan.status === 'active' && assessment.result_code === 'reconcile_done') {
      setIfChanged('status', 'done');
      setIfChanged('terminal_state_reason', 'reconcile_done');
      setIfChanged('terminalized_at', nowTs);
      setIfChanged('state_integrity_version', nextVersion);
    } else if (plan.status === 'active' && assessment.result_code === 'reconcile_partial_due_to_deferred_gate') {
      setIfChanged('terminal_state_reason', 'partial_due_to_deferred_gate');
      setIfChanged('terminalized_at', '');
      setIfChanged('state_integrity_version', nextVersion);
    } else if (plan.status === 'active' && assessment.result_code === 'reconcile_blocked') {
      setIfChanged('terminal_state_reason', 'reconcile_blocked');
      setIfChanged('terminalized_at', '');
      setIfChanged('state_integrity_version', nextVersion);
    }

    if (!set.length) return result;
    set.push('updated_at=?');
    values.push(nowTs);
    this.db.prepare(`UPDATE plans SET ${set.join(', ')} WHERE id=?`).run(...values, planId);
    const updated = this._mustPlan(planId, 'status, terminal_state_reason, terminalized_at, state_integrity_version');
    return {
      ...result,
      applied: true,
      mutated: true,
      plan_status: updated.status,
      terminal_state_reason: updated.terminal_state_reason ?? '',
      terminalized_at: updated.terminalized_at ?? '',
      state_integrity_version: Number(updated.state_integrity_version ?? nextVersion) || nextVersion,
    };
  }

  reconcileTerminalizationDiagnostic({ strict = true } = {}) {
    const mode = resolveAutoTerminalizeMode();
    const rows = this.db.prepare("SELECT id, status FROM plans WHERE status='active' ORDER BY id").all();
    let contradictionBefore = 0;
    let contradictionAfter = 0;
    let reconciledDone = 0;
    const details = [];
    for (const row of rows) {
      const before = this.assessPlanReconciliation(row.id, { source: 'diagnostic', strict });
      if (before.active_contradiction_eligible) contradictionBefore++;
      const reconcile = this.reconcilePlanTerminalState(row.id, { source: 'diagnostic', strict });
      const after = this.assessPlanReconciliation(row.id, { source: 'diagnostic:after', strict });
      if (after.active_contradiction_eligible) contradictionAfter++;
      if (reconcile.mutated && reconcile.plan_status === 'done') reconciledDone++;
      details.push({
        plan_id: row.id,
        before: {
          result_code: before.result_code,
          active_contradiction_eligible: before.active_contradiction_eligible,
          blockers: before.blockers,
        },
        after: {
          plan_status: after.plan_status,
          result_code: after.result_code,
          active_contradiction_eligible: after.active_contradiction_eligible,
          terminal_state_reason: after.terminal_state_reason,
          terminalized_at: after.terminalized_at,
        },
        reconcile: {
          mode,
          mutated: reconcile.mutated,
          applied: reconcile.applied,
          result_code: reconcile.result_code,
        },
      });
    }
    return {
      mode,
      strict: !!strict,
      scanned_active_plans: rows.length,
      contradiction_count_before: contradictionBefore,
      contradiction_count_after: contradictionAfter,
      reconciled_to_done: reconciledDone,
      details,
    };
  }

  assessCompletionBackfill() {
    const counts = { pass: 0, fail: 0, legacy_unknown: 0 };
    for (const row of this.db.prepare(
      "SELECT validation_status, COUNT(*) AS n FROM attempts GROUP BY validation_status ORDER BY validation_status"
    ).all()) {
      const key = ATTEMPT_VALIDATION_STATUS.has(String(row.validation_status ?? ''))
        ? row.validation_status
        : 'legacy_unknown';
      counts[key] = Number(row.n ?? 0);
    }
    const legacyMissingPayload = this.db.prepare(
      "SELECT COUNT(*) AS n FROM attempts a JOIN steps s ON s.id=a.step_id WHERE (s.completion_payload_json='' OR s.completion_payload_json IS NULL) AND a.validation_status='legacy_unknown'"
    ).get().n ?? 0;
    const invalidRows = this.db.prepare(
      "SELECT COUNT(*) AS n FROM attempts WHERE validation_status NOT IN ('pass','fail','legacy_unknown') OR validation_status IS NULL OR validation_status=''"
    ).get().n ?? 0;
    return {
      total_attempts: counts.pass + counts.fail + counts.legacy_unknown,
      by_validation_status: counts,
      legacy_missing_payload_attempts: Number(legacyMissingPayload),
      invalid_status_rows: Number(invalidRows),
      mode: resolveCompletionGateMode(),
    };
  }

  // ---- steps -------------------------------------------------------------

  addStep(planId, { title, context, tools, role, acceptance_criteria, carry_forward, idx }) {
    const plan = this._mustPlan(planId, 'status');
    if (!title || !String(title).trim()) throw new Error('step title is required');
    const ts = now();
    const newId = this._tx(() => { // shift + insert must be one atomic unit
      let order = idx;
      if (order == null) {
        const max = this.db.prepare('SELECT MAX(idx) m FROM steps WHERE plan_id=?').get(planId);
        order = (max.m ?? 0) + 1;
      } else {
        order = Number(order);
        if (!Number.isInteger(order) || order < 1) throw new Error(`bad idx: ${idx} (must be an integer >= 1)`);
        // Insert-at-idx: shift everything at/after the slot up by one. Use the
        // negative-staging two-phase pattern so the UNIQUE(plan_id, idx) index
        // never sees a transient collision — flip all affected rows into the
        // negative space (still distinct), then map -x back to (-x + 1) which
        // is x + 1 in positive space.
        this._shiftIdxUp(planId, order);
      }
      const info = this.db
        .prepare(`INSERT INTO steps (plan_id, idx, title, status, context, tools, role, acceptance_criteria, carry_forward, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(planId, order, String(title).trim(), 'pending', String(context ?? ''), jsonArr(tools),
             String(role ?? '').trim(), String(acceptance_criteria ?? ''), String(carry_forward ?? ''), ts, ts);
      const id = Number(info.lastInsertRowid);
      // A step added to an already-active plan is immediately part of the
      // execution roster — freeze its initial assignment now so the transparency
      // trail is complete. Draft plans defer to setPlanStatus('active') below.
      if (plan.status && plan.status !== 'draft' && plan.status !== 'abandoned') {
        this._appendAssignment(id, { reason: '', assigned_by: 'add-step' });
      }
      return id;
    });
    this.touchPlan(planId);
    return this.getStep(newId);
  }

  // Shift all steps in `planId` with `idx >= from` up by one, staged through
  // negative idx values so the UNIQUE(plan_id, idx) index never sees a transient
  // collision during the multi-row UPDATE. Assumes _tx.
  _shiftIdxUp(planId, from) {
    this.db.prepare('UPDATE steps SET idx = -(idx + 1) WHERE plan_id=? AND idx >= ?').run(planId, from);
    this.db.prepare('UPDATE steps SET idx = -idx WHERE plan_id=? AND idx < 0').run(planId);
  }
  // Move step `stepId` from its current idx to `newIdx`, sliding intervening
  // siblings by one so the invariant (contiguous 1..N per plan) holds. Assumes
  // _tx and that newIdx has been validated to be in [1, stepCount].
  _moveStepIdx(planId, stepId, curIdx, newIdx) {
    if (curIdx === newIdx) return;
    // Stage the moving step to a sentinel negative value so its old and new idx
    // never both exist alongside the shifted siblings under the UNIQUE index.
    this.db.prepare('UPDATE steps SET idx = ? WHERE id = ?').run(-999999, stepId);
    if (newIdx > curIdx) {
      // Sliding forward: rows in (curIdx, newIdx] move one slot down. Process
      // ascending so each vacates its old slot before the next row occupies it.
      this.db.prepare('UPDATE steps SET idx = -(idx - 1) WHERE plan_id=? AND idx > ? AND idx <= ?').run(planId, curIdx, newIdx);
    } else {
      // Sliding backward: rows in [newIdx, curIdx) move one slot up.
      this.db.prepare('UPDATE steps SET idx = -(idx + 1) WHERE plan_id=? AND idx >= ? AND idx < ?').run(planId, newIdx, curIdx);
    }
    this.db.prepare('UPDATE steps SET idx = -idx WHERE plan_id=? AND idx < 0 AND id <> ?').run(planId, stepId);
    this.db.prepare('UPDATE steps SET idx = ? WHERE id = ?').run(newIdx, stepId);
  }

  // level 2 — the full step payload: context, tools, criteria, carry-forward,
  // every recorded attempt (the failure log), and outbound links.
  getStep(id, prefetched = null, { known_open_lease = null } = {}) {
    const s = prefetched && Number(prefetched.id) === Number(id) ? prefetched : this._mustStep(id, '*');
    // Attempts are capped to the LAST 10 (oldest→newest) — a step that failed 50×
    // must not drown the payload; attempts_total says how many exist in all.
    const attemptRows = this._prep(
      'step_attempts_recent_with_total',
      'SELECT id, what_tried, result, verdict, role, review_rounds, executor, agent, model, model_source, session_ref, validation_status, validation_errors_json, created_at, COUNT(*) OVER() AS total_count FROM attempts WHERE step_id=? ORDER BY id DESC LIMIT 10',
    ).all(id);
    const attempts_total = Number(attemptRows[0]?.total_count ?? 0) || 0;
    const attempts = attemptRows.reverse().map((attempt) => {
      const { total_count, ...rest } = attempt;
      return rest;
    });
    const links = this._prep('step_links_from', 'SELECT id, to_plan_id, to_step_id, relation, note FROM links WHERE from_step_id=?').all(id);
    const assignments = this._listAssignments(id);
    const activeLease = known_open_lease ?? this._openLeaseForStep(id);
    return {
      id: s.id,
      plan_id: s.plan_id,
      idx: s.idx,
      title: s.title,
      status: s.status,
      context: s.context,
      tools: parseArr(s.tools),
      role: s.role ?? '',
      acceptance_criteria: s.acceptance_criteria,
      carry_forward: s.carry_forward,
      layman: s.layman ?? '',
      verification_disposition: s.verification_disposition ?? '',
      disposition_reason: s.disposition_reason ?? '',
      disposition_at: s.disposition_at ?? '',
      completion_payload_json: s.completion_payload_json ?? '',
      completion_validated_at: s.completion_validated_at ?? '',
      auto_reassignment_count: Number(s.auto_reassignment_count ?? 0) || 0,
      completion_payload: parseObj(s.completion_payload_json || ''),
      completion_payload_present: !!String(s.completion_payload_json || '').trim(),
      completion_payload_validated_at: s.completion_validated_at ?? '',
      completion_payload_version: 2,
      completion_gate_mode: resolveCompletionGateMode(),
      completion_validation_errors: parseArr((attempts.at(-1)?.validation_errors_json) ?? '[]'),
      completion_validation_status: attempts.at(-1)?.validation_status ?? 'legacy_unknown',
      attempts: attempts.map((attempt) => ({
        ...attempt,
        validation_status: ATTEMPT_VALIDATION_STATUS.has(String(attempt.validation_status ?? ''))
          ? attempt.validation_status
          : 'legacy_unknown',
        validation_errors: parseArr(attempt.validation_errors_json || '[]'),
      })),
      attempts_total,
      links,
      notes: this.listNotes(id), // append-only review/feedback thread, ordered
      file_refs: this.listFileRefs({ step_id: id }), // surface only — paths/roles, no content
      assignments, // append-only dispatch-assignment history; last row = current planned intent
      execution_lease: activeLease ? this._leaseRow(activeLease) : null,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  }

  // Plain-English per-step field: settable directly (used by set_layman) or via
  // recordAttempt's optional `layman` param. Distinct from what_tried, which is
  // evidence-heavy and lives on the attempt, not the step.
  setLayman(stepId, text) {
    const s = this._mustStep(stepId, 'plan_id');
    this.db.prepare('UPDATE steps SET layman=?, updated_at=? WHERE id=?').run(String(text ?? ''), now(), stepId);
    this.touchPlan(s.plan_id);
    return this.getStep(stepId);
  }

  updateStep(id, fields) {
    const s = this._mustStep(id, '*');
    const allowed = {};
    if (fields.title != null) allowed.title = String(fields.title);
    if (fields.context != null) allowed.context = String(fields.context);
    if (fields.tools != null) allowed.tools = jsonArr(fields.tools);
    if (fields.role != null) allowed.role = String(fields.role).trim();
    if (fields.acceptance_criteria != null) allowed.acceptance_criteria = String(fields.acceptance_criteria);
    if (fields.carry_forward != null) allowed.carry_forward = String(fields.carry_forward);
    // idx is validated + moved separately: contiguous 1..N per plan (UNIQUE index)
    // means a raw column write would corrupt ordering. _moveStepIdx handles the
    // sibling slide inside _tx; here we just bounds-check and hand it off.
    let newIdx = null;
    if (fields.idx != null) {
      newIdx = Number(fields.idx);
      if (!Number.isInteger(newIdx) || newIdx < 1) throw new Error(`bad idx: ${fields.idx} (must be an integer >= 1)`);
      const count = this.db.prepare('SELECT COUNT(*) c FROM steps WHERE plan_id=?').get(s.plan_id).c;
      if (newIdx > count) throw new Error(`bad idx: ${fields.idx} (plan has ${count} step${count === 1 ? '' : 's'}; must be <= ${count})`);
    }
    // A role change on an already-snapshotted step is a reassignment — append a
    // new revision instead of silently overwriting history. reason is REQUIRED
    // for post-initial changes so the audit trail is meaningful; missing reason
    // on the very first assignment (no prior revision) is allowed and stamped ''.
    const roleChanging = fields.role != null && String(fields.role).trim() !== (s.role ?? '');
    if (roleChanging && this._latestAssignment(id) && !String(fields.reason ?? '').trim()) {
      throw new Error('role change requires a reason (audited reassignment)');
    }
    const keys = Object.keys(allowed);
    if (keys.length || newIdx != null) {
      this._tx(() => {
        if (keys.length) {
          const set = keys.map((k) => `${k}=?`).join(', ');
          this.db.prepare(`UPDATE steps SET ${set}, updated_at=? WHERE id=?`).run(...keys.map((k) => allowed[k]), now(), id);
        }
        if (newIdx != null && newIdx !== s.idx) {
          this._moveStepIdx(s.plan_id, id, s.idx, newIdx);
          this.db.prepare('UPDATE steps SET updated_at=? WHERE id=?').run(now(), id);
        }
        if (roleChanging) {
          this._appendAssignment(id, {
            reason: String(fields.reason ?? '').trim(),
            assigned_by: String(fields.assigned_by ?? '').trim(),
          });
        }
      });
      this.touchPlan(s.plan_id);
    }
    return this.getStep(id);
  }

  // ---- step assignments (planned dispatch, audited history) --------------

  // Compute the resolved dispatch for a step using the same rules as the runner
  // (cwd = process.cwd() at write time). Callers may pass an explicit `cwd`.
  // Returns a flat object matching the step_assignments columns (never null).
  _resolveStepDispatch(step, { cwd = null } = {}) {
    const projectName = this.projectNameForPlan(step.plan_id);
    const r = resolveRole(step.role ?? '', { cwd: cwd ?? null, projectName });
    if (r.mode === 'dispatch') return {
      role: step.role ?? '', agent: r.agent ?? '', model: r.model ?? '', charter: r.charter ?? '',
      resolution_source: r.source ?? 'default',
    };
    // orchestrator-decides: still record the intent (role tag + reason). Agent/model
    // are blank on purpose — we do not fabricate a concrete model when none was pinned.
    return { role: step.role ?? '', agent: '', model: '', charter: '', resolution_source: r.reason ?? 'untagged' };
  }

  _dispatchPolicy(step, {
    explicit_role = null, resolved_model = '', model_catalog = null, dispatch_policy = null, override_reason = '',
  } = {}) {
    const roles = DEFAULT_STAFF_ROLES;
    const models = model_catalog?.models ?? [];
    return evaluateDispatchPolicy({
      step,
      explicit_role: explicit_role ?? (step.role ?? ''),
      candidate_roles: roles,
      resolved_model,
      available_models: models,
      dispatch_policy,
      override_reason,
    });
  }

  _assertDispatchOverrideBeforeMutation(step, {
    explicit_role = '', resolved_model = '', dispatch_policy = null, override_reason = '',
  } = {}) {
    const policy = this._dispatchPolicy(step, {
      explicit_role,
      resolved_model,
      dispatch_policy,
      override_reason,
    });
    const requires = policy.reason_codes?.includes('dispatch_override_reason_required');
    if (requires) {
      const err = new Error('dispatch_override_reason_required');
      err.details = {
        explicit_role: explicit_role || '',
        best_role: policy.best_match?.role || '',
        reason_codes: policy.reason_codes || [],
      };
      throw err;
    }
    return policy;
  }

  _latestAssignment(stepId) {
    return this._prep('latest_assignment', 'SELECT * FROM step_assignments WHERE step_id=? ORDER BY revision DESC LIMIT 1').get(stepId) ?? null;
  }

  _eventAssignmentForStep(stepId) {
    const row = this._latestAssignment(stepId);
    if (row?.id != null) return { assignment_id: Number(row.id), assignment_missing_reason: '' };
    return { assignment_id: null, assignment_missing_reason: 'no_assignment_snapshot' };
  }

  _appendLifecycleEvent(activityId, stepId, {
    event_type,
    phase = '',
    summary = '',
    command_summary = '',
    metadata = {},
    assignment_id = null,
    assignment_missing_reason = '',
    resolve_assignment = true,
    timestamp = now(),
  } = {}) {
    if (!ACTIVITY_EVENT_TYPES.has(event_type)) throw new Error(`bad event_type: ${event_type}`);
    const resolved = resolve_assignment
      ? (assignment_id == null
          ? this._eventAssignmentForStep(stepId)
          : { assignment_id: Number(assignment_id), assignment_missing_reason: '' })
      : {
          assignment_id: assignment_id == null ? null : Number(assignment_id),
          assignment_missing_reason: assignment_id == null
            ? (assignment_missing_reason || 'no_assignment_snapshot')
            : '',
        };
    const missingReason = resolved.assignment_id == null
      ? clamp(assignment_missing_reason || resolved.assignment_missing_reason || 'no_assignment_snapshot', 120)
      : '';
    const ts = clamp(timestamp, 48) || now();
    const info = this._prep(
      'insert_activity_event',
      `INSERT INTO activity_events
        (activity_id, event_type, step_id, assignment_id, assignment_missing_reason, event_timestamp, phase, summary, command_summary, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      activityId,
      event_type,
      Number(stepId),
      resolved.assignment_id,
      missingReason,
      ts,
      clamp(phase ?? '', 96),
      clamp(summary ?? '', 500),
      clamp(command_summary ?? '', 280),
      sanitizeMetadataJson(metadata ?? {}),
      ts,
    );
    if (event_type === 'timeline' || event_type === 'heartbeat_progress') this._compactTimelineEvents(activityId);
    return Number(info.lastInsertRowid);
  }

  _listAssignments(stepId) {
    return this._prep(
      'list_assignments',
      'SELECT id, revision, role, agent, model, charter, resolution_source, context_snapshot, dispatch_policy_json, reason, assigned_by, created_at FROM step_assignments WHERE step_id=? ORDER BY revision',
    ).all(stepId)
      .map((row) => ({
        ...row,
        dispatch_policy_json: row.dispatch_policy_json ?? '',
        dispatch_policy: parseObj(row.dispatch_policy_json || ''),
      }));
  }

  // Append the next revision. Called under _tx by updateStep, snapshot helpers,
  // and assignStep — never write step_assignments outside these paths. Returns
  // the inserted row shape so callers can echo it.
  _appendAssignment(stepId, extra = {}) {
    const s = this._mustStep(stepId, '*');
    const cur = this._resolveStepDispatch(s);
    const policyEvaluation = this._dispatchPolicy(s, {
      explicit_role: s.role ?? '',
      resolved_model: cur.model ?? '',
      dispatch_policy: extra.dispatch_policy ?? null,
      override_reason: extra.override_reason ?? '',
    });
    const policySnapshot = {
      version: policyEvaluation.version,
      dispatch_policy: policyEvaluation.dispatch_policy,
      selected_role: policyEvaluation.selected_role,
      best_match: policyEvaluation.best_match?.role ?? '',
      reason_codes: policyEvaluation.reason_codes ?? [],
      requires_override_reason: !!policyEvaluation.requires_override_reason,
      override_reason: String(extra.override_reason ?? policyEvaluation.override_reason ?? ''),
    };
    const last = this._latestAssignment(stepId);
    const rev = (last?.revision ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO step_assignments
        (step_id, role, agent, model, charter, resolution_source, context_snapshot, dispatch_policy_json, reason, assigned_by, revision, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(stepId, cur.role, cur.agent, cur.model, cur.charter, cur.resolution_source,
          String(s.context ?? ''), JSON.stringify(policySnapshot), String(extra.reason ?? ''),
          String(extra.assigned_by ?? ''), rev, now());
    return this._latestAssignment(stepId);
  }

  // Snapshot every unsnapshotted step of a plan — idempotent. Called from
  // setPlanStatus('active') and from addStep when the owning plan is already
  // active, so newly added steps are captured immediately.
  _snapshotPlanAssignments(planId, { assigned_by = 'plan-activation' } = {}) {
    return this._tx(() => {
      const stepIds = this.db.prepare('SELECT id FROM steps WHERE plan_id=? ORDER BY idx, id').all(planId).map((r) => r.id);
      const captured = [];
      for (const id of stepIds) {
        if (this._latestAssignment(id)) continue; // already snapshotted; do not double-record
        this._appendAssignment(id, { reason: '', assigned_by });
        captured.push(id);
      }
      return captured;
    });
  }

  // Public: force-snapshot a single step (used by callers who add steps to an
  // active plan without going through addStep, e.g. a template instantiation
  // path that wants an explicit freeze).
  snapshotStepAssignment(stepId, opts = {}) {
    return this._tx(() => {
      if (this._latestAssignment(stepId)) return this._latestAssignment(stepId);
      return this._appendAssignment(stepId, { reason: '', assigned_by: opts.assigned_by ?? 'manual' });
    });
  }

  // Explicit reassignment: set a new role (may equal current) AND append a
  // revision with a reason. Prefer this over updateStep for user-facing "change
  // agent" flows — it enforces the reason requirement uniformly regardless of
  // whether the role actually changed (e.g. re-resolve after editing the map).
  assignStep(stepId, {
    role, reason, assigned_by, dispatch_policy = null, override_reason = '',
  }) {
    if (!reason || !String(reason).trim()) throw new Error('reason is required for reassignment');
    return this._tx(() => {
      const s = this._mustStep(stepId, '*');
      const newRole = role != null ? String(role).trim() : (s.role ?? '');
      this._assertDispatchOverrideBeforeMutation(
        { ...s, role: newRole || (s.role ?? ''), dispatch_policy: dispatch_policy ?? null },
        {
          explicit_role: newRole || (s.role ?? ''),
          resolved_model: '',
          dispatch_policy,
          override_reason,
        },
      );
      if (newRole !== (s.role ?? '')) {
        this.db.prepare('UPDATE steps SET role=?, updated_at=? WHERE id=?').run(newRole, now(), stepId);
      }
      this._appendAssignment(stepId, {
        reason: String(reason).trim(),
        assigned_by: String(assigned_by ?? '').trim() || 'user',
        dispatch_policy,
        override_reason,
      });
      this.touchPlan(s.plan_id);
      return this.getStep(stepId);
    });
  }

  // Redo primitive: send the step back to pending, log a review note capturing
  // the reason, and preserve every attempt + assignment history (never wipe
  // them). Optionally append a new assignment revision when a fresh dispatch
  // needs a distinct reason ("try implementer again with a stronger charter").
  redoStep(stepId, { reason, assigned_by } = {}) {
    if (!reason || !String(reason).trim()) throw new Error('reason is required for redo');
    return this._tx(() => {
      const s = this._mustStep(stepId, '*');
      this.db.prepare("UPDATE steps SET status='pending', updated_at=? WHERE id=?").run(now(), stepId);
      this.db.prepare("UPDATE steps SET verification_disposition='', disposition_reason='', disposition_at='' WHERE id=?").run(stepId);
      this.db.prepare('INSERT INTO notes (step_id, author, body, created_at) VALUES (?,?,?,?)')
        .run(stepId, String(assigned_by ?? 'user'), `[redo] ${String(reason).trim()}`, now());
      this.touchPlan(s.plan_id);
      return this.getStep(stepId);
    });
  }

  // ---- execution leases (unavoidable lifecycle primitive) ----------------

  _leaseRow(row) {
    if (!row) return null;
    return {
      id: row.id, plan_id: row.plan_id, step_id: row.step_id, activity_id: row.activity_id ?? null,
      executor: row.executor ?? '', run_id: row.run_id ?? '', session_ref: row.session_ref ?? '',
      role: row.role ?? '', agent: row.agent ?? '',
      requested_model: row.requested_model ?? '', actual_model: row.actual_model ?? '',
      model_source: row.model_source ?? '', child_pid: row.child_pid ?? null,
      claimed_at: row.claimed_at, first_artifact_deadline_at: row.first_artifact_deadline_at ?? '', deadline_at: row.deadline_at ?? '',
      last_heartbeat_at: row.last_heartbeat_at, stale_after_ms: row.stale_after_ms,
      status: row.status, outcome: row.outcome ?? '',
      close_reason: row.close_reason ?? '', stale_reason: row.stale_reason ?? '', closed_at: row.closed_at ?? '',
    };
  }

  _openLeaseForStep(stepId) {
    return this._prep('open_lease_for_step', "SELECT * FROM execution_leases WHERE step_id=? AND status='open' LIMIT 1").get(stepId) ?? null;
  }

  _getLeaseOrThrow(leaseId) {
    const row = this.db.prepare('SELECT * FROM execution_leases WHERE id=?').get(leaseId);
    if (!row) throw new Error(`no execution lease with id ${leaseId}`);
    return row;
  }

  // Atomically open a supervised execution lease: claim the step, create (or
  // join) the paired activity run, insert an open lease. Callers get back the
  // step + lease + activity_key so subsequent heartbeat/close calls can go
  // through the SAME single primitive. `deadline_ms` is enforced by
  // reapStaleLeases; `stale_after_ms` bounds how long a supervisor can go
  // silent before being reaped. Never fabricate telemetry.
  openExecutionLease({
    plan_id, step_id, executor = '', run_id = null, session_ref = null,
    role = '', agent = '', requested_model = '', actual_model = '', model_source = '',
    child_pid = null, deadline_ms = null, stale_after_ms = 120000,
    dispatch_policy = null, lease_policy = null, override_reason = '',
    phase = 'preflight', action_summary = 'claimed via execution lease',
    progress_total = 0, progress_completed = 0, metadata = {},
  } = {}) {
    const pid = Number(plan_id);
    const sid = Number(step_id);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('plan_id must be a positive integer');
    if (!Number.isInteger(sid) || sid < 1) throw new Error('step_id must be a positive integer');
    const step = this._mustStep(sid, '*');
    if (step.plan_id !== pid) throw new Error(`step ${sid} does not belong to plan ${pid}`);
    const generatedRunId = run_id == null;
    const generatedSessionRef = session_ref == null;
    const rid = String(run_id ?? `run-${sid}-${Date.now().toString(36)}`).slice(0, 96);
    const sess = String(session_ref ?? `${executor || 'lease'}-${rid}`).slice(0, 256);
    const canAssumeNewActivity = generatedRunId && generatedSessionRef;
    const leasePolicyNorm = normalizeLeasePolicyInput({
      ...lease_policy,
      stale_after_ms: stale_after_ms ?? lease_policy?.stale_after_ms,
    });
    const staleMs = Math.max(5000, Math.min(
      24 * 3600 * 1000,
      Number(leasePolicyNorm.normalized.stale_after_ms) || 120000,
    ));
    const effectiveDeadlineMs = deadline_ms != null && Number(deadline_ms) > 0
      ? Number(deadline_ms)
      : 0;
    const firstArtifactDeadlineMs = Number(leasePolicyNorm.normalized.first_artifact_deadline_ms) || 0;
    const nowTs = now();
    const deadlineTs = effectiveDeadlineMs > 0
      ? new Date(Date.now() + Math.min(24 * 3600 * 1000, effectiveDeadlineMs)).toISOString()
      : '';
    const firstArtifactDeadlineTs = firstArtifactDeadlineMs > 0
      ? new Date(Date.now() + Math.min(24 * 3600 * 1000, firstArtifactDeadlineMs)).toISOString()
      : '';
    const dispatchPolicyNorm = normalizeDispatchPolicyInput(dispatch_policy, {
      ...step,
      role: String(role || step.role || ''),
    });
    this._assertDispatchOverrideBeforeMutation(
      { ...step, role: String(role || step.role || ''), dispatch_policy: dispatchPolicyNorm.normalized },
      {
        explicit_role: String(role || step.role || ''),
        resolved_model: String(requested_model || ''),
        dispatch_policy: dispatchPolicyNorm.normalized,
        override_reason,
      },
    );
    return this._tx(() => {
      // Reject double-open: the partial UNIQUE(step_id) WHERE status='open' would
      // raise anyway, but returning a clean error keeps the surface tidy.
      const already = this._openLeaseForStep(sid);
      if (already) {
        const err = new Error(`step ${sid} already has an open execution lease (id ${already.id}, executor ${already.executor || 'unknown'})`);
        err.details = { existing_lease_id: already.id, executor: already.executor, claimed_at: already.claimed_at };
        throw err;
      }
      // CAS-claim the step. There are two legitimate patterns:
      //   1) Fresh claim: pending/failed → in_progress inside this transaction.
      //   2) Adopt: caller already claimed via nextStep({claim:true}) so status
      //      is already in_progress; we bind the lease without re-claiming.
      // Anything else (done/blocked/skipped) is not claimable — refuse cleanly.
      const claim = this._prep(
        'claim_step_for_lease',
        "UPDATE steps SET status='in_progress', updated_at=? WHERE id=? AND status IN ('pending','failed')",
      ).run(nowTs, sid);
      if (claim.changes === 0) {
        const cur = this._mustStep(sid, 'status');
        if (cur.status !== 'in_progress') {
          const err = new Error(`step ${sid} is not claimable (current status: ${cur.status})`);
          err.details = { step_status: cur.status };
          throw err;
        }
        // adopted — the step is already in_progress and there is no open lease
      }
      const existingActivityRow = canAssumeNewActivity
        ? null
        : this._prep(
          'activity_by_identity',
          'SELECT * FROM activity_runs WHERE plan_id=? AND step_id=? AND run_id=? AND session_ref=?',
        ).get(pid, sid, rid, sess);
      const leaseMetadata = {
        ...(existingActivityRow ? parseObj(existingActivityRow.metadata || '{}') : {}),
        ...sanitizeMetadata(metadata),
        dispatch_policy: dispatchPolicyNorm.normalized,
        lease_policy: leasePolicyNorm.normalized,
        lease_policy_valid: leasePolicyNorm.ok,
        lease_policy_errors: leasePolicyNorm.errors,
        override_reason: String(override_reason ?? '').trim(),
      };
      const activityRow = this._upsertActivity(
        { plan_id: pid, step_id: sid, run_id: rid, session_ref: sess },
        {
          role, agent, requested_model, actual_model, model_source,
          phase, action_summary, status: 'in_progress',
          progress_completed, progress_total, metadata: leaseMetadata,
        },
        { create_if_missing: true, require_existing: false, assume_new: canAssumeNewActivity },
      );
      const insert = this._prep(
        'insert_execution_lease',
        `INSERT INTO execution_leases
          (plan_id, step_id, activity_id, executor, run_id, session_ref, role, agent, requested_model, actual_model, model_source, child_pid, claimed_at, first_artifact_deadline_at, deadline_at, last_heartbeat_at, stale_after_ms, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open')`,
      ).run(pid, sid, activityRow.id, String(executor ?? ''), rid, sess,
            String(role ?? ''), String(agent ?? ''), String(requested_model ?? ''), String(actual_model ?? ''),
            String(model_source ?? ''), child_pid != null ? Number(child_pid) : null,
            nowTs, firstArtifactDeadlineTs, deadlineTs, nowTs, staleMs);
      const leaseRow = {
        id: Number(insert.lastInsertRowid),
        plan_id: pid,
        step_id: sid,
        activity_id: activityRow.id,
        executor: String(executor ?? ''),
        run_id: rid,
        session_ref: sess,
        role: String(role ?? ''),
        agent: String(agent ?? ''),
        requested_model: String(requested_model ?? ''),
        actual_model: String(actual_model ?? ''),
        model_source: String(model_source ?? ''),
        child_pid: child_pid != null ? Number(child_pid) : null,
        claimed_at: nowTs,
        first_artifact_deadline_at: firstArtifactDeadlineTs,
        deadline_at: deadlineTs,
        last_heartbeat_at: nowTs,
        stale_after_ms: staleMs,
        status: 'open',
        outcome: '',
        close_reason: '',
        stale_reason: '',
        closed_at: '',
      };
      this._appendLifecycleEvent(activityRow.id, sid, {
        event_type: 'start_claimed',
        phase: 'claim',
        summary: 'step claimed for execution lease',
        metadata: {
          lease_id: leaseRow.id,
          executor: String(executor ?? ''),
          run_id: rid,
          session_ref: sess,
        },
        timestamp: nowTs,
      });
      this.touchPlan(pid);
      const stepSnapshot = this.getStep(
        sid,
        { ...step, status: 'in_progress', updated_at: nowTs },
        { known_open_lease: leaseRow },
      );
      return {
        lease: this._leaseRow(leaseRow),
        activity: this._activityRow(activityRow, {
          prefetched_execution_lease_row: leaseRow,
          prefetched_step_snapshot: stepSnapshot,
        }),
        step: stepSnapshot,
      };
    });
  }

  // Heartbeat: bump the lease clock AND upsert the paired activity row. Any
  // provided telemetry (phase/progress/action_summary/actual_model/...) rides
  // through to the activity. Rejects heartbeat on a closed/cancelled lease so
  // an orphaned wrapper cannot resurrect a reaped run.
  heartbeatExecutionLease(leaseId, patch = {}) {
    const lease = this._getLeaseOrThrow(Number(leaseId));
    if (lease.status !== 'open') throw new Error(`execution lease ${leaseId} is ${lease.status}, cannot heartbeat`);
    const nowTs = now();
    return this._tx(() => {
      const identity = { plan_id: lease.plan_id, step_id: lease.step_id, run_id: lease.run_id, session_ref: lease.session_ref };
      const activityRow = this._upsertActivity(
        identity,
        {
          role: patch.role ?? lease.role,
          agent: patch.agent ?? lease.agent,
          requested_model: patch.requested_model ?? lease.requested_model,
          actual_model: patch.actual_model ?? lease.actual_model,
          model_source: patch.model_source ?? lease.model_source,
          phase: patch.phase,
          action_summary: patch.action_summary,
          command_summary: patch.command_summary,
          status: patch.status ?? 'in_progress',
          outcome: patch.outcome,
          verification_state: patch.verification_state,
          blocker: patch.blocker,
          progress_completed: patch.progress_completed,
          progress_total: patch.progress_total,
          file_count: patch.file_count,
          artifact_count: patch.artifact_count,
          recent_artifacts: patch.recent_artifacts,
          metadata: patch.metadata,
        },
        { create_if_missing: false, require_existing: true },
      );
      const setFields = ['last_heartbeat_at=?'];
      const setValues = [nowTs];
      if (patch.actual_model != null) { setFields.push('actual_model=?'); setValues.push(String(patch.actual_model)); }
      if (patch.model_source != null) { setFields.push('model_source=?'); setValues.push(String(patch.model_source)); }
      if (patch.role != null)         { setFields.push('role=?');         setValues.push(String(patch.role)); }
      if (patch.agent != null)        { setFields.push('agent=?');        setValues.push(String(patch.agent)); }
      if (patch.child_pid !== undefined) {
        setFields.push('child_pid=?');
        setValues.push(patch.child_pid == null ? null : Number(patch.child_pid));
      }
      if (patch.deadline_ms != null && Number(patch.deadline_ms) > 0) {
        setFields.push('deadline_at=?');
        setValues.push(new Date(Date.now() + Number(patch.deadline_ms)).toISOString());
      }
      if (patch.first_artifact_deadline_ms != null && Number(patch.first_artifact_deadline_ms) > 0) {
        setFields.push('first_artifact_deadline_at=?');
        setValues.push(new Date(Date.now() + Number(patch.first_artifact_deadline_ms)).toISOString());
      }
      this.db.prepare(`UPDATE execution_leases SET ${setFields.join(', ')} WHERE id=?`).run(...setValues, lease.id);
      this._appendLifecycleEvent(activityRow.id, lease.step_id, {
        event_type: 'heartbeat_progress',
        phase: patch.phase ?? activityRow.phase ?? '',
        summary: patch.action_summary || patch.command_summary || 'heartbeat',
        command_summary: patch.command_summary || '',
        metadata: {
          progress_completed: patch.progress_completed ?? activityRow.progress_completed ?? 0,
          progress_total: patch.progress_total ?? activityRow.progress_total ?? 0,
          verification_state: patch.verification_state ?? activityRow.verification_state ?? '',
          stale_after_ms: Number(lease.stale_after_ms) || 120000,
        },
        timestamp: nowTs,
      });
      return {
        lease: this._leaseRow(this._getLeaseOrThrow(lease.id)),
        activity: this._activityRow(activityRow, {}),
      };
    });
  }

  // Terminalize a lease: append a `terminal` activity event, upsert the
  // activity to a terminal status, optionally record an attempt in the SAME
  // transaction so the whole close is atomic. `disposition` is required when
  // `step_verdict='pass'` — the plan-done gate depends on it downstream.
  closeExecutionLease(leaseId, {
    outcome = 'success', close_reason = '', terminal_summary = 'lease closed',
    stale_reason = '',
    terminal_phase = 'review', terminal_metadata = {},
    verification_state = null,
    step_verdict = null, // pass | fail | partial | blocked (blocked = don't recordAttempt)
    attempt = null, // { what_tried, result, role, executor, agent, model, model_source, session_ref }
    completion_payload = null,
    disposition = null, disposition_reason = '',
  } = {}) {
    const lease = this._getLeaseOrThrow(Number(leaseId));
    if (lease.status !== 'open') {
      // Idempotent close: return current state instead of throwing so retry
      // logic on flaky supervisors doesn't double-terminalize.
      return { lease: this._leaseRow(lease), activity: null, step: this.getStep(lease.step_id), reused: true };
    }
    if (!LEASE_OUTCOME.has(outcome)) throw new Error(`bad lease outcome: ${outcome}`);
    let dispositionCandidate = disposition;
    if (step_verdict === 'pass') {
      dispositionCandidate = dispositionCandidate || 'verified';
      if (!STEP_DISPOSITION_PASS.has(dispositionCandidate)) {
        throw new Error(`disposition "${dispositionCandidate}" cannot accompany step_verdict=pass (only verified|not_applicable)`);
      }
    } else if (dispositionCandidate && !STEP_DISPOSITION.has(dispositionCandidate)) {
      throw new Error(`bad disposition: ${dispositionCandidate}`);
    }
    const nowTs = now();
    const identity = { plan_id: lease.plan_id, step_id: lease.step_id, run_id: lease.run_id, session_ref: lease.session_ref };
    const activityStatus = outcome === 'success' ? 'completed'
      : outcome === 'blocked' ? 'blocked'
      : outcome === 'cancelled' ? 'cancelled'
      : 'failed';
    return this._tx(() => {
      // Terminalize the activity (upsert + terminal event) in this same tx.
      const activityRow = this._upsertActivity(
        identity,
        {
          status: activityStatus,
          outcome: outcome === 'success' ? 'success' : (outcome === 'partial' ? 'partial' : (outcome === 'blocked' ? 'blocked' : (outcome === 'cancelled' ? 'cancelled' : 'failed'))),
          verification_state: verification_state
            ?? (step_verdict === 'pass' ? 'passed' : (step_verdict === 'blocked' ? 'skipped' : (step_verdict === 'partial' ? 'failed' : 'failed'))),
          action_summary: terminal_summary,
          phase: terminal_phase,
        },
        { create_if_missing: false, require_existing: true },
      );
      this._appendLifecycleEvent(activityRow.id, lease.step_id, {
        event_type: 'terminal',
        phase: String(terminal_phase ?? ''),
        summary: terminal_summary,
        metadata: { ...terminal_metadata, close_reason, outcome },
        timestamp: nowTs,
      });
      const lifecycleType = outcome === 'success' ? 'completion' : 'execution_failure';
      this._appendLifecycleEvent(activityRow.id, lease.step_id, {
        event_type: lifecycleType,
        phase: String(terminal_phase ?? ''),
        summary: lifecycleType === 'completion'
          ? 'execution completed'
          : `execution failed (${String(outcome || 'failed')})`,
        metadata: {
          outcome: String(outcome || ''),
          close_reason: String(close_reason || ''),
          stale_reason: String(stale_reason || ''),
          verification_state: verification_state ?? '',
        },
        timestamp: nowTs,
      });
      // Close the lease.
      this.db.prepare(
        "UPDATE execution_leases SET status='closed', outcome=?, close_reason=?, stale_reason=?, closed_at=?, last_heartbeat_at=? WHERE id=?"
      ).run(String(outcome ?? ''), String(close_reason ?? '').slice(0, 200), String(stale_reason ?? '').slice(0, 80), nowTs, nowTs, lease.id);
      // Optional attempt in-tx so telemetry and evidence land together.
      if (step_verdict && attempt) {
        this.recordAttempt(lease.step_id, {
          what_tried: attempt.what_tried ?? terminal_summary,
          result: attempt.result ?? '',
          verdict: step_verdict,
          role: attempt.role ?? lease.role,
          executor: attempt.executor ?? lease.executor,
          agent: attempt.agent ?? lease.agent,
          model: attempt.model ?? lease.actual_model ?? lease.requested_model,
          model_source: attempt.model_source ?? lease.model_source,
          session_ref: attempt.session_ref ?? lease.session_ref,
          completion_payload: attempt.completion_payload ?? completion_payload,
          disposition: dispositionCandidate ?? undefined,
          disposition_reason: disposition_reason || (dispositionCandidate === 'verified' ? 'closed via execution lease' : disposition_reason),
        }, { reconcile: false, reconcile_source: 'close_execution_lease', emit_lifecycle_events: false });
      } else if (dispositionCandidate) {
        // No attempt but explicit disposition (e.g. cancelled/blocked): honor it.
        this.setStepDisposition(
          lease.step_id,
          { disposition: dispositionCandidate, reason: disposition_reason || `lease ${outcome}` },
          { reconcile: false, reconcile_source: 'close_execution_lease' },
        );
      } else if (outcome !== 'success' && !attempt) {
        // Non-success close without an attempt: reset the step so it stays
        // retryable; no attempt row is fabricated. `abandoned` / `cancelled`
        // (e.g. no evidence produced, executor died silently, reaped) hand
        // the step back to `pending` so the next dispatcher can pick it up
        // without needing to see a fabricated failure. `failed` / other
        // outcomes flip it to `failed` so the retry budget still applies.
        const resetTo = (outcome === 'abandoned' || outcome === 'cancelled') ? 'pending' : 'failed';
        this.db.prepare("UPDATE steps SET status=?, updated_at=? WHERE id=? AND status='in_progress'").run(resetTo, nowTs, lease.step_id);
      }
      this.touchPlan(lease.plan_id);
      const stepTerminalized = !!(step_verdict && attempt) || !!dispositionCandidate;
      const stepStatusChanged = outcome !== 'success' && !attempt;
      const stepAlreadyTerminal = ['done', 'skipped', 'blocked'].includes(
        this._mustStep(lease.step_id, 'status').status,
      );
      if (stepTerminalized || stepStatusChanged || stepAlreadyTerminal) {
        this.reconcilePlanTerminalState(lease.plan_id, { source: 'close_execution_lease', strict: true });
      }
      const closedLeaseRow = this._getLeaseOrThrow(lease.id);
      return {
        lease: this._leaseRow(closedLeaseRow),
        activity: this._activityRow(activityRow, {}),
        step: this.getStep(lease.step_id),
      };
    });
  }

  // Reap: close leases whose deadline has passed OR that haven't heartbeaten
  // within `stale_after_ms`. Each reaped lease produces a terminal event, is
  // marked cancelled, and its owning step drops back to `failed` so a fresh
  // supervisor can retry it. Callers may narrow by plan_id.
  _recoverAfterStaleLease({ lease, stale_reason, lease_trigger, dispatch_policy = null, lease_policy = null, override_reason = '' } = {}) {
    const mode = resolveAutoReassignMode();
    const policyEvalStep = this._mustStep(lease.step_id, '*');
    const activityMeta = lease.activity_id
      ? parseObj(this.db.prepare('SELECT metadata FROM activity_runs WHERE id=?').get(lease.activity_id)?.metadata || '{}')
      : {};
    const dispatchPolicyInput = dispatch_policy ?? activityMeta.dispatch_policy ?? null;
    const leasePolicyInput = lease_policy ?? activityMeta.lease_policy ?? null;
    const dispatchPolicyNorm = normalizeDispatchPolicyInput(dispatchPolicyInput, policyEvalStep);
    const leasePolicyNorm = normalizeLeasePolicyInput(leasePolicyInput);
    const policyEval = this._dispatchPolicy(policyEvalStep, {
      explicit_role: policyEvalStep.role ?? '',
      resolved_model: '',
      dispatch_policy: dispatchPolicyNorm.normalized,
      override_reason,
    });
    const latestAssignment = this._latestAssignment(lease.step_id);
    const currentRole = String(latestAssignment?.role ?? policyEvalStep.role ?? '').trim();
    const currentModel = String(latestAssignment?.model ?? '').trim();
    const fallbackCandidates = [
      ...dispatchPolicyNorm.normalized.fallback_roles,
      ...((policyEval.alternatives || []).map((alt) => alt.role)),
    ].filter(Boolean);
    const fallbackRole = fallbackCandidates.find((role) => role !== currentRole) || '';
    if (!fallbackRole) {
      return {
        mode,
        action: 'manual_recovery_required',
        reason: 'no_distinct_fallback_role',
        stale_reason,
        policy_snapshot: dispatchPolicyNorm.normalized,
      };
    }
    const projectName = this.projectNameForPlan(lease.plan_id);
    const fallbackResolution = resolveRole(fallbackRole, { cwd: null, projectName });
    const fallbackModel = fallbackResolution.mode === 'dispatch' ? String(fallbackResolution.model ?? '') : '';
    const duplicateAssignment = fallbackRole === currentRole && fallbackModel === currentModel;
    const stepCount = Number(policyEvalStep.auto_reassignment_count ?? 0) || 0;
    const limit = Number(leasePolicyNorm.normalized.max_auto_reassignments ?? 0);
    if (stepCount >= limit) {
      return {
        mode,
        action: 'manual_recovery_required',
        reason: 'max_auto_reassignments_exhausted',
        stale_reason,
        auto_reassignment_count: stepCount,
        max_auto_reassignments: limit,
      };
    }
    const proposed = {
      role: fallbackRole,
      model: fallbackModel,
      stale_reason,
      lease_trigger: lease_trigger || stale_reason,
      reason_code: stale_reason,
      mode,
      dispatch_policy: dispatchPolicyNorm.normalized,
      lease_policy: leasePolicyNorm.normalized,
      requires_override_reason: !!policyEval.requires_override_reason,
      override_reason: String(override_reason ?? '').trim(),
    };
    if (mode !== 'enforce') return { ...proposed, action: mode === 'advisory' ? 'proposed_only' : 'disabled' };
    if (duplicateAssignment) {
      return {
        ...proposed,
        action: 'manual_recovery_required',
        reason: 'duplicate_assignment_prevented',
      };
    }
    return this._tx(() => {
      const beforeRev = this._latestAssignment(lease.step_id)?.revision ?? 0;
      const roleMismatch = !!policyEval.material_mismatch;
      const recoveryReasonCode = roleMismatch ? 'role_mismatch' : stale_reason;
      const effectiveOverrideReason = String(override_reason ?? '').trim()
        || (roleMismatch ? `auto stale recovery role mismatch (${stale_reason})` : '');
      this.assignStep(lease.step_id, {
        role: fallbackRole,
        reason: roleMismatch
          ? `[role_mismatch|${stale_reason}] stale lease recovery from lease #${lease.id}`
          : `[${stale_reason}] stale lease recovery from lease #${lease.id}`,
        assigned_by: 'auto-reassign',
        dispatch_policy: dispatchPolicyNorm.normalized,
        override_reason: effectiveOverrideReason,
      });
      const after = this._mustStep(lease.step_id, 'auto_reassignment_count');
      const afterRev = this._latestAssignment(lease.step_id)?.revision ?? beforeRev;
      const appended = afterRev > beforeRev;
      if (appended) {
        this.db.prepare('UPDATE steps SET auto_reassignment_count=auto_reassignment_count+1, updated_at=? WHERE id=?')
          .run(now(), lease.step_id);
      }
      return {
        ...proposed,
        action: appended ? 'auto_reassigned' : 'manual_recovery_required',
        reason: appended ? '' : 'assignment_not_appended',
        reason_code: recoveryReasonCode,
        auto_reassignment_count: (Number(after.auto_reassignment_count ?? 0) || 0) + (appended ? 1 : 0),
        max_auto_reassignments: limit,
      };
    });
  }

  _leaseHasArtifactEvidence(lease) {
    const stepRow = this._mustStep(lease.step_id, 'completion_payload_json');
    if (String(stepRow.completion_payload_json ?? '').trim()) return true;
    if (lease.activity_id != null) {
      const activity = this.db.prepare('SELECT artifact_count, recent_artifacts FROM activity_runs WHERE id=?').get(lease.activity_id);
      if (activity) {
        if (Number(activity.artifact_count ?? 0) > 0) return true;
        const recent = parseArr(activity.recent_artifacts || '[]');
        if (Array.isArray(recent) && recent.length > 0) return true;
      }
    }
    const attempt = this.db.prepare(
      "SELECT id FROM attempts WHERE step_id=? AND validation_status='pass' ORDER BY id DESC LIMIT 1"
    ).get(lease.step_id);
    return !!attempt;
  }

  _latestActivityForStep(stepId, { include_terminal = true } = {}) {
    const where = include_terminal
      ? 'step_id=?'
      : "step_id=? AND status IN ('queued','in_progress','blocked')";
    return this.db.prepare(
      `SELECT * FROM activity_runs WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT 1`
    ).get(stepId) ?? null;
  }

  reapStaleLeases({
    plan_id = null, now_ms = Date.now(), grace_ms = 0, dispatch_policy = null, lease_policy = null, override_reason = '',
  } = {}) {
    const nowIso = new Date(now_ms).toISOString();
    const filterPlan = plan_id != null ? Number(plan_id) : null;
    const openLeases = this.db.prepare(
      filterPlan != null
        ? "SELECT * FROM execution_leases WHERE status='open' AND plan_id=?"
        : "SELECT * FROM execution_leases WHERE status='open'"
    ).all(...(filterPlan != null ? [filterPlan] : []));
    const reaped = [];
    const mode = resolveAutoReassignMode();
    for (const lease of openLeases) {
      const hbTs = Date.parse(lease.last_heartbeat_at || '');
      const faTs = Date.parse(lease.first_artifact_deadline_at || '');
      const dlTs = Date.parse(lease.deadline_at || '');
      const staleFor = Number.isFinite(hbTs) ? now_ms - hbTs : Infinity;
      const staleAfter = Number(lease.stale_after_ms) || 120000;
      const staleBreach = staleFor > (staleAfter + grace_ms);
      const overallDeadlineBreach = Number.isFinite(dlTs) && now_ms > dlTs + grace_ms;
      const firstArtifactDeadlineBreach = Number.isFinite(faTs)
        && now_ms > faTs + grace_ms
        && !this._leaseHasArtifactEvidence(lease);
      if (!staleBreach && !overallDeadlineBreach && !firstArtifactDeadlineBreach) continue;
      const reason = firstArtifactDeadlineBreach
        ? 'reap:first_artifact_deadline_miss'
        : overallDeadlineBreach
          ? 'reap:deadline_exceeded'
          : 'reap:stale_heartbeat';
      const staleReason = firstArtifactDeadlineBreach ? 'artifact_deadline_miss' : 'lease_timeout';
      try {
        let outcome = null;
        let recovery = null;
        const run = () => {
          outcome = this.closeExecutionLease(lease.id, {
            outcome: 'cancelled',
            close_reason: reason,
            stale_reason: staleReason,
            terminal_summary: firstArtifactDeadlineBreach
              ? `first artifact deadline missed (${Math.max(0, now_ms - faTs)}ms past ${lease.first_artifact_deadline_at})`
              : overallDeadlineBreach
                ? `deadline exceeded (${Math.max(0, now_ms - dlTs)}ms past ${lease.deadline_at})`
                : `no heartbeat for ${staleFor}ms (limit ${staleAfter}ms)`,
            terminal_metadata: {
              reason,
              stale_for_ms: staleFor,
              first_artifact_deadline_at: lease.first_artifact_deadline_at || '',
              deadline_at: lease.deadline_at || '',
              reaped_at: nowIso,
            },
          });
          recovery = this._recoverAfterStaleLease({
            lease,
            stale_reason: staleReason,
            lease_trigger: reason,
            dispatch_policy,
            lease_policy,
            override_reason,
          });
          const activityId = outcome?.activity?.id ?? lease.activity_id ?? null;
          if (activityId) {
            this._appendLifecycleEvent(activityId, lease.step_id, {
              event_type: 'reassignment_recovery',
              phase: 'recovery',
              summary: recovery?.action === 'auto_reassigned'
                ? 'stale lease recovered via auto reassignment'
                : 'stale lease requires manual recovery',
              metadata: {
                action: recovery?.action || 'unknown',
                reason: recovery?.reason || '',
                reason_code: recovery?.reason_code || staleReason,
                stale_reason: staleReason,
                lease_trigger: reason,
                auto_reassignment_count: recovery?.auto_reassignment_count ?? null,
              },
              timestamp: nowIso,
            });
          }
        };
        if (mode === 'enforce') this._tx(run);
        else run();
        reaped.push({ lease_id: lease.id, plan_id: lease.plan_id, step_id: lease.step_id, reason, stale_reason: staleReason, recovery, outcome });
      } catch (e) {
        reaped.push({ lease_id: lease.id, plan_id: lease.plan_id, step_id: lease.step_id, reason, stale_reason: staleReason, error: e.message });
      }
    }
    return { reaped_count: reaped.length, reaped };
  }

  getExecutionLease(leaseId) { return this._leaseRow(this._getLeaseOrThrow(Number(leaseId))); }

  listExecutionLeases({ plan_id = null, step_id = null, status = null } = {}) {
    const filters = [];
    const values = [];
    if (plan_id != null) { filters.push('plan_id=?'); values.push(Number(plan_id)); }
    if (step_id != null) { filters.push('step_id=?'); values.push(Number(step_id)); }
    if (status)          { filters.push('status=?');  values.push(String(status)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM execution_leases ${where} ORDER BY id DESC LIMIT 200`).all(...values).map((r) => this._leaseRow(r));
  }

  // Aggregated plan-level roster for UIs: per-step { initial, planned, current
  // (live re-resolution), actual (last attempt provenance), drift flags }.
  // Pure read; the live re-resolution uses the caller-supplied `cwd` so a
  // repo-local .plan-roles.json can override — the MCP server passes null.
  getPlanRoster(planId, { cwd = null } = {}) {
    const plan = this.openPlan(planId);
    const activationSnapshotted = plan.status !== 'draft';
    const modelCatalog = listCursorModels();
    const rows = plan.steps.map((idxRow) => {
      const step = this.getStep(idxRow.id);
      const assignments = step.assignments;
      const initial = assignments[0] ?? null;
      const planned = assignments.at(-1) ?? null; // latest revision = current intent
      const live = this._resolveStepDispatch({ ...step, plan_id: plan.id }, { cwd });
      const policy = this._dispatchPolicy(
        { ...step, plan_id: plan.id },
        { explicit_role: step.role ?? '', resolved_model: live.model ?? '', model_catalog: modelCatalog },
      );
      const lastAttempt = step.attempts.at(-1) ?? null;
      const actual = lastAttempt
        ? {
            role: lastAttempt.role ?? '', agent: lastAttempt.agent ?? '', model: lastAttempt.model ?? '',
            model_source: lastAttempt.model_source ?? '', executor: lastAttempt.executor ?? '',
            session_ref: lastAttempt.session_ref ?? '', verdict: lastAttempt.verdict, created_at: lastAttempt.created_at,
          }
        : null;
      const drift = {
        role_tag_changed: planned ? planned.role !== (step.role ?? '') : false,
        map_resolution_changed: planned
          ? (planned.agent !== live.agent || planned.model !== live.model || planned.charter !== live.charter)
          : false,
        context_changed: planned ? planned.context_snapshot !== (step.context ?? '') : false,
        execution_diverged: !!(actual && planned && (
          (actual.agent && actual.agent !== planned.agent) ||
          (actual.model && actual.model !== planned.model))),
      };
      return {
        step_id: step.id, idx: step.idx, title: step.title, status: step.status, role: step.role ?? '',
        acceptance_criteria: step.acceptance_criteria,
        planned_context_preview: (step.context ?? '').slice(0, 400),
        initial, planned, live, actual, drift, assignments, dispatch_policy: policy,
      };
    });
    return {
      plan_id: plan.id, plan_title: plan.title, plan_status: plan.status,
      snapshotted: activationSnapshotted,
      steps: rows,
    };
  }

  setStepStatus(id, status, { reconcile = true, reconcile_source = 'set_step_status' } = {}) {
    if (!STEP_STATUS.has(status)) throw new Error(`bad step status: ${status}`);
    const s = this._mustStep(id, 'plan_id, verification_disposition');
    this.db.prepare('UPDATE steps SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
    // Auto-disposition for skipped: skipping a step is a deliberate "not
    // applicable" outcome; recording that here (instead of leaving
    // disposition blank) preserves back-compat for callers that don't yet know
    // about setStepDisposition, while still letting `deferred`/`blocked`
    // require explicit reason via setStepDisposition. `done` sees an
    // auto-`legacy_unknown` so the ambiguity is surfaced rather than silently
    // treated as verified.
    const priorDisp = s.verification_disposition ?? '';
    if (status === 'skipped' && !priorDisp) {
      this._setStepDispositionRow(id, 'not_applicable', 'auto: setStepStatus(skipped)');
    } else if (status === 'done' && !priorDisp) {
      this._setStepDispositionRow(id, 'legacy_unknown', 'auto: setStepStatus(done) without record_attempt');
    } else if (status === 'pending' || status === 'in_progress' || status === 'failed') {
      // A step returning to active work invalidates any prior disposition —
      // the audit trail should not claim it as still verified.
      if (priorDisp) this._setStepDispositionRow(id, '', '');
    }
    this.touchPlan(s.plan_id);
    if (reconcile) this.reconcilePlanTerminalState(s.plan_id, { source: reconcile_source, strict: true });
    return this.getStep(id);
  }

  // Write a note FORWARD to a step (typically the next one) — the explicit
  // "carry this context across the reset" channel.
  writeCarryForward(stepId, note, { append = true } = {}) {
    const s = this._mustStep(stepId, 'plan_id, carry_forward');
    const next = append && s.carry_forward
      ? `${s.carry_forward}\n${String(note)}`
      : String(note);
    this.db.prepare('UPDATE steps SET carry_forward=?, updated_at=? WHERE id=?').run(next, now(), stepId);
    this.touchPlan(s.plan_id);
    return this.getStep(stepId);
  }

  // The whole "don't repeat past pitfalls" mechanism: log what was tried + how it went.
  // Optional `layman` writes the step's plain-English box alongside the attempt —
  // a convenience so the executor doesn't need a second call (set_layman still works too).
  // Actual-execution provenance (agent/model/model_source/session_ref) is optional and
  // stored verbatim — an empty string is treated as "unknown" downstream so we never
  // invent a concrete model we did not observe.
  recordAttempt(stepId, { what_tried, result, verdict, role, review_rounds, executor,
                          agent, model, model_source, session_ref, layman,
                          completion_payload, disposition, disposition_reason } = {},
  { reconcile = true, reconcile_source = 'record_attempt', emit_lifecycle_events = true } = {}) {
    const stepRow = this._mustStep(stepId, 'plan_id, completion_payload_json, completion_validated_at');
    if (!what_tried || !String(what_tried).trim()) throw new Error('what_tried is required');
    const v = verdict ?? 'fail';
    if (!VERDICTS.has(v)) throw new Error(`bad verdict: ${v} (pass|fail|partial)`);
    const gateMode = resolveCompletionGateMode();
    const hasCompletionPayload = completion_payload != null && completion_payload !== '';
    const validation = hasCompletionPayload || v === 'pass'
      ? validateCompletionPayload(completion_payload, { claimed_pass: v === 'pass' })
      : { ok: false, errors: [], normalizedPayload: null };
    const isMissingPayload = validation.errors.some((e) => e.code === 'completion_json_missing');
    const validationStatus = validation.ok
      ? 'pass'
      : (isMissingPayload ? 'legacy_unknown' : (gateMode === 'off' ? 'legacy_unknown' : 'fail'));
    const validationErrorsJson = (!validation.ok && gateMode !== 'off')
      ? JSON.stringify(validation.errors)
      : '';
    if (v === 'pass' && gateMode === 'enforce' && !validation.ok) {
      const codes = validation.errors.map((e) => e.code).join(',');
      throw new Error(`completion_gate_rejected:${codes}`);
    }
    // Verification disposition on a passing attempt is now first-class. Default
    // to `verified` so existing callers keep working; explicit `disposition`
    // overrides. `deferred`/`blocked`/`legacy_unknown` are NOT valid pass
    // dispositions — a step marked pass without evidence of verification would
    // silently short-circuit the plan-done gate downstream.
    let dispositionToApply = null;
    let dispositionReasonToApply = '';
    if (disposition != null && disposition !== '') {
      if (!STEP_DISPOSITION.has(disposition)) throw new Error(`bad disposition: ${disposition}`);
      if (v === 'pass' && !STEP_DISPOSITION_PASS.has(disposition)) {
        throw new Error(`disposition "${disposition}" cannot accompany verdict=pass (only verified|not_applicable)`);
      }
      dispositionToApply = disposition;
      dispositionReasonToApply = String(disposition_reason ?? '').trim();
    } else if (v === 'pass') {
      dispositionToApply = 'verified';
      dispositionReasonToApply = 'auto-verified: record_attempt(pass)';
    }
    this._tx(() => {
      const ts = now();
      this.db.prepare('INSERT INTO attempts (step_id, what_tried, result, verdict, role, review_rounds, executor, agent, model, model_source, session_ref, validation_status, validation_errors_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(stepId, String(what_tried), String(result ?? ''), v,
             String(role ?? '').trim(), Math.max(0, Number(review_rounds ?? 0) | 0), String(executor ?? '').trim(),
             String(agent ?? '').trim(), String(model ?? '').trim(),
             String(model_source ?? '').trim(), String(session_ref ?? '').trim(),
             ATTEMPT_VALIDATION_STATUS.has(validationStatus) ? validationStatus : 'legacy_unknown',
             validationErrorsJson, ts);
      // a passing attempt advances the step to done; a fail marks it failed (not blocked — still retryable)
      // (setStepStatus also touches the plan, so no extra touchPlan here)
      if (v === 'pass') this.setStepStatus(stepId, 'done', { reconcile: false, reconcile_source });
      else this.setStepStatus(stepId, 'failed', { reconcile: false, reconcile_source });
      if (v === 'pass' && validation.ok && validation.normalizedPayload) {
        this.db.prepare('UPDATE steps SET completion_payload_json=?, completion_validated_at=?, updated_at=? WHERE id=?')
          .run(JSON.stringify(validation.normalizedPayload), now(), now(), stepId);
      } else if (v === 'pass' && !validation.ok && gateMode !== 'enforce') {
        // Warn/off modes never fabricate machine-checkable success evidence.
        if (!String(stepRow.completion_payload_json ?? '').trim() || stepRow.completion_validated_at == null) {
          this.db.prepare("UPDATE steps SET completion_payload_json='', completion_validated_at=COALESCE(completion_validated_at, ''), updated_at=? WHERE id=?")
            .run(now(), stepId);
        }
      }
      if (dispositionToApply != null) {
        this._setStepDispositionRow(stepId, dispositionToApply, dispositionReasonToApply);
      }
      if (layman != null) this.setLayman(stepId, layman);
      const activityRow = emit_lifecycle_events ? this._latestActivityForStep(stepId, { include_terminal: true }) : null;
      if (activityRow && emit_lifecycle_events) {
        if (!validation.ok && validation.errors.length) {
          this._appendLifecycleEvent(activityRow.id, stepId, {
            event_type: 'validation_failure',
            phase: 'validation',
            summary: 'completion payload validation failed',
            metadata: {
              verdict: v,
              validation_status: validationStatus,
              reason_codes: validation.errors.map((e) => e.code),
            },
            timestamp: ts,
          });
        }
        if (v === 'pass') {
          this._appendLifecycleEvent(activityRow.id, stepId, {
            event_type: 'completion',
            phase: 'validation',
            summary: 'step completion recorded',
            metadata: {
              validation_status: validationStatus,
              disposition: dispositionToApply ?? '',
            },
            timestamp: ts,
          });
        } else {
          this._appendLifecycleEvent(activityRow.id, stepId, {
            event_type: 'execution_failure',
            phase: 'attempt',
            summary: 'step attempt failed',
            metadata: {
              verdict: v,
              validation_status: validationStatus,
            },
            timestamp: ts,
          });
        }
      }
      if (reconcile) this.reconcilePlanTerminalState(stepRow.plan_id, { source: reconcile_source, strict: true });
    });
    return this.getStep(stepId);
  }

  // Explicit disposition setter for admin/UI flows. Used to reconcile steps
  // that were closed outside the recordAttempt path (raw setStepStatus,
  // orphan cleanup, deferred/blocked audit reconciliation).
  setStepDisposition(stepId, { disposition, reason } = {}, { reconcile = true, reconcile_source = 'set_step_disposition' } = {}) {
    const s = this._mustStep(stepId, 'plan_id, status');
    if (!STEP_DISPOSITION.has(disposition)) throw new Error(`bad disposition: ${disposition} (verified|not_applicable|deferred|blocked|legacy_unknown)`);
    if (!disposition) throw new Error('disposition is required');
    if (['deferred', 'blocked', 'not_applicable'].includes(disposition) && !String(reason ?? '').trim()) {
      throw new Error(`disposition "${disposition}" requires a reason`);
    }
    this._setStepDispositionRow(stepId, disposition, String(reason ?? '').trim());
    this.touchPlan(s.plan_id);
    if (reconcile) this.reconcilePlanTerminalState(s.plan_id, { source: reconcile_source, strict: true });
    return this.getStep(stepId);
  }

  _setStepDispositionRow(stepId, disposition, reason) {
    this.db.prepare(
      'UPDATE steps SET verification_disposition=?, disposition_reason=?, disposition_at=?, updated_at=? WHERE id=?'
    ).run(String(disposition), String(reason ?? ''), now(), now(), stepId);
  }

  // The driver primitive for auto-progression: hand back the next WORKABLE step
  // (lowest idx not done/skipped/blocked, with every builds_on/blocks dependency
  // already done) WITH full context. Embeds cross-plan
  // `lessons` — relevant past failures from ANY plan — so pitfalls hit elsewhere
  // surface before you repeat them. 'blocked' steps wait on a human, so they are
  // skipped (like nextPlan skips blocked plans) rather than wedging the steps
  // behind them. Four shapes:
  //   step object                 → work this (may carry skipped_blocked_steps)
  //   { all_blocked: true }       → every unclaimed step waits
  //   { all_in_progress: true }   → active executors own all remaining work
  //   null                        → plan complete (nothing left to do)
  // Shared dependency gate (nextStep + readySteps MUST agree): an outbound
  // builds_on/blocks link from stepId to a step that is not yet done/skipped
  // means the prerequisite hasn't landed. Plan-level links (to_plan_id only,
  // no to_step_id) can't be status-checked, so they're ignored here — they
  // never gate a step. Returns the list of unmet to_step_ids (empty = satisfied).
  _unmetDeps(stepId) {
    return this.db.prepare(`
      SELECT l.to_step_id FROM links l JOIN steps d ON l.to_step_id = d.id
      WHERE l.from_step_id=? AND l.relation IN ('builds_on','blocks') AND d.status NOT IN ('done','skipped')`)
      .all(stepId).map((r) => r.to_step_id);
  }
  _depsSatisfied(step) { return this._unmetDeps(step.id).length === 0; }

  //
  // With { claim: true } the selection and the pending→in_progress status
  // transition happen atomically inside a single _tx, and steps already in
  // `in_progress` are skipped — the runner uses this so two concurrent
  // dispatchers can never hand out the same step. Peek mode (claim:false, the
  // default) keeps today's behavior bit-for-bit for existing agent flows that
  // rely on next_step being idempotent.
  nextStep(planId, { claim = false, executor = '' } = {}) {
    this._mustPlan(planId);
    const pick = () => {
      const allRemaining = this.db
        .prepare("SELECT id, idx, title, status FROM steps WHERE plan_id=? AND status NOT IN ('done','skipped') ORDER BY idx, id")
        .all(planId);
      if (!allRemaining.length) return { done: true };
      const inProgress = allRemaining.filter((r) => r.status === 'in_progress');
      const remaining = claim
        ? allRemaining.filter((r) => r.status !== 'in_progress')
        : allRemaining;
      // Claimed work is not completion. Surface it explicitly so another runner
      // pauses instead of marking the plan done while an executor is still active.
      if (!remaining.length) return { allInProgress: inProgress };
      // Dependency gate: an outbound builds_on/blocks link to a step that is not yet
      // done/skipped means this step's prerequisite hasn't landed — skip it like a
      // blocked step (reason 'dependency') instead of handing it out to fail.
      const blocked = remaining.filter((r) => r.status === 'blocked');
      const depWaiting = [];
      let workable = null;
      for (const r of remaining) {
        if (r.status === 'blocked') continue;
        const deps = this._unmetDeps(r.id);
        if (deps.length) { depWaiting.push({ ...r, waiting_on_step_ids: deps }); continue; }
        workable = r; break;
      }
      return { workable, blocked, depWaiting };
    };
    const CLAIM_RACE = Symbol('claim-race');
    const select = () => {
      const picked = pick();
      if (picked.done) return null;
      if (picked.allInProgress) return {
        plan_id: planId,
        all_in_progress: true,
        active_steps: picked.allInProgress.map(({ id, idx, title }) => ({ id, idx, title })),
      };
      const { workable, blocked, depWaiting } = picked;
      const describe = (rows) => rows.map(({ id, idx, title, waiting_on_step_ids }) => ({
        id, idx, title,
        reason: waiting_on_step_ids ? 'dependency' : 'blocked',
        ...(waiting_on_step_ids ? { waiting_on_step_ids } : {}),
      }));
      if (!workable) {
        return {
          plan_id: planId,
          all_blocked: true,
          blocked_steps: describe([...blocked, ...depWaiting]),
        };
      }
      if (claim) {
        // Compare-and-set the claim: only flip the status if nobody else has
        // done so since we picked. Zero changes => a concurrent dispatcher won;
        // callers retry (which will now surface `in_progress` and hop to the
        // next workable step).
        const info = this.db.prepare(
          "UPDATE steps SET status='in_progress', updated_at=? WHERE id=? AND status IN ('pending','failed')"
        ).run(now(), workable.id);
        if (info.changes === 0) return CLAIM_RACE;
        this.touchPlan(planId);
      }
      const step = this.getStep(workable.id);
      step.lessons = this.getLessons({ step_id: workable.id, limit: 5 });
      const live = this._resolveStepDispatch(step, {});
      step.dispatch_policy = this._dispatchPolicy(step, { resolved_model: live.model ?? '' });
      const skipped = describe([...blocked, ...depWaiting].filter((b) => b.idx < workable.idx));
      if (skipped.length) step.skipped_blocked_steps = skipped;
      if (claim) {
        step.claimed = true;
        if (executor) step.claimed_by = String(executor);
      }
      return step;
    };
    if (!claim) return select();
    // A concurrent claimant may win between our read and compare-and-set. End
    // this transaction and repick from a fresh snapshot instead of leaking a
    // transient MCP error to the caller.
    while (true) {
      const result = this._tx(select);
      if (result !== CLAIM_RACE) return result;
    }
  }

  // Atomic compare-and-set claim on a specific step: pending/failed → in_progress.
  // Runners and any autonomous dispatcher should use this over a peek + set_status
  // pair so two callers can't take the same step. Returns { claimed: true } on
  // success, { claimed: false, current_status } if someone else got there first.
  claimStep(stepId, { executor = '' } = {}) {
    const s = this._mustStep(stepId, 'status, plan_id');
    return this._tx(() => {
      const info = this.db.prepare(
        "UPDATE steps SET status='in_progress', updated_at=? WHERE id=? AND status IN ('pending','failed')"
      ).run(now(), stepId);
      if (info.changes === 0) return { claimed: false, step_id: stepId, current_status: s.status };
      this.touchPlan(s.plan_id);
      return { claimed: true, step_id: stepId, ...(executor ? { claimed_by: String(executor) } : {}) };
    });
  }

  // The concurrently-launchable frontier: EVERY pending/failed, non-blocked step in the
  // plan whose deps are satisfied (not just the lowest-idx one — that's nextStep's
  // job). Uses the SAME _depsSatisfied gate as nextStep so the two agree by
  // construction. Full step payload per entry (same shape nextStep hands out),
  // each with lessons embedded so a dispatched agent has everything it needs.
  //
  // With { claim:true }, claim the whole frontier in one transaction before
  // returning it. This closes the race where two interactive orchestrators both
  // call ready_steps, see the same pending frontier, and fan out duplicate work.
  // With { limit:N }, claim at most N steps (unlimited when omitted).
  readySteps(planId, { claim = false, executor = '', limit = null } = {}) {
    this._mustPlan(planId);
    const claimLimit = limit == null ? Infinity : Math.max(0, Math.floor(Number(limit) || 0));
    const run = claim ? (fn) => this._tx(fn) : (fn) => fn();
    return run(() => {
      const pending = this.db
        .prepare("SELECT id, idx FROM steps WHERE plan_id=? AND status IN ('pending','failed') ORDER BY idx, id")
        .all(planId);
      let ready = pending.filter((r) => this._depsSatisfied(r));
      if (claim && ready.length) {
        const claimOne = this.db.prepare(
          "UPDATE steps SET status='in_progress', updated_at=? WHERE id=? AND status IN ('pending','failed')"
        );
        const claimed = [];
        for (const r of ready) {
          if (claimed.length >= claimLimit) break;
          if (claimOne.run(now(), r.id).changes === 1) claimed.push(r);
        }
        ready = claimed;
        if (ready.length) this.touchPlan(planId);
      } else if (!claim && Number.isFinite(claimLimit) && claimLimit !== Infinity) {
        ready = ready.slice(0, claimLimit);
      }
      return ready.map((r) => {
        const step = this.getStep(r.id);
        step.lessons = this.getLessons({ step_id: r.id, limit: 5 });
        const live = this._resolveStepDispatch(step, {});
        step.dispatch_policy = this._dispatchPolicy(step, { resolved_model: live.model ?? '' });
        if (claim) {
          step.claimed = true;
          if (executor) step.claimed_by = String(executor);
        }
        return step;
      });
    });
  }

  // Cross-plan failure memory: IDF-weighted lexical match of `terms` (or a step's
  // title+tools) against EVERY non-pass attempt in EVERY plan. Returns the most
  // relevant "tried X → got Y, don't repeat", excluding the step's own attempts.
  getLessons({ terms = '', step_id = null, limit = 5, all = false } = {}) {
    let q = String(terms || '');
    let scopeProject = this.currentProjectId();
    if (step_id != null) {
      const st = this.db.prepare('SELECT s.title, s.tools, p.project_id FROM steps s JOIN plans p ON s.plan_id=p.id WHERE s.id=?').get(step_id);
      if (st) { q = `${q} ${st.title} ${parseArr(st.tools).join(' ')}`; scopeProject = st.project_id ?? 1; }
    }
    const qToks = [...new Set(tokenize(q))];
    if (!qToks.length) return [];
    const rows = this.db.prepare(`
      SELECT a.id attempt_id, a.what_tried, a.result, a.verdict, a.created_at,
             s.id step_id, s.title step_title, s.plan_id, p.title plan_title, p.project_id
      FROM attempts a JOIN steps s ON a.step_id = s.id JOIN plans p ON s.plan_id = p.id
      WHERE a.verdict != 'pass'`).all()
      .filter((r) => r.step_id !== step_id && (all || (r.project_id ?? 1) === scopeProject));
    if (!rows.length) return [];
    const entries = rows.map((r) => ({ doc: r, toks: new Set(tokenize(`${r.step_title} ${r.what_tried} ${r.result}`)) }));
    return idfRank(entries, qToks, limit, (a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((x) => ({
        plan_id: x.doc.plan_id, plan_title: x.doc.plan_title,
        step_id: x.doc.step_id, step_title: x.doc.step_title,
        what_tried: x.doc.what_tried, result: x.doc.result, verdict: x.doc.verdict,
        score: Math.round(x.score * 100) / 100,
      }));
  }

  // ---- notes (append-only review/feedback thread on a step) --------------

  addNote(stepId, { author, body }) {
    this._mustStep(stepId);
    if (!body || !String(body).trim()) throw new Error('note body is required');
    this.db.prepare('INSERT INTO notes (step_id, author, body, created_at) VALUES (?,?,?,?)')
      .run(stepId, String(author ?? '').trim(), String(body), now());
    return this.getStep(stepId);
  }

  listNotes(stepId) {
    return this._prep('list_notes_by_step', 'SELECT id, author, body, created_at FROM notes WHERE step_id=? ORDER BY id').all(stepId);
  }

  // ---- links -------------------------------------------------------------

  link(fromStepId, { to_plan_id, to_step_id, relation, note }) {
    this._mustStep(fromStepId);
    if (to_plan_id == null && to_step_id == null) throw new Error('link needs a to_plan_id or to_step_id');
    const rel = relation ?? 'references';
    if (!RELATIONS.has(rel)) throw new Error(`bad relation: ${rel}`);
    if (to_plan_id != null) this._mustPlan(to_plan_id);
    if (to_step_id != null) this._mustStep(to_step_id);
    const info = this.db
      .prepare('INSERT INTO links (from_step_id, to_plan_id, to_step_id, relation, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(fromStepId, to_plan_id ?? null, to_step_id ?? null, rel, String(note ?? ''), now());
    return { id: Number(info.lastInsertRowid), from_step_id: fromStepId, to_plan_id: to_plan_id ?? null, to_step_id: to_step_id ?? null, relation: rel, note: note ?? '' };
  }

  // ---- file references (cited, read on demand) ---------------------------

  addFileRef({ plan_id, step_id, path, role, note }) {
    if (!path || !String(path).trim()) throw new Error('file path is required');
    let pid = plan_id;
    if (step_id != null) pid = this._mustStep(step_id, 'plan_id').plan_id;
    if (pid == null) throw new Error('provide step_id or plan_id');
    this._mustPlan(pid);
    const r = role ?? 'reference';
    if (!FILE_ROLES.has(r)) throw new Error(`bad role: ${r} (primary|dependency|related|reference)`);
    const info = this.db.prepare('INSERT INTO file_refs (plan_id, step_id, path, role, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(pid, step_id ?? null, String(path).trim(), r, String(note ?? ''), now());
    return this.getFileRef(Number(info.lastInsertRowid));
  }

  getFileRef(id) {
    const r = this.db.prepare('SELECT * FROM file_refs WHERE id=?').get(id);
    if (!r) throw new Error(`no file ref with id ${id}`);
    return { id: r.id, plan_id: r.plan_id, step_id: r.step_id ?? null, path: r.path, role: r.role, note: r.note, created_at: r.created_at };
  }

  // Surface ONLY — paths + roles + notes, never content.
  listFileRefs({ step_id, plan_id, plan_level } = {}) {
    let rows = [];
    if (step_id != null) rows = this._prep('file_refs_by_step', 'SELECT * FROM file_refs WHERE step_id=? ORDER BY id').all(step_id);
    else if (plan_id != null) rows = plan_level
      ? this._prep('file_refs_plan_level', 'SELECT * FROM file_refs WHERE plan_id=? AND step_id IS NULL ORDER BY id').all(plan_id)
      : this._prep('file_refs_by_plan', 'SELECT * FROM file_refs WHERE plan_id=? ORDER BY id').all(plan_id);
    return rows.map((r) => ({ id: r.id, plan_id: r.plan_id, step_id: r.step_id ?? null, path: r.path, role: r.role, note: r.note }));
  }

  // EXPAND — read the file on demand (the only call that loads bytes).
  //
  // TRUST BOUNDARY: this reads whatever local path was stored on the file_ref,
  // which the agent supplied. plan-ledger runs as a single-user local tool and
  // trusts its own operator, but a prompt-injected agent could still ask to
  // read secrets on disk. Two cheap safeguards, applied unconditionally:
  //   (1) refuse to read regular files above `maxFileBytes` (default 5 MB) —
  //       a hard belt on accidental "please attach my 200 MB pcap" mistakes,
  //   (2) still cap the returned text at `maxBytes` characters (default 60k)
  //       so the caller always gets a preview it can reason about.
  // Set PLAN_LEDGER_MAX_FILE_BYTES=0 to disable the file-size gate entirely.
  readFileRef(id, { maxBytes = 60000, maxFileBytes } = {}) {
    const r = this.getFileRef(id);
    let stat;
    try { stat = statSync(r.path); } catch { return { ...r, exists: false, error: `file not found at ${r.path}` }; }
    const envCap = Number(process.env.PLAN_LEDGER_MAX_FILE_BYTES);
    const hardCap = maxFileBytes != null ? Number(maxFileBytes)
      : Number.isFinite(envCap) ? envCap : 5 * 1024 * 1024;
    if (hardCap > 0 && stat.size > hardCap) {
      return { ...r, exists: true, bytes: stat.size, truncated: true,
        error: `file too large: ${stat.size} bytes > ${hardCap} byte cap (set PLAN_LEDGER_MAX_FILE_BYTES to raise or 0 to disable)` };
    }
    let content;
    try { content = readFileSync(r.path, 'utf8'); } catch (e) { return { ...r, exists: true, bytes: stat.size, error: e.message }; }
    const truncated = content.length > maxBytes;
    return { ...r, exists: true, bytes: stat.size, truncated, content: truncated ? content.slice(0, maxBytes) + `\n…[truncated ${content.length - maxBytes} chars — read the file directly for the rest]` : content };
  }

  removeFileRef(id) {
    const info = this.db.prepare('DELETE FROM file_refs WHERE id=?').run(id);
    if (info.changes === 0) throw new Error(`no file ref with id ${id}`);
    return { deleted: id };
  }

  // From the plan's code graph, propose dependencies + dependents of `path` via
  // import edges. Groups by source_file (works for native + graphify graphs) and
  // returns paths in the same absolute form as `path`. Does NOT add them.
  suggestFileRefs(planId, path) {
    const norm = (p) => String(p).replace(/\\/g, '/');
    const np = norm(path);
    if (!this.hasGraph(planId)) return { path, matched: null, suggestions: [], reason: 'no code graph for this plan' };
    const nodes = this.db.prepare('SELECT node_id, source_file FROM graph_nodes WHERE plan_id=?').all(planId);
    const idToFile = new Map(nodes.map((n) => [n.node_id, norm(n.source_file || n.node_id)]));
    const files = [...new Set(idToFile.values())];
    const matched = files.find((f) => f === np) || files.find((f) => np.endsWith('/' + f) || np.endsWith(f))
      || files.find((f) => f.split('/').pop() === np.split('/').pop());
    if (!matched) return { path, matched: null, suggestions: [], reason: 'file not found in the code graph' };
    const prefix = np.endsWith(matched) ? np.slice(0, np.length - matched.length) : ''; // recover the absolute root
    const toPath = (rel) => (prefix ? prefix + rel : rel);
    const edges = this.db.prepare("SELECT src, tgt FROM graph_edges WHERE plan_id=? AND relation='imports_from'").all(planId);
    const cited = new Set(this.listFileRefs({ plan_id: planId }).map((f) => norm(f.path)));
    const out = new Map();
    for (const e of edges) {
      const sf = idToFile.get(e.src), tf = idToFile.get(e.tgt);
      if (sf === matched && tf && tf !== matched) out.set(tf, { path: toPath(tf), role: 'dependency', reason: `${matched} imports it` });
      if (tf === matched && sf && sf !== matched) out.set(sf, { path: toPath(sf), role: 'related', reason: `imports ${matched}` });
    }
    const suggestions = [...out.values()].filter((s) => !cited.has(norm(s.path)));
    return { path, matched, suggestions };
  }

  // ---- refs (rules / tools, toggleable) ----------------------------------

  _refRow(r) {
    return {
      id: r.id, kind: r.kind, name: r.name, body: r.body,
      enabled: !!r.enabled, plan_id: r.plan_id ?? null, project_id: r.project_id ?? null,
      scope: r.plan_id != null ? 'plan' : (r.project_id != null ? 'project' : 'global'),
      keywords: parseArr(r.keywords), created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  // Scope default: plan_id → plan ref; `global:true` → global; else the CURRENT project
  // (so a project's rules/tools don't bleed into others). project_id overrides the project.
  createRef({ kind, name, body, enabled, plan_id, project_id, global, keywords }) {
    const k = kind ?? 'rule';
    if (!REF_KINDS.has(k)) throw new Error(`bad ref kind: ${k} (rule|tool)`);
    if (!name || !String(name).trim()) throw new Error('ref name is required');
    if (plan_id != null) this._mustPlan(plan_id);
    let proj = null;
    if (plan_id == null && !global) {
      proj = project_id ?? this.currentProjectId();
      if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(proj)) throw new Error(`no project with id ${proj}`);
    }
    const ts = now();
    const info = this.db
      .prepare('INSERT INTO refs (kind, name, body, enabled, plan_id, project_id, keywords, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(k, String(name).trim(), String(body ?? ''), enabled === false ? 0 : 1,
           plan_id ?? null, proj, jsonArr(keywords), ts, ts);
    return this.getRef(Number(info.lastInsertRowid));
  }

  getRef(id) {
    const r = this.db.prepare('SELECT * FROM refs WHERE id=?').get(id);
    if (!r) throw new Error(`no ref with id ${id}`);
    return this._refRow(r);
  }

  // Returns the refs APPLICABLE in a context: global + the project's + (optionally) the plan's.
  // Defaults the project to the current one, so the board shows this project's tools + globals.
  listRefs({ kind, enabled, plan_id, project_id, scope } = {}) {
    const proj = project_id ?? this.currentProjectId();
    let rows = this.db.prepare('SELECT * FROM refs ORDER BY kind, name').all();
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (enabled != null) rows = rows.filter((r) => !!r.enabled === !!enabled);
    if (scope === 'global') rows = rows.filter((r) => r.plan_id == null && r.project_id == null);
    else rows = rows.filter((r) =>
      (r.plan_id == null && r.project_id == null) ||           // global
      (r.plan_id == null && r.project_id === proj) ||          // this project
      (plan_id != null && r.plan_id === plan_id));             // this plan
    return rows.map((r) => this._refRow(r));
  }

  updateRef(id, fields) {
    const r = this.db.prepare('SELECT id FROM refs WHERE id=?').get(id);
    if (!r) throw new Error(`no ref with id ${id}`);
    const allowed = {};
    if (fields.kind != null) {
      if (!REF_KINDS.has(fields.kind)) throw new Error(`bad ref kind: ${fields.kind}`);
      allowed.kind = fields.kind;
    }
    if (fields.name != null) allowed.name = String(fields.name);
    if (fields.body != null) allowed.body = String(fields.body);
    if (fields.enabled != null) allowed.enabled = fields.enabled ? 1 : 0;
    if (fields.keywords != null) allowed.keywords = jsonArr(fields.keywords);
    if ('plan_id' in fields) allowed.plan_id = fields.plan_id ?? null;
    const keys = Object.keys(allowed);
    if (keys.length) {
      const set = keys.map((k) => `${k}=?`).join(', ');
      this.db.prepare(`UPDATE refs SET ${set}, updated_at=? WHERE id=?`).run(...keys.map((k) => allowed[k]), now(), id);
    }
    return this.getRef(id);
  }

  deleteRef(id) {
    const info = this.db.prepare('DELETE FROM refs WHERE id=?').run(id);
    if (info.changes === 0) throw new Error(`no ref with id ${id}`);
    return { deleted: id };
  }

  // ---- code graph (absorbed graphify node-link graph, per plan) -----------

  // Ingest a NetworkX node-link object (graphify graph.json): { nodes:[...], links:[...] }.
  // Replaces any existing graph for the plan. Computes degree for ranking.
  importGraph(planId, graph) {
    this._mustPlan(planId);
    const nodes = graph?.nodes || [];
    const edges = graph?.links || graph?.edges || [];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('graph must have nodes[] and links[]/edges[]');
    // DELETE + re-INSERT is one atomic unit: a failed import rolls back
    // to the previous graph instead of leaving the plan graphless.
    this._tx(() => {
      this.db.prepare('DELETE FROM graph_nodes WHERE plan_id=?').run(planId);
      this.db.prepare('DELETE FROM graph_edges WHERE plan_id=?').run(planId);
      const ni = this.db.prepare('INSERT OR REPLACE INTO graph_nodes (plan_id,node_id,label,file_type,source_file,source_location,community,kind,degree) VALUES (?,?,?,?,?,?,?,?,0)');
      for (const n of nodes) {
        const id = String(n.id ?? n.node_id ?? '');
        if (!id) continue;
        ni.run(planId, id, String(n.label ?? id), n.file_type ?? null, n.source_file ?? null,
               n.source_location ?? null, n.community ?? null, n.kind ?? n.type ?? null);
      }
      const ei = this.db.prepare('INSERT INTO graph_edges (plan_id,src,tgt,relation,confidence,weight) VALUES (?,?,?,?,?,?)');
      const deg = new Map();
      for (const e of edges) {
        const s = String(e.source ?? e._src ?? ''), t = String(e.target ?? e._tgt ?? '');
        if (!s || !t) continue;
        ei.run(planId, s, t, e.relation ?? 'related', e.confidence ?? 'EXTRACTED', Number(e.weight ?? 1));
        deg.set(s, (deg.get(s) || 0) + 1); deg.set(t, (deg.get(t) || 0) + 1);
      }
      const du = this.db.prepare('UPDATE graph_nodes SET degree=? WHERE plan_id=? AND node_id=?');
      for (const [id, d] of deg) du.run(d, planId, id);
    });
    this.touchPlan(planId);
    return this.graphStats(planId);
  }

  graphStats(planId) {
    return {
      nodes: this.db.prepare('SELECT COUNT(*) c FROM graph_nodes WHERE plan_id=?').get(planId).c,
      edges: this.db.prepare('SELECT COUNT(*) c FROM graph_edges WHERE plan_id=?').get(planId).c,
      communities: this.db.prepare('SELECT COUNT(DISTINCT community) c FROM graph_nodes WHERE plan_id=? AND community IS NOT NULL').get(planId).c,
    };
  }

  hasGraph(planId) { return this.graphStats(planId).nodes > 0; }

  godNodes(planId, limit = 8) {
    return this.db.prepare('SELECT node_id, label, degree, source_file, community FROM graph_nodes WHERE plan_id=? ORDER BY degree DESC, label LIMIT ?').all(planId, limit);
  }

  // The grounding primitive: keyword-match seeds → degree-ranked BFS within a node
  // budget → compact subgraph (the token-saving "only what this touches" slice).
  queryGraph(planId, terms, budget = 14) {
    const nodes = this.db.prepare('SELECT node_id, label, source_file, source_location, community, degree FROM graph_nodes WHERE plan_id=?').all(planId);
    if (!nodes.length) return null;
    const byId = new Map(nodes.map((n) => [n.node_id, n]));
    const edges = this.db.prepare('SELECT src, tgt, relation, confidence FROM graph_edges WHERE plan_id=?').all(planId);
    const adj = new Map(nodes.map((n) => [n.node_id, new Set()]));
    for (const e of edges) { adj.get(e.src)?.add(e.tgt); adj.get(e.tgt)?.add(e.src); }
    const q = String(terms).toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
    const seeds = nodes
      .filter((n) => q.some((w) => (n.label + ' ' + n.node_id).toLowerCase().includes(w)))
      .sort((a, b) => b.degree - a.degree);
    if (!seeds.length) return { terms, matched: 0, nodes: [], edges: [] };
    const keep = new Set(), frontier = [];
    for (const s of seeds) { if (keep.size >= budget) break; keep.add(s.node_id); frontier.push(s.node_id); }
    while (frontier.length && keep.size < budget) {
      const cur = frontier.shift();
      for (const nb of [...(adj.get(cur) || [])].sort((a, b) => (byId.get(b)?.degree || 0) - (byId.get(a)?.degree || 0))) {
        if (keep.size >= budget) break;
        if (!keep.has(nb)) { keep.add(nb); frontier.push(nb); }
      }
    }
    return {
      terms, matched: seeds.length,
      nodes: [...keep].map((id) => byId.get(id)).filter(Boolean),
      edges: edges.filter((e) => keep.has(e.src) && keep.has(e.tgt)),
    };
  }

  // ---- project brain: on-demand info about the project at large ----------

  // A compact whole-project snapshot for instantly orienting a fresh session.
  projectBrief() {
    const cur = this.currentProjectId();
    const plans = this.listPlans(); // current project only
    const totals = { plans: plans.length, steps: 0, done: 0 };
    for (const p of plans) { totals.steps += p.steps; totals.done += p.done; }
    const recent_lessons = this.db.prepare(`
      SELECT a.what_tried, a.result, a.verdict, s.title AS step_title, p.id AS plan_id, p.title AS plan_title
      FROM attempts a JOIN steps s ON a.step_id = s.id JOIN plans p ON s.plan_id = p.id
      WHERE a.verdict != 'pass' AND (p.project_id IS NULL OR p.project_id = ?) ORDER BY a.id DESC LIMIT 6`).all(cur)
      .map((l) => ({ ...l, what_tried: l.what_tried.slice(0, 160), result: (l.result || '').slice(0, 160) }));
    const code_graphs = plans.filter((p) => this.hasGraph(p.id)).map((p) => ({ id: p.id, title: p.title, ...this.graphStats(p.id) }));
    return { project: this.getProject(cur), projects: this.listProjects(), totals, plans, recent_lessons, code_graphs };
  }

  // "Ask the project anything": one IDF-weighted lexical query across ALL plans,
  // steps, and attempts → the relevant slice, ranked. The on-demand info entry point.
  recall(query, limit = 8, all = false) {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return { query, hits: [] };
    const cur = this.currentProjectId();
    const inScope = (pid) => all || (pid ?? 1) === cur;
    const docs = [];
    for (const p of this.db.prepare('SELECT id, project_id, title, keywords, summary, status FROM plans').all())
      if (inScope(p.project_id)) docs.push({ type: 'plan', id: p.id, title: p.title, status: p.status, text: `${p.title} ${parseArr(p.keywords).join(' ')} ${p.summary}` });
    for (const s of this.db.prepare('SELECT s.id, s.plan_id, s.title, s.context, s.acceptance_criteria, s.carry_forward, s.status, p.project_id FROM steps s JOIN plans p ON s.plan_id = p.id').all())
      if (inScope(s.project_id)) docs.push({ type: 'step', id: s.id, plan_id: s.plan_id, title: s.title, status: s.status, text: `${s.title} ${s.context} ${s.acceptance_criteria} ${s.carry_forward}` });
    for (const a of this.db.prepare('SELECT a.id, a.what_tried, a.result, a.verdict, a.step_id, s.title AS st, s.plan_id, p.project_id FROM attempts a JOIN steps s ON a.step_id = s.id JOIN plans p ON s.plan_id = p.id').all())
      if (inScope(a.project_id)) docs.push({ type: 'attempt', id: a.id, step_id: a.step_id, plan_id: a.plan_id, title: a.st, status: a.verdict, text: `${a.what_tried} ${a.result}` });
    const entries = docs.map((d) => ({ doc: d, toks: new Set(tokenize(d.text)) }));
    return {
      query,
      hits: idfRank(entries, q, limit)
        .map((x) => {
          const d = x.doc;
          return { type: d.type, id: d.id, plan_id: d.plan_id, step_id: d.step_id, title: d.title, status: d.status,
            snippet: d.text.replace(/\s+/g, ' ').trim().slice(0, 160), score: Math.round(x.score * 100) / 100 };
        }),
    };
  }

  // ---- prior-plan discovery (planning preflight) -------------------------

  // Short, RELEVANT snippets for a matched prior plan — carry-forward notes and
  // failure lessons that overlap the query, each collapsed + hard-capped. This is
  // the deliberate opposite of dumping step bodies: only tokens that overlap the
  // discovery query survive, at most `maxSnippets` per kind, each ≤ `maxLen` chars.
  _planSnippets(planId, qToks, { maxSnippets = 3, maxLen = 160 } = {}) {
    const qset = new Set(qToks);
    const overlap = (text) => { let n = 0; for (const t of new Set(tokenize(text))) if (qset.has(t)) n++; return n; };
    const clip = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, maxLen);
    const out = [];
    // Relevant carry-forward notes (the "what the next step needs" channel).
    this.db.prepare("SELECT carry_forward FROM steps WHERE plan_id=? AND carry_forward != '' ORDER BY idx, id").all(planId)
      .map((r) => ({ text: r.carry_forward, score: overlap(r.carry_forward) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSnippets)
      .forEach((c) => out.push({ type: 'carry_forward', text: clip(c.text) }));
    // Relevant lessons (non-pass attempts) — "tried X → got Y, don't repeat".
    this.db.prepare("SELECT a.what_tried, a.result FROM attempts a JOIN steps s ON a.step_id=s.id WHERE s.plan_id=? AND a.verdict != 'pass'").all(planId)
      .map((a) => ({ text: `${a.what_tried} ${a.result}`.trim(), score: overlap(`${a.what_tried} ${a.result}`) }))
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSnippets)
      .forEach((l) => out.push({ type: 'lesson', text: clip(l.text) }));
    return out;
  }

  // Planning preflight: extract (or accept) a bounded keyword set from a new goal,
  // then run ONE cross-project keyword query over plan SURFACE metadata (title +
  // keywords + summary — never step bodies) to surface prior art before decomposition.
  // Completed matches (status 'done') are returned separately from related-but-active
  // matches so a still-in-flight plan is never presented as finished evidence.
  // With `draft_plan_id`, the discovered matches are recorded as durable provenance on
  // that draft. `abandoned` plans and the draft itself are excluded from candidates.
  plannerStart({ goal = '', keywords = null, limit = 5, max_keywords = 8, draft_plan_id = null } = {}) {
    const maxKw = Math.min(8, Math.max(1, Number(max_keywords) || 8));
    const provided = Array.isArray(keywords) && keywords.length;
    const source = [];
    if (provided) source.push(...keywords);
    if (goal) source.push(goal);
    const kw = extractKeywords(source, maxKw);
    const keyword_source = provided ? (goal ? 'provided+goal' : 'provided') : 'extracted';
    const lim = Math.max(1, Number(limit) || 5);
    const draftId = draft_plan_id != null ? Number(draft_plan_id) : null;
    const base = { goal: String(goal ?? ''), keywords: kw, keyword_source, completed: [], related_active: [], consulted: null };
    const qToks = [...new Set(kw)];
    if (!qToks.length) return base;

    const candidates = this.db
      .prepare('SELECT id, project_id, title, keywords, summary, status, updated_at FROM plans')
      .all()
      .filter((p) => p.status !== 'abandoned' && p.id !== draftId);
    if (!candidates.length) return base;

    const projName = new Map(this.db.prepare('SELECT id, name FROM projects').all().map((r) => [r.id, r.name]));
    const surfaceText = (p) => `${p.title} ${parseArr(p.keywords).join(' ')} ${p.summary}`;
    const entries = candidates.map((p) => ({ doc: p, toks: new Set(tokenize(surfaceText(p))) }));
    // Rank ALL matches (idfRank keeps only score>0), newest-first on ties, then bucket.
    const ranked = idfRank(entries, qToks, candidates.length, (a, b) => (a.updated_at < b.updated_at ? 1 : -1));

    const shape = (x) => {
      const p = x.doc;
      const kws = parseArr(p.keywords);
      const surfaceToks = new Set(tokenize(surfaceText(p)));
      return {
        plan_id: p.id,
        title: p.title,
        project_id: p.project_id ?? 1,
        project: projName.get(p.project_id ?? 1) ?? null,
        keywords: kws,
        status: p.status,
        updated_at: p.updated_at,
        score: Math.round(x.score * 100) / 100,
        matched_keywords: qToks.filter((t) => surfaceToks.has(t)),
        snippets: this._planSnippets(p.id, qToks),
      };
    };

    const completed = [];
    const related_active = [];
    for (const x of ranked) {
      if (x.doc.status === 'done') { if (completed.length < lim) completed.push(shape(x)); }
      else if (x.doc.status === 'active' && related_active.length < lim) related_active.push(shape(x));
      if (completed.length >= lim && related_active.length >= lim) break;
    }

    let consulted = null;
    if (draftId != null) {
      const ids = [...completed, ...related_active].map((m) => m.plan_id);
      consulted = this.recordPlanConsultation(draftId, { consulted_plan_ids: ids, keywords: kw, goal }).recorded;
    }
    return { ...base, completed, related_active, consulted };
  }

  // Durable provenance write: record which prior plans a draft consulted during its
  // preflight. Deduped per (draft, prior) pair (re-recording refreshes the row);
  // status_at_consult freezes the prior plan's status so completed-vs-active evidence
  // survives later changes. Unknown prior ids are skipped, never fabricated.
  recordPlanConsultation(planId, { consulted_plan_ids = [], keywords = [], goal = '', note = '' } = {}) {
    this._mustPlan(planId);
    const ids = [...new Set((consulted_plan_ids || []).map(Number).filter((n) => Number.isInteger(n) && n !== Number(planId)))];
    const kwJson = jsonArr(keywords);
    const noteText = String(note || goal || '');
    const recorded = this._tx(() => {
      const rows = [];
      for (const cid of ids) {
        const prior = this.db.prepare('SELECT id, status FROM plans WHERE id=?').get(cid);
        if (!prior) continue;
        const relation = prior.status === 'done' ? 'completed' : 'related-active';
        this.db.prepare(`
          INSERT INTO plan_consultations (plan_id, consulted_plan_id, status_at_consult, relation, keywords, note, created_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(plan_id, consulted_plan_id) DO UPDATE SET
            status_at_consult=excluded.status_at_consult, relation=excluded.relation,
            keywords=excluded.keywords, note=excluded.note, created_at=excluded.created_at
        `).run(planId, cid, prior.status, relation, kwJson, noteText, now());
        rows.push({ consulted_plan_id: cid, status_at_consult: prior.status, relation });
      }
      return rows;
    });
    this.touchPlan(planId);
    return { plan_id: Number(planId), recorded, consulted_plans: this.listConsultedPlans(planId) };
  }

  // Surface the prior-plan provenance recorded on a draft: which plans it consulted,
  // the status they had when consulted (frozen), and their current status/title now.
  listConsultedPlans(planId) {
    return this.db.prepare(`
      SELECT c.consulted_plan_id, c.status_at_consult, c.relation, c.keywords, c.created_at,
             p.title, p.status AS current_status, p.project_id
      FROM plan_consultations c LEFT JOIN plans p ON p.id = c.consulted_plan_id
      WHERE c.plan_id=? ORDER BY c.id`).all(planId)
      .map((r) => ({
        consulted_plan_id: r.consulted_plan_id,
        title: r.title ?? null,
        project_id: r.project_id ?? null,
        status_at_consult: r.status_at_consult,
        current_status: r.current_status ?? null,
        relation: r.relation,
        keywords: parseArr(r.keywords),
        created_at: r.created_at,
      }));
  }

  backfillMissingActivityMarkers() {
    const ts = now();
    const rows = this.db.prepare(`
      SELECT s.id AS step_id, s.plan_id
      FROM steps s
      LEFT JOIN activity_runs ar ON ar.step_id = s.id
      WHERE ar.id IS NULL
      ORDER BY s.id
    `).all();
    let inserted = 0;
    const existingMarker = this.db.prepare(
      "SELECT id, plan_id, step_id FROM activity_runs WHERE run_id='backfill-missing' AND session_ref='migration-backfill' AND step_id=? LIMIT 1"
    );
    const insertRun = this.db.prepare(`
      INSERT INTO activity_runs (
        plan_id, step_id, run_id, session_ref, role, agent, requested_model, actual_model, model_source,
        phase, action_summary, command_summary, status, outcome, verification_state, blocker,
        progress_completed, progress_total, file_count, artifact_count, recent_artifacts, metadata,
        started_at, updated_at, ended_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const row of rows) {
      const marker = existingMarker.get(row.step_id);
      if (marker) continue;
      const info = insertRun.run(
        row.plan_id,
        row.step_id,
        'backfill-missing',
        'migration-backfill',
        '',
        '',
        '',
        '',
        '',
        'backfill',
        'historical activity backfill marker',
        '',
        'cancelled',
        'unknown',
        'skipped',
        '',
        0,
        0,
        0,
        0,
        '[]',
        sanitizeMetadataJson({ synthetic: true, marker: 'activity_backfill_missing' }),
        ts,
        ts,
        ts,
      );
      const activityId = Number(info.lastInsertRowid);
      this._appendLifecycleEvent(activityId, row.step_id, {
        event_type: 'activity_backfill_missing',
        phase: 'backfill',
        summary: 'synthetic historical marker for missing activity',
        metadata: { synthetic: true, reason: 'historical_missing_activity' },
        assignment_id: null,
        assignment_missing_reason: 'historical_backfill',
        resolve_assignment: false,
        timestamp: ts,
      });
      inserted++;
    }
    return { inserted_markers: inserted, scanned_steps: rows.length };
  }

  assessActivityBackfill() {
    const markerEvents = Number(this.db.prepare(
      "SELECT COUNT(*) AS n FROM activity_events WHERE event_type='activity_backfill_missing'"
    ).get().n || 0);
    const markerRuns = Number(this.db.prepare(
      "SELECT COUNT(*) AS n FROM activity_runs WHERE run_id='backfill-missing' AND session_ref='migration-backfill'"
    ).get().n || 0);
    const missingSteps = Number(this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM steps s
      WHERE NOT EXISTS (SELECT 1 FROM activity_runs ar WHERE ar.step_id=s.id)
    `).get().n || 0);
    return {
      marker_runs: markerRuns,
      marker_events: markerEvents,
      steps_missing_any_activity: missingSteps,
      idempotent: markerRuns === markerEvents,
    };
  }

  activityHealthSummary({ plan_id = null, step_id = null } = {}) {
    const runs = this.listRecentActivity({ plan_id, step_id, limit: 200 });
    const distribution = { stale_lease: 0, needs_manual_verification: 0, awaiting_artifact: 0, healthy: 0 };
    for (const run of runs) {
      const state = BOARD_HEALTH_STATES.has(run?.health?.state) ? run.health.state : 'healthy';
      distribution[state]++;
    }
    const dominant = distribution.stale_lease > 0
      ? 'stale_lease'
      : distribution.needs_manual_verification > 0
        ? 'needs_manual_verification'
        : distribution.awaiting_artifact > 0
          ? 'awaiting_artifact'
          : 'healthy';
    return {
      dominant_state: dominant,
      distribution,
      total_runs: runs.length,
    };
  }

  // ---- structured live execution activity ---------------------------------

  _normalizeActivityIdentity({ plan_id, step_id, run_id, session_ref } = {}) {
    const pid = Number(plan_id);
    const sid = Number(step_id);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('plan_id must be a positive integer');
    if (!Number.isInteger(sid) || sid < 1) throw new Error('step_id must be a positive integer');
    const step = this._mustStep(sid, 'plan_id');
    if (step.plan_id !== pid) throw new Error(`step ${sid} does not belong to plan ${pid}`);
    const rid = clamp(run_id, 96);
    if (!rid) throw new Error('run_id is required');
    const sess = clamp(session_ref, 256);
    if (!sess) throw new Error('session_ref is required');
    return { plan_id: pid, step_id: sid, run_id: rid, session_ref: sess };
  }

  _activityRow(
    row,
    {
      stale_after_ms = 120000,
      include_events = false,
      events_limit = 30,
      now_ms = Date.now(),
      prefetched_execution_lease_row = null,
      prefetched_step_snapshot = null,
    } = {},
  ) {
    const stale = staleStatus(row.status, row.updated_at, stale_after_ms, now_ms);
    const out = {
      id: row.id,
      plan_id: row.plan_id,
      step_id: row.step_id,
      run_id: row.run_id,
      session_ref: row.session_ref,
      role: row.role,
      agent: row.agent,
      requested_model: row.requested_model,
      actual_model: row.actual_model,
      model_source: row.model_source,
      phase: row.phase,
      action_summary: row.action_summary,
      command_summary: row.command_summary,
      status: row.status,
      outcome: row.outcome,
      verification_state: row.verification_state,
      blocker: row.blocker,
      started_at: row.started_at,
      updated_at: row.updated_at,
      ended_at: row.ended_at || '',
      progress_completed: row.progress_completed,
      progress_total: row.progress_total,
      file_count: row.file_count,
      artifact_count: row.artifact_count,
      recent_artifacts: parseArr(row.recent_artifacts),
      metadata: parseObj(row.metadata),
      stale: stale.stale,
      stale_for_ms: stale.stale_for_ms,
    };
    if (include_events) {
      out.events = this.db.prepare(
        'SELECT id, event_type, step_id, assignment_id, assignment_missing_reason, event_timestamp, phase, summary, command_summary, metadata, created_at FROM activity_events WHERE activity_id=? ORDER BY id DESC LIMIT ?'
      ).all(row.id, Math.max(1, Number(events_limit) || 30))
        .reverse()
        .map((e) => ({
          id: e.id,
          event_type: e.event_type,
          step_id: e.step_id,
          assignment_id: e.assignment_id == null ? null : Number(e.assignment_id),
          assignment_missing_reason: e.assignment_missing_reason || '',
          timestamp: e.event_timestamp || e.created_at,
          phase: e.phase,
          summary: e.summary,
          command_summary: e.command_summary,
          metadata: parseObj(e.metadata),
          created_at: e.created_at,
        }));
    }
    // Attach the matching execution lease (if any) so the UI can render
    // executor identity, deadline countdown, stale threshold, and terminal
    // close-reason without a separate round-trip. Prefer the lease tied to
    // this exact activity row (matches on run+session), then fall back to
    // any open lease for the step. `null` when no lease exists — legacy
    // pre-v8 activity rows or callers that never opened one.
    try {
      let leaseRow = prefetched_execution_lease_row && Number(prefetched_execution_lease_row.step_id) === Number(row.step_id)
        ? prefetched_execution_lease_row
        : null;
      if (!leaseRow) {
        leaseRow = this.db.prepare(
          "SELECT * FROM execution_leases WHERE plan_id=? AND step_id=? AND run_id=? AND session_ref=? ORDER BY id DESC LIMIT 1"
        ).get(row.plan_id, row.step_id, row.run_id, row.session_ref);
      }
      if (!leaseRow) {
        leaseRow = this.db.prepare(
          "SELECT * FROM execution_leases WHERE step_id=? AND status='open' ORDER BY id DESC LIMIT 1"
        ).get(row.step_id);
      }
      if (leaseRow) {
        const deadlineMs = leaseRow.deadline_at ? Date.parse(leaseRow.deadline_at) : null;
        const firstArtifactDeadlineMs = leaseRow.first_artifact_deadline_at
          ? Date.parse(leaseRow.first_artifact_deadline_at)
          : null;
        const heartbeatMs = leaseRow.last_heartbeat_at ? Date.parse(leaseRow.last_heartbeat_at) : null;
        const staleAfter = Number(leaseRow.stale_after_ms) || 120000;
        out.execution_lease = {
          id: leaseRow.id,
          status: leaseRow.status,
          executor: leaseRow.executor,
          role: leaseRow.role,
          agent: leaseRow.agent,
          child_pid: leaseRow.child_pid,
          claimed_at: leaseRow.claimed_at,
          last_heartbeat_at: leaseRow.last_heartbeat_at,
          heartbeat_age_ms: heartbeatMs ? Math.max(0, now_ms - heartbeatMs) : null,
          first_artifact_deadline_at: leaseRow.first_artifact_deadline_at || '',
          first_artifact_deadline_in_ms: firstArtifactDeadlineMs ? firstArtifactDeadlineMs - now_ms : null,
          deadline_at: leaseRow.deadline_at || '',
          deadline_in_ms: deadlineMs ? deadlineMs - now_ms : null,
          stale_after_ms: staleAfter,
          stale_countdown_ms: heartbeatMs ? Math.max(0, staleAfter - (now_ms - heartbeatMs)) : null,
          outcome: leaseRow.outcome || '',
          close_reason: leaseRow.close_reason || '',
          stale_reason: leaseRow.stale_reason || '',
          closed_at: leaseRow.closed_at || '',
        };
      } else {
        out.execution_lease = null;
      }
    } catch { out.execution_lease = null; }
    // Surface the step's disposition alongside so the UI can render distinct
    // verified/deferred/blocked/not_applicable/legacy_unknown states rather
    // than only "done".
    try {
      const step = prefetched_step_snapshot && Number(prefetched_step_snapshot.id) === Number(row.step_id)
        ? prefetched_step_snapshot
        : this.db.prepare(
          'SELECT status, verification_disposition, disposition_reason, disposition_at FROM steps WHERE id=?'
        ).get(row.step_id);
      if (step) {
        out.step_status = step.status;
        out.step_disposition = step.verification_disposition || '';
        out.step_disposition_reason = step.disposition_reason || '';
        out.step_disposition_at = step.disposition_at || '';
      }
    } catch {}
    try {
      if (prefetched_step_snapshot && Number(prefetched_step_snapshot.id) === Number(row.step_id)) {
        out.latest_validation_status = prefetched_step_snapshot.completion_validation_status || 'legacy_unknown';
        out.latest_validation_errors = Array.isArray(prefetched_step_snapshot.completion_validation_errors)
          ? prefetched_step_snapshot.completion_validation_errors
          : [];
      } else {
        const attempt = this.db.prepare(
          'SELECT validation_status, validation_errors_json FROM attempts WHERE step_id=? ORDER BY id DESC LIMIT 1'
        ).get(row.step_id);
        out.latest_validation_status = attempt?.validation_status || 'legacy_unknown';
        out.latest_validation_errors = parseArr(attempt?.validation_errors_json || '[]');
      }
    } catch {
      out.latest_validation_status = 'legacy_unknown';
      out.latest_validation_errors = [];
    }
    out.health = this._deriveBoardHealth(out);
    return out;
  }

  _deriveBoardHealth(activity) {
    const reasons = [];
    const lease = activity.execution_lease || null;
    const leaseHeartbeatAge = Number(lease?.heartbeat_age_ms ?? -1);
    const leaseStaleAfter = Number(lease?.stale_after_ms ?? 0);
    if (lease && lease.status === 'open' && leaseHeartbeatAge >= 0 && leaseStaleAfter > 0 && leaseHeartbeatAge > leaseStaleAfter) {
      reasons.push({
        code: 'stale_lease',
        stale_for_ms: leaseHeartbeatAge,
        stale_after_ms: leaseStaleAfter,
        lease_id: lease.id,
        lease_trigger: lease.stale_reason || 'lease_timeout',
      });
      return { state: 'stale_lease', reasons };
    }
    const disposition = String(activity.step_disposition || '');
    if (['deferred', 'blocked', 'legacy_unknown'].includes(disposition) || String(activity.latest_validation_status || '') === 'fail') {
      reasons.push({
        code: 'needs_manual_verification',
        disposition,
        disposition_reason: String(activity.step_disposition_reason || ''),
        validation_status: String(activity.latest_validation_status || ''),
        validation_error_codes: Array.isArray(activity.latest_validation_errors)
          ? activity.latest_validation_errors.map((e) => String(e?.code || '')).filter(Boolean)
          : [],
      });
      return { state: 'needs_manual_verification', reasons };
    }
    if (
      ['queued', 'in_progress', 'blocked'].includes(String(activity.status || ''))
      && Number(activity.artifact_count || 0) === 0
      && (!Array.isArray(activity.recent_artifacts) || activity.recent_artifacts.length === 0)
    ) {
      reasons.push({
        code: 'awaiting_artifact',
        artifact_count: Number(activity.artifact_count || 0),
        lease_id: lease?.id ?? null,
      });
      return { state: 'awaiting_artifact', reasons };
    }
    reasons.push({ code: 'healthy' });
    return { state: 'healthy', reasons };
  }

  _validateActivityStatus(current, next) {
    if (!ACTIVITY_STATUS.has(next)) throw new Error(`bad status: ${next}`);
    if (!canTransitionActivityStatus(current, next)) throw new Error(`invalid activity status transition: ${current} -> ${next}`);
  }

  _compactTimelineEvents(activityId, keep = Number(process.env.PLAN_LEDGER_ACTIVITY_TIMELINE_KEEP) || 200) {
    const max = Math.max(1, Number(keep) || 200);
    const row = this.db.prepare(
      "SELECT COUNT(*) c FROM activity_events WHERE activity_id=? AND event_type='timeline'"
    ).get(activityId);
    const extra = (row?.c ?? 0) - max;
    if (extra <= 0) return 0;
    return this.db.prepare(
      "DELETE FROM activity_events WHERE id IN (SELECT id FROM activity_events WHERE activity_id=? AND event_type='timeline' ORDER BY id ASC LIMIT ?)"
    ).run(activityId, extra).changes;
  }

  _upsertActivity(
    identity,
    input = {},
    { create_if_missing = true, require_existing = false, assume_new = false } = {},
  ) {
    const existing = assume_new
      ? null
      : this.db.prepare(
        'SELECT * FROM activity_runs WHERE plan_id=? AND step_id=? AND run_id=? AND session_ref=?'
      ).get(identity.plan_id, identity.step_id, identity.run_id, identity.session_ref);
    if (!existing && require_existing) throw new Error('activity run not found for plan/step/run/session key');
    const ts = now();
    const status = input.status != null ? String(input.status) : (existing?.status ?? 'in_progress');
    this._validateActivityStatus(existing?.status ?? '', status);
    const outcome = input.outcome != null ? String(input.outcome) : (existing?.outcome ?? '');
    if (!ACTIVITY_OUTCOME.has(outcome)) throw new Error(`bad outcome: ${outcome}`);
    const verification_state = input.verification_state != null ? String(input.verification_state) : (existing?.verification_state ?? 'pending');
    if (!ACTIVITY_VERIFICATION.has(verification_state)) throw new Error(`bad verification_state: ${verification_state}`);
    const started_at = existing?.started_at || clamp(input.started_at, 48) || ts;
    const ended_at = ACTIVITY_TERMINAL_STATUS.has(status)
      ? (clamp(input.ended_at, 48) || existing?.ended_at || ts)
      : '';
    const progress_completed = clampInt(input.progress_completed ?? existing?.progress_completed ?? 0, 0) ?? 0;
    const progress_total = clampInt(input.progress_total ?? existing?.progress_total ?? 0, 0) ?? 0;
    if (progress_total && progress_completed > progress_total) throw new Error('progress_completed cannot exceed progress_total');
    const values = {
      plan_id: identity.plan_id,
      step_id: identity.step_id,
      run_id: identity.run_id,
      session_ref: identity.session_ref,
      role: clamp(input.role ?? existing?.role ?? '', 64),
      agent: clamp(input.agent ?? existing?.agent ?? '', 128),
      requested_model: clamp(input.requested_model ?? existing?.requested_model ?? '', 128),
      actual_model: clamp(input.actual_model ?? existing?.actual_model ?? '', 128),
      model_source: clamp(input.model_source ?? existing?.model_source ?? '', 64),
      phase: clamp(input.phase ?? existing?.phase ?? '', 96),
      action_summary: clamp(input.action_summary ?? existing?.action_summary ?? '', 280),
      command_summary: clamp(input.command_summary ?? existing?.command_summary ?? '', 280),
      status,
      outcome,
      verification_state,
      blocker: clamp(input.blocker ?? existing?.blocker ?? '', 400),
      progress_completed,
      progress_total,
      file_count: clampInt(input.file_count ?? existing?.file_count ?? 0, 0) ?? 0,
      artifact_count: clampInt(input.artifact_count ?? existing?.artifact_count ?? 0, 0) ?? 0,
      recent_artifacts: input.recent_artifacts != null
        ? sanitizeRecentArtifacts(input.recent_artifacts)
        : (existing?.recent_artifacts ?? '[]'),
      metadata: input.metadata != null
        ? sanitizeMetadataJson(input.metadata)
        : (existing?.metadata ?? '{}'),
      started_at,
      updated_at: clamp(input.updated_at, 48) || ts,
      ended_at,
    };
    if (!existing && !create_if_missing) throw new Error('activity run not found for plan/step/run/session key');
    const info = this._prep(
      'upsert_activity_row',
      `INSERT INTO activity_runs (
        plan_id, step_id, run_id, session_ref, role, agent, requested_model, actual_model, model_source,
        phase, action_summary, command_summary, status, outcome, verification_state, blocker,
        progress_completed, progress_total, file_count, artifact_count, recent_artifacts, metadata,
        started_at, updated_at, ended_at
      ) VALUES (
        @plan_id, @step_id, @run_id, @session_ref, @role, @agent, @requested_model, @actual_model, @model_source,
        @phase, @action_summary, @command_summary, @status, @outcome, @verification_state, @blocker,
        @progress_completed, @progress_total, @file_count, @artifact_count, @recent_artifacts, @metadata,
        @started_at, @updated_at, @ended_at
      )
      ON CONFLICT(plan_id, step_id, run_id, session_ref) DO UPDATE SET
        role=excluded.role, agent=excluded.agent, requested_model=excluded.requested_model, actual_model=excluded.actual_model,
        model_source=excluded.model_source, phase=excluded.phase, action_summary=excluded.action_summary,
        command_summary=excluded.command_summary, status=excluded.status, outcome=excluded.outcome,
        verification_state=excluded.verification_state, blocker=excluded.blocker,
        progress_completed=excluded.progress_completed, progress_total=excluded.progress_total,
        file_count=excluded.file_count, artifact_count=excluded.artifact_count,
        recent_artifacts=excluded.recent_artifacts, metadata=excluded.metadata,
        updated_at=excluded.updated_at, ended_at=excluded.ended_at`,
    ).run(values);
    const activityId = existing?.id != null ? Number(existing.id) : Number(info.lastInsertRowid);
    return {
      ...(existing ?? {}),
      ...values,
      id: activityId,
    };
  }

  startActivity(input = {}) {
    const key = this._normalizeActivityIdentity(input);
    const row = this._tx(() => {
      const exists = this.db.prepare(
        'SELECT id FROM activity_runs WHERE plan_id=? AND step_id=? AND run_id=? AND session_ref=?'
      ).get(key.plan_id, key.step_id, key.run_id, key.session_ref);
      if (exists) throw new Error('activity run already exists for plan/step/run/session key');
      return this._upsertActivity(key, { status: 'in_progress', ...input }, { create_if_missing: true, require_existing: false });
    });
    return this._activityRow(row, {});
  }

  upsertActivityHeartbeat(input = {}) {
    const key = this._normalizeActivityIdentity(input);
    const row = this._tx(() => this._upsertActivity(key, input, { create_if_missing: true, require_existing: false }));
    return this._activityRow(row, {});
  }

  appendActivityEvent(input = {}) {
    const key = this._normalizeActivityIdentity(input);
    const type = String(input.event_type ?? 'timeline');
    if (!ACTIVITY_EVENT_TYPES.has(type)) throw new Error(`bad event_type: ${type}`);
    const nowTs = now();
    return this._tx(() => {
      const row = this._upsertActivity(key, { updated_at: nowTs, phase: input.phase, status: input.status }, { create_if_missing: false, require_existing: true });
      const eventId = this._appendLifecycleEvent(row.id, key.step_id, {
        event_type: type,
        phase: input.phase ?? '',
        summary: input.summary ?? '',
        command_summary: input.command_summary ?? '',
        metadata: input.metadata ?? {},
        timestamp: nowTs,
      });
      return {
        event_id: eventId,
        activity_id: row.id,
        event_type: type,
        created_at: nowTs,
      };
    });
  }

  listCurrentActivity({ project_id = null, plan_id = null, step_id = null, stale_after_ms = 120000, include_events = false, events_limit = 30, limit = 50 } = {}) {
    // An explicit plan/step is authoritative even when another project is
    // currently selected in the board. Only unscoped activity queries inherit
    // the current project.
    const pid = project_id ?? (plan_id == null && step_id == null ? this.currentProjectId() : null);
    let rows = this.db.prepare(`
      SELECT ar.* FROM activity_runs ar
      JOIN plans p ON p.id = ar.plan_id
      WHERE ar.status IN ('queued','in_progress','blocked')
        AND (? IS NULL OR p.project_id IS NULL OR p.project_id = ?)
      ORDER BY ar.updated_at DESC, ar.id DESC
    `).all(pid, pid);
    if (plan_id != null) rows = rows.filter((r) => r.plan_id === Number(plan_id));
    if (step_id != null) rows = rows.filter((r) => r.step_id === Number(step_id));
    const capped = rows.slice(0, Math.max(1, Number(limit) || 50));
    return capped.map((r) => this._activityRow(r, { stale_after_ms, include_events, events_limit }));
  }

  listRecentActivity({ project_id = null, plan_id = null, step_id = null, stale_after_ms = 120000, include_events = false, events_limit = 20, limit = 100 } = {}) {
    const pid = project_id ?? (plan_id == null && step_id == null ? this.currentProjectId() : null);
    let rows = this.db.prepare(`
      SELECT ar.* FROM activity_runs ar
      JOIN plans p ON p.id = ar.plan_id
      WHERE (? IS NULL OR p.project_id IS NULL OR p.project_id = ?)
      ORDER BY ar.updated_at DESC, ar.id DESC
    `).all(pid, pid);
    if (plan_id != null) rows = rows.filter((r) => r.plan_id === Number(plan_id));
    if (step_id != null) rows = rows.filter((r) => r.step_id === Number(step_id));
    const capped = rows.slice(0, Math.max(1, Number(limit) || 100));
    return capped.map((r) => this._activityRow(r, { stale_after_ms, include_events, events_limit }));
  }

  // Cheap "what's happening now" snapshot for the board's Live mode. `rev` changes
  // on ANY mutation (by this or any other process — WAL readers see latest commits),
  // so the client can detect activity by polling. active_steps = in-progress steps
  // in the current project (the plans being actively worked) for focus + highlight.
  activity() {
    const cur = this.currentProjectId();
    const maxP = this.db.prepare('SELECT MAX(updated_at) m FROM plans').get().m || '';
    const maxS = this.db.prepare('SELECT MAX(updated_at) m FROM steps').get().m || '';
    const att = this.db.prepare('SELECT COUNT(*) c, MAX(created_at) m FROM attempts').get();
    const active_steps = this.db.prepare(`
      SELECT s.id AS step_id, s.plan_id, s.title AS step_title, s.idx, s.updated_at
      FROM steps s JOIN plans p ON s.plan_id = p.id
      WHERE s.status = 'in_progress' AND (p.project_id IS NULL OR p.project_id = ?)
      ORDER BY s.updated_at DESC`).all(cur);
    const current = this.listCurrentActivity({ project_id: cur, stale_after_ms: Number(process.env.PLAN_LEDGER_ACTIVITY_STALE_MS) || 120000, limit: 200 });
    return {
      rev: `${maxP}|${maxS}|${att.c}|${att.m || ''}`,
      active_steps,
      current_activity: current,
      health: this.activityHealthSummary({}),
      backfill: this.assessActivityBackfill(),
    };
  }

  // ---- templates (reusable plan skeletons) -------------------------------

  _resolveTemplate(idOrName) {
    const row = typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))
      ? this.db.prepare('SELECT * FROM templates WHERE id=?').get(Number(idOrName))
      : this.db.prepare('SELECT * FROM templates WHERE name=?').get(String(idOrName));
    if (!row) throw new Error(`no template "${idOrName}"`);
    return row;
  }

  createTemplate({ name, description, keywords, steps }) {
    if (!name || !String(name).trim()) throw new Error('template name is required');
    const id = this._tx(() => { // template + inline steps land atomically
      const ts = now();
      const info = this.db.prepare('INSERT INTO templates (name, description, keywords, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(String(name).trim(), String(description ?? ''), jsonArr(keywords), ts, ts);
      const tid = Number(info.lastInsertRowid);
      if (Array.isArray(steps)) steps.forEach((s, i) => this.addTemplateStep(tid, { ...s, idx: s.idx ?? i + 1 }));
      return tid;
    });
    return this.getTemplate(id);
  }

  addTemplateStep(templateId, { title, context, tools, role, acceptance_criteria, idx }) {
    this._resolveTemplate(templateId);
    if (!title || !String(title).trim()) throw new Error('template step title is required');
    let order = idx;
    if (order == null) { const m = this.db.prepare('SELECT MAX(idx) m FROM template_steps WHERE template_id=?').get(templateId); order = (m.m ?? 0) + 1; }
    this.db.prepare('INSERT INTO template_steps (template_id, idx, title, context, tools, role, acceptance_criteria) VALUES (?,?,?,?,?,?,?)')
      .run(templateId, order, String(title).trim(), String(context ?? ''), jsonArr(tools), String(role ?? '').trim(), String(acceptance_criteria ?? ''));
    return this.getTemplate(templateId);
  }

  listTemplates() {
    return this.db.prepare('SELECT * FROM templates ORDER BY name').all().map((t) => ({
      id: t.id, name: t.name, description: t.description, keywords: parseArr(t.keywords),
      steps: this.db.prepare('SELECT COUNT(*) c FROM template_steps WHERE template_id=?').get(t.id).c,
    }));
  }

  getTemplate(idOrName) {
    const t = this._resolveTemplate(idOrName);
    const steps = this.db.prepare('SELECT idx, title, context, tools, role, acceptance_criteria FROM template_steps WHERE template_id=? ORDER BY idx, id').all(t.id)
      .map((s) => ({ idx: s.idx, title: s.title, context: s.context, tools: parseArr(s.tools), role: s.role ?? '', acceptance_criteria: s.acceptance_criteria }));
    return { id: t.id, name: t.name, description: t.description, keywords: parseArr(t.keywords), steps };
  }

  // Clone a template's steps onto a plan (appended in order).
  instantiateTemplate(idOrName, planId) {
    this._mustPlan(planId);
    const tpl = this.getTemplate(idOrName);
    this._tx(() => { // all-or-nothing: a half-instantiated template is worse than none
      for (const s of tpl.steps) this.addStep(planId, { title: s.title, context: s.context, tools: s.tools, role: s.role, acceptance_criteria: s.acceptance_criteria });
    });
    return this.openPlan(planId);
  }

  // Capture a plan's current steps as a reusable template.
  saveAsTemplate(planId, name, description) {
    const plan = this.openPlan(planId);
    const tplId = this._tx(() => { // template + captured steps land atomically
      const tpl = this.createTemplate({ name, description: description ?? plan.summary, keywords: plan.keywords });
      plan.steps.forEach((s, i) => {
        const full = this.getStep(s.id);
        this.addTemplateStep(tpl.id, { title: full.title, context: full.context, tools: full.tools, role: full.role, acceptance_criteria: full.acceptance_criteria, idx: i + 1 });
      });
      return tpl.id;
    });
    return this.getTemplate(tplId);
  }

  deleteTemplate(idOrName) {
    const t = this._resolveTemplate(idOrName);
    this.db.prepare('DELETE FROM templates WHERE id=?').run(t.id);
    return { deleted: t.id };
  }

  // ---- internal ----------------------------------------------------------

  // Existence guards: return the row (selected columns) or throw the canonical
  // "no plan/step with id N" error every caller (and the smoke suite) relies on.
  _mustPlan(id, cols = 'id') {
    const row = this.db.prepare(`SELECT ${cols} FROM plans WHERE id=?`).get(id);
    if (!row) throw new Error(`no plan with id ${id}`);
    return row;
  }
  _mustStep(id, cols = 'id') {
    const row = this.db.prepare(`SELECT ${cols} FROM steps WHERE id=?`).get(id);
    if (!row) throw new Error(`no step with id ${id}`);
    return row;
  }

  touchPlan(id) { this.db.prepare('UPDATE plans SET updated_at=? WHERE id=?').run(now(), id); }
}
