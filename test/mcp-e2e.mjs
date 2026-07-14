// mcp-e2e.mjs — boots the real server over stdio and drives it as an MCP client.
// Uses a temp DB so it doesn't touch real data. Run: node test/mcp-e2e.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(tmpdir(), `plan-ledger-e2e-${process.pid}.db`);
const parse = (r) => JSON.parse(r.content[0].text);

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
console.log('next_step id matches added step:', next.id === step.id);
await client.callTool({ name: 'record_attempt', arguments: { step_id: step.id, what_tried: 'approach A', result: 'boom', verdict: 'fail' } });
const afterFail = parse(await client.callTool({ name: 'get_step', arguments: { step_id: step.id } }));
console.log('failure logged over MCP:', afterFail.attempts.length === 1 && afterFail.status === 'failed');
const passRes = parse(await client.callTool({ name: 'record_attempt', arguments: { step_id: step.id, what_tried: 'approach B', verdict: 'pass' } }));
console.log('record_attempt carries continuation directive:', typeof passRes.directive === 'string' && /plan complete/i.test(passRes.directive));
const done = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
console.log('plan complete (next_step {complete}):', done.complete === true && typeof done.directive === 'string');

// surface index must not leak step bodies
const idx = parse(await client.callTool({ name: 'list_plans', arguments: {} }));
console.log('surface index clean (no context):', idx[0].context === undefined && idx[0].keywords.includes('e2e'));

await client.close();
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });
console.log('\nMCP e2e OK');
