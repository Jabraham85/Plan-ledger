#!/usr/bin/env node
// server.mjs — plan-ledger MCP server (stdio).
//
// External working memory for Claude. Plans are surface-indexed (title +
// keywords) and only opened on demand; each step carries its own context,
// tools, acceptance criteria, carry-forward notes, and a failure log so past
// pitfalls aren't repeated.
//
// DB location: $PLAN_LEDGER_DB, else ~/Documents/plan-ledger/data/plan-ledger.db.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Store, defaultDbPath } from './db.mjs';
import { reapLoop } from './supervisor.mjs';
import { resolveRole } from './roles.mjs';
import { evaluateDispatchPolicy } from './dispatch-policy.mjs';
import { buildPlanContext, buildProjectContext, groundSlice, stepTerms } from './context.mjs';
import { extractRepo } from './extract.mjs';
import { RagStore, defaultRagDbPath } from './rag/store.mjs';
import { registerRagTools } from './rag/tools.mjs';

const dbPath = defaultDbPath();
const store = new Store(dbPath);
store.checkpoint(); // trim any WAL left behind by a previous unclean exit
// RAG sidecar: own rag.db (never the precious ledger DB), same lifecycle discipline.
const ragStore = new RagStore(defaultRagDbPath());
process.on('SIGINT', () => { store.close(); ragStore.close(); process.exit(0); });
process.on('exit', () => { store.close(); ragStore.close(); });

const server = new McpServer({ name: 'plan-ledger', version: '0.1.0' });

// Roles resolve through the role map (src/roles.mjs; docs/ROLE_MAP_DESIGN.md). An
// unknown role is allowed (charters and map entries come and go) but flagged, so
// typos surface at authoring time. cwd:null — an MCP server's cwd is not reliably
// the working repo, so only the user-file layers + default charter chain apply here.
const roleWarning = (step) => {
  if (!step?.role) return step;
  const r = resolveRole(step.role, { cwd: null, projectName: store.projectNameForPlan(step.plan_id) });
  if (r.mode === 'dispatch') return step;
  return { ...step, role_warning: r.reason === 'disabled'
    ? `role "${step.role}" is disabled in the role map — dispatch will fall back to orchestrator-decides`
    : `no charter file for role "${step.role}" at ${join(homedir(), '.claude', 'agents', `${step.role}.md`)} and no role-map entry — dispatch will fall back to a generic agent (check for a typo)` };
};

const dispatchPolicyForStep = (step) => evaluateDispatchPolicy({
  step,
  explicit_role: step.role ?? '',
});

// Mutation acks are SLIM: the caller just wrote the payload, so echoing the full
// level-2 step back (context + attempts + links + file_refs) only burns context.
// Directive/warning fields ride on top; read-paths (get_step/next_step) stay full.
const slimStep = (step) => {
  const out = { id: step.id, plan_id: step.plan_id, idx: step.idx, title: step.title, status: step.status, updated_at: step.updated_at };
  if (step.role_warning) out.role_warning = step.role_warning;
  return out;
};

// Every tool returns JSON text; throwing turns into an MCP isError result.
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const tool = (name, cfg, fn) =>
  server.registerTool(name, cfg, (args) => {
    try { return ok(fn(args ?? {})); }
    catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
  });

// ---- projects (top level: project → plan → step) --------------------------

tool('list_projects', {
  title: 'List projects',
  description: 'List all projects (with plan counts) and which one is current. Plans/refs/recall/lessons are scoped to the current project by default so projects don\'t mix.',
  inputSchema: {},
}, () => store.listProjects());

tool('create_project', {
  title: 'Create a project',
  description: 'Create a new top-level project. Plans created while it is current belong to it.',
  inputSchema: { name: z.string(), description: z.string().optional() },
}, ({ name, description }) => store.createProject({ name, description }));

tool('set_current_project', {
  title: 'Switch the current project',
  description: 'Set the active project. Subsequent create_plan / list_plans / recall / get_lessons default to it.',
  inputSchema: { project_id: z.number().int() },
}, ({ project_id }) => store.setCurrentProject(project_id));

tool('set_project_status', {
  title: 'Set project status',
  description: 'active | archived.',
  inputSchema: { project_id: z.number().int(), status: z.enum(['active', 'archived']) },
}, ({ project_id, status }) => store.setProjectStatus(project_id, status));

tool('get_project_context', {
  title: 'Get the project setup prompt (paste to onboard a workspace)',
  description:
    'Return the app/project-level setup handoff for a project (default: current) — the paste that drops any ' +
    'workspace into the right project and fully equips it: live-tool instructions, self-install, the project\'s ' +
    'plans + active rules/tools, and the workflow. Works even with zero plans. This is the "set me up" prompt.',
  inputSchema: { project_id: z.number().int().optional().describe('default: current project') },
}, ({ project_id }) => ({ markdown: buildProjectContext(store, project_id ?? store.currentProjectId()) }));

// ---- surface / navigation -------------------------------------------------

tool('list_plans', {
  title: 'List plans (surface index)',
  description:
    'Level-0 index. Returns ONLY title, keywords, status, and step counts for every plan — never step bodies. ' +
    'Start here to see what exists cheaply, then open_plan the one that matches before pulling any detail.',
  inputSchema: {
    status: z.enum(['draft', 'active', 'done', 'abandoned', 'blocked']).optional().describe('filter by plan status'),
    query: z.string().optional().describe('case-insensitive match against title and keywords'),
    project_id: z.number().int().optional().describe('a specific project (default: current project)'),
    all: z.boolean().optional().describe('list plans across ALL projects'),
  },
}, ({ status, query, project_id, all }) => store.listPlans({ status, query, project_id, all }));

tool('open_plan', {
  title: 'Open a plan',
  description:
    'Level-1 detail. Returns the plan summary plus an ORDERED STEP INDEX (step id/idx/title/status only). ' +
    'Use this to understand a plan and find which step to work; call get_step for a step\'s full context.',
  inputSchema: { plan_id: z.number().int().describe('plan id from list_plans') },
}, ({ plan_id }) => store.openPlan(plan_id));

tool('get_step', {
  title: 'Get a step (full context)',
  description:
    'Level-2 detail. Returns one step\'s full payload: context, tools, acceptance_criteria, carry_forward, the ' +
    'attempts log (past tries + verdicts — read this to avoid repeating failures), and outbound links. ' +
    'Pull ONLY the step you are about to work; let the rest stay on disk.',
  inputSchema: { step_id: z.number().int() },
}, ({ step_id }) => store.getStep(step_id));

