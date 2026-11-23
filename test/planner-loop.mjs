import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { compileWorkerPacket, runPlannerLoop } from '../src/planner-handoff.mjs';

const root = mkdtempSync(join(tmpdir(), 'ledger-qa-loop-'));
const db = join(root, 'fixture.db');
const acceptanceAuthority = Object.freeze({});
const store = new Store(db, { acceptanceAuthority });
process.env.PLAN_LEDGER_ROLES = join(root, 'no-roles.json');
process.env.PLAN_LEDGER_AUTO_TERMINALIZE = 'shadow';
const project = store.createProject({ name: 'Offline planner loop' });
store.setProjectRoot(project.id, root);
const authorization = {
  source_ref: 'test:offline-loop', user_instruction: 'Verify the fixture output',
  granted_actions: ['write fixture output'], constraints: ['offline fixture only'],
};
const contract = { version: 1, criteria: [{ id: 'output', description: 'Read the verified calibration output' }] };
const revise = {
  decision: 'revise', reason: 'Calibration output differs from the expected value',
  feedback: [{ criterion_id: 'output', observation: 'Read incorrect value', next_action: 'Write calibrated output and re-read it' }],
};
const file = 'output.txt';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function makePlan(title, consulted_plan_ids = []) {
  const plan = store.createPlan({ title, summary: 'Verify the fixture output', project_id: project.id, consulted_plan_ids });
  const step = store.addStep(plan.id, { title: 'Verify fixture output', acceptance_contract: contract });
  store.setPlanStatus(plan.id, 'active');
  return { plan, step, packetArgs: { step_id: step.id, authorization, owned_paths: [file, 'rejected.txt'] } };
}

function workerOutput(contents, fileName = file) {
  writeFileSync(join(root, fileName), contents);
  return { summary: 'Worker claims pass', completion_payload: {
    outcome: 'success', artifacts: [fileName], limitations: ['Offline calibration fixture'],
    commands: [{ command: 'read fixture output', exit_code: 0, output: contents }],
    criteria: [{ id: 'output', status: 'verified', reviewer: 'worker', evidence: [{ path: fileName, sha256: hash(contents) }] }],
  } };
}

function handoff(planId) {
  const cli = fileURLToPath(new URL('../src/ledger-cli.mjs', import.meta.url));
  const command = spawnSync(process.execPath, [cli, 'planner_handoff', '--input', JSON.stringify({ plan_id: planId })], {
    env: { ...process.env, PLAN_LEDGER_DB: db }, encoding: 'utf8',
  });
  assert.equal(command.status, 0, command.stderr);
  return JSON.parse(command.stdout).result;
}

