// mcp-e2e.mjs — boots the real server over stdio and drives it as an MCP client.
// Uses a temp DB so it doesn't touch real data. Run: node test/mcp-e2e.mjs
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(tmpdir(), `plan-ledger-e2e-${process.pid}.db`);
// The server's RAG sidecar must never open a real data/rag.db — pin it to a temp file.
const ragDbPath = join(tmpdir(), `plan-ledger-e2e-rag-${process.pid}.db`);
// Role-map fixture (PLAN_LEDGER_ROLES) so the server never reads the user's real
// ~/.claude/plan-roles.json: implementer remapped to a built-in, off-role disabled.
const rolesPath = join(tmpdir(), `plan-ledger-e2e-roles-${process.pid}.json`);
writeFileSync(rolesPath, JSON.stringify({ roles: { implementer: { agent: 'general-purpose' }, 'off-role': false } }));
// Fake HOME so ~/.claude/agents/<role>.md charter probes resolve deterministically —
// the machine running this test need not have any Claude Code charters installed.
const fakeHome = join(tmpdir(), `plan-ledger-e2e-home-${process.pid}`);
mkdirSync(join(fakeHome, '.claude', 'agents'), { recursive: true });
for (const role of ['implementer', 'debugger']) {
  writeFileSync(join(fakeHome, '.claude', 'agents', `${role}.md`), `# ${role} charter (fixture)`);
}
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const { homedir } = await import('node:os');
const parse = (r) => JSON.parse(r.content[0].text);
// Every probe both logs AND asserts — a false condition must exit non-zero.
const check = (label, cond) => { console.log(`${label}:`, cond); assert.ok(cond, label); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(__dirname, '..', 'src', 'server.mjs')],
  env: { ...process.env, PLAN_LEDGER_DB: dbPath, PLAN_LEDGER_ROLES: rolesPath, PLAN_LEDGER_RAG_DB: ragDbPath,
    HOME: fakeHome, USERPROFILE: fakeHome },
});
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools;
console.log(`tools exposed: ${tools.length} -> ${tools.map((t) => t.name).join(', ')}`);
check('tool surface includes the expected minimum set', tools.length >= 54);
check('activity tools are exposed', ['start_activity', 'heartbeat_activity', 'append_activity_event', 'list_current_activity', 'list_recent_activity']
  .every((n) => tools.some((t) => t.name === n)));
check('reconciliation read-only diagnostic tool is exposed',
  tools.some((t) => t.name === 'assess_plan_reconciliation'));
check('retired tools are gone (set_ref_enabled, list_file_refs)',
  !tools.some((t) => t.name === 'set_ref_enabled' || t.name === 'list_file_refs'));
check('new update_plan tool is exposed', tools.some((t) => t.name === 'update_plan'));
// RAG sidecar surface (§5): all six tools registered on the same server.
const ragTools = ['rag_ingest', 'rag_status', 'rag_query', 'rag_expand', 'rag_cite', 'rag_forget'];
check('all six rag_* tools exposed', ragTools.every((n) => tools.some((t) => t.name === n)));

const plan = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'E2E plan', keywords: ['e2e'] } }));
console.log('created plan', plan.id);
const priorDone = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'Diagon audit done', keywords: ['diagon', 'audit', 'handoff'] } }));
const priorActive = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'Diagon architect active', keywords: ['diagon', 'architect', 'stalled'] } }));
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: priorDone.id, status: 'done' } });
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: priorActive.id, status: 'active' } });
const priorDoneStep = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: priorDone.id, title: 'audit lesson', carry_forward: 'carry forward stalled architect handoff' } }));
await client.callTool({ name: 'record_attempt', arguments: {
  step_id: priorDoneStep.id,
  what_tried: 'audited reassignment for stalled architect',
  result: 'captured reusable lesson',
  verdict: 'fail',
} });
const preflight = parse(await client.callTool({ name: 'planner_start', arguments: {
  goal: 'audited reassignment from stalled architect',
  keywords: ['Diagon', 'Audit', 'reassignment', 'stalled', 'architect', 'handoff', 'provenance', 'board', 'overflow'],
  max_keywords: 8,
  limit: 3,
  draft_plan_id: plan.id,
} }));
check('planner_start returns bounded normalized keyword set', preflight.keywords.length <= 8
  && preflight.keywords.every((k) => k === k.toLowerCase()));
check('planner_start separates completed and active related matches',
  preflight.completed.some((m) => m.plan_id === priorDone.id)
    && preflight.related_active.some((m) => m.plan_id === priorActive.id));