tool('next_step', {
  title: 'Get next actionable step',
  description:
    'Driver primitive for auto-progression. Returns the lowest-idx WORKABLE step, WITH full context — blocked ' +
    'steps AND steps whose builds_on/blocks-linked dependency steps are not yet done are skipped (reported in ' +
    'skipped_blocked_steps with a reason). Four shapes: a step → work it; {all_blocked} → everything left waits ' +
    'on the user or a dependency; {all_in_progress} → another executor owns every remaining step; {complete} → plan ' +
    'done. After finishing a step (record_attempt) call this to advance. ' +
    'Pass claim:true to atomically flip the returned step to in_progress in one transaction — required when several ' +
    'autonomous dispatchers (runners, parallel Task calls) share the ledger, so two callers can never receive the ' +
    'same step. Default false preserves idempotent peek semantics.',
  inputSchema: {
    plan_id: z.number().int(),
    claim: z.boolean().optional().describe('atomically CAS the returned step to in_progress (default false = peek only)'),
    executor: z.string().optional().describe('tag stamped on the claim for observability (e.g. "runner-mcp", "cursor")'),
  },
}, ({ plan_id, claim, executor }) => {
  const plan = store.openPlan(plan_id);
  if (plan.status === 'draft') return {
    awaiting_approval: true,
    plan,
    directive:
      `Plan #${plan_id} is draft and MUST NOT execute. Present the complete plan to the user and ask ` +
      `"Approve plan #${plan_id} to begin execution?" Only after explicit approval call ` +
      `set_plan_status(${plan_id}, "active"), then resume next_step.`,
  };
  const step = store.nextStep(plan_id, { claim: !!claim, executor: executor ?? '' });
  if (step === null) return {
    complete: true,
    directive:
      `Plan #${plan_id} is complete. set_plan_status(${plan_id}, "done"), then call next_plan() and keep working ` +
      'the plan it returns — do not stop unless nothing is workable or the user scoped this run.',
  };
  if (step.all_in_progress) return {
    ...step,
    directive:
      `Plan #${plan_id} is NOT complete: every remaining step is already in_progress ` +
      `(${step.active_steps.map((s) => `#${s.id}`).join(', ')}). Do not mark the plan done or dispatch duplicates; ` +
      'wait for those executors, inspect their status, or recover an orphan before retrying next_step.',
  };
  if (step.all_blocked) return {
    ...step,
    directive:
      `Every remaining step in plan #${plan_id} is blocked or waiting on a dependency. ` +
      `set_plan_status(${plan_id}, "blocked"), then ` +
      'call next_plan() and continue with the plan it returns — do not stop here.',
  };
  // Resolve the role through the role map (user-file layers only: an MCP server's
  // cwd is not reliably the working repo, so the directive tells the client that a
  // repo-local .plan-roles.json — which the client CAN see — still overrides).
  const policy = step.dispatch_policy || dispatchPolicyForStep(step);
  const dispatchRole = policy.selected_role || step.role || '';
  const r = resolveRole(dispatchRole, { cwd: null, projectName: store.projectNameForPlan(plan_id) });
  const dispatch = r.mode === 'dispatch'
    ? `DISPATCH to the "${r.agent}" agent (Claude Code: Agent tool subagent_type "${r.agent}"` +
      (r.model ? `, model "${r.model}"` : '') +
      `; Cursor: launch a fresh full agent CLI session with \`agent -p --output-format json` +
      (r.model ? ` --model "${r.model}"` : '') +
      ` --trust --force --workspace "<repo>" "<brief>"\`, then record its returned session_id and model_source "cursor-cli"; ` +
      (r.global_context ? `give it these persistent cross-project role rules: ${r.global_context}; ` : '') +
      (r.charter
        ? `no subagents available: read ${r.charter} and adopt it yourself, then self-review against its ` +
          `Definition of done before recording`
        : `no subagents available: work it yourself and self-review against the acceptance_criteria before recording`) +
      `) with a brief composed from this step's context + acceptance_criteria + carry_forward + lessons` +
      (r.agent !== r.role && r.charter
        ? `; the brief MUST open with: read + adopt the "${r.role}" charter at ${r.charter}` : '') +
      `; if ./.plan-roles.json in the repo maps "${r.role}" differently, prefer that resolution; ` +
      `when it reports, REVIEW the deliverable against the acceptance_criteria and the role's Definition of done ` +
      `(from ${r.charter ?? 'the acceptance_criteria alone'}; evidence required — claims don't count), ` +
      `send corrections back to the same agent if it falls short (max 3 rounds), `
    : r.reason === 'untagged'
      ? 'work it (or dispatch to the best-fit role agent), '
      : `work it (role "${step.role}" is ${r.reason === 'disabled' ? 'disabled in the role map' : 'not in the roster or role map'} — ` +
        `pick the best-fit role from docs/ROLES.md yourself, or update_step(${step.id}, role: "<name>")), `;
  const claimPrefix = step.claimed
    ? `Step #${step.id} was atomically claimed for you (status is already in_progress). Read attempts + lessons FIRST `
    : `Work this step now: set_step_status(${step.id}, "in_progress"), read attempts + lessons FIRST `;
  return {
    ...step,
    dispatch_policy: policy,
    directive:
      `${claimPrefix}(never repeat ` +
      `a failed approach), dispatch policy selected "${dispatchRole || 'orchestrator'}" (${policy.selection_mode})` +
      `${policy.warnings?.length ? ` with warnings: ${policy.warnings.join(' | ')}` : ''}; ${dispatch}` +
      `then record_attempt(${step.id}, ...) noting the role + review rounds. After ` +
      `that, call next_step(${plan_id}) again — do not end your turn while workable steps remain.` +
      (step.brain?.length
        ? ` BRAIN: \`brain\` holds ${step.brain.length} recorded fact(s) about this step's code — put them in the brief ` +
          `(verify any marked suspect/conflict before relying on it). When the step teaches durable truths, ` +
          `absorb_findings(step_id: ${step.id}, …) with subject + evidence (path:line), and depends_on the brain ids you relied on.`
        : ` When the step teaches durable truths, absorb_findings(step_id: ${step.id}, …) with subject + evidence (path:line).`),
  };
});

tool('ready_steps', {
  title: 'Get the concurrently-launchable frontier',
  description:
    'Return pending or failed retryable steps in a plan whose builds_on/blocks dependencies are already satisfied ' +
    '(done or skipped) — the frontier that could be dispatched RIGHT NOW, not just the lowest-idx one. Uses the ' +
    'same dependency gate as next_step, so the two always agree on what is workable. Steps not listed are either ' +
    'blocked, waiting on a dependency, already done, or in_progress. Peek first, apply worker-slot and path-conflict ' +
    'limits, then claim only the selected steps. Failed retryable steps are included in the returned frontier.',
  inputSchema: {
    plan_id: z.number().int(),
    claim: z.boolean().optional().describe('atomically claim returned steps (default false = peek only)'),
    limit: z.number().int().positive().optional().describe('maximum steps to return or claim'),
    executor: z.string().optional().describe('tag returned on each claim (e.g. "cursor-interactive")'),
  },
}, ({ plan_id, claim, limit, executor }) => {
  const plan = store.openPlan(plan_id);
  if (plan.status === 'draft') return {
    awaiting_approval: true,
    plan,
    steps: [],
    directive:
      `Plan #${plan_id} is draft. Do not claim or dispatch its steps; present the complete plan and wait for explicit approval.`,
  };
  const steps = store.readySteps(plan_id, {
    claim: !!claim,
    limit,
    executor: executor ?? '',
  }).map((s) => roleWarning(s));
  return {
    steps,
    directive: steps.length
      ? `${claim ? 'These steps are already atomically claimed for this run. ' : 'Apply worker-slot and path-conflict limits before claiming. '}` +
        `These ${steps.length} step(s) are ready for continuous-refill dispatch. Claim only available, ` +
        'non-conflicting slots; refill each slot as its agent finishes.'
      : 'Nothing is ready right now — every remaining step is blocked, mid-flight, or waiting on a dependency. ' +
        'Call next_step for the detailed reason.',
  };
});

tool('next_plan', {
  title: 'Get the next workable plan',
  description:
    'Driver primitive for continuous runs: the oldest non-done/abandoned/blocked plan in a project (default: ' +
    'current) that still has a workable step. Returns the opened plan (level-1 detail) → call next_step on it; ' +
    '{complete} → nothing workable remains. Call this whenever a plan finishes or blocks, instead of stopping.',
  inputSchema: { project_id: z.number().int().optional().describe('default: current project') },
}, ({ project_id }) => {
  const plan = store.nextPlan(project_id);
  if (!plan) return {
    complete: true,
    directive:
      `No workable plans remain in project #${project_id ?? store.currentProjectId()}. Report the run's outcomes ` +
      'and stop — or ask the user for the next objective.',
  };
  return {
    ...plan,
    ...(plan.status === 'draft' ? { awaiting_approval: true } : {}),
    directive: plan.status === 'draft'
      ? `Plan #${plan.id} ("${plan.title}") is draft. Present its complete step board and wait for explicit user approval; do not execute it.`
      : `Work plan #${plan.id} ("${plan.title}") now: call next_step(${plan.id}) and keep going — do not stop.`,
  };
});

// ---- authoring ------------------------------------------------------------

tool('create_plan', {
  title: 'Create a plan',
  description:
    'Create a new plan. Keep the summary to a tight "what + why"; put execution detail in steps. ' +
    'Optional consulted_plan_ids records durable prior-plan provenance at creation.',
  inputSchema: {
    title: z.string().describe('short, searchable title'),
    keywords: z.array(z.string()).optional().describe('surface keywords used for matching in list_plans'),
    summary: z.string().optional().describe('one-paragraph what/why, shown when the plan is opened'),
    project_id: z.number().int().optional().describe('owning project (default: current project)'),
    consulted_plan_ids: z.array(z.number().int()).optional().describe('prior plan ids consulted while drafting this plan'),
    consulted_keywords: z.array(z.string()).optional().describe('keyword set used to discover consulted plans'),
    consulted_goal: z.string().optional().describe('planning goal text associated with consultation'),
    consulted_note: z.string().optional(),
  },
}, ({ title, keywords, summary, project_id, consulted_plan_ids, consulted_keywords, consulted_goal, consulted_note }) =>
  store.createPlan({ title, keywords, summary, project_id, consulted_plan_ids, consulted_keywords, consulted_goal, consulted_note }));

