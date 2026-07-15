// runner-unit.mjs — unit tests for scripts/runner-lib.mjs (parseVerify, runVerify,
// applyVerifyGate) plus a stubbed end-to-end proof that drives the REAL
// scripts/runner.mjs against a temp DB with a fake CLAUDE_BIN, exercising the
// VERIFY override for real (not just the pure helpers). Run: node test/runner-unit.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { parseVerdict, parseVerify, runVerify, applyVerifyGate } from '../scripts/runner-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };

// --- parseVerdict (unchanged, sanity-checked here since runner.mjs now imports
//     it from runner-lib.mjs instead of defining it inline) ---
check('parseVerdict reads the final VERDICT line', parseVerdict('did stuff\nVERDICT: pass — it works').verdict === 'pass');
check('parseVerdict defaults to fail with no marker', parseVerdict('no marker here').verdict === 'fail');

// --- parseVerify: VERIFY absent = unchanged behavior (null, no gate applied) ---
check('parseVerify: no VERIFY line -> null', parseVerify('Just some step context.\nAcceptance: it works.') === null);
check('parseVerify: empty/undefined context -> null', parseVerify(undefined) === null && parseVerify('') === null);
check('parseVerify: extracts the command', parseVerify('VERIFY: npm test\nrest of context') === 'npm test');
check('parseVerify: command found further down (RAG:-style first-lines convention)',
  parseVerify('RAG: docs — start: "x"\nVERIFY: node -e "process.exit(0)"\nmore context') === 'node -e "process.exit(0)"');
check('parseVerify: trims whitespace around the command', parseVerify('VERIFY:   node -v  ') === 'node -v');

// --- runVerify: exit code + output tail ---
{
  const ok = runVerify(`${JSON.stringify(process.execPath)} -e "process.exit(0)"`);
  check('runVerify: exit 0 -> ok:true', ok.ok === true && ok.code === 0);
  const fail = runVerify(`${JSON.stringify(process.execPath)} -e "console.error('BOOM-tail-marker'); process.exit(1)"`);
  check('runVerify: exit 1 -> ok:false, code 1', fail.ok === false && fail.code === 1);
  check('runVerify: captures output tail', fail.tail.includes('BOOM-tail-marker'));
  const longFail = runVerify(`${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(2000)); process.exit(3)"`);
  check('runVerify: tail is capped near 500 chars', longFail.tail.length <= 500);
}

// --- applyVerifyGate: the four required behaviors ---
{
  // 1. VERIFY absent = unchanged behavior
  const r1 = applyVerifyGate('pass', 'agent verdict: pass', null);
  check('applyVerifyGate: no VERIFY command -> verdict/result untouched', r1.verdict === 'pass' && r1.resultText === 'agent verdict: pass' && r1.verified === null);

  // claimed fail/partial: gate never runs the command (nothing to override)
  const r2 = applyVerifyGate('fail', 'agent verdict: fail', `${JSON.stringify(process.execPath)} -e "process.exit(1)"`);
  check('applyVerifyGate: claimed fail is left alone (gate only re-checks claimed pass)', r2.verdict === 'fail' && r2.verified === null);

  // 2. VERIFY + exit 0 + claimed pass = pass
  const r3 = applyVerifyGate('pass', 'agent verdict: pass', `${JSON.stringify(process.execPath)} -e "process.exit(0)"`);
  check('applyVerifyGate: VERIFY exit 0 + claimed pass -> stays pass', r3.verdict === 'pass' && r3.verified === true);
  check('applyVerifyGate: pass path annotates the result', r3.resultText.includes('VERIFY ok'));

  // 3. VERIFY + exit 1 + claimed pass = fail, with the output tail in the result
  const r4 = applyVerifyGate('pass', 'agent verdict: pass', `${JSON.stringify(process.execPath)} -e "console.error('GATE-OVERRIDE-MARKER'); process.exit(1)"`);
  check('applyVerifyGate: VERIFY exit 1 + claimed pass -> overridden to fail', r4.verdict === 'fail' && r4.verified === false);
  check('applyVerifyGate: failure result includes the VERIFY output tail', r4.resultText.includes('GATE-OVERRIDE-MARKER'));
  check('applyVerifyGate: failure result names the exit code', r4.resultText.includes('exit 1'));
}

console.log(`\n${pass} unit checks passed.\n`);

// ============================================================================
// STUBBED END-TO-END PROOF — drives the REAL scripts/runner.mjs (not the pure
// helpers) against a temp DB with CLAUDE_BIN pointed at a fake CLI that always
// claims "VERDICT: pass" while the step's own VERIFY command is made to fail.
// Expected: the VERIFY override fires and the step ends the run in status
// "failed" (record_attempt's own pass/fail wiring, driven by our overridden
// verdict — see scripts/runner.mjs's inject branch).
// ============================================================================
{
  const dbPath = join(tmpdir(), `plan-ledger-verify-e2e-${process.pid}.db`);
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });

  const setup = new Store(dbPath);
  const plan = setup.createPlan({ title: 'VERIFY e2e plan', keywords: ['verify-e2e'] });
  const step = setup.addStep(plan.id, {
    title: 'Stubbed step whose VERIFY always fails',
    context: [
      `VERIFY: ${JSON.stringify(process.execPath)} -e "console.error('E2E-VERIFY-FAILED-MARKER'); process.exit(1)"`,
      'This step does nothing real — the fake CLAUDE_BIN always claims pass; the point',
      'is proving the runner overrides that claim when VERIFY fails.',
    ].join('\n'),
    acceptance_criteria: 'n/a — stubbed proof',
  });
  setup.close(); // release the handle before the child process opens the same file

  const runnerPath = join(__dirname, '..', 'scripts', 'runner.mjs');
  const fakeCli = join(__dirname, 'fixtures', 'fake-claude-cli.mjs');
  check('fake CLI fixture exists', existsSync(fakeCli));

  const out = execFileSync(process.execPath, [
    runnerPath, '--plan', String(plan.id), '--live', '--inject',
    '--max-attempts', '1', '--allowedTools', 'Write,Read',
  ], {
    env: { ...process.env, CLAUDE_BIN: fakeCli, PLAN_LEDGER_DB: dbPath },
    encoding: 'utf8',
  });
  console.log(out);

  const verify = new Store(dbPath);
  const finalStep = verify.getStep(step.id);
  check('e2e: stub claimed pass but VERIFY override left the step failed', finalStep.status === 'failed');
  const lastAttempt = finalStep.attempts.at(-1);
  check('e2e: override attempt recorded by runner-inject', lastAttempt.executor === 'runner-inject' && lastAttempt.verdict === 'fail');
  check('e2e: override attempt result carries the VERIFY output tail', lastAttempt.result.includes('E2E-VERIFY-FAILED-MARKER'));
  verify.close();

  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  console.log(`\n${pass} total checks passed (incl. stubbed e2e).\n`);
}