const updPlan = parse(await client.callTool({ name: 'update_plan', arguments: {
  plan_id: plan.id,
  summary: 'E2E plan refreshed with consulted provenance',
  consulted_plan_ids: [priorDone.id],
  consulted_keywords: ['diagon', 'audit'],
} }));
check('update_plan records consulted prior plans', updPlan.consulted_plans.some((c) => c.consulted_plan_id === priorDone.id));
const step = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: plan.id, title: 'do a thing', context: 'ctx' } }));
const draftNext = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id, claim: true } }));
check('draft approval gate: next_step does not claim or execute', draftNext.awaiting_approval === true
  && draftNext.plan.status === 'draft' && /explicit approval/i.test(draftNext.directive));
const draftReady = parse(await client.callTool({ name: 'ready_steps', arguments: { plan_id: plan.id, claim: true } }));
check('draft approval gate: ready_steps returns an empty frontier', draftReady.awaiting_approval === true
  && draftReady.steps.length === 0);
const draftProjectNext = parse(await client.callTool({ name: 'next_plan', arguments: {} }));
check('draft approval gate: next_plan presents instead of executing', draftProjectNext.awaiting_approval === true
  && /wait for explicit user approval/i.test(draftProjectNext.directive));
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: plan.id, status: 'active' } });
const next = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('next_step id matches added step', next.id === step.id);
const startAct = parse(await client.callTool({ name: 'start_activity', arguments: {
  plan_id: plan.id,
  step_id: step.id,
  run_id: 'mcp-run-1',
  session_ref: 'mcp-session-1',
  role: 'implementer',
  phase: 'dispatch',
  action_summary: 'MCP activity start',
} }));
check('start_activity persists keyed activity run', startAct.run_id === 'mcp-run-1' && startAct.session_ref === 'mcp-session-1');
const hbAct = parse(await client.callTool({ name: 'heartbeat_activity', arguments: {
  plan_id: plan.id,
  step_id: step.id,
  run_id: 'mcp-run-1',
  session_ref: 'mcp-session-1',
  status: 'in_progress',
  phase: 'execute',
  progress_completed: 1,
  progress_total: 2,
} }));
check('heartbeat_activity upserts progress', hbAct.progress_completed === 1 && hbAct.phase === 'execute');
const evAct = parse(await client.callTool({ name: 'append_activity_event', arguments: {
  plan_id: plan.id,
  step_id: step.id,
  run_id: 'mcp-run-1',
  session_ref: 'mcp-session-1',
  event_type: 'terminal',
  summary: 'safe terminal event',
  command_summary: 'safe command',
} }));
check('append_activity_event appends terminal event', Number.isInteger(evAct.event_id) && evAct.event_type === 'terminal');
const currentAct = parse(await client.callTool({ name: 'list_current_activity', arguments: { plan_id: plan.id, step_id: step.id, include_events: true } }));
check('list_current_activity returns the active run with events', currentAct.length === 1 && currentAct[0].events.some((e) => e.event_type === 'terminal'));
const recentAct = parse(await client.callTool({ name: 'list_recent_activity', arguments: { plan_id: plan.id, limit: 5 } }));
check('list_recent_activity returns activity history', recentAct.some((r) => r.run_id === 'mcp-run-1'));
await client.callTool({ name: 'record_attempt', arguments: { step_id: step.id, what_tried: 'approach A', result: 'boom', verdict: 'fail' } });
const afterFail = parse(await client.callTool({ name: 'get_step', arguments: { step_id: step.id } }));
check('failure logged over MCP', afterFail.attempts.length === 1 && afterFail.status === 'failed');
const passRes = parse(await client.callTool({ name: 'record_attempt', arguments: { step_id: step.id, what_tried: 'approach B', verdict: 'pass' } }));
check('record_attempt carries continuation directive', typeof passRes.directive === 'string' && /plan complete/i.test(passRes.directive));
const done = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('plan complete (next_step {complete})', done.complete === true && /next_plan\(\)/.test(done.directive));

// next_plan: drives the continuous loop; set_plan_status(done|blocked) points at it
const npDone = parse(await client.callTool({ name: 'next_plan', arguments: {} }));
check('next_plan {complete} when nothing workable', npDone.complete === true && typeof npDone.directive === 'string');
const step2 = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: plan.id, title: 'follow-up thing', context: 'ctx2' } }));
const npRes = parse(await client.callTool({ name: 'next_plan', arguments: {} }));
check('next_plan returns the workable plan + directive', npRes.id === plan.id && new RegExp(`next_step\\(${plan.id}\\)`).test(npRes.directive));