tool('update_plan', {
  title: 'Update a plan',
  description:
    'Edit mutable plan metadata (title/keywords/summary) and optionally append/refresh consulted prior plans. ' +
    'Status transitions stay on set_plan_status.',
  inputSchema: {
    plan_id: z.number().int(),
    title: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    summary: z.string().optional(),
    consulted_plan_ids: z.array(z.number().int()).optional().describe('prior plan ids consulted while refining this draft'),
    consulted_keywords: z.array(z.string()).optional(),
    consulted_goal: z.string().optional(),
    consulted_note: z.string().optional(),
  },
}, ({ plan_id, ...fields }) => store.updatePlan(plan_id, fields));

tool('add_step', {
  title: 'Add a step to a plan',
  description:
    'Append (or insert at idx) a step. Put EVERYTHING this step needs in `context` and how it is judged in ' +
    '`acceptance_criteria`, so the step can be executed in a fresh session with no other memory.',
  inputSchema: {
    plan_id: z.number().int(),
    title: z.string(),
    context: z.string().optional().describe('self-contained: what to do and what is needed to do it'),
    tools: z.array(z.string()).optional().describe('tool/MCP names this step uses'),
    role: z.string().max(64).optional().describe('subagent role that executes this step (e.g. implementer, ui-designer, test-engineer); empty = orchestrator decides at dispatch'),
    acceptance_criteria: z.string().optional().describe('concrete pass condition'),
    carry_forward: z.string().optional().describe('seed note carried in from a prior step'),
    idx: z.number().int().optional().describe('1-based position; appends to end if omitted'),
  },
}, ({ plan_id, ...rest }) => slimStep(roleWarning(store.addStep(plan_id, rest))));

tool('update_step', {
  title: 'Update a step',
  description:
    'Edit a step\'s fields (title/context/tools/role/acceptance_criteria/carry_forward/idx). Only pass what changes. ' +
    'Changing the `role` on a step that already has a plan-time assignment appends an audited revision — `reason` ' +
    'is REQUIRED then (post-initial reassignment). Optional `assigned_by` tags who made the change (default: user).',
  inputSchema: {
    step_id: z.number().int(),
    title: z.string().optional(),
    context: z.string().optional(),
    tools: z.array(z.string()).optional(),
    role: z.string().max(64).optional().describe('subagent role that executes this step; empty string clears it'),
    acceptance_criteria: z.string().optional(),
    carry_forward: z.string().optional(),
    idx: z.number().int().optional(),
    reason: z.string().optional().describe('required when changing `role` on a step with a prior assignment revision'),
    assigned_by: z.string().max(64).optional().describe('who made the reassignment (default: user)'),
  },
}, ({ step_id, ...fields }) => slimStep(roleWarning(store.updateStep(step_id, fields))));

tool('assign_step', {
  title: 'Reassign the specialist that executes a step (audited)',
  description:
    'Explicit reassignment path — append a new step-assignment revision with a required reason. Use this from UIs ' +
    'and reviewers whenever the specialist selection changes (or needs to be re-resolved after a role-map edit). ' +
    'Preserves attempts and prior assignment revisions.',
  inputSchema: {
    step_id: z.number().int(),
    role: z.string().max(64).optional().describe('new role tag (defaults to current)'),
    reason: z.string().describe('why this dispatch is changing — required'),
    assigned_by: z.string().max(64).optional().describe('who is making the change (default: user)'),
    dispatch_policy: z.object({
      task_modality: z.string().optional(),
      required_artifact_type: z.string().optional(),
      preferred_role: z.string().optional(),
      fallback_roles: z.array(z.string()).optional(),
    }).optional(),
    override_reason: z.string().max(400).optional(),
  },
}, ({
  step_id, role, reason, assigned_by, dispatch_policy, override_reason,
}) => slimStep(roleWarning(store.assignStep(step_id, {
  role, reason, assigned_by, dispatch_policy, override_reason,
}))));

tool('redo_step', {
  title: 'Send a step back to pending with a reason',
  description:
    'Explicit redo action: reset a step to pending, append a note capturing the correction reason, and preserve ' +
    'every attempt + assignment revision. Use this from a reviewer flow instead of raw set_step_status when the ' +
    'work should visibly be retried (the note lets the next executor see WHY it is being redone).',
  inputSchema: {
    step_id: z.number().int(),
    reason: z.string().describe('why the step needs to be redone — required'),
    assigned_by: z.string().max(64).optional().describe('who is requesting the redo (default: user)'),
  },
}, ({ step_id, reason, assigned_by }) => slimStep(store.redoStep(step_id, { reason, assigned_by })));

tool('get_plan_roster', {
  title: 'Get a plan\'s execution roster (planned vs actual)',
  description:
    'Return per-step transparency for a plan: initial plan-time assignment, current planned dispatch (latest ' +
    'revision), the live role-map resolution now, the last observed execution provenance (agent/model/source), ' +
    'assignment revision history, and drift flags between them. Read-only.',
  inputSchema: { plan_id: z.number().int() },
}, ({ plan_id }) => store.getPlanRoster(plan_id, { cwd: null }));

tool('start_activity', {
  title: 'Start durable step activity',
  description:
    'Create a durable live execution activity record keyed by plan/step/run/session. Stores structured run telemetry ' +
    '(role/agent/model/session/phase/progress/artifacts/verification/blockers/status/outcome/metadata) without chain-of-thought.',
  inputSchema: {
    plan_id: z.number().int(),
    step_id: z.number().int(),
    run_id: z.string().min(1).max(96),
    session_ref: z.string().min(1).max(256),
    role: z.string().max(64).optional(),
    agent: z.string().max(128).optional(),
    requested_model: z.string().max(128).optional(),
    actual_model: z.string().max(128).optional(),
    model_source: z.string().max(64).optional(),
    phase: z.string().max(96).optional(),
    action_summary: z.string().max(500).optional(),
    command_summary: z.string().max(280).optional(),
    status: z.enum(['queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
    outcome: z.enum(['success', 'failed', 'partial', 'blocked', 'cancelled', 'unknown']).optional(),
    verification_state: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'not_applicable']).optional(),
    blocker: z.string().max(500).optional(),
    progress_completed: z.number().int().min(0).optional(),
    progress_total: z.number().int().min(0).optional(),
    file_count: z.number().int().min(0).optional(),
    artifact_count: z.number().int().min(0).optional(),
    recent_artifacts: z.array(z.string()).max(30).optional(),
    metadata: z.record(z.any()).optional(),
  },
}, (args) => store.startActivity(args));

tool('heartbeat_activity', {
  title: 'Upsert activity heartbeat',
  description:
    'Atomically upsert a heartbeat on the plan/step/run/session activity key. Safe for concurrent writers; updates status, phase, progress, counters, models, verification and metadata.',
  inputSchema: {
    plan_id: z.number().int(),
    step_id: z.number().int(),
    run_id: z.string().min(1).max(96),
    session_ref: z.string().min(1).max(256),
    role: z.string().max(64).optional(),
    agent: z.string().max(128).optional(),
    requested_model: z.string().max(128).optional(),
    actual_model: z.string().max(128).optional(),
    model_source: z.string().max(64).optional(),
    phase: z.string().max(96).optional(),
    action_summary: z.string().max(500).optional(),
    command_summary: z.string().max(280).optional(),
    status: z.enum(['queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
    outcome: z.enum(['success', 'failed', 'partial', 'blocked', 'cancelled', 'unknown']).optional(),
    verification_state: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'not_applicable']).optional(),
    blocker: z.string().max(500).optional(),
    progress_completed: z.number().int().min(0).optional(),
    progress_total: z.number().int().min(0).optional(),
    file_count: z.number().int().min(0).optional(),
    artifact_count: z.number().int().min(0).optional(),
    recent_artifacts: z.array(z.string()).max(30).optional(),
    metadata: z.record(z.any()).optional(),
  },
}, (args) => store.upsertActivityHeartbeat(args));

