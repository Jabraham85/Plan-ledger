// runner-unit.mjs — unit tests for scripts/runner-lib.mjs (parseVerify, runVerify,
// applyVerifyGate, formatUsageLine, appendUsageToLatestAttempt) plus a stubbed
// end-to-end proof that drives the REAL scripts/runner.mjs against a temp DB with
// a fake CLAUDE_BIN, exercising the VERIFY override for real (not just the pure
// helpers). Run: node test/runner-unit.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { parseVerdict, parseVerify, runVerify, applyVerifyGate, formatUsageLine, appendUsageToLatestAttempt,
  parseFindings, formatFindingLines, FINDINGS_MAX, FINDINGS_INSTRUCTIONS, splitParts, pickBrief } from '../scripts/runner-lib.mjs';

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

// --- formatUsageLine ---
{
  const line = formatUsageLine({ tin: 1234, tout: 56, cost: 0.789, turns: 3, model: 'sonnet' });
  check('formatUsageLine: exact shape', line === 'usage: in=1234 out=56 cost=$0.7890 turns=3 model=sonnet');
  const noModel = formatUsageLine({ tin: 1, tout: 1, cost: 0, turns: 1 });
  check('formatUsageLine: missing model -> "default"', noModel === 'usage: in=1 out=1 cost=$0.0000 turns=1 model=default');
}

// --- appendUsageToLatestAttempt ---
{
  const s = new Store(':memory:');
  const plan = s.createPlan({ title: 'usage-append plan', keywords: [] });
  const step = s.addStep(plan.id, { title: 'noop step' });
  const beforeId = s.db.prepare('SELECT MAX(id) m FROM attempts WHERE step_id=?').get(step.id).m || 0;
  check('appendUsageToLatestAttempt: nothing to append when no new attempt landed',
    appendUsageToLatestAttempt(s.db, step.id, beforeId, 'usage: in=1 out=1 cost=$0.0000 turns=1 model=default').appended === false);

  s.recordAttempt(step.id, { what_tried: 'did the thing', result: 'base result', verdict: 'fail' });
  const r = appendUsageToLatestAttempt(s.db, step.id, beforeId, 'usage: in=10 out=5 cost=$0.0010 turns=1 model=default');
  check('appendUsageToLatestAttempt: appends to the newly-created attempt', r.appended === true);
  const att = s.getStep(step.id).attempts.at(-1);
  check('appendUsageToLatestAttempt: usage line lands in the result field', att.result.includes('base result') && att.result.includes('usage: in=10 out=5'));

  // a call keyed off the attempt we JUST appended to (sinceId = its own id) has
  // nothing newer to attach to — must skip, not silently overwrite the same row again
  const latestId = s.db.prepare('SELECT MAX(id) m FROM attempts WHERE step_id=?').get(step.id).m;
  const r2 = appendUsageToLatestAttempt(s.db, step.id, latestId, 'usage: in=999 out=999 cost=$9.9999 turns=9 model=x');
  check('appendUsageToLatestAttempt: no attempt newer than sinceId -> skipped', r2.appended === false);
  s.close();
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

  // Pass --model so the runner records the OBSERVED CLI-selected model on the
  // attempt (v5 provenance). Without --model there's nothing to record.
  const out = execFileSync(process.execPath, [
    runnerPath, '--plan', String(plan.id), '--live', '--inject',
    '--max-attempts', '1', '--allowedTools', 'Write,Read', '--model', 'stub-model-x',
  ], {
    env: { ...process.env, CLAUDE_BIN: fakeCli, PLAN_LEDGER_DB: dbPath, PLAN_LEDGER_CURSOR_MODELS: 'stub-model-x' },
    encoding: 'utf8',
  });
  console.log(out);

  const verify = new Store(dbPath);
  const finalStep = verify.getStep(step.id);
  check('e2e: stub claimed pass but VERIFY override left the step failed', finalStep.status === 'failed');
  const lastAttempt = finalStep.attempts.at(-1);
  check('e2e: override attempt recorded by runner-inject', lastAttempt.executor === 'runner-inject' && lastAttempt.verdict === 'fail');
  check('e2e: override attempt result carries the VERIFY output tail', lastAttempt.result.includes('E2E-VERIFY-FAILED-MARKER'));
  check('e2e: override attempt result carries the usage line', /usage: in=\d+ out=\d+ cost=\$[\d.]+ turns=\d+ model=\w+/.test(lastAttempt.result));
  check('e2e: attempt persists observed model + runner-cli provenance (v5)',
    lastAttempt.model === 'stub-model-x' && lastAttempt.model_source === 'runner-cli');
  verify.close();

  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  console.log(`\n${pass} total checks passed (incl. inject-mode stubbed e2e).\n`);
}

