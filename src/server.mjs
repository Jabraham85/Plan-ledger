#!/usr/bin/env node
// server.mjs — plan-ledger MCP server (stdio).
//
// External working memory for Claude. Plans are surface-indexed (title +
// keywords) and only opened on demand; each step carries its own context,
// tools, acceptance criteria, carry-forward notes, and a failure log so past
// pitfalls aren't repeated.
//
// DB location: $PLAN_LEDGER_DB, else ./data/plan-ledger.db next to this file.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Store, defaultDbPath } from './db.mjs';
import { resolveRole } from './roles.mjs';
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
    'skipped_blocked_steps with a reason). Three shapes: a step → work it; {all_blocked} → everything left waits ' +
    'on the user or a dependency; {complete} → plan done. After finishing a step (record_attempt) call this to advance.',
  inputSchema: { plan_id: z.number().int() },
}, ({ plan_id }) => {
  const step = store.nextStep(plan_id);
  if (step === null) return {
    complete: true,
    directive:
      `Plan #${plan_id} is complete. set_plan_status(${plan_id}, "done"), then call next_plan() and keep working ` +
      'the plan it returns — do not stop unless nothing is workable or the user scoped this run.',
  };
  if (step.all_blocked) return {
    ...step,
    directive:
      `Every remaining step in plan #${plan_id} waits on the user. set_plan_status(${plan_id}, "blocked"), then ` +
      'call next_plan() and continue with the plan it returns — do not stop here.',
  };
  // Resolve the role through the role map (user-file layers only: an MCP server's
  // cwd is not reliably the working repo, so the directive tells the client that a
  // repo-local .plan-roles.json — which the client CAN see — still overrides).
  const r = resolveRole(step.role, { cwd: null, projectName: store.projectNameForPlan(plan_id) });
  const dispatch = r.mode === 'dispatch'
    ? `DISPATCH to the "${r.agent}" agent (Claude Code: Agent tool subagent_type "${r.agent}"` +
      (r.model ? `, model "${r.model}"` : '') + `; Cursor: invoke the /${r.agent} subagent or Task tool; ` +
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
  return {
    ...step,
    directive:
      `Work this step now: set_step_status(${step.id}, "in_progress"), read attempts + lessons FIRST (never repeat ` +
      `a failed approach), ${dispatch}then record_attempt(${step.id}, ...) noting the role + review rounds. After ` +
      `that, call next_step(${plan_id}) again — do not end your turn while workable steps remain.`,
  };
});

tool('ready_steps', {
  title: 'Get the concurrently-launchable frontier',
  description:
    'Return EVERY pending, non-blocked step in a plan whose builds_on/blocks dependencies are already satisfied ' +
    '(done or skipped) — the full set that could be dispatched RIGHT NOW, not just the lowest-idx one. Uses the ' +
    'same dependency gate as next_step, so the two always agree on what is workable. Steps not listed are either ' +
    'blocked, waiting on a dependency, or already done/in_progress/failed.',
  inputSchema: { plan_id: z.number().int() },
}, ({ plan_id }) => {
  const steps = store.readySteps(plan_id).map((s) => roleWarning(s));
  return {
    steps,
    directive: steps.length
      ? `These ${steps.length} step(s) are independent and ready — dispatch them CONCURRENTLY (one agent per ` +
        'step in a single batch), then review each. Steps not listed wait on a dependency or the user.'
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
    directive: `Work plan #${plan.id} ("${plan.title}") now: call next_step(${plan.id}) and keep going — do not stop.`,
  };
});

// ---- authoring ------------------------------------------------------------

tool('create_plan', {
  title: 'Create a plan',
  description: 'Create a new plan. Keep the summary to a tight "what + why"; put execution detail in steps.',
  inputSchema: {
    title: z.string().describe('short, searchable title'),
    keywords: z.array(z.string()).optional().describe('surface keywords used for matching in list_plans'),
    summary: z.string().optional().describe('one-paragraph what/why, shown when the plan is opened'),
    project_id: z.number().int().optional().describe('owning project (default: current project)'),
  },
}, ({ title, keywords, summary, project_id }) => store.createPlan({ title, keywords, summary, project_id }));

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
  description: 'Edit a step\'s fields (title/context/tools/role/acceptance_criteria/carry_forward/idx). Only pass what changes.',
  inputSchema: {
    step_id: z.number().int(),
    title: z.string().optional(),
    context: z.string().optional(),
    tools: z.array(z.string()).optional(),
    role: z.string().max(64).optional().describe('subagent role that executes this step; empty string clears it'),
    acceptance_criteria: z.string().optional(),
    carry_forward: z.string().optional(),
    idx: z.number().int().optional(),
  },
}, ({ step_id, ...fields }) => slimStep(roleWarning(store.updateStep(step_id, fields))));

// ---- the working loop -----------------------------------------------------

tool('record_attempt', {
  title: 'Record an attempt on a step',
  description:
    'Log what you tried and how it went. verdict=pass marks the step done; fail/partial marks it failed (still ' +
    'retryable) and is preserved in the failure log so the approach is not repeated. ALWAYS record failures.',
  inputSchema: {
    step_id: z.number().int(),
    what_tried: z.string().describe('the approach taken — specific enough that "do not repeat" is actionable'),
    result: z.string().optional().describe('what actually happened (error text, output, observation)'),
    verdict: z.enum(['pass', 'fail', 'partial']).optional().describe('default fail'),
    role: z.string().max(64).optional().describe('subagent role that executed the attempt (e.g. implementer)'),
    review_rounds: z.number().int().min(0).optional().describe('orchestrator send-back rounds before acceptance'),
    executor: z.string().max(64).optional().describe('who drove the attempt (e.g. runner-mcp, runner-inject, orchestrator)'),
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
  description: 'draft | active | done | abandoned | blocked (blocked = every remaining step waits on the user; skipped by autonomous runs).',
  inputSchema: { plan_id: z.number().int(), status: z.enum(['draft', 'active', 'done', 'abandoned', 'blocked']) },
}, ({ plan_id, status }) => {
  const plan = store.setPlanStatus(plan_id, status);
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[plan-ledger] up — db: ${dbPath}`);