tool('append_activity_event', {
  title: 'Append timeline or terminal event',
  description:
    'Append an event to an existing activity run. timeline events are compacted by retention policy; terminal events are preserved.',
  inputSchema: {
    plan_id: z.number().int(),
    step_id: z.number().int(),
    run_id: z.string().min(1).max(96),
    session_ref: z.string().min(1).max(256),
    event_type: z.enum(['timeline', 'terminal']).optional(),
    phase: z.string().max(96).optional(),
    summary: z.string().max(500).optional(),
    command_summary: z.string().max(280).optional(),
    status: z.enum(['queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
    metadata: z.record(z.any()).optional(),
  },
}, (args) => store.appendActivityEvent(args));

tool('list_current_activity', {
  title: 'List current live activity',
  description:
    'List currently active activity runs (queued/in_progress/blocked) with derived stale status at read time. Optional event expansion.',
  inputSchema: {
    project_id: z.number().int().optional(),
    plan_id: z.number().int().optional(),
    step_id: z.number().int().optional(),
    stale_after_ms: z.number().int().min(1000).max(86_400_000).optional(),
    include_events: z.boolean().optional(),
    events_limit: z.number().int().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
}, (args) => store.listCurrentActivity(args));

tool('list_recent_activity', {
  title: 'List recent activity history',
  description:
    'List recent activity runs (active and completed) ordered by newest heartbeat/update, with derived stale status and optional event expansion.',
  inputSchema: {
    project_id: z.number().int().optional(),
    plan_id: z.number().int().optional(),
    step_id: z.number().int().optional(),
    stale_after_ms: z.number().int().min(1000).max(86_400_000).optional(),
    include_events: z.boolean().optional(),
    events_limit: z.number().int().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
}, (args) => store.listRecentActivity(args));

// ---- execution leases (unavoidable lifecycle primitive) --------------------

tool('open_execution_lease', {
  title: 'Open a supervised execution lease on a step',
  description:
    'Atomically claim a step (pending/failed → in_progress), create the paired activity run, and open an ' +
    'execution lease so the runner/MCP/CLI/board execution surfaces terminalize the same way. Refused when the ' +
    'step is not claimable or another lease is already open. Callers must heartbeat_execution_lease periodically ' +
    'and close_execution_lease when the step terminalizes; reap_stale_leases handles supervisor death.',
  inputSchema: {
    plan_id: z.number().int(),
    step_id: z.number().int(),
    executor: z.string().max(64).optional(),
    run_id: z.string().max(96).optional(),
    session_ref: z.string().max(256).optional(),
    role: z.string().max(64).optional(),
    agent: z.string().max(128).optional(),
    requested_model: z.string().max(128).optional(),
    actual_model: z.string().max(128).optional(),
    model_source: z.string().max(64).optional(),
    child_pid: z.number().int().nullable().optional(),
    deadline_ms: z.number().int().positive().max(24 * 3600 * 1000).optional(),
    stale_after_ms: z.number().int().min(5000).max(24 * 3600 * 1000).optional(),
    dispatch_policy: z.object({
      task_modality: z.string().optional(),
      required_artifact_type: z.string().optional(),
      preferred_role: z.string().optional(),
      fallback_roles: z.array(z.string()).optional(),
    }).optional(),
    lease_policy: z.object({
      first_artifact_deadline_ms: z.number().int().positive().optional(),
      heartbeat_interval_ms: z.number().int().positive().optional(),
      stale_after_ms: z.number().int().positive().optional(),
      max_auto_reassignments: z.number().int().min(0).optional(),
    }).optional(),
    override_reason: z.string().max(400).optional(),
    phase: z.string().max(96).optional(),
    action_summary: z.string().max(500).optional(),
    progress_total: z.number().int().min(0).optional(),
    progress_completed: z.number().int().min(0).optional(),
    metadata: z.record(z.any()).optional(),
  },
}, (args) => store.openExecutionLease(args));

tool('heartbeat_execution_lease', {
  title: 'Heartbeat an open execution lease',
  description:
    'Bump the lease clock and upsert the paired activity in one call. Rejects heartbeat on a closed/cancelled lease.',
  inputSchema: {
    lease_id: z.number().int(),
    role: z.string().max(64).optional(),
    agent: z.string().max(128).optional(),
    actual_model: z.string().max(128).optional(),
    model_source: z.string().max(64).optional(),
    child_pid: z.number().int().nullable().optional(),
    phase: z.string().max(96).optional(),
    action_summary: z.string().max(500).optional(),
    command_summary: z.string().max(280).optional(),
    status: z.enum(['queued', 'in_progress', 'blocked']).optional(),
    verification_state: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'not_applicable']).optional(),
    blocker: z.string().max(500).optional(),
    progress_completed: z.number().int().min(0).optional(),
    progress_total: z.number().int().min(0).optional(),
    file_count: z.number().int().min(0).optional(),
    artifact_count: z.number().int().min(0).optional(),
    recent_artifacts: z.array(z.string()).max(30).optional(),
    metadata: z.record(z.any()).optional(),
    deadline_ms: z.number().int().positive().max(24 * 3600 * 1000).optional(),
  },
}, ({ lease_id, ...patch }) => store.heartbeatExecutionLease(lease_id, patch));

tool('close_execution_lease', {
  title: 'Terminalize an execution lease',
  description:
    'Atomically append a `terminal` activity event, upsert the activity to a terminal status, optionally record an ' +
    'attempt with a verdict, and (for pass) require a verification disposition (verified|not_applicable). Idempotent ' +
    'on an already-closed lease. Non-success closes without an attempt reset the step to failed so it stays retryable.',
  inputSchema: {
    lease_id: z.number().int(),
    outcome: z.enum(['success', 'failed', 'partial', 'blocked', 'cancelled']).optional(),
    close_reason: z.string().max(200).optional(),
    terminal_summary: z.string().max(500).optional(),
    terminal_phase: z.string().max(96).optional(),
    terminal_metadata: z.record(z.any()).optional(),
    verification_state: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'not_applicable']).optional(),
    step_verdict: z.enum(['pass', 'fail', 'partial', 'blocked']).optional(),
    attempt: z.object({
      what_tried: z.string(),
      result: z.string().optional(),
      role: z.string().optional(),
      executor: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      model_source: z.string().optional(),
      session_ref: z.string().optional(),
      completion_payload: z.any().optional(),
    }).optional(),
    completion_payload: z.any().optional(),
    disposition: z.enum(['verified', 'not_applicable', 'deferred', 'blocked', 'legacy_unknown']).optional(),
    disposition_reason: z.string().max(400).optional(),
  },
}, ({ lease_id, ...rest }) => store.closeExecutionLease(lease_id, rest));

tool('reap_stale_leases', {
  title: 'Reap stale/deadline-breached execution leases',
  description:
    'Sweep open leases whose deadline has passed or that have been silent longer than stale_after_ms. Each reaped ' +
    'lease is cancelled with a terminal event, and its step drops back to failed so a fresh supervisor can retry it.',
  inputSchema: {
    plan_id: z.number().int().optional(),
    grace_ms: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
    dispatch_policy: z.object({
      task_modality: z.string().optional(),
      required_artifact_type: z.string().optional(),
      preferred_role: z.string().optional(),
      fallback_roles: z.array(z.string()).optional(),
    }).optional(),
    lease_policy: z.object({
      first_artifact_deadline_ms: z.number().int().positive().optional(),
      heartbeat_interval_ms: z.number().int().positive().optional(),
      stale_after_ms: z.number().int().positive().optional(),
      max_auto_reassignments: z.number().int().min(0).optional(),
    }).optional(),
    override_reason: z.string().max(400).optional(),
  },
}, (args) => store.reapStaleLeases(args ?? {}));

tool('list_execution_leases', {
  title: 'List execution leases (open or all)',
  description: 'Read-only listing with optional filters (plan/step/status). Newest first.',
  inputSchema: {
    plan_id: z.number().int().optional(),
    step_id: z.number().int().optional(),
    status: z.enum(['open', 'closed', 'cancelled']).optional(),
  },
}, (args) => store.listExecutionLeases(args ?? {}));

tool('get_execution_lease', {
  title: 'Get an execution lease',
  description: 'Read-only detail for a single lease id.',
  inputSchema: { lease_id: z.number().int() },
}, ({ lease_id }) => store.getExecutionLease(lease_id));