// The plan-done gate now requires no active steps + no open leases + no
// non-terminal activity. Prep the probe by (a) terminalizing the earlier
// mcp-run-1 activity, and (b) skipping the follow-up step (park it with an
// explicit `not_applicable` disposition so the gate is satisfied).
const doneBlockedProbe = await client.callTool({ name: 'set_plan_status', arguments: { plan_id: plan.id, status: 'done' } });
check('set_plan_status(done) is refused while activity is non-terminal or steps remain', doneBlockedProbe.isError === true
  && /cannot be marked done/.test(doneBlockedProbe.content[0].text));
await client.callTool({ name: 'heartbeat_activity', arguments: {
  plan_id: plan.id, step_id: step.id, run_id: 'mcp-run-1', session_ref: 'mcp-session-1',
  status: 'completed', outcome: 'success', verification_state: 'passed',
} });
await client.callTool({ name: 'set_step_status', arguments: { step_id: step2.id, status: 'skipped' } });
const spd = parse(await client.callTool({ name: 'set_plan_status', arguments: { plan_id: plan.id, status: 'done' } }));
check('set_plan_status(done) directs to next_plan once invariants are satisfied', /next_plan\(\)/.test(spd.directive));
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: plan.id, status: 'active' } }); // restore for the probes below
const reconcileRead = parse(await client.callTool({ name: 'assess_plan_reconciliation', arguments: { plan_id: plan.id } }));
check('assess_plan_reconciliation returns deterministic summary payload',
  typeof reconcileRead.result_code === 'string' && Array.isArray(reconcileRead.blockers) && typeof reconcileRead.mode === 'string');

// surface index must not leak step bodies
const idx = parse(await client.callTool({ name: 'list_plans', arguments: {} }));
check('surface index clean (no context)', idx[0].context === undefined && idx[0].keywords.includes('e2e'));

// zod hardening: non-positive limits/budgets must be rejected at the schema
const badLimit = await client.callTool({ name: 'recall', arguments: { query: 'anything', limit: 0 } });
check('recall rejects limit 0', badLimit.isError === true);
const badBudget = await client.callTool({ name: 'query_graph', arguments: { plan_id: plan.id, terms: 'x', budget: -3 } });
check('query_graph rejects negative budget', badBudget.isError === true);

// mutation acks are SLIM: id/plan_id/idx/title/status/updated_at (+ directive fields),
// never the full level-2 step — the caller just wrote that payload.
check('add_step ack is slim (no context/attempts echoed)', step.id > 0 && step.plan_id === plan.id && step.title === 'do a thing'
  && step.context === undefined && step.attempts === undefined && step.file_refs === undefined && typeof step.updated_at === 'string');
check('record_attempt ack is slim but keeps plan_progress', passRes.context === undefined && passRes.attempts === undefined && /steps done/.test(passRes.plan_progress));

// role charter check: unknown role is ACCEPTED but warned about, known role is silent.
// The plan was activated above, so `bogus` gets an initial assignment snapshot on add — every
// subsequent role change is a reassignment that requires an audit reason.
const bogus = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: plan.id, title: 'bogus-role step', role: 'no-such-role-xyz' } }));
check('unknown role accepted with role_warning', typeof bogus.role_warning === 'string' && /no charter file/.test(bogus.role_warning));
const known = parse(await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'implementer', reason: 'e2e: promote to implementer' } }));
check('known role carries no role_warning', known.role_warning === undefined);
const bogusFull = parse(await client.callTool({ name: 'get_step', arguments: { step_id: bogus.id } }));
check('role persisted despite slim ack', bogusFull.role === 'implementer');
check('reassignment appended a new step_assignment revision',
  Array.isArray(bogusFull.assignments) && bogusFull.assignments.length === 2
    && bogusFull.assignments[0].role === 'no-such-role-xyz'
    && bogusFull.assignments[1].role === 'implementer'
    && bogusFull.assignments[1].reason === 'e2e: promote to implementer');
// Reassignments without a reason are refused (audited-history contract)
const noReason = await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'debugger' } });
check('update_step refuses a role change without a reason after initial snapshot',
  noReason.isError === true && /reason/i.test(noReason.content[0].text));

