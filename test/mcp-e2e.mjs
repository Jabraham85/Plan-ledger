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
check('plan complete (next_step {complete})', done.complete === true && typeof done.directive === 'string');

// surface index must not leak step bodies
const idx = parse(await client.callTool({ name: 'list_plans', arguments: {} }));
check('surface index clean (no context)', idx[0].context === undefined && idx[0].keywords.includes('e2e'));

// zod hardening: non-positive limits/budgets must be rejected at the schema
const badLimit = await client.callTool({ name: 'recall', arguments: { query: 'anything', limit: 0 } });
check('recall rejects limit 0', badLimit.isError === true);
const badBudget = await client.callTool({ name: 'query_graph', arguments: { plan_id: plan.id, terms: 'x', budget: -3 } });
check('query_graph rejects negative budget', badBudget.isError === true);

// role charter check: unknown role is ACCEPTED but warned about, known role is silent
const bogus = parse(await client.callTool({ name: 'add_step', arguments: { plan_id: plan.id, title: 'bogus-role step', role: 'no-such-role-xyz' } }));
check('unknown role accepted with role_warning', bogus.role === 'no-such-role-xyz' && typeof bogus.role_warning === 'string' && /no charter file/.test(bogus.role_warning));
const known = parse(await client.callTool({ name: 'update_step', arguments: { step_id: bogus.id, role: 'implementer' } }));
check('known role carries no role_warning', known.role === 'implementer' && known.role_warning === undefined);

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