tool('set_step_disposition', {
  title: 'Set a step\'s verification disposition (audited)',
  description:
    'Record the closure decision for a step: verified | not_applicable | deferred | blocked | legacy_unknown. ' +
    'deferred / blocked / not_applicable require a reason. Verified is auto-set by record_attempt(pass); this ' +
    'tool is for admin/UI reconciliation of steps closed outside the normal record_attempt path.',
  inputSchema: {
    step_id: z.number().int(),
    disposition: z.enum(['verified', 'not_applicable', 'deferred', 'blocked', 'legacy_unknown']),
    reason: z.string().optional(),
  },
}, ({ step_id, disposition, reason }) => store.setStepDisposition(step_id, { disposition, reason }));

tool('assess_plan_terminalization', {
  title: 'Dry-run the plan-done gate',
  description:
    'Read-only: explain exactly which invariants would block setPlanStatus(done) right now (active steps, missing ' +
    'dispositions, open leases, non-terminal activity). Useful for UIs before offering "close plan".',
  inputSchema: { plan_id: z.number().int() },
}, ({ plan_id }) => store.assessPlanTerminalization(plan_id));

tool('assess_plan_reconciliation', {
  title: 'Read terminalization reconciliation state',
  description:
    'Read-only: summarize whether an active plan is contradiction-eligible (all strict blockers cleared) and how ' +
    'auto-terminalization would classify it under the current PLAN_LEDGER_AUTO_TERMINALIZE mode.',
  inputSchema: {
    plan_id: z.number().int(),
    source: z.string().max(120).optional(),
    strict: z.boolean().optional(),
  },
}, ({ plan_id, source, strict }) => store.assessPlanReconciliation(plan_id, { source, strict }));

tool('assess_completion_backfill', {
  title: 'Read completion-validation backfill summary',
  description:
    'Read-only summary of completion validation states across attempts (pass|fail|legacy_unknown), ' +
    'including legacy missing-payload counts. Does not rewrite historical data.',
  inputSchema: {},
}, () => store.assessCompletionBackfill());

tool('assess_activity_backfill', {
  title: 'Read activity backfill summary',
  description:
    'Read-only summary of synthetic activity_backfill_missing markers for historical steps with no activity history.',
  inputSchema: {},
}, () => store.assessActivityBackfill());

// ---- the working loop -----------------------------------------------------

tool('record_attempt', {
  title: 'Record an attempt on a step',
  description:
    'Log what you tried and how it went. verdict=pass marks the step done; fail/partial marks it failed (still ' +
    'retryable) and is preserved in the failure log so the approach is not repeated. ALWAYS record failures. ' +
    'Optional provenance fields (agent/model/model_source/session_ref) capture WHAT actually served the call, ' +
    'separate from the step\'s PLANNED assignment — leave blank when unknown (never fabricate a model).',
  inputSchema: {
    step_id: z.number().int(),
    what_tried: z.string().describe('the approach taken — specific enough that "do not repeat" is actionable'),
    result: z.string().optional().describe('what actually happened (error text, output, observation)'),
    verdict: z.enum(['pass', 'fail', 'partial']).optional().describe('default fail'),
    role: z.string().max(64).optional().describe('subagent role that executed the attempt (e.g. implementer)'),
    review_rounds: z.number().int().min(0).optional().describe('orchestrator send-back rounds before acceptance'),
    executor: z.string().max(64).optional().describe('who drove the attempt (e.g. runner-mcp, runner-inject, orchestrator)'),
    agent: z.string().max(128).optional().describe('concrete agent that actually ran (e.g. general-purpose, cursor-top-level)'),
    model: z.string().max(128).optional().describe('concrete model that actually served the call (e.g. claude-sonnet-4-5)'),
    model_source: z.enum(['role-map', 'runner-cli', 'telemetry', 'self-report', 'user', 'unknown']).optional()
      .describe('provenance of the model field (default unknown; use runner-cli/telemetry when observed programmatically)'),
    session_ref: z.string().max(256).optional().describe('optional link to the chat transcript or session id'),
    completion_payload: z.any().optional().describe('machine-checkable completion_payload_v2 evidence payload'),
    layman: z.string().optional().describe('plain-English "what was done + thoughts" for this step (distinct from what_tried) — set/overwrites the step\'s layman box'),
  },
}, ({ step_id, ...rest }) => {
  const step = store.recordAttempt(step_id, rest);
  // Directive rides in the tool result — the freshest thing in context when the
  // model decides whether to keep going. This is what keeps the loop alive.
  const plan = store.openPlan(step.plan_id);
  const remaining = plan.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  const workable = remaining.filter((s) => s.status !== 'blocked' && s.id !== step.id);
  const progress = `${plan.steps.length - remaining.length}/${plan.steps.length} steps done`;
  let directive;
  if (step.status === 'done') {
    directive = workable.length
      ? `Step done (${progress}). ${workable.length} workable step(s) remain — write_carry_forward anything the ` +
        `next step needs, then IMMEDIATELY call next_step(${step.plan_id}) and keep working. Do not end your turn.`
      : remaining.length
        ? `Step done (${progress}). Only blocked steps remain — set_plan_status(${step.plan_id}, "blocked") and ` +
          'continue with the next workable plan.'
        : `Step done — plan complete (${progress}). set_plan_status(${step.plan_id}, "done"), then continue with ` +
          'the next workable plan unless the user scoped this run.';
  } else {
    directive =
      'Failure logged; the step stays retryable. Retry NOW with a DIFFERENT approach (check the attempts log — ' +
      `never repeat one marked fail). If it genuinely needs the user, set_step_status(${step.id}, "blocked") + ` +
      `write_carry_forward the unblock note, then call next_step(${step.plan_id}) to advance past it. Do not stop.`;
  }
  return { ...slimStep(step), plan_progress: progress, directive };
});

tool('set_layman', {
  title: 'Set a step\'s plain-English box',
  description:
    'Write the step\'s layman field: plain-English "what was done + thoughts", basic terms — distinct from ' +
    'what_tried (which is evidence-heavy, on the attempt). Replaces the current value. Also settable inline via ' +
    'record_attempt\'s optional `layman` param.',
  inputSchema: { step_id: z.number().int(), text: z.string() },
}, ({ step_id, text }) => slimStep(store.setLayman(step_id, text)));

tool('write_carry_forward', {
  title: 'Carry context forward to a step',
  description:
    'The explicit channel for surviving a context reset: write a note INTO a later step (usually the next one) ' +
    'so the fresh session executing it has exactly what it needs and nothing more. Appends by default.',
  inputSchema: {
    step_id: z.number().int().describe('the step that should RECEIVE the note (e.g. the next step)'),
    note: z.string(),
    append: z.boolean().optional().describe('append to existing carry_forward (default true) or replace (false)'),
  },
}, ({ step_id, note, append }) => {
  const step = store.writeCarryForward(step_id, note, { append });
  return {
    ...slimStep(step),
    directive:
      `Carry-forward saved on step #${step_id}. Keep the loop going: call next_step(${step.plan_id}) — or ` +
      'next_plan() if this plan is finished — do not stop.',
  };
});

tool('add_note', {
  title: 'Append a note to a step\'s review thread',
  description:
    'Append one entry to a step\'s append-only discussion thread (review/feedback back-and-forth) — distinct ' +
    'from record_attempt (work records) and link_items (graph edges). Returned in order by get_step as `notes`.',
  inputSchema: {
    step_id: z.number().int(),
    author: z.string().max(64).optional().describe('who is writing this note (e.g. a role name or "user")'),
    body: z.string(),
  },
}, ({ step_id, author, body }) => slimStep(store.addNote(step_id, { author, body })));

tool('link_items', {
  title: 'Link a step to a related plan/step',
  description:
    'Create a pathway from a step to a related plan or step (relation: references | builds_on | blocks | supersedes). ' +
    'Use builds_on when a step depends on something built earlier, so the chain back is explicit. NOTE: a ' +
    'builds_on/blocks link to a STEP is a real dependency — next_step defers the linking step until that step is done.',
  inputSchema: {
    from_step_id: z.number().int(),
    to_plan_id: z.number().int().optional(),
    to_step_id: z.number().int().optional(),
    relation: z.enum(['references', 'builds_on', 'blocks', 'supersedes']).optional(),
    note: z.string().optional(),
  },
}, ({ from_step_id, ...rest }) => store.link(from_step_id, rest));

// ---- refs (toggleable rules / tools) & context handoff ---------------------