// role map → next_step directive: the fixture remaps implementer to a built-in agent
const defaultCharter = (role) => join(homedir(), '.claude', 'agents', `${role}.md`);
const remapped = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('directive names the RESOLVED agent for a remapped role',
  remapped.id === bogus.id && remapped.directive.includes('subagent_type "general-purpose"'));
check('remapped directive opens the brief with the role\'s charter',
  remapped.directive.includes(`read + adopt the "implementer" charter at ${defaultCharter('implementer')}`));
// a role NOT in the map resolves through the default chain — today's semantics, absolute charter path
await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'debugger', reason: 'e2e: swap to debugger' } });
const unmapped = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('unmapped roster role dispatches as itself with its default charter',
  unmapped.directive.includes('subagent_type "debugger"') && unmapped.directive.includes(defaultCharter('debugger')));
// a disabled role degrades to the orchestrator-decides branch
await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'off-role', reason: 'e2e: probe disabled path' } });
const disabled = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('disabled role → orchestrator-decides directive',
  /disabled in the role map/.test(disabled.directive) && !/DISPATCH/.test(disabled.directive));
await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'implementer', reason: 'e2e: restore implementer' } }); // restore for probes below

// templates over MCP: a role'd inline step must survive the zod schema round-trip
await client.callTool({ name: 'create_template', arguments: { name: 'e2e-tpl', steps: [
  { title: 'roled step', context: 'ctx', role: 'implementer', acceptance_criteria: 'done', idx: 1 },
] } });
const tpl = parse(await client.callTool({ name: 'get_template', arguments: { template: 'e2e-tpl' } }));
check('create_template keeps role on inline steps', tpl.steps[0].role === 'implementer' && tpl.steps[0].idx === 1);

// ready_steps: the concurrently-launchable frontier, agreeing with next_step's dependency gate
const rp = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'ready-steps e2e plan', keywords: ['ready'] } }));
const rs1 = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: rp.id, title: 'ready one' } }));
const rs2 = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: rp.id, title: 'ready two' } }));
const rs3 = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: rp.id, title: 'ready three (depends on two)' } }));
await client.callTool({ name: 'link_items', arguments: { from_step_id: rs3.id, to_step_id: rs2.id, relation: 'builds_on' } });
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: rp.id, status: 'active' } });
const readyBefore = parse(await client.callTool({ name: 'ready_steps', arguments: { plan_id: rp.id } }));
console.log('ready_steps before dep done:', readyBefore.steps.map((s) => s.id));
check('ready_steps excludes step3 while its dep is unmet', !readyBefore.steps.some((s) => s.id === rs3.id));
check('ready_steps includes independent steps 1 and 2', readyBefore.steps.some((s) => s.id === rs1.id) && readyBefore.steps.some((s) => s.id === rs2.id));
check('ready_steps directive tells the caller to filter slots before claiming',
  /worker-slot and path-conflict limits/i.test(readyBefore.directive));
await client.callTool({ name: 'record_attempt', arguments: { step_id: rs2.id, what_tried: 'finished two', verdict: 'pass' } });
const readyAfter = parse(await client.callTool({ name: 'ready_steps', arguments: { plan_id: rp.id } }));
console.log('ready_steps after dep done:', readyAfter.steps.map((s) => s.id));
check('ready_steps includes step3 once its dep is done', readyAfter.steps.some((s) => s.id === rs3.id));
const nextPick = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: rp.id } }));
check('next_step and ready_steps agree on what is workable', readyAfter.steps.some((s) => s.id === nextPick.id));
await client.callTool({ name: 'record_attempt', arguments: { step_id: rs1.id, what_tried: 'first try failed', verdict: 'fail' } });
const retryReady = parse(await client.callTool({ name: 'ready_steps', arguments: { plan_id: rp.id } }));
check('ready_steps includes failed retryable steps just like next_step',
  retryReady.steps.some((s) => s.id === rs1.id && s.status === 'failed'));

// ready_steps claim mode: claim only available slots, then let another refill
// claim receive the remaining step without duplicating the first claim.
const rcp = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'claimed-frontier e2e' } }));
await client.callTool({ name: 'add_step', arguments: { plan_id: rcp.id, title: 'frontier alpha' } });
await client.callTool({ name: 'add_step', arguments: { plan_id: rcp.id, title: 'frontier beta' } });
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: rcp.id, status: 'active' } });
const claimedReady = parse(await client.callTool({
  name: 'ready_steps', arguments: { plan_id: rcp.id, claim: true, limit: 1, executor: 'cursor-e2e' },
}));
check('ready_steps({claim,limit}) atomically claims only one slot',
  claimedReady.steps.length === 1
    && claimedReady.steps.every((s) => s.status === 'in_progress' && s.claimed && s.claimed_by === 'cursor-e2e')
    && /already atomically claimed/.test(claimedReady.directive));