try {
  const prior = store.createPlan({ title: 'Calibration research', project_id: project.id });
  const separate = store.createProject({ name: 'Separate fixture scope' });
  const unrelated = store.createPlan({ title: 'Other project research', project_id: separate.id });
  const { plan, step, packetArgs } = makePlan('Research, work, QA and handoff', [prior.id, unrelated.id]);
  const packets = [];
  assert.equal(handoff(plan.id).ready, false);
  const successful = await runPlannerLoop(store, { packetArgs, acceptanceAuthority,
    adapter: { kind: 'offline-local', run: async ({ packet }) => {
      packets.push(structuredClone(packet));
      packet.review_owner = 'worker-mutated';
      packet.scope.owned_paths.push('unowned.txt');
      return packets.length === 1 ? workerOutput('incorrect', 'rejected.txt') : workerOutput('calibrated');
    } },
    reviewEvidence: ({ report, submission }) => {
      const receipt = report.completion_payload.criteria[0].evidence[0];
      const observed = readFileSync(join(root, receipt.path), 'utf8');
      assert.equal(hash(observed), receipt.sha256);
      assert.ok(submission.submission_id > 0);
      if (observed === 'calibrated') return { decision: 'accept', reason: 'Independent fixture read matched calibrated output' };
      store.absorbFindings([{ kind: 'lesson', subject: 'calibration', claim: 'Calibration output must be read independently after writing.' }], { step_id: step.id });
      return revise;
    },
  });
  assert.equal(successful.status, 'accepted');
  assert.equal(successful.attempts, 2);
  assert.deepEqual(packets.map(p => p.consulted_plans.map(q => q.consulted_plan_id)), [[prior.id], [prior.id]]);
  assert.notEqual(packets[0].packet_id, packets[1].packet_id);
  assert.deepEqual(packets[0].authorization, packets[1].authorization);
  assert.deepEqual(packets[0].scope, packets[1].scope);
  assert.equal(packets[1].prior_review.feedback[0].next_action, revise.feedback[0].next_action);
  assert.equal(packets[1].findings[0].subject, 'calibration');
  assert.deepEqual(store.getStep(step.id).attempts.map(a => a.verdict), ['partial', 'pass']);
  assert.notEqual(packets[1].prior_review.submission_id, successful.handoff.steps[0].review.submission_id);
  assert.equal(store.listExecutionLeases({ step_id: step.id, status: 'open' }).length, 0);
  const bundle = handoff(plan.id);
  assert.equal(bundle.ready, true);
  assert.equal(bundle.plan_status, 'active'); // shadow mode leaves closure policy to the caller
  assert.equal(bundle.steps[0].review.reviewer, 'Nova');
  assert.equal(bundle.steps[0].review.reason, 'Independent fixture read matched calibrated output');
  assert.equal(bundle.steps[0].criteria[0].evidence[0].sha256, hash('calibrated'));
  assert.equal(readFileSync(join(root, 'rejected.txt'), 'utf8'), 'incorrect');
  writeFileSync(join(root, file), 'drifted');
  assert.ok(handoff(plan.id).blockers.some(b => b.code === 'criterion_evidence_invalid'));
  console.log('ok fresh prompt incorporates scoped research and structured QA feedback, and handoff rechecks accepted evidence');

  const held = makePlan('Deferred QA');
  let calls = 0;
  const heldOptions = { packetArgs: held.packetArgs, acceptanceAuthority,
    adapter: { kind: 'offline-local', run: async () => { calls++; return workerOutput('valid receipt'); } },
    reviewEvidence: () => ({ decision: 'defer', reason: 'Review needs a separate fixture observation' }),
  };
  const deferred = await runPlannerLoop(store, heldOptions);
  assert.equal(deferred.status, 'awaiting_review');
  const heldStep = store.getStep(held.step.id);
  const resumed = await runPlannerLoop(store, heldOptions);
  assert.equal(resumed.status, 'awaiting_review');
  assert.equal(resumed.submission_id, deferred.submission_id);
  assert.equal(calls, 1);
  assert.equal(store.getStep(held.step.id).acceptance_epoch, heldStep.acceptance_epoch);
  assert.equal(heldStep.execution_lease, null);
  const heldHandoff = handoff(held.plan.id);
  assert.equal(heldHandoff.ready, false);
  assert.ok(heldHandoff.blockers.some(b => b.code === 'awaiting_independent_review' && b.submission_id === resumed.submission_id));
  console.log('ok deferred review preserves the current submission across invocations');

  const denied = makePlan('Platform blocker');
  const blocked = await runPlannerLoop(store, { packetArgs: denied.packetArgs, acceptanceAuthority,
    adapter: { kind: 'offline-local', run: async () => ({ blocker: { kind: 'platform_denial', reason: 'fixture denied' } }) },
    reviewEvidence: () => assert.fail('blocker must stop before review'),
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.attempts, 1);
  assert.equal(store.getStep(denied.step.id).execution_lease, null);
  assert.equal(handoff(denied.plan.id).ready, false);
  console.log('ok platform denial stops the loop and releases local ownership');

  const exhausted = makePlan('Exhausted revisions');
  const limited = await runPlannerLoop(store, { packetArgs: exhausted.packetArgs, acceptanceAuthority, maxAttempts: 2,
    adapter: { kind: 'offline-local', run: async () => workerOutput('still incorrect') }, reviewEvidence: () => revise,
  });
  assert.equal(limited.status, 'retry_budget_exhausted');
  assert.deepEqual(store.getStep(exhausted.step.id).attempts.map(a => a.verdict), ['partial', 'partial']);
  assert.equal(compileWorkerPacket(store, exhausted.packetArgs).prior_review.reason, revise.reason);
  assert.equal(handoff(exhausted.plan.id).ready, false);
  console.log('ok exhausted retries preserve actionable feedback for a later planner session');

  const malformed = makePlan('Malformed QA response');
  const failed = await runPlannerLoop(store, { packetArgs: malformed.packetArgs, acceptanceAuthority,
    adapter: { kind: 'offline-local', run: async () => workerOutput('candidate') },
    reviewEvidence: () => ({ decision: 'revise', reason: 'Invalid target', feedback: [{ ...revise.feedback[0], criterion_id: 'unknown' }] }),
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.run.error.message, /planner_qa_invalid:criterion_id/);
  assert.equal(handoff(malformed.plan.id).ready, false);
  console.log('ok invalid review cannot accept evidence or trigger another attempt');

  const staleReceipt = makePlan('Repair a stale receipt');
  const receiptPackets = [];
  const writeStaleReceipt = () => {
    const report = workerOutput('original receipt', 'rejected.txt');
    writeFileSync(join(root, 'rejected.txt'), 'changed receipt');
    return report;
  };
  let reviews = 0;
  const repaired = await runPlannerLoop(store, { packetArgs: staleReceipt.packetArgs, acceptanceAuthority,
    adapter: { kind: 'offline-local', run: async ({ packet }) => {
      receiptPackets.push(packet);
      return receiptPackets.length === 1 ? writeStaleReceipt() : workerOutput('current receipt');
    } },
    reviewEvidence: ({ report }) => {
      reviews++;
      const evidence = report.completion_payload.criteria[0].evidence[0];
      assert.equal(hash(readFileSync(join(root, evidence.path))), evidence.sha256);
      return { decision: 'accept', reason: 'Read and checked the replacement receipt' };
    },
  });
  assert.equal(repaired.status, 'accepted');
  assert.equal(repaired.handoff.ready, true);
  assert.equal(reviews, 1);
  assert.equal(receiptPackets.length, 2);
  assert.equal(receiptPackets[1].validation_feedback.errors[0].code, 'evidence_hash_mismatch');
  assert.match(receiptPackets[1].validation_feedback.errors[0].next_action, /current receipt/);
  assert.deepEqual(receiptPackets[1].authorization, receiptPackets[0].authorization);
  assert.deepEqual(receiptPackets[1].scope, receiptPackets[0].scope);
  assert.deepEqual(store.getStep(staleReceipt.step.id).attempts.map(attempt => attempt.verdict), ['fail', 'pass']);
  console.log('ok a stale receipt triggers scoped validation feedback and fresh independent review');

  const exhaustedReceipt = makePlan('Exhaust stale receipt repair');
  const exhaustedRepair = await runPlannerLoop(store, { packetArgs: exhaustedReceipt.packetArgs, acceptanceAuthority, maxAttempts: 2,
    adapter: { kind: 'offline-local', run: async () => writeStaleReceipt() },
    reviewEvidence: () => assert.fail('Stale receipts cannot reach review'),
  });
  assert.equal(exhaustedRepair.status, 'retry_budget_exhausted');
  assert.equal(exhaustedRepair.attempts, 2);
  assert.equal(store.getStep(exhaustedReceipt.step.id).execution_lease, null);
  assert.equal(handoff(exhaustedReceipt.plan.id).ready, false);
  console.log('ok repeatedly stale evidence consumes only the configured budget');

  const failedCommand = makePlan('Stop on a failed command');
  const invalid = await runPlannerLoop(store, { packetArgs: failedCommand.packetArgs, acceptanceAuthority,
    adapter: { kind: 'offline-local', run: async () => {
      const report = workerOutput('test command genuinely failed');
      report.completion_payload.commands[0].exit_code = 1;
      return report;
    } },
    reviewEvidence: () => assert.fail('A failed command cannot reach acceptance'),
  });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.attempts, 1);
  assert.equal(invalid.run.work_result.validation_errors[0].code, 'completion_command_failed');
  assert.equal(handoff(failedCommand.plan.id).ready, false);
  console.log('ok non-receipt validation errors do not trigger automatic rework');
  console.log('planner QA loop OK (8 scenarios); local fixtures only');
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