tool('list_refs', {
  title: 'List rules / tools',
  description:
    'List reusable rules and tool references. enabled-filter + scope: pass a plan_id to get that ' +
    "plan's refs plus globals; scope:'global' for globals only. These are what the user toggles on/off " +
    'so guidance does not linger in chats; enabled ones are folded into get_context.',
  inputSchema: {
    kind: z.enum(['rule', 'tool']).optional(),
    enabled: z.boolean().optional(),
    plan_id: z.number().int().optional().describe("include this plan's refs plus globals"),
    scope: z.enum(['global']).optional(),
  },
}, ({ kind, enabled, plan_id, scope }) => store.listRefs({ kind, enabled, plan_id, scope }));

tool('create_ref', {
  title: 'Create a rule / tool reference',
  description: 'Add a reusable rule or tool reference to the library. plan_id omitted → global; enabled defaults true.',
  inputSchema: {
    kind: z.enum(['rule', 'tool']).describe('rule = guidance to apply; tool = a tool/MCP to use'),
    name: z.string(),
    body: z.string().optional().describe('the rule text or what the tool is for'),
    enabled: z.boolean().optional(),
    plan_id: z.number().int().optional().describe('scope to a specific plan'),
    project_id: z.number().int().optional().describe('scope to a specific project (default: current project)'),
    global: z.boolean().optional().describe('make it apply across ALL projects'),
    keywords: z.array(z.string()).optional(),
  },
}, ({ kind, ...rest }) => store.createRef({ kind, ...rest }));

tool('update_ref', {
  title: 'Update a rule / tool',
  description: 'Edit a reference (kind/name/body/enabled/plan_id/keywords). Only pass what changes.',
  inputSchema: {
    ref_id: z.number().int(),
    kind: z.enum(['rule', 'tool']).optional(),
    name: z.string().optional(),
    body: z.string().optional(),
    enabled: z.boolean().optional(),
    plan_id: z.number().int().nullable().optional(),
    keywords: z.array(z.string()).optional(),
  },
}, ({ ref_id, ...fields }) => store.updateRef(ref_id, fields));

tool('delete_ref', {
  title: 'Delete a rule / tool',
  description: 'Remove a reference from the library.',
  inputSchema: { ref_id: z.number().int() },
}, ({ ref_id }) => store.deleteRef(ref_id));

tool('get_context', {
  title: 'Get a plan as a paste-ready context blob',
  description:
    'Return the full markdown handoff for a plan — plan + every step (context, acceptance, carry-forward, ' +
    'failures-to-avoid, links) + the currently-enabled rules/tools. This is the same text the board\'s ' +
    '"Copy context" button produces; use it to hand a fresh workspace complete grounding for a plan.',
  inputSchema: { plan_id: z.number().int() },
}, ({ plan_id }) => ({ markdown: buildPlanContext(store, plan_id) }));

// ---- code graph (absorbed graphify graph; ground steps in code) ------------

tool('import_graph', {
  title: 'Import a code graph into a plan',
  description:
    'Absorb a graphify-style NetworkX node-link graph (graph.json: {nodes[], links[]}) into a plan so its ' +
    'steps can be grounded in code. Pass `path` to a graph.json file (e.g. graphify-out/graph.json) or an ' +
    'inline `graph` object. Replaces any existing graph for the plan.',
  inputSchema: {
    plan_id: z.number().int(),
    path: z.string().optional().describe('path to a graph.json file'),
    graph: z.any().optional().describe('inline node-link graph object (if no path)'),
  },
}, ({ plan_id, path, graph }) => {
  const g = path ? JSON.parse(readFileSync(path, 'utf8')) : graph;
  if (!g) throw new Error('provide path or graph');
  return store.importGraph(plan_id, g);
});

tool('query_graph', {
  title: 'Query a plan code graph (compact subgraph)',
  description:
    'Keyword-ground the plan\'s code graph: returns the focused subgraph that the terms touch (degree-ranked ' +
    'BFS within a node budget) — the token-saving slice instead of whole files. Deterministic, no LLM.',
  inputSchema: {
    plan_id: z.number().int(),
    terms: z.string().describe('keywords, e.g. "auth flow" or a step title'),
    budget: z.number().int().positive().optional().describe('max nodes in the slice (default 14)'),
  },
}, ({ plan_id, terms, budget }) => store.queryGraph(plan_id, terms, budget ?? 14) ?? { error: 'no graph for this plan' });

tool('ground_step', {
  title: 'Ground a step in the code graph',
  description:
    'Return the code slice relevant to a step (grounds the plan graph on the step\'s title + tools). Use before ' +
    'working a step to pull only the code it touches.',
  inputSchema: { step_id: z.number().int(), budget: z.number().int().positive().optional() },
}, ({ step_id, budget }) => {
  const s = store.getStep(step_id);
  const terms = stepTerms(s);
  return {
    step: { id: s.id, title: s.title },
    subgraph: store.queryGraph(s.plan_id, terms, budget ?? 8),
    markdown: groundSlice(store, s.plan_id, terms, budget ?? 8),
  };
});

tool('graph_stats', {
  title: 'Code graph stats + god-nodes',
  description: 'Node/edge/community counts and the highest-degree concepts (god-nodes) for a plan\'s code graph.',
  inputSchema: { plan_id: z.number().int() },
}, ({ plan_id }) => ({ ...store.graphStats(plan_id), god_nodes: store.godNodes(plan_id, 8) }));

tool('build_graph', {
  title: 'Build a code graph natively from a local repo',
  description:
    'Extract a local Python/JS/TS repo into a code graph WITHOUT graphify (native zero-dep regex extractor: ' +
    'files, classes/functions, imports, inherits, calls) and import it into a plan. Use when you have the source ' +
    'locally and want grounding without running graphify. For richer/multi-language graphs, run graphify and use import_graph.',
  inputSchema: {
    plan_id: z.number().int(),
    path: z.string().describe('local repo or folder path'),
  },
}, ({ plan_id, path }) => store.importGraph(plan_id, extractRepo(path)));

tool('get_lessons', {
  title: 'Cross-plan lessons (relevant past failures)',
  description:
    'Search EVERY non-pass attempt across ALL plans for ones relevant to a step or to free-text terms ' +
    '(IDF-weighted lexical match). Returns "tried X → got Y, don\'t repeat" from anywhere in the ledger. ' +
    'next_step already embeds these for the step it returns; call this directly to check before a fresh approach.',
  inputSchema: {
    step_id: z.number().int().optional().describe('match against this step\'s title + tools'),
    terms: z.string().optional().describe('free-text keywords to match instead/as well'),
    limit: z.number().int().positive().optional(),
    all: z.boolean().optional().describe('search across ALL projects (default: the step\'s/current project only)'),
  },
}, ({ step_id, terms, limit, all }) => store.getLessons({ step_id, terms, limit: limit ?? 5, all }));

// ---- project brain: on-demand info about the project at large --------------

tool('project_brief', {
  title: 'Project brief (whole-project snapshot)',
  description:
    'Compact cross-plan snapshot to orient instantly: every plan with progress, the most recent lessons ' +
    '(failures to avoid), and which plans have code graphs. Pull this at the start of a session to know the ' +
    'state of the project at large without reading anything.',
  inputSchema: {},
}, () => store.projectBrief());

tool('recall', {
  title: 'Ask the project (cross-plan search)',
  description:
    'One lexical query across ALL plans, steps, and the failure log — returns the most relevant slice, ranked ' +
    '(plans, steps, and past attempts/lessons). Use to answer "what do we know / have we tried / where is X" ' +
    'about the project at large, on demand, without loading everything.',
  inputSchema: {
    query: z.string().describe('natural keywords, e.g. "token savings orchestrator" or "exe signature"'),
    limit: z.number().int().positive().optional(),
    all: z.boolean().optional().describe('search across ALL projects (default: current project only)'),
  },
}, ({ query, limit, all }) => store.recall(query, limit ?? 8, all));

// ---- findings: the brain's write-back channel (plan #134) -----------------