const refillReady = parse(await client.callTool({
  name: 'ready_steps', arguments: { plan_id: rcp.id, claim: true, limit: 1, executor: 'second-e2e' },
}));
check('ready_steps({claim,limit}) lets the next refill claim the remaining step',
  refillReady.steps.length === 1
    && refillReady.steps[0].id !== claimedReady.steps[0].id
    && refillReady.steps[0].claimed_by === 'second-e2e');
const duplicateReady = parse(await client.callTool({
  name: 'ready_steps', arguments: { plan_id: rcp.id, claim: true, limit: 1, executor: 'third-e2e' },
}));
check('ready_steps({claim,limit}) prevents duplicate parallel dispatch', duplicateReady.steps.length === 0);

// layman box over MCP: both channels
const lstepE = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: rp.id, title: 'layman e2e step' } }));
const setRes = parse(await client.callTool({ name: 'set_layman', arguments: { step_id: lstepE.id, text: 'Plain English: wired the thing up.' } }));
check('set_layman ack is slim', setRes.context === undefined && setRes.id === lstepE.id);
const afterSet = parse(await client.callTool({ name: 'get_step', arguments: { step_id: lstepE.id } }));
check('set_layman round-trips over MCP', afterSet.layman === 'Plain English: wired the thing up.');
await client.callTool({ name: 'record_attempt', arguments: { step_id: lstepE.id, what_tried: 'did the work', verdict: 'pass', layman: 'Made the button work when clicked.' } });
const afterAttemptLayman = parse(await client.callTool({ name: 'get_step', arguments: { step_id: lstepE.id } }));
check('record_attempt(layman=...) round-trips over MCP', afterAttemptLayman.layman === 'Made the button work when clicked.');

// notes thread over MCP
const nstepE = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: rp.id, title: 'notes e2e step' } }));
await client.callTool({ name: 'add_note', arguments: { step_id: nstepE.id, author: 'reviewer', body: 'Please double-check the edge case.' } });
await client.callTool({ name: 'add_note', arguments: { step_id: nstepE.id, author: 'implementer', body: 'Done, covered in the next attempt.' } });
const afterNotes = parse(await client.callTool({ name: 'get_step', arguments: { step_id: nstepE.id } }));
check('add_note appends twice over MCP, in order', afterNotes.notes.length === 2
  && afterNotes.notes[0].body.includes('edge case') && afterNotes.notes[1].body.includes('Done'));

// next_step claim option (§ core repair): atomically claim in one transaction,
// so a second peek in the same tick sees the step as already in_progress and
// hops on. The MCP surface exposes this to autonomous dispatchers (runners,
// parallel Task calls) that share the ledger.
const claimPlan = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'claim-e2e', keywords: ['claim'] } }));
const claimA = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: claimPlan.id, title: 'step alpha', context: 'a' } }));
const claimB = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: claimPlan.id, title: 'step beta', context: 'b' } }));
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: claimPlan.id, status: 'active' } });
const claimed = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: claimPlan.id, claim: true, executor: 'e2e-runner' } }));
check('next_step({claim}) atomically flips the returned step to in_progress',
  claimed.id === claimA.id && claimed.status === 'in_progress' && claimed.claimed === true && claimed.claimed_by === 'e2e-runner'
    && /atomically claimed/.test(claimed.directive));
const nextClaim = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: claimPlan.id, claim: true } }));
check('next_step({claim}) skips a claimed step and hands out the next workable', nextClaim.id === claimB.id);
const activeClaim = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: claimPlan.id, claim: true } }));
check('next_step({claim}) reports active work instead of false completion',
  activeClaim.all_in_progress === true && activeClaim.complete === undefined
    && /NOT complete/.test(activeClaim.directive));

