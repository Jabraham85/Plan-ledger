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
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, statSync } from 'node:fs';

// The ONE default DB location, shared by every entry point (MCP server, board,
// packaged exe, runner, scripts). $PLAN_LEDGER_DB overrides; otherwise the
// homedir install convention — deliberately NOT import.meta-relative, which is
// undefined inside the packaged SEA exe (see context.mjs REPO note).
export function defaultDbPath() {
  return process.env.PLAN_LEDGER_DB
    || join(homedir(), 'Documents', 'plan-ledger', 'data', 'plan-ledger.db');
}

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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  keywords    TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
  summary     TEXT    NOT NULL DEFAULT '',      -- one-paragraph "what/why", shown on open
  status      TEXT    NOT NULL DEFAULT 'draft', -- draft | active | done | abandoned | blocked
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id             INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  idx                 INTEGER NOT NULL,          -- 1-based order within the plan
  title               TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending', -- pending | in_progress | done | failed | blocked | skipped
  context             TEXT    NOT NULL DEFAULT '',        -- everything needed to do THIS step
  tools               TEXT    NOT NULL DEFAULT '[]',      -- JSON array of tool/MCP names this step uses
  role                TEXT    NOT NULL DEFAULT '',        -- subagent role that executes this step (e.g. implementer)
  acceptance_criteria TEXT    NOT NULL DEFAULT '',        -- how we know the step passed
  carry_forward       TEXT    NOT NULL DEFAULT '',        -- notes written FOR this step by the previous one
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
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
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_step ON attempts(step_id);

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
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you',
  'are', 'was', 'not', 'but', 'use', 'used', 'using', 'via', 'run', 'add', 'get', 'set', 'its',
  'has', 'have', 'will', 'can', 'per', 'than', 'then', 'when', 'what', 'which', 'our', 'out', 'off',
  'all', 'any', 'one', 'two', 'step', 'plan', 'steps', 'plans', 'node']);
const tokenize = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w));

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

export class Store {
  constructor(dbPath) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 3000;'); // board + MCP + CLI share the file
    this.db.exec('PRAGMA journal_size_limit = 4194304;'); // cap the -wal file at ~4MB after checkpoints
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