const FINDING_ITEM = z.object({
  claim: z.string().describe('ONE atomic truth, stated so it is still true tomorrow — e.g. "recall() only returns ACTIVE findings". Not a diary of actions.'),
  kind: z.enum(['fact', 'decision', 'lesson', 'failure', 'warning']).optional().describe('default fact'),
  subject: z.string().optional().describe('what it is about, as a stable anchor: a path, path#symbol, config key, or topic (e.g. "src/db.mjs#recall", "config.yaml#context"). Dedup and correction are scoped by subject — always set it.'),
  slot: z.string().optional().describe('for a single-valued aspect of the subject (a setting, a version, a default): a newer finding with the same subject+slot SUPERSEDES the old one'),
  evidence: z.union([z.string(), z.array(z.string())]).optional().describe('where it was verified: file:line, command, test name, URL'),
  supersedes: z.number().int().optional().describe('id of an existing finding this one corrects'),
  depends_on: z.array(z.number().int()).optional().describe('ids of findings this one was BUILT ON (e.g. from your brief). If any of them later changes, this one is re-opened for re-evaluation.'),
  files: z.array(z.string()).optional().describe('source files this truth rests on (relative to root). Paths in subject/evidence are linked automatically; if a linked file changes, the finding turns suspect.'),
  impact: z.enum(['normal', 'high']).optional().describe('high = changes what everything about this subject means (e.g. "the princess is a frog"): every finding on or naming the subject is re-opened for re-evaluation. Use rarely.'),
});

tool('absorb_findings', {
  title: 'Absorb findings into the brain (dedup, no model calls)',
  description:
    'Write back what you LEARNED — durable, evidenced, subject-anchored truths — so later work is briefed with it. ' +
    'Each item is deduplicated against what the project already knows: identical or paraphrased claims merge ' +
    '(evidence added, seen_count bumped); similar claims with different numbers or opposite polarity are kept as a ' +
    'CONFLICT for review, never silently merged; a same subject+slot value supersedes the old one. Nothing is deleted. ' +
    'Per-item outcome: created | duplicate | near_duplicate | superseded | conflict | confirmed | rejected. Use dry_run to preview. ' +
    'Truth maintenance: when a finding is superseded or retracted, the findings built on it (depends_on) turn SUSPECT and are ' +
    'listed in "suspected"; re-reporting a suspect finding verbatim confirms it.',
  inputSchema: {
    findings: z.array(FINDING_ITEM).max(200),
    plan_id: z.number().int().optional().describe('provenance + project scope (default: current project)'),
    step_id: z.number().int().optional().describe('provenance; implies its plan and project'),
    source: z.string().max(120).optional().describe('who learned it, e.g. "runner:implementer" or "chat"'),
    dry_run: z.boolean().optional().describe('report outcomes without writing'),
    root: z.string().optional().describe('absolute project directory that relative file paths resolve against (enables file staleness checks); defaults to the project root set with set_project_root'),
    briefed: z.array(z.number().int()).optional().describe('ids of findings you were shown before doing the work; related ones are linked as dependencies'),
  },
}, ({ findings, ...opts }) => store.absorbFindings(findings, opts));

tool('query_findings', {
  title: 'Query findings',
  description:
    'Browse or search the brain\'s findings. `subject` is a prefix ("src/db.mjs" also matches "src/db.mjs#recall"); ' +
    '`query` ranks lexically. Default shows ACTIVE findings in the current project; "live" adds SUSPECT ones (something ' +
    'they were built on changed — verify before relying); "any" includes the superseded and retracted history. ' +
    'Findings with a non-empty conflicts_with disagree with another finding.',
  inputSchema: {
    subject: z.string().optional(),
    kind: z.enum(['fact', 'decision', 'lesson', 'failure', 'warning']).optional(),
    status: z.enum(['active', 'suspect', 'live', 'superseded', 'retracted', 'any']).optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    plan_id: z.number().int().optional().describe('scope to this plan\'s project'),
    all: z.boolean().optional().describe('search across ALL projects'),
  },
}, (args) => store.queryFindings(args));

tool('retract_finding', {
  title: 'Retract a finding',
  description: 'Mark a finding as wrong (it stays in history with your reason, and stops being recalled). ' +
    'To REPLACE a finding with a corrected one, absorb the new one with `supersedes` instead.',
  inputSchema: {
    finding_id: z.number().int(),
    reason: z.string().describe('why it is wrong — required'),
  },
}, ({ finding_id, reason }) => store.retractFinding(finding_id, reason));

tool('set_project_root', {
  title: 'Set where a project\'s source lives',
  description: 'Record the absolute directory of a project\'s source tree. Findings absorbed without an explicit root ' +
    'then link to the files in their subject/evidence automatically, so the brain notices when that code changes ' +
    '(check_stale) and next_step briefs them as SUSPECT until re-checked. Pass an empty root to clear it.',
  inputSchema: {
    project_id: z.number().int().optional().describe('default: the current project'),
    root: z.string().describe('absolute path, e.g. C:/Users/me/Documents/MyGame'),
  },
}, ({ project_id, root }) => store.setProjectRoot(project_id ?? store.currentProjectId(), root));

tool('check_stale', {
  title: 'Check findings against their source files',
  description: 'Re-hash every source file an active finding was built on. Findings whose file changed or vanished turn SUSPECT ' +
    '(re-evaluate them with suspect_findings + resolve_finding). Deterministic, no model calls. Run before briefing from the brain.',
  inputSchema: {
    project_id: z.number().int().optional(),
    all: z.boolean().optional().describe('check every project'),
  },
}, (args) => store.checkStale(args));

tool('suspect_findings', {
  title: 'List findings that need re-evaluation',
  description: 'The re-evaluation queue: SUSPECT findings with WHY (the changed file, or the finding that was revised/retracted/' +
    'added with high impact — with its current value). Check each against the source, then call resolve_finding.',
  inputSchema: {
    limit: z.number().int().positive().max(200).optional(),
    plan_id: z.number().int().optional(),
    all: z.boolean().optional(),
  },
}, (args) => store.suspectQueue(args));

tool('resolve_finding', {
  title: 'Resolve (re-evaluate or edit) a finding',
  description: 'Settle a finding after checking it: "confirmed" (still true → active, re-anchored to current files), "revised" ' +
    '(replace with `claim`; history kept), "retracted" (no longer true), "unsure" (stays suspect, reason logged). ' +
    'Revising or retracting re-opens the findings built on it (returned as "suspected") — re-evaluate those next. ' +
    'Also the way to EDIT a live finding: verdict "revised" with the new claim.',
  inputSchema: {
    finding_id: z.number().int(),
    verdict: z.enum(['confirmed', 'revised', 'retracted', 'unsure']),
    claim: z.string().optional().describe('the corrected claim (required for revised)'),
    reason: z.string().optional().describe('what you checked / why'),
    evidence: z.array(z.string()).optional(),
    source: z.string().max(120).optional(),
  },
}, ({ finding_id, ...opts }) => store.resolveFinding(finding_id, opts));
tool('planner_start', {
  title: 'Planning preflight: discover relevant prior plans',
  description:
    'Run BEFORE decomposing a new goal into steps. Extracts (or accepts) a bounded keyword set and runs ONE ' +
    'cross-project keyword search over plan SURFACE metadata (title + keywords + summary — never step bodies). ' +
    'Returns ranked matches split into `completed` (status done — usable as finished evidence) and ' +
    '`related_active` (still in flight — NOT completed evidence), each with plan id/title/project/keywords/status/' +
    'updated_at and only short relevant carry-forward/lesson snippets. Pass draft_plan_id to durably record which ' +
    'prior plans informed the draft (surfaced later by open_plan as consulted_plans).',
  inputSchema: {
    goal: z.string().optional().describe('the new goal text; keywords are extracted from it when `keywords` is omitted'),
    keywords: z.array(z.string()).optional().describe('explicit bounded keyword set (overrides extraction)'),
    limit: z.number().int().positive().optional().describe('max matches per bucket (default 5)'),
    max_keywords: z.number().int().min(1).max(8).optional().describe('cap on the keyword set size (max 8; default 8)'),
    draft_plan_id: z.number().int().optional().describe('if set, record the discovered matches as provenance on this draft'),
  },
}, ({ goal, keywords, limit, max_keywords, draft_plan_id }) =>
  store.plannerStart({ goal, keywords, limit, max_keywords, draft_plan_id }));