// Transparent execution roster (v5): plan-time snapshot on activation + audited
// reassignment + reasoned redo + actual-execution provenance surfaced on attempts.
const rosterPlan = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'roster e2e', keywords: ['roster'] } }));
const rStep = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: rosterPlan.id, title: 'roster step', context: 'ctx-initial', role: 'implementer' } }));
// draft plan: no snapshot yet — activate to trigger the freeze
const rosterDraft = parse(await client.callTool({ name: 'get_plan_roster', arguments: { plan_id: rosterPlan.id } }));
check('roster: draft plan has no snapshotted assignment yet',
  rosterDraft.snapshotted === false && rosterDraft.steps[0].initial === null && rosterDraft.steps[0].planned === null);
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: rosterPlan.id, status: 'active' } });
const rosterActive = parse(await client.callTool({ name: 'get_plan_roster', arguments: { plan_id: rosterPlan.id } }));
check('roster: activation snapshots the initial assignment',
  rosterActive.snapshotted === true
    && rosterActive.steps[0].initial !== null
    && rosterActive.steps[0].initial.role === 'implementer'
    && rosterActive.steps[0].initial.agent === 'general-purpose'
    && rosterActive.steps[0].initial.resolution_source === 'user');
// assign_step appends an auditable revision — reason is required
const noAssignReason = await client.callTool({ name: 'assign_step', arguments: { step_id: rStep.id, role: 'debugger' } });
check('assign_step refuses without a reason', noAssignReason.isError === true && /reason/i.test(noAssignReason.content[0].text));
await client.callTool({ name: 'assign_step', arguments: { step_id: rStep.id, role: 'debugger', reason: 'e2e: switch specialist', assigned_by: 'e2e' } });
const rosterReassigned = parse(await client.callTool({ name: 'get_plan_roster', arguments: { plan_id: rosterPlan.id } }));
const revs = rosterReassigned.steps[0].assignments;
check('assign_step appends a revision with the reason',
  revs.length === 2 && revs[1].role === 'debugger' && revs[1].reason === 'e2e: switch specialist' && revs[1].assigned_by === 'e2e');
// Drift: editing context after the snapshot flags context_changed
await client.callTool({ name: 'update_step', arguments: { step_id: rStep.id, context: 'ctx-edited-post-snapshot' } });
const rosterDrifted = parse(await client.callTool({ name: 'get_plan_roster', arguments: { plan_id: rosterPlan.id } }));
check('roster: context drift is flagged when the step body diverges from the snapshot',
  rosterDrifted.steps[0].drift.context_changed === true);
// Actual-execution provenance: record_attempt carries the fields through to getStep
await client.callTool({ name: 'record_attempt', arguments: { step_id: rStep.id, what_tried: 'e2e provenance probe', verdict: 'pass',
  agent: 'general-purpose', model: 'claude-sonnet-4-5', model_source: 'runner-cli', session_ref: 'e2e-session-1' } });
const rStepAfter = parse(await client.callTool({ name: 'get_step', arguments: { step_id: rStep.id } }));
const lastAttempt = rStepAfter.attempts.at(-1);
check('record_attempt persists actual agent/model/model_source/session_ref',
  lastAttempt.agent === 'general-purpose' && lastAttempt.model === 'claude-sonnet-4-5'
    && lastAttempt.model_source === 'runner-cli' && lastAttempt.session_ref === 'e2e-session-1');
const rosterActual = parse(await client.callTool({ name: 'get_plan_roster', arguments: { plan_id: rosterPlan.id } }));
check('roster: actual execution provenance is aggregated from the latest attempt',
  rosterActual.steps[0].actual?.model === 'claude-sonnet-4-5' && rosterActual.steps[0].actual?.model_source === 'runner-cli');
// redo_step: back to pending with a note and every attempt / assignment revision preserved
const noRedoReason = await client.callTool({ name: 'redo_step', arguments: { step_id: rStep.id } });
check('redo_step refuses without a reason', noRedoReason.isError === true && /reason/i.test(noRedoReason.content[0].text));
await client.callTool({ name: 'redo_step', arguments: { step_id: rStep.id, reason: 'e2e: redo with different approach', assigned_by: 'reviewer' } });
const rStepRedone = parse(await client.callTool({ name: 'get_step', arguments: { step_id: rStep.id } }));
check('redo_step returns to pending, preserves attempts and assignment history, appends a review note',
  rStepRedone.status === 'pending'
    && rStepRedone.attempts.length >= 1
    && rStepRedone.assignments.length === 2
    && rStepRedone.notes.some((n) => n.body.includes('[redo]') && /different approach/.test(n.body)));

await client.close();
rmSync(rolesPath, { force: true });
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });
rmSync(ragDbPath, { force: true });
rmSync(ragDbPath + '-wal', { force: true });
rmSync(ragDbPath + '-shm', { force: true });
rmSync(fakeHome, { recursive: true, force: true });
console.log('\nMCP e2e OK');