// ============================================================================
// STUBBED END-TO-END PROOF — MCP mode's "skip with a console note" branch.
// The fake CLI is NOT a real MCP client (it never calls record_attempt over
// MCP), so a non-inject (--live, no --inject) run against it must find no new
// attempt afterward and skip the usage-line append with a console note instead
// of guessing which attempt to touch — and must NOT run/override VERIFY either,
// since the step never reached status=done.
// ============================================================================
{
  const dbPath = join(tmpdir(), `plan-ledger-verify-mcp-e2e-${process.pid}.db`);
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });

  const setup = new Store(dbPath);
  const plan = setup.createPlan({ title: 'VERIFY MCP e2e plan', keywords: ['verify-mcp-e2e'] });
  const step = setup.addStep(plan.id, {
    title: 'MCP-mode step whose fake agent never calls record_attempt',
    context: `VERIFY: ${JSON.stringify(process.execPath)} -e "process.exit(1)"\nMCP-mode stub — the fake CLAUDE_BIN never touches the DB.`,
  });
  setup.close();

  const runnerPath = join(__dirname, '..', 'scripts', 'runner.mjs');
  const fakeCli = join(__dirname, 'fixtures', 'fake-claude-cli.mjs');
  const out = execFileSync(process.execPath, [
    runnerPath, '--plan', String(plan.id), '--live',
    '--max-attempts', '1', '--allowedTools', 'Write,Read',
  ], {
    env: { ...process.env, CLAUDE_BIN: fakeCli, PLAN_LEDGER_DB: dbPath },
    encoding: 'utf8',
  });
  console.log(out);

  check('MCP e2e: skip note printed (no new attempt from the fake non-MCP CLI)',
    out.includes('usage line skipped — no new attempt recorded'));
  check('MCP e2e: VERIFY was never claimed to run (step never reached done)',
    !out.includes('VERIFY override') && !out.includes('VERIFY passed'));
  // Lease-based lifecycle: when no attempt lands, closeExecutionLease closes the
  // lease as `abandoned` and hands the step back to pending; the runner then
  // exhausts its per-step attempt budget on the retry. The plan must NEVER be
  // marked complete on this path, and the runner must announce the pause.
  check('MCP e2e: active work is not falsely reported as plan complete',
    !out.includes('✅ plan complete') && /(plan is not complete|pausing for a human|unresolved after)/.test(out));

  const verify = new Store(dbPath);
  const finalStep = verify.getStep(step.id);
  check('MCP e2e: step left retryable (pending) after abandoned lease',
    finalStep.status === 'pending' || finalStep.status === 'failed');
  check('MCP e2e: no attempts were fabricated', finalStep.attempts.length === 0);
  check('MCP e2e: runner did not mark a plan done while its step was active',
    verify.openPlan(plan.id).status !== 'done');
  const openLeases = verify.listExecutionLeases({ plan_id: plan.id, status: 'open' });
  check('MCP e2e: no lease is left open after the runner exits', openLeases.length === 0);
  verify.close();

  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  console.log(`\n${pass} total checks passed (incl. both stubbed e2e proofs).\n`);
}