  // Fold the WAL back into the main file and truncate it (no-op on :memory:).
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {} }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.checkpoint(); // don't leave a fat -wal behind
    this.db.close();
  }

  // Numbered, PRAGMA user_version-gated migrations. Version 1 stamps the 2026-07
  // state (project layer + step/template roles + attempt provenance). Add future
  // migrations here gated on `v < N`, then bump USER_VERSION to N. The hasCol
  // backfills in the version-1 block are belt-and-braces (safe on any DB shape),
  // so they run unconditionally; NEW migrations should rely on the version gate.
  static USER_VERSION = 1;

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
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('current_project', '1')").run();

    // ---- numbered migrations (gate on v, wrap in _tx, bump the stamp) ----
    // if (v < 2) this._tx(() => { this.db.exec('ALTER TABLE ...'); });

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
  getProject(id) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) throw new Error(`no project with id ${id}`);
    const c = this.db.prepare("SELECT COUNT(*) n, SUM(status='done') done FROM plans WHERE project_id=?").get(id);
    return { id: p.id, name: p.name, description: p.description, status: p.status, plans: c.n ?? 0, plans_done: c.done ?? 0, created_at: p.created_at, updated_at: p.updated_at };
  }
  listProjects() {
    const cur = this.currentProjectId();
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all().map((p) => {
      const c = this.db.prepare("SELECT COUNT(*) n, SUM(status='done') done FROM plans WHERE project_id=?").get(p.id);
      return { id: p.id, name: p.name, description: p.description, status: p.status, plans: c.n ?? 0, plans_done: c.done ?? 0, current: p.id === cur };
    });
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
      if (n && !n.all_blocked) return this.openPlan(r.id); // all_blocked = nothing workable in it either
    }
    return null;
  }

  // ---- plans -------------------------------------------------------------

  createPlan({ title, keywords, summary, project_id }) {
    if (!title || !String(title).trim()) throw new Error('title is required');
    const pid = project_id ?? this.currentProjectId();
    if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(pid)) throw new Error(`no project with id ${pid}`);
    const ts = now();
    const info = this.db
      .prepare('INSERT INTO plans (project_id, title, keywords, summary, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(pid, String(title).trim(), jsonArr(keywords), String(summary ?? ''), 'draft', ts, ts);
    return this.openPlan(Number(info.lastInsertRowid));
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
      created_at: p.created_at,
      updated_at: p.updated_at,
      steps, // index only — call getStep(id) for a step's full context
      file_refs: this.listFileRefs({ plan_id: p.id, plan_level: true }), // plan-level cited files
    };
  }

  setPlanStatus(id, status) {
    if (!PLAN_STATUS.has(status)) throw new Error(`bad plan status: ${status}`);
    const info = this.db.prepare('UPDATE plans SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
    if (info.changes === 0) throw new Error(`no plan with id ${id}`);
    return this.openPlan(id);
  }

  // ---- steps -------------------------------------------------------------

  addStep(planId, { title, context, tools, role, acceptance_criteria, carry_forward, idx }) {
    this._mustPlan(planId);
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
        // true insert-at-idx: make room by shifting everything at/after the slot down one
        this.db.prepare('UPDATE steps SET idx = idx + 1 WHERE plan_id=? AND idx >= ?').run(planId, order);
      }
      const info = this.db
        .prepare(`INSERT INTO steps (plan_id, idx, title, status, context, tools, role, acceptance_criteria, carry_forward, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(planId, order, String(title).trim(), 'pending', String(context ?? ''), jsonArr(tools),
             String(role ?? '').trim(), String(acceptance_criteria ?? ''), String(carry_forward ?? ''), ts, ts);
      return Number(info.lastInsertRowid);
    });
    this.touchPlan(planId);
    return this.getStep(newId);
  }

  // level 2 — the full step payload: context, tools, criteria, carry-forward,
  // every recorded attempt (the failure log), and outbound links.
  getStep(id) {
    const s = this._mustStep(id, '*');
    // Attempts are capped to the LAST 10 (oldest→newest) — a step that failed 50×
    // must not drown the payload; attempts_total says how many exist in all.
    const attempts_total = this.db.prepare('SELECT COUNT(*) c FROM attempts WHERE step_id=?').get(id).c;
    const attempts = this.db.prepare('SELECT id, what_tried, result, verdict, role, review_rounds, executor, created_at FROM attempts WHERE step_id=? ORDER BY id DESC LIMIT 10').all(id).reverse();
    const links = this.db.prepare('SELECT id, to_plan_id, to_step_id, relation, note FROM links WHERE from_step_id=?').all(id);
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
      attempts,
      attempts_total,
      links,
      file_refs: this.listFileRefs({ step_id: id }), // surface only — paths/roles, no content
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
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
    if (fields.idx != null) allowed.idx = Number(fields.idx);
    const keys = Object.keys(allowed);
    if (keys.length) {
      const set = keys.map((k) => `${k}=?`).join(', ');
      this.db.prepare(`UPDATE steps SET ${set}, updated_at=? WHERE id=?`).run(...keys.map((k) => allowed[k]), now(), id);
      this.touchPlan(s.plan_id);
    }
    return this.getStep(id);
  }

  setStepStatus(id, status) {
    if (!STEP_STATUS.has(status)) throw new Error(`bad step status: ${status}`);
    const s = this._mustStep(id, 'plan_id');
    this.db.prepare('UPDATE steps SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
    this.touchPlan(s.plan_id);
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
  recordAttempt(stepId, { what_tried, result, verdict, role, review_rounds, executor }) {
    this._mustStep(stepId);
    if (!what_tried || !String(what_tried).trim()) throw new Error('what_tried is required');
    const v = verdict ?? 'fail';
    if (!VERDICTS.has(v)) throw new Error(`bad verdict: ${v} (pass|fail|partial)`);
    this._tx(() => {
      this.db.prepare('INSERT INTO attempts (step_id, what_tried, result, verdict, role, review_rounds, executor, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(stepId, String(what_tried), String(result ?? ''), v,
             String(role ?? '').trim(), Math.max(0, Number(review_rounds ?? 0) | 0), String(executor ?? '').trim(), now());
      // a passing attempt advances the step to done; a fail marks it failed (not blocked — still retryable)
      // (setStepStatus also touches the plan, so no extra touchPlan here)
      if (v === 'pass') this.setStepStatus(stepId, 'done');
      else this.setStepStatus(stepId, 'failed');
    });
    return this.getStep(stepId);
  }

  // The driver primitive for auto-progression: hand back the next WORKABLE step
  // (lowest idx not done/skipped/blocked, with every builds_on/blocks dependency
  // already done) WITH full context. Embeds cross-plan
  // `lessons` — relevant past failures from ANY plan — so pitfalls hit elsewhere
  // surface before you repeat them. 'blocked' steps wait on a human, so they are
  // skipped (like nextPlan skips blocked plans) rather than wedging the steps
  // behind them. Three shapes:
  //   step object              → work this (may carry skipped_blocked_steps)
  //   { all_blocked: true }    → steps remain but every one waits on a human
  //   null                     → plan complete (nothing left to do)
  nextStep(planId) {
    this._mustPlan(planId);
    const remaining = this.db
      .prepare("SELECT id, idx, title, status FROM steps WHERE plan_id=? AND status NOT IN ('done','skipped') ORDER BY idx, id")
      .all(planId);
    if (!remaining.length) return null;
    // Dependency gate: an outbound builds_on/blocks link to a step that is not yet
    // done/skipped means this step's prerequisite hasn't landed — skip it like a
    // blocked step (reason 'dependency') instead of handing it out to fail.
    const unmetDeps = (stepId) => this.db.prepare(`
      SELECT l.to_step_id FROM links l JOIN steps d ON l.to_step_id = d.id
      WHERE l.from_step_id=? AND l.relation IN ('builds_on','blocks') AND d.status NOT IN ('done','skipped')`)
      .all(stepId).map((r) => r.to_step_id);
    const blocked = remaining.filter((r) => r.status === 'blocked');
    const depWaiting = [];
    let workable = null;
    for (const r of remaining) {
      if (r.status === 'blocked') continue;
      const deps = unmetDeps(r.id);
      if (deps.length) { depWaiting.push({ ...r, waiting_on_step_ids: deps }); continue; }
      workable = r; break;
    }
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
    const step = this.getStep(workable.id);
    step.lessons = this.getLessons({ step_id: workable.id, limit: 5 });
    const skipped = describe([...blocked, ...depWaiting].filter((b) => b.idx < workable.idx));
    if (skipped.length) step.skipped_blocked_steps = skipped;
    return step;
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
    if (step_id != null) rows = this.db.prepare('SELECT * FROM file_refs WHERE step_id=? ORDER BY id').all(step_id);
    else if (plan_id != null) rows = plan_level
      ? this.db.prepare('SELECT * FROM file_refs WHERE plan_id=? AND step_id IS NULL ORDER BY id').all(plan_id)
      : this.db.prepare('SELECT * FROM file_refs WHERE plan_id=? ORDER BY id').all(plan_id);
    return rows.map((r) => ({ id: r.id, plan_id: r.plan_id, step_id: r.step_id ?? null, path: r.path, role: r.role, note: r.note }));
  }

  // EXPAND — read the file on demand (the only call that loads bytes).
  readFileRef(id, { maxBytes = 60000 } = {}) {
    const r = this.getFileRef(id);
    let stat;
    try { stat = statSync(r.path); } catch { return { ...r, exists: false, error: `file not found at ${r.path}` }; }
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

  setRefEnabled(id, enabled) { return this.updateRef(id, { enabled: !!enabled }); }

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
    return { rev: `${maxP}|${maxS}|${att.c}|${att.m || ''}`, active_steps };
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
