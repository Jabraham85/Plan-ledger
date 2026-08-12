// approval-workflow.mjs — focused MCP regression for draft approval gates.
// Run: node test/approval-workflow.mjs
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const parse = (res) => JSON.parse(res.content[0].text);
const check = (label, cond) => {
  assert.ok(cond, label);
  console.log(`  ok  ${label}`);
};

const dbPath = join(tmpdir(), `plan-ledger-approval-${process.pid}.db`);
const ragDbPath = join(tmpdir(), `plan-ledger-approval-rag-${process.pid}.db`);
const rolesPath = join(tmpdir(), `plan-ledger-approval-roles-${process.pid}.json`);
const fakeHome = join(tmpdir(), `plan-ledger-approval-home-${process.pid}`);

let client = null;
try {
  writeFileSync(rolesPath, JSON.stringify({ roles: { implementer: { agent: 'general-purpose' } } }));
  mkdirSync(join(fakeHome, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(fakeHome, '.claude', 'agents', 'implementer.md'), '# implementer charter (fixture)');
  writeFileSync(join(fakeHome, '.claude', 'agents', 'test-engineer.md'), '# test-engineer charter (fixture)');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(__dirname, '..', 'src', 'server.mjs')],
    env: {
      ...process.env,
      PLAN_LEDGER_DB: dbPath,
      PLAN_LEDGER_ROLES: rolesPath,
      PLAN_LEDGER_RAG_DB: ragDbPath,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });

  client = new Client({ name: 'approval-workflow-e2e', version: '0.0.0' });
  await client.connect(transport);

  const plan = parse(await client.callTool({
    name: 'create_plan',
    arguments: { title: 'Draft approval workflow regression', keywords: ['approval', 'workflow'] },
  }));
  const step1 = parse(await client.callTool({
    name: 'add_step',
    arguments: { plan_id: plan.id, title: 'First gated step', context: 'do first', acceptance_criteria: 'first done' },
  }));
  const step2 = parse(await client.callTool({
    name: 'add_step',
    arguments: { plan_id: plan.id, title: 'Second gated step', context: 'do second', acceptance_criteria: 'second done' },
  }));
  check('created a draft plan with at least two steps', step1.plan_id === plan.id && step2.plan_id === plan.id && step1.id !== step2.id);

  const statusBefore = [
    parse(await client.callTool({ name: 'get_step', arguments: { step_id: step1.id } })).status,
    parse(await client.callTool({ name: 'get_step', arguments: { step_id: step2.id } })).status,
  ];
  check('both step statuses start pending', statusBefore[0] === 'pending' && statusBefore[1] === 'pending');

  const draftNext = parse(await client.callTool({
    name: 'next_step',
    arguments: { plan_id: plan.id, claim: true, executor: 'approval-test' },
  }));
  check('next_step(claim:true) on draft returns awaiting_approval', draftNext.awaiting_approval === true && draftNext.plan.status === 'draft');

  const statusAfterDraftNext = [
    parse(await client.callTool({ name: 'get_step', arguments: { step_id: step1.id } })).status,
    parse(await client.callTool({ name: 'get_step', arguments: { step_id: step2.id } })).status,
  ];
  check('next_step(claim:true) on draft does not change step statuses',
    statusAfterDraftNext[0] === 'pending' && statusAfterDraftNext[1] === 'pending');

  const draftReady = parse(await client.callTool({
    name: 'ready_steps',
    arguments: { plan_id: plan.id, claim: true, executor: 'approval-test' },
  }));
  check('ready_steps(claim:true) on draft returns awaiting_approval', draftReady.awaiting_approval === true);
  check('ready_steps(claim:true) on draft returns an empty frontier', Array.isArray(draftReady.steps) && draftReady.steps.length === 0);

  const draftProjectNext = parse(await client.callTool({ name: 'next_plan', arguments: {} }));
  check('next_plan presents the draft plan rather than directing execution',
    draftProjectNext.id === plan.id
      && draftProjectNext.awaiting_approval === true
      && !/call next_step\(/i.test(draftProjectNext.directive));

  await client.callTool({ name: 'set_plan_status', arguments: { plan_id: plan.id, status: 'active' } });

  const activeStep1 = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
  check('first active next_step returns first step', activeStep1.id === step1.id);
  await client.callTool({
    name: 'record_attempt',
    arguments: { step_id: step1.id, what_tried: 'executed first step', verdict: 'pass', result: 'ok' },
  });

  const activeStep2 = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
  check('second active next_step returns second step', activeStep2.id === step2.id);
  await client.callTool({
    name: 'record_attempt',
    arguments: { step_id: step2.id, what_tried: 'executed second step', verdict: 'pass', result: 'ok' },
  });

  const complete = parse(await client.callTool({ name: 'next_step', arguments: { plan_id: plan.id } }));
  check('next_step reports complete after both passing attempts', complete.complete === true);

  console.log('\napproval workflow MCP regression OK');
} finally {
  if (client) await client.close();
  rmSync(rolesPath, { force: true });
  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });
  rmSync(ragDbPath, { force: true });
  rmSync(ragDbPath + '-wal', { force: true });
  rmSync(ragDbPath + '-shm', { force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}
