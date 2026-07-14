// mcp-e2e.mjs — boots the real server over stdio and drives it as an MCP client.
// Uses a temp DB so it doesn't touch real data. Run: node test/mcp-e2e.mjs
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(tmpdir(), `plan-ledger-e2e-${process.pid}.db`);
const parse = (r) => JSON.parse(r.content[0].text);
// Every probe both logs AND asserts — a false condition must exit non-zero.
const check = (label, cond) => { console.log(`${label}:`, cond); assert.ok(cond, label); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(__dirname, '..', 'src', 'server.mjs')],
  env: { ...process.env, PLAN_LEDGER_DB: dbPath },
});
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools;
console.log(`tools exposed: ${tools.length} -> ${tools.map((t) => t.name).join(', ')}`);

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

// templates over MCP: a role'd inline step must survive the zod schema round-trip
await client.callTool({ name: 'create_template', arguments: { name: 'e2e-tpl', steps: [
  { title: 'roled step', context: 'ctx', role: 'implementer', acceptance_criteria: 'done', idx: 1 },
] } });
const tpl = parse(await client.callTool({ name: 'get_template', arguments: { template: 'e2e-tpl' } }));
check('create_template keeps role on inline steps', tpl.steps[0].role === 'implementer' && tpl.steps[0].idx === 1);

await client.close();
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });
console.log('\nMCP e2e OK');
