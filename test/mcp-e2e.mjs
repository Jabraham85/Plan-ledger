// mcp-e2e.mjs — boots the real server over stdio and drives it as an MCP client.
// Uses a temp DB so it doesn't touch real data. Run: node test/mcp-e2e.mjs
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { rmSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(tmpdir(), `plan-ledger-e2e-${process.pid}.db`);
// The server's RAG sidecar must never open a real data/rag.db — pin it to a temp file.
const ragDbPath = join(tmpdir(), `plan-ledger-e2e-rag-${process.pid}.db`);
// Role-map fixture (PLAN_LEDGER_ROLES) so the server never reads the user's real
// ~/.claude/plan-roles.json: implementer remapped to a built-in, off-role disabled.
const rolesPath = join(tmpdir(), `plan-ledger-e2e-roles-${process.pid}.json`);
writeFileSync(rolesPath, JSON.stringify({ roles: { implementer: { agent: 'general-purpose' }, 'off-role': false } }));
const parse = (r) => JSON.parse(r.content[0].text);
// Every probe both logs AND asserts — a false condition must exit non-zero.
const check = (label, cond) => { console.log(`${label}:`, cond); assert.ok(cond, label); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(__dirname, '..', 'src', 'server.mjs')],
  env: { ...process.env, PLAN_LEDGER_DB: dbPath, PLAN_LEDGER_ROLES: rolesPath, PLAN_LEDGER_RAG_DB: ragDbPath },
});
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools;
console.log(`tools exposed: ${tools.length} -> ${tools.map((t) => t.name).join(', ')}`);
check('tool count matches the registered surface', tools.length === 49);
check('retired tools are gone (set_ref_enabled, list_file_refs)',
  !tools.some((t) => t.name === 'set_ref_enabled' || t.name === 'list_file_refs'));
// RAG sidecar surface (§5): all six tools registered on the same server.
const ragTools = ['rag_ingest', 'rag_status', 'rag_query', 'rag_expand', 'rag_cite', 'rag_forget'];
check('all six rag_* tools exposed', ragTools.every((n) => tools.some((t) => t.name === n)));

const plan = parse(await client.callTool({ name: 'create_plan', arguments: { title: 'E2E plan', keywords: ['e2e'] } }));
console.log('created plan', plan.id);
const step = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: plan.id, title: 'do a thing', context: 'ctx' } }));
const next = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('next_step id matches added step', next.id === step.id);
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
const spd = parse(await client.callTool({ name: 'set_plan_status', arguments: { plan_id: plan.id, status: 'done' } }));
check('set_plan_status(done) directs to next_plan', /next_plan\(\)/.test(spd.directive));
await client.callTool({ name: 'set_plan_status', arguments: { plan_id: plan.id, status: 'active' } }); // restore for the probes below
await client.callTool({ name: 'set_step_status', arguments: { step_id: step2.id, status: 'skipped' } }); // park the probe step

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

// role charter check: unknown role is ACCEPTED but warned about, known role is silent
const bogus = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: plan.id, title: 'bogus-role step', role: 'no-such-role-xyz' } }));
check('unknown role accepted with role_warning', typeof bogus.role_warning === 'string' && /no charter file/.test(bogus.role_warning));
const known = parse(await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'implementer' } }));
check('known role carries no role_warning', known.role_warning === undefined);
const bogusFull = parse(await client.callTool({ name: 'get_step', arguments: { step_id: bogus.id } }));
check('role persisted despite slim ack', bogusFull.role === 'implementer');

// role map → next_step directive: the fixture remaps implementer to a built-in agent
const defaultCharter = (role) => join(homedir(), '.claude', 'agents', `${role}.md`);
const remapped = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('directive names the RESOLVED agent for a remapped role',
  remapped.id === bogus.id && remapped.directive.includes('subagent_type "general-purpose"'));
check('remapped directive opens the brief with the role\'s charter',
  remapped.directive.includes(`read + adopt the "implementer" charter at ${defaultCharter('implementer')}`));
// a role NOT in the map resolves through the default chain — today's semantics, absolute charter path
await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'debugger' } });
const unmapped = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('unmapped roster role dispatches as itself with its default charter',
  unmapped.directive.includes('subagent_type "debugger"') && unmapped.directive.includes(defaultCharter('debugger')));
// a disabled role degrades to the orchestrator-decides branch
await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'off-role' } });
const disabled = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
check('disabled role → orchestrator-decides directive',
  /disabled in the role map/.test(disabled.directive) && !/DISPATCH/.test(disabled.directive));
await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'implementer' } }); // restore for probes below

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
const readyBefore = parse(await client.callTool({ name: 'ready_steps', arguments: { plan_id: rp.id } }));
console.log('ready_steps before dep done:', readyBefore.steps.map((s) => s.id));
check('ready_steps excludes step3 while its dep is unmet', !readyBefore.steps.some((s) => s.id === rs3.id));
check('ready_steps includes independent steps 1 and 2', readyBefore.steps.some((s) => s.id === rs1.id) && readyBefore.steps.some((s) => s.id === rs2.id));
check('ready_steps directive tells the caller to dispatch concurrently', /CONCURRENTLY/.test(readyBefore.directive));
await client.callTool({ name: 'record_attempt', arguments: { step_id: rs2.id, what_tried: 'finished two', verdict: 'pass' } });
const readyAfter = parse(await client.callTool({ name: 'ready_steps', arguments: { plan_id: rp.id } }));
console.log('ready_steps after dep done:', readyAfter.steps.map((s) => s.id));
check('ready_steps includes step3 once its dep is done', readyAfter.steps.some((s) => s.id === rs3.id));
const nextPick = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: rp.id } }));
check('next_step and ready_steps agree on what is workable', readyAfter.steps.some((s) => s.id === nextPick.id));

// layman box over MCP: both channels
const lstepE = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: rp.id, title: 'layman e2e step' } }));
const setRes = parse(await client.callTool({ name: 'set_layman', arguments: { step_id: lstepE.id, text: 'Plain English: wired the thing up.' } }));
check('set_layman ack is slim', setRes.context === undefined && setRes.id === lstepE.id);
const afterSet = parse(await client.callTool({ name: 'get_step', arguments: { step_id: lstepE.id } }));
check('set_layman round-trips over MCP', afterSet.layman === 'Plain English: wired the thing up.');
await client.callTool({ name: 'record_attempt', arguments: { step_id: lstepE.id, what_tried: 'did the work', verdict: 'pass', layman: 'Made the button work when clicked.' } });
const afterAttemptLayman = parse(await client.callTool({ name: 'get_step', arguments: { step_id: lstepE.id } }));
check('record_attempt(layman=...) round-trips over MCP', afterAttemptLayman.layman === 'Made the button work when clicked.');

await client.close();
rmSync(rolesPath, { force: true });
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });
rmSync(ragDbPath, { force: true });
rmSync(ragDbPath + '-wal', { force: true });
rmSync(ragDbPath + '-shm', { force: true });
console.log('\nMCP e2e OK');