// ============================================================================
// FINDINGS WRITE-BACK (plan #134): parseFindings / formatFindingLines units,
// then a stubbed e2e proving the whole loop through the REAL runner process:
// step 1's agent reports a finding → the runner absorbs it → step 2's BRIEF
// contains it → step 2's identical report is deduplicated, not stored twice.
// ============================================================================
{
  const v = (body) => `did work\n${body}\nVERDICT: pass — ok`;
  check('parseFindings: absent line → nothing, no error', (() => { const r = parseFindings(v('')); return r.findings.length === 0 && r.error === null; })());
  const good = parseFindings(v('FINDINGS: [{"subject":"a","claim":"b is c"}]'));
  check('parseFindings: valid single-line array', good.findings.length === 1 && good.findings[0].claim === 'b is c' && good.error === null);
  check('parseFindings: empty array → nothing, no error', parseFindings(v('FINDINGS: []')).error === null);
  const bad = parseFindings(v('FINDINGS: [{"claim": oops}]'));
  check('parseFindings: malformed JSON → nothing absorbed + reason', bad.findings.length === 0 && /not valid/.test(bad.error));
  // Behaviour change 2026-09-22 (bench/findings-real Amendment 2): multi-line arrays
  // are now ACCEPTED — bracket matching makes them unambiguous, and rejecting them
  // threw away real agents' findings for a formatting choice.
  const multi = parseFindings('FINDINGS: [\n  {"claim":"x y"}\n]\nVERDICT: pass — ok');
  check('parseFindings: multi-line JSON array is accepted (bracket-matched)', multi.findings.length === 1 && multi.error === null);
  check('parseFindings: an array that never closes → nothing absorbed + reason',
    /never closes/.test(parseFindings('FINDINGS: [{"claim":"x y"}\nVERDICT: pass — ok').error));

  // Real failure modes observed in DeepSeek v4-pro output (18 agents, only 7 compliant):
  const glued = 'did work\nFINDINGS: [{"claim":"a is b"}]VERDICT: pass — did it';
  check('REAL: VERDICT glued onto the FINDINGS line → findings parsed', parseFindings(glued).findings.length === 1);
  check('REAL: …and the glued verdict is recovered (was a false FAIL)',
    parseVerdict(glued).verdict === 'pass' && parseVerdict(glued).what_tried === 'did it');
  const spaced = 'x\nFINDINGS: [{"claim":"a is b"}] VERDICT: partial — half';
  check('REAL: glued with a space → verdict recovered', parseVerdict(spaced).verdict === 'partial');
  const prefixed = 'Here are my findings. FINDINGS: [{"claim":"a is b"}]\nVERDICT: pass — ok';
  check('REAL: FINDINGS mid-line after prose → parsed', parseFindings(prefixed).findings.length === 1);
  const quoted = 'FINDINGS: [{"claim":"the agent must end with VERDICT: pass|fail|partial and FINDINGS: [ ... ] before it"}]';
  check('REAL: contract text QUOTED inside a claim is not read as the verdict (no marker → fail)',
    parseVerdict(quoted).verdict === 'fail' && parseVerdict(quoted).what_tried === null);
  check('REAL: a "]" and a quoted FINDINGS marker inside a claim do not break the array',
    parseFindings(quoted).findings.length === 1 && parseFindings(quoted).findings[0].claim.includes('FINDINGS: [ ... ]'));
  check('REAL: findings present but no VERDICT at all → still a fail (contract kept)',
    parseVerdict('FINDINGS: [{"claim":"a is b"}]').verdict === 'fail');
  check('strict line-start VERDICT still works with no FINDINGS', parseVerdict('work\nVERDICT: pass — ok').verdict === 'pass');
  check('parseFindings: an object instead of an array → rejected', /array/.test(parseFindings(v('FINDINGS: {"claim":"x y"}')).error));
  const mixed = parseFindings(v('FINDINGS: [{"claim":"x y"}, 3, "str", [1]]'));
  check('parseFindings: non-object items dropped, objects kept', mixed.findings.length === 1 && /dropped/.test(mixed.error));
  const many = parseFindings(v(`FINDINGS: ${JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ claim: `fact ${i} holds` })))}`));
  check(`parseFindings: capped at ${FINDINGS_MAX}`, many.findings.length === FINDINGS_MAX && /first 20/.test(many.error));
  check('parseFindings: the LAST FINDINGS line wins', parseFindings('FINDINGS: [{"claim":"old one"}]\nFINDINGS: [{"claim":"new one"}]').findings[0].claim === 'new one');
  check('parseFindings: does not disturb parseVerdict', parseVerdict(v('FINDINGS: [{"claim":"x y"}]')).verdict === 'pass');
  const lines = formatFindingLines([{ kind: 'fact', subject: 's', claim: 'c is d', conflicts_with: [] },
    { kind: 'warning', subject: '', claim: 'e is f', conflicts_with: [9] }]);
  check('formatFindingLines: header + one line each, conflict called out, empty subject labelled',
    lines.length === 3 && lines[1].includes('[fact] s: c is d') && lines[2].includes('(general)') && lines[2].includes('CONFLICT'));
  check('formatFindingLines: nothing to say → no lines', formatFindingLines([]).length === 0);
  const parts = splitParts('Fix the runner retry loop\nContext: (1) the retry cap is wrong (2) the port clashes. Also check the docs.\n- update the tests now');
  check('splitParts: lines, numbered items, sentences and bullets become separate parts',
    parts.includes('Fix the runner retry loop') && parts.includes('the retry cap is wrong') && parts.includes('the port clashes.') &&
    parts.includes('Also check the docs.') && parts.includes('update the tests now'));
  check('splitParts: fragments under 3 words are dropped', !splitParts('ok\nyes sure\nthis one stays').some((p) => p === 'ok' || p === 'yes sure'));
  const fdb = [{ id: 1, t: 'retry cap', score: 0 }, { id: 2, t: 'retry cap loop', score: 0 }, { id: 3, t: 'port clash', score: 0 }, { id: 4, t: 'docs', score: 0 }];
  const fq = (text, k) => fdb.map((f) => ({ ...f, score: f.t.split(' ').filter((w) => text.includes(w)).length }))
    .filter((f) => f.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  const brief = pickBrief(fq, 'the retry cap loop is wrong\nthe port clash must be fixed', { limit: 2 });
  check('pickBrief: one best hit PER PART — the port finding is not crowded out by two retry findings',
    brief.length === 2 && brief.some((f) => f.id === 3) && brief.some((f) => f.id === 2));
  check('pickBrief: tops up from the whole text when parts find too little, no duplicates',
    new Set(pickBrief(fq, 'retry cap loop port clash docs', { limit: 3 }).map((f) => f.id)).size === 3);
  const sus = formatFindingLines([{ id: 42, kind: 'fact', subject: 's', claim: 'x is y', status: 'suspect', conflicts_with: [] }]);
  check('formatFindingLines: #id shown (citable in depends_on), SUSPECT called out',
    sus[1].startsWith('- #42 [fact]') && sus[1].includes('SUSPECT') && !lines[1].includes('SUSPECT'));
  check('FINDINGS_INSTRUCTIONS teach the single-line contract', FINDINGS_INSTRUCTIONS.join(' ').includes('FINDINGS: [{'));

  const dbPath = join(tmpdir(), `plan-ledger-findings-e2e-${process.pid}.db`);
  const promptLog = join(tmpdir(), `plan-ledger-findings-prompts-${process.pid}.log`);
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  rmSync(promptLog, { force: true });
  const setup = new Store(dbPath);
  const plan = setup.createPlan({ title: 'Findings e2e plan' });
  setup.addStep(plan.id, { title: 'Inspect the zebra cache config', context: 'Find out how many entries the zebra cache holds.' });
  setup.addStep(plan.id, { title: 'Tune the zebra cache', context: 'Adjust zebra cache entries if needed.' });
  setup.close();

  const out = execFileSync(process.execPath, [
    join(__dirname, '..', 'scripts', 'runner.mjs'), '--plan', String(plan.id), '--live', '--inject',
    '--max-attempts', '1', '--allowedTools', 'Write,Read',
  ], {
    env: { ...process.env, CLAUDE_BIN: join(__dirname, 'fixtures', 'fake-claude-findings.mjs'),
      PLAN_LEDGER_DB: dbPath, FAKE_PROMPT_LOG: promptLog },
    encoding: 'utf8',
  });
  console.log(out);
  const prompts = readFileSync(promptLog, 'utf8').split('=====PROMPT-END=====').map((p) => p.trim()).filter(Boolean);
  check('findings e2e: both steps ran (two agent prompts)', prompts.length === 2);
  check('findings e2e: agents are told the FINDINGS contract', prompts.every((p) => p.includes('FINDINGS: [{')));
  check('findings e2e: step 1 was briefed with NO findings (none existed yet)', !prompts[0].includes('zebra cache holds 42 entries'));
  check("findings e2e: step 2's brief CONTAINS what step 1 learned", prompts[1].includes('zebra cache holds 42 entries') &&
    prompts[1].includes('What the project already knows'));
  check('findings e2e: runner logged the absorb', /findings absorbed: 1 created/.test(out) && /findings absorbed: 1 duplicate/.test(out));

  const after = new Store(dbPath);
  const found = after.queryFindings({ plan_id: plan.id, status: 'any' });
  check('findings e2e: exactly ONE finding stored (step 2 re-report deduplicated)', found.length === 1 && found[0].seen_count === 2);
  check('findings e2e: provenance = first reporting step + runner source', found[0].step_id != null && found[0].source === 'runner:agent' &&
    found[0].evidence.includes('fixture/zebra.cfg:3'));
  check('findings e2e: both steps still completed normally', after.openPlan(plan.id).steps.every((st) => st.status === 'done'));
  after.close();
  for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });
  rmSync(promptLog, { force: true });
  console.log(`\n${pass} total checks passed (incl. findings write-back e2e).\n`);
}