tool('record_plan_consultation', {
  title: 'Record prior plans a draft consulted',
  description:
    'Durably attach prior-plan provenance to a (usually draft) plan: which already-existing plans informed it, the ' +
    'status each had when consulted (frozen), and the keywords that surfaced them. Deduped per (draft, prior) pair. ' +
    'Surfaced by open_plan as `consulted_plans`. planner_start(draft_plan_id) calls this for you.',
  inputSchema: {
    plan_id: z.number().int().describe('the draft plan that consulted prior work'),
    consulted_plan_ids: z.array(z.number().int()).describe('prior plan ids that informed the draft'),
    keywords: z.array(z.string()).optional().describe('the keyword set used during discovery'),
    goal: z.string().optional().describe('the goal text (stored as the consultation note when note is omitted)'),
    note: z.string().optional(),
  },
}, ({ plan_id, ...rest }) => store.recordPlanConsultation(plan_id, rest));

// ---- templates (reusable plan skeletons) -----------------------------------

tool('list_templates', {
  title: 'List plan templates',
  description: 'List reusable plan skeletons (name, description, step count). Use instantiate_template to clone one onto a plan.',
  inputSchema: {},
}, () => store.listTemplates());

tool('get_template', {
  title: 'Get a template with its steps',
  description: 'Return a template by id or name, including its ordered step skeletons.',
  inputSchema: { template: z.string().describe('template id or name') },
}, ({ template }) => store.getTemplate(template));

tool('create_template', {
  title: 'Create a plan template',
  description: 'Define a reusable plan skeleton with ordered step skeletons (each title/context/tools/acceptance_criteria).',
  inputSchema: {
    name: z.string(),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    steps: z.array(z.object({
      title: z.string(),
      context: z.string().optional(),
      tools: z.array(z.string()).optional(),
      role: z.string().optional().describe('subagent role that executes this step when instantiated'),
      acceptance_criteria: z.string().optional(),
      idx: z.number().int().optional().describe('1-based position; defaults to array order'),
    })).optional(),
  },
}, (args) => store.createTemplate(args));

tool('instantiate_template', {
  title: 'Instantiate a template into a plan',
  description: 'Clone a template\'s steps (in order) onto an existing plan. Returns the updated plan.',
  inputSchema: { template: z.string().describe('template id or name'), plan_id: z.number().int() },
}, ({ template, plan_id }) => store.instantiateTemplate(template, plan_id));

tool('save_as_template', {
  title: 'Save a plan as a template',
  description: 'Capture a plan\'s current steps as a new reusable template.',
  inputSchema: { plan_id: z.number().int(), name: z.string(), description: z.string().optional() },
}, ({ plan_id, name, description }) => store.saveAsTemplate(plan_id, name, description));

tool('delete_template', {
  title: 'Delete a template',
  description: 'Remove a template (by id or name).',
  inputSchema: { template: z.string() },
}, ({ template }) => store.deleteTemplate(template));

// ---- file references (cited, read on demand) -------------------------------

tool('add_file_ref', {
  title: 'Cite a file on a step/plan',
  description:
    'Attach a file reference to a step (preferred) or plan. It is SURFACED but NOT read — every session sees the ' +
    'file exists (path + role + note) and calls read_file_ref to load it ONLY when the current step needs it. ' +
    'role: primary (the file being worked) | dependency | related | reference.',
  inputSchema: {
    step_id: z.number().int().optional().describe('attach to this step (preferred)'),
    plan_id: z.number().int().optional().describe('or plan-level, if no step'),
    path: z.string().describe('file path (absolute recommended)'),
    role: z.enum(['primary', 'dependency', 'related', 'reference']).optional(),
    note: z.string().optional().describe('why it matters / what it is'),
  },
}, (a) => store.addFileRef(a));

tool('read_file_ref', {
  title: 'Expand a cited file (read its content on demand)',
  description:
    'Read one cited file\'s content — the ONLY call that loads bytes. Use when you decide the current step needs ' +
    'that file. Returns content (capped ~60k chars); for the full file read it directly.',
  inputSchema: { file_ref_id: z.number().int() },
}, ({ file_ref_id }) => store.readFileRef(file_ref_id));

tool('remove_file_ref', {
  title: 'Remove a cited file',
  description: 'Delete a file citation.',
  inputSchema: { file_ref_id: z.number().int() },
}, ({ file_ref_id }) => store.removeFileRef(file_ref_id));

tool('suggest_file_refs', {
  title: 'Suggest dependencies/related files from the code graph',
  description:
    'Given a file path, propose its dependencies (files it imports → role dependency) and dependents (files that ' +
    'import it → role related) from the plan\'s code graph, as ready-to-cite file refs. With apply+step_id it cites ' +
    'them on the step; otherwise it just returns proposals. Needs a code graph (build_graph / import_graph) first.',
  inputSchema: {
    path: z.string().describe('the file to find neighbors for (e.g. the primary you\'re editing)'),
    plan_id: z.number().int().optional(),
    step_id: z.number().int().optional().describe('resolves the plan; with apply, cites onto this step'),
    apply: z.boolean().optional().describe('add the suggestions as file refs on step_id'),
  },
}, ({ path, plan_id, step_id, apply }) => {
  let pid = plan_id;
  if (pid == null && step_id != null) pid = store.getStep(step_id).plan_id;
  if (pid == null) throw new Error('provide plan_id or step_id');
  const res = store.suggestFileRefs(pid, path);
  if (apply && step_id && res.suggestions.length) {
    res.added = res.suggestions.map((s) => store.addFileRef({ step_id, path: s.path, role: s.role, note: s.reason })).length;
  }
  return res;
});

// ---- status ---------------------------------------------------------------

tool('set_plan_status', {
  title: 'Set plan status',
  description: 'draft | active | done | abandoned | blocked (blocked = every remaining step waits on the user; ' +
    'skipped by autonomous runs). `done` is now GATED: rejected while any step is active, any execution lease is ' +
    'open, any activity run is non-terminal, or any closed step lacks a verification disposition. Pass ' +
    'force:true with reason to record an audited forced closure (completion_lock).',
  inputSchema: {
    plan_id: z.number().int(),
    status: z.enum(['draft', 'active', 'done', 'abandoned', 'blocked']),
    force: z.boolean().optional().describe('bypass the done-gate; requires reason'),
    reason: z.string().optional().describe('required when force:true — recorded as plans.completion_lock audit trail'),
  },
}, ({ plan_id, status, force, reason }) => {
  const plan = store.setPlanStatus(plan_id, status, { force: !!force, reason: reason ?? '' });
  if (status === 'done' || status === 'blocked') return {
    ...plan,
    directive:
      `Plan #${plan_id} marked ${status}. Call next_plan() and continue with the plan it returns — do not stop ` +
      'unless it reports nothing workable or the user scoped this run.',
  };
  return plan;
});

tool('set_step_status', {
  title: 'Set step status',
  description: 'pending | in_progress | done | failed | blocked | skipped. (record_attempt sets done/failed for you.)',
  inputSchema: {
    step_id: z.number().int(),
    status: z.enum(['pending', 'in_progress', 'done', 'failed', 'blocked', 'skipped']),
  },
}, ({ step_id, status }) => {
  const step = store.setStepStatus(step_id, status);
  if (status === 'blocked') return {
    ...slimStep(step),
    directive:
      `Blocked recorded. write_carry_forward the unblock note if you haven't, then call next_step(${step.plan_id}) ` +
      '— blocked steps are skipped — and continue with the next workable step or plan. Do not stop here.',
  };
  return slimStep(step);
});

// ---- RAG sidecar tools (§5) -----------------------------------------------

registerRagTools(server, ragStore);

// ---- boot -----------------------------------------------------------------

// Boot a bounded reaper so any lease left orphaned by a caller that
// crashed mid-tool (agent exited before close_execution_lease) closes as
// `cancelled` within one interval — this is how MCP callers get the same
// stale-recovery contract the board already runs.
const reapInterval = Math.max(5_000, Number(process.env.PLAN_LEDGER_REAP_INTERVAL_MS) || 60_000);
const reapStale = Math.max(5_000, Number(process.env.PLAN_LEDGER_REAP_STALE_MS) || 120_000);
const reaper = reapLoop(store, {
  interval_ms: reapInterval,
  stale_after_ms: reapStale,
  logger: (msg) => console.error(`[plan-ledger] ${msg}`),
});
process.on('SIGINT', () => { reaper.stop(); try { store.close(); } catch {} process.exit(0); });
process.on('exit', () => { reaper.stop(); try { store.close(); } catch {} });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[plan-ledger] up — db: ${dbPath} — reap every ${reaper.interval_ms}ms (stale=${reaper.stale_after_ms}ms)`);
