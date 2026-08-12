// parallel-supervisor.mjs — deterministic tests for bounded parallel dispatch.
// Run: node test/parallel-supervisor.mjs

import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/db.mjs';
import { runParallelSupervisor, clampMaxWorkers } from '../src/parallel-supervisor.mjs';
import {
  parseStepOwnership,
  ownershipConflicts,
  selectNonConflictingSteps,
  PathLockRegistry,
  normalizeRepoPath,
} from '../src/path-ownership.mjs';
import { probeOwnedArtifacts, buildArtifactBaseline, supervise } from '../src/supervisor.mjs';
import { createWorktreePool } from '../scripts/worktree-pool.mjs';
import { IntegrationError } from '../scripts/worktree-integrator.mjs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParallelStepRunner } from '../scripts/runner-step.mjs';
import { buildCompletionPayloadV2 } from '../scripts/execution-governance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

function makeStore(name) {
  const path = join(tmpdir(), `plan-ledger-parallel-${name}-${process.pid}-${Date.now().toString(36)}.db`);
  for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
  const store = new Store(path);
  return { store, path };
}
function cleanup(store, path) {
  try { store.close(); } catch {}
  for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function initGitRepo(dir, { dirty = false } = {}) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.eol', 'lf'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  if (dirty) writeFileSync(join(dir, 'dirty.txt'), 'dirty\n');
}

function normalizeLf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function spawnFake(fakePath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakePath], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

// --- path ownership ---
{
  const ownership = parseStepOwnership({
    context: 'OWNED_PATH: src/a.mjs\nOWNED_GLOB: lib/',
    file_refs: [{ path: 'src/b.mjs', role: 'write' }],
  });
  check('parseStepOwnership reads OWNED_PATH and write file_refs',
    ownership.exact.includes('src/a.mjs') && ownership.exact.includes('src/b.mjs'));
  check('parseStepOwnership reads OWNED_GLOB prefix', ownership.prefixes.includes('lib'));
  const a = { exact: ['src/foo.mjs'], prefixes: [] };
  const b = { exact: ['src/foo.mjs'], prefixes: [] };
  check('exact path conflict detected', ownershipConflicts(a, b));
  const c = { exact: [], prefixes: ['src'] };
  const d = { exact: ['src/nested/x.mjs'], prefixes: [] };
  check('prefix/exact conflict detected', ownershipConflicts(c, d));
  check('normalizeRepoPath strips leading ./', normalizeRepoPath('./src/x') === 'src/x');
}

// --- bounded readySteps claim ---
{
  const { store, path } = makeStore('ready-limit');
  const plan = store.createPlan({ title: 'limit plan' });
  store.addStep(plan.id, { title: 's1' });
  store.addStep(plan.id, { title: 's2' });
  store.addStep(plan.id, { title: 's3' });
  const claimed = store.readySteps(plan.id, { claim: true, executor: 'test', limit: 2 });
  check('readySteps({claim,limit:2}) claims at most 2', claimed.length === 2);
  const rest = store.readySteps(plan.id, { claim: true, executor: 'test2' });
  check('readySteps({claim:true}) claims remaining frontier', rest.length === 1);
  const p2 = store.createPlan({ title: 'limit peek' });
  store.addStep(p2.id, { title: 'a' });
  store.addStep(p2.id, { title: 'b' });
  store.addStep(p2.id, { title: 'c' });
  check('readySteps({limit:2}) peek returns at most 2 without claiming',
    store.readySteps(p2.id, { limit: 2 }).length === 2
      && store.readySteps(p2.id).length === 3);
  cleanup(store, path);
}

// --- max concurrency ---
{
  const { store, path } = makeStore('max-workers');
  const plan = store.createPlan({ title: 'parallel cap' });
  for (let i = 0; i < 5; i++) store.addStep(plan.id, { title: `step ${i}`, context: `OWNED_PATH: out/step-${i}.txt` });
  store.setPlanStatus(plan.id, 'active');
  let peak = 0;
  let active = 0;
  const stepRunner = async ({ step }) => {
    active++;
    peak = Math.max(peak, active);
    await sleep(30);
    store.recordAttempt(step.id, { what_tried: 'fake', verdict: 'pass' });
    store.setStepStatus(step.id, 'done');
    store.setStepDisposition(step.id, { disposition: 'verified', reason: 'test' });
    active--;
    return { outcome: 'success' };
  };
  const res = await runParallelSupervisor(store, {
    plan_id: plan.id,
    max_workers: 2,
    stepRunner,
  });
  check('parallel run completes all steps', res.status === 'complete' && res.steps_finished === 5);
  check('peak concurrency respects max_workers=2', peak <= 2 && peak >= 2);
  check('no open leases after parallel run', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
}

// --- immediate refill ---
{
  const { store, path } = makeStore('refill');
  const plan = store.createPlan({ title: 'refill plan' });
  const s1 = store.addStep(plan.id, { title: 'fast', context: 'OWNED_PATH: out/a.txt' });
  const s2 = store.addStep(plan.id, { title: 'slow', context: 'OWNED_PATH: out/b.txt' });
  const s3 = store.addStep(plan.id, { title: 'fast2', context: 'OWNED_PATH: out/c.txt' });
  store.setPlanStatus(plan.id, 'active');
  const order = [];
  const stepRunner = async ({ step }) => {
    order.push(`start-${step.id}`);
    const delay = step.id === s2.id ? 80 : 10;
    await sleep(delay);
    store.recordAttempt(step.id, { what_tried: 'fake', verdict: 'pass' });
    store.setStepStatus(step.id, 'done');
    store.setStepDisposition(step.id, { disposition: 'verified', reason: 'test' });
    order.push(`end-${step.id}`);
    return { outcome: 'success' };
  };
  await runParallelSupervisor(store, {
    plan_id: plan.id,
    max_workers: 2,
    stepRunner,
  });
  check('third step starts before slow step finishes (immediate refill)',
    order.indexOf(`start-${s3.id}`) < order.indexOf(`end-${s2.id}`));
  cleanup(store, path);
}

// --- dependency gating ---
{
  const { store, path } = makeStore('deps');
  const plan = store.createPlan({ title: 'deps plan' });
  const s1 = store.addStep(plan.id, { title: 'first', context: 'OWNED_PATH: out/1.txt' });
  const s2 = store.addStep(plan.id, { title: 'second', context: 'OWNED_PATH: out/2.txt' });
  store.link(s2.id, { to_step_id: s1.id, relation: 'builds_on' });
  store.setPlanStatus(plan.id, 'active');
  const ran = [];
  await runParallelSupervisor(store, {
    plan_id: plan.id,
    max_workers: 3,
    stepRunner: async ({ step }) => {
      ran.push(step.id);
      store.recordAttempt(step.id, { what_tried: 'fake', verdict: 'pass' });
      store.setStepStatus(step.id, 'done');
      store.setStepDisposition(step.id, { disposition: 'verified', reason: 'test' });
      return { outcome: 'success' };
    },
  });
  check('dependency gating runs prerequisite first', ran.indexOf(s1.id) < ran.indexOf(s2.id));
  cleanup(store, path);
}

// --- path conflict serialization ---
{
  const { store, path } = makeStore('path-conflict');
  const plan = store.createPlan({ title: 'conflict plan' });
  store.addStep(plan.id, { title: 'a', context: 'OWNED_PATH: shared/out.txt' });
  store.addStep(plan.id, { title: 'b', context: 'OWNED_PATH: shared/out.txt' });
  store.setPlanStatus(plan.id, 'active');
  let concurrent = 0;
  let peak = 0;
  await runParallelSupervisor(store, {
    plan_id: plan.id,
    max_workers: 2,
    stepRunner: async ({ step }) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await sleep(40);
      store.recordAttempt(step.id, { what_tried: 'fake', verdict: 'pass' });
      store.setStepStatus(step.id, 'done');
      store.setStepDisposition(step.id, { disposition: 'verified', reason: 'test' });
      concurrent--;
      return { outcome: 'success' };
    },
  });
  check('conflicting steps never run concurrently', peak === 1);
  cleanup(store, path);
}

// --- path lock registry unit ---
{
  const reg = new PathLockRegistry();
  const o1 = { exact: ['src/a.mjs'], prefixes: [] };
  const o2 = { exact: ['src/a.mjs'], prefixes: [] };
  reg.acquire(1, o1);
  check('registry blocks conflicting acquire', reg.conflictsWithActive(o2));
  reg.release(1);
  check('registry allows after release', !reg.conflictsWithActive(o2));
  const ready = [{ id: 10, context: 'OWNED_PATH: x.mjs' }, { id: 11, context: 'OWNED_PATH: x.mjs' }];
  const picked = selectNonConflictingSteps(ready, reg, { max: 2 });
  check('selectNonConflictingSteps picks only one conflicting step', picked.length === 1);
}

// --- worktree skip mode ---
{
  const dir = join(tmpdir(), `pl-wt-skip-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const pool = createWorktreePool({ repoRoot: dir, skipWorktrees: true });
  const wt = await pool.allocate({ planId: 1, stepId: 2, runId: 'r1' });
  check('skip-worktrees uses repo root as cwd', wt.skipped === true && wt.cwd === dir);
  const rel = await pool.release(wt);
  check('skip-worktrees release is no-op safe', rel.skipped === true);
}

// --- worktree allocate/cleanup with real git repo ---
{
  const dir = join(tmpdir(), `pl-wt-git-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  const pool = createWorktreePool({ repoRoot: dir, worktreeBase: join(dir, '.wt') });
  const wt = await pool.allocate({ planId: 9, stepId: 8, runId: 'run-a' });
  check('worktree created under base', wt.skipped === false && existsSync(wt.path));
  await pool.release(wt);
  check('worktree removed in finally', !existsSync(wt.path));
  const pruned = pool.cleanupOrphans({ openLeases: [] });
  check('orphan cleanup runs without error', typeof pruned.pruned === 'number');
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- artifact probe + supervise heartbeat ---
{
  const dir = join(tmpdir(), `pl-artifact-${process.pid}`);
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'out', 'base.txt'), 'hello');
  const ownership = { exact: ['out/base.txt'], prefixes: ['out'] };
  const baseline = buildArtifactBaseline(dir, ownership);
  const before = probeOwnedArtifacts(dir, ownership, { baseline });
  check('baseline suppresses promotion for unchanged file', before.has_new_artifacts === false);
  writeFileSync(join(dir, 'out', 'new.txt'), 'world');
  const after = probeOwnedArtifacts(dir, ownership, { baseline });
  check('artifact probe detects new file under owned prefix', after.has_new_artifacts && after.promoted.includes('out/new.txt'));
}

// --- supervise integrates artifact probe on heartbeat ---
{
  const { store, path } = makeStore('artifact-hb');
  const plan = store.createPlan({ title: 'artifact hb' });
  const step = store.addStep(plan.id, { title: 'hb step' });
  store.setPlanStatus(plan.id, 'active');
  const dir = join(tmpdir(), `pl-sup-art-${process.pid}`);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  let promoted = false;
  const res = await supervise(store, {
    plan_id: plan.id,
    step_id: step.id,
    executor: 'artifact-test',
    heartbeat_ms: 25,
    artifact_cwd: dir,
    owned_paths: { exact: [], prefixes: ['artifacts'] },
    onArtifactsPromoted: () => { promoted = true; },
  }, async ({ heartbeat }) => {
    writeFileSync(join(dir, 'artifacts', 'proof.txt'), 'ok');
    heartbeat({ phase: 'execute' });
    return { verdict: 'pass', attempt: { what_tried: 'wrote proof', result: 'ok' } };
  });
  const activity = store.listRecentActivity({ plan_id: plan.id, step_id: step.id, limit: 1 })[0];
  check('supervise heartbeat promoted owned artifact', promoted === true || Number(activity?.artifact_count) > 0);
  check('supervise artifact path closed cleanly', res.outcome === 'success');
  cleanup(store, path);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- crash isolation: one worker throw does not stop others ---
{
  const { store, path } = makeStore('crash-isolation');
  const plan = store.createPlan({ title: 'crash plan' });
  store.addStep(plan.id, { title: 'ok1', context: 'OWNED_PATH: out/1.txt' });
  const bad = store.addStep(plan.id, { title: 'bad', context: 'OWNED_PATH: out/bad.txt' });
  store.addStep(plan.id, { title: 'ok2', context: 'OWNED_PATH: out/2.txt' });
  store.setPlanStatus(plan.id, 'active');
  let finished = 0;
  await runParallelSupervisor(store, {
    plan_id: plan.id,
    max_workers: 3,
    max_attempts_per_step: 1,
    stepRunner: async ({ step }) => {
      if (step.id === bad.id) throw new Error('simulated crash');
      store.recordAttempt(step.id, { what_tried: 'fake', verdict: 'pass' });
      store.setStepStatus(step.id, 'done');
      store.setStepDisposition(step.id, { disposition: 'verified', reason: 'test' });
      finished++;
      return { outcome: 'success' };
    },
  });
  check('crash isolation: other workers still finish', finished === 2);
  check('crashed step returns to retryable pending', store.getStep(bad.id).status === 'pending');
  check('crash leaves no open leases', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
}

// --- bounded stale recovery hook (lease opened + reaped) ---
{
  const { store, path } = makeStore('stale-recovery');
  const plan = store.createPlan({ title: 'stale' });
  const step = store.addStep(plan.id, { title: 'stale step' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({
    plan_id: plan.id, step_id: step.id, executor: 'stale-test', stale_after_ms: 5_000,
  });
  const reaped = store.reapStaleLeases({ now_ms: Date.now() + 10_000, grace_ms: 0 });
  check('bounded stale recovery closes orphan lease', reaped.reaped_count === 1);
  check('stale step returned to pending', store.getStep(step.id).status === 'pending');
  check('no duplicate open leases', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
}

// --- clampMaxWorkers ---
{
  check('clampMaxWorkers defaults invalid to 2', clampMaxWorkers(0) === 2);
  check('clampMaxWorkers caps at 8', clampMaxWorkers(99) === 8);
}

// --- spawn cwd propagation: child writes inside worktree, not repo root ---
{
  const repo = join(tmpdir(), `pl-cwd-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const entry = await pool.allocate({ planId: 1, stepId: 2, runId: 'cwd-test' });
  const fake = join(__dirname, 'fixtures', 'fake-cwd-writer.mjs');
  await spawnFake(fake, entry.cwd);
  check('worker marker written inside worktree', existsSync(join(entry.cwd, '.plan-ledger-worker-marker')));
  check('worker marker absent from integration root', !existsSync(join(repo, '.plan-ledger-worker-marker')));
  await pool.discard(entry);
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- integration: successful worker edits survive in root ---
{
  const repo = join(tmpdir(), `pl-int-ok-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const entry = await pool.allocate({ planId: 3, stepId: 4, runId: 'ok' });
  mkdirSync(join(entry.cwd, 'out'), { recursive: true });
  writeFileSync(join(entry.cwd, 'out', 'result.txt'), 'integrated\n');
  const res = await pool.integrateSuccess(entry, { message: 'plan-ledger step 4' });
  check('integrate returns commit sha', !!res.commit);
  check('integrated file exists in root', existsSync(join(repo, 'out', 'result.txt')));
  check('worktree path removed after integrate', !existsSync(entry.path));
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- two concurrent integrations serialize without losing edits ---
{
  const repo = join(tmpdir(), `pl-int-par-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const e1 = await pool.allocate({ planId: 1, stepId: 10, runId: 'a' });
  const e2 = await pool.allocate({ planId: 1, stepId: 11, runId: 'b' });
  mkdirSync(join(e1.cwd, 'out'), { recursive: true });
  mkdirSync(join(e2.cwd, 'out'), { recursive: true });
  writeFileSync(join(e1.cwd, 'out', 'a.txt'), 'a\n');
  writeFileSync(join(e2.cwd, 'out', 'b.txt'), 'b\n');
  await Promise.all([
    pool.integrateSuccess(e1, { message: 'step 10' }),
    pool.integrateSuccess(e2, { message: 'step 11' }),
  ]);
  check('parallel integrate preserves first edit', existsSync(join(repo, 'out', 'a.txt')));
  check('parallel integrate preserves second edit', existsSync(join(repo, 'out', 'b.txt')));
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- dependent worker sees prerequisite integration on HEAD ---
{
  const repo = join(tmpdir(), `pl-int-dep-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const e1 = await pool.allocate({ planId: 2, stepId: 1, runId: 'dep-a' });
  mkdirSync(join(e1.cwd, 'shared'), { recursive: true });
  writeFileSync(join(e1.cwd, 'shared', 'dep.txt'), 'dep\n');
  await pool.integrateSuccess(e1, { message: 'prerequisite step' });
  const e2 = await pool.allocate({ planId: 2, stepId: 2, runId: 'dep-b' });
  check('dependent worker worktree includes prerequisite commit', existsSync(join(e2.cwd, 'shared', 'dep.txt')));
  await pool.discard(e2);
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- dirty integration root rejects parallel write mode ---
{
  const repo = join(tmpdir(), `pl-dirty-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo, { dirty: true });
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const gate = pool.assertCleanForParallelWrite();
  check('dirty root rejects default parallel write mode', gate.ok === false && /uncommitted/.test(gate.reason || ''));
  const skipPool = createWorktreePool({ repoRoot: repo, skipWorktrees: true });
  check('skip-worktrees bypasses dirty gate', skipPool.assertCleanForParallelWrite().skipped === true);
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- failed worker edits are not integrated ---
{
  const repo = join(tmpdir(), `pl-int-fail-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const entry = await pool.allocate({ planId: 5, stepId: 6, runId: 'fail' });
  writeFileSync(join(entry.cwd, 'orphan.txt'), 'never integrate\n');
  await pool.discard(entry);
  check('failed worker edit absent from root', !existsSync(join(repo, 'orphan.txt')));
  check('failed worker worktree removed', !existsSync(entry.path));
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- artifact baseline advances: unchanged file promoted once ---
{
  const { store, path } = makeStore('artifact-once');
  const plan = store.createPlan({ title: 'artifact once' });
  const step = store.addStep(plan.id, { title: 'once step' });
  store.setPlanStatus(plan.id, 'active');
  const dir = join(tmpdir(), `pl-art-once-${process.pid}`);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const ownership = { exact: [], prefixes: ['artifacts'] };
  let promoted = 0;
  await supervise(store, {
    plan_id: plan.id, step_id: step.id, executor: 'probe-once',
    artifact_cwd: dir, owned_paths: ownership,
    onArtifactsPromoted: () => { promoted++; },
  }, async ({ heartbeat }) => {
    writeFileSync(join(dir, 'artifacts', 'once.txt'), 'x');
    heartbeat({});
    heartbeat({});
    return { verdict: 'pass', attempt: { what_tried: 'probe', result: 'ok' } };
  });
  check('unchanged artifact promoted only once across heartbeats', promoted === 1);
  cleanup(store, path);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- C1 enforce: valid parallel inject pass with completion_payload_v2 ---
{
  const priorGate = process.env.PLAN_LEDGER_COMPLETION_GATE;
  process.env.PLAN_LEDGER_COMPLETION_GATE = 'enforce';
  const { store, path } = makeStore('enforce-inject');
  const repo = join(tmpdir(), `pl-enforce-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const plan = store.createPlan({ title: 'enforce inject' });
  const step = store.addStep(plan.id, {
    title: 'inject pass',
    context: 'OWNED_PATH: out/proof.txt',
    acceptance_criteria: 'REQUIRED_ARTIFACT: out/proof.txt',
  });
  store.setPlanStatus(plan.id, 'active');
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const fakeCli = join(__dirname, 'fixtures', 'fake-integrate-cli.mjs');
  const runInjected = (s, dispatch, hooks = {}) => spawnFake(fakeCli, hooks.cwd).then((out) => {
    const parsed = JSON.parse(out);
    return {
      isError: false,
      result: parsed.result || out,
      cost: parsed.total_cost_usd || 0,
      tin: parsed.usage?.input_tokens || 0,
      tout: parsed.usage?.output_tokens || 0,
      turns: parsed.num_turns || 1,
      model: 'test',
    };
  });
  const stepRunner = createParallelStepRunner({
    store,
    inject: true,
    executorId: 'runner-parallel',
    dispatchPlanForStep: (st) => ({
      policy: { warnings: [], requires_override_reason: false },
      dispatchRole: '',
      roleResolution: { mode: 'local' },
      requestedModel: '',
    }),
    runInjected,
    runAgent: async () => null,
    budgetOrLimitStop: () => false,
    usage: { cost: 0, in: 0, out: 0, turns: 0, agents: 0 },
    cursorModelCatalog: { models: [] },
    worktreePool: pool,
    checkPortReady: async () => true,
  });
  await runParallelSupervisor(store, {
    plan_id: plan.id,
    max_workers: 1,
    stepRunner,
  });
  const finalStep = store.getStep(step.id);
  check('enforce inject pass succeeds atomically', finalStep.status === 'done' && finalStep.verification_disposition === 'verified');
  check('enforce inject persists completion_payload_v2', finalStep.completion_payload_present === true && finalStep.completion_payload?.contract_version === 2);
  check('integrated artifact lands in root repo', existsSync(join(repo, 'out', 'proof.txt')));
  check('no open leases after enforce inject pass', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
  if (priorGate == null) delete process.env.PLAN_LEDGER_COMPLETION_GATE; else process.env.PLAN_LEDGER_COMPLETION_GATE = priorGate;
}

// --- C1 enforce: missing evidence fails closed ---
{
  const priorGate = process.env.PLAN_LEDGER_COMPLETION_GATE;
  process.env.PLAN_LEDGER_COMPLETION_GATE = 'enforce';
  const { store, path } = makeStore('enforce-fail');
  const plan = store.createPlan({ title: 'enforce fail' });
  const step = store.addStep(plan.id, { title: 'missing payload step' });
  store.setPlanStatus(plan.id, 'active');
  const opened = store.openExecutionLease({ plan_id: plan.id, step_id: step.id, executor: 'enforce-fail' });
  let rejected = false;
  try {
    store.closeExecutionLease(opened.lease.id, {
      outcome: 'success',
      step_verdict: 'pass',
      attempt: { what_tried: 'no payload', result: 'bad', verdict: 'pass', executor: 'enforce-fail' },
    });
  } catch (e) {
    rejected = /completion_gate_rejected/.test(String(e.message || ''));
  }
  check('enforce mode rejects pass without completion_payload', rejected === true);
  check('reject keeps lease open', store.getExecutionLease(opened.lease.id).status === 'open');
  cleanup(store, path);
  if (priorGate == null) delete process.env.PLAN_LEDGER_COMPLETION_GATE; else process.env.PLAN_LEDGER_COMPLETION_GATE = priorGate;
}

// --- buildCompletionPayloadV2 shape ---
{
  const payload = buildCompletionPayloadV2({
    evaluated: {
      verdict: 'pass',
      checked_artifacts: [{ path: 'out/x.txt', exists: true }],
      checked_commands: [{ command: 'echo ok', exit_code: 0, ok: true, tail: 'ok' }],
      unresolved_gaps: [],
    },
    outcome: 'success',
  });
  check('buildCompletionPayloadV2 includes artifacts and commands', payload.contract_version === 2 && payload.artifacts.length === 1 && payload.commands.length === 1);
}

// --- supervise forwards top-level completion_payload ---
{
  const { store, path } = makeStore('top-level-payload');
  const plan = store.createPlan({ title: 'top payload' });
  const step = store.addStep(plan.id, { title: 'payload step' });
  store.setPlanStatus(plan.id, 'active');
  const payload = {
    contract_version: 2,
    outcome: 'success',
    artifacts: [{ path: 'docs/a.json', kind: 'file', note: '' }],
    commands: [{ command: 'echo ok', exit_code: 0, output_redacted: true }],
    limitations: [],
  };
  await supervise(store, {
    plan_id: plan.id, step_id: step.id, executor: 'payload-top',
  }, async () => ({
    verdict: 'pass',
    step_verdict: 'pass',
    completion_payload: payload,
    attempt: { what_tried: 'ok', result: 'ok', verdict: 'pass', executor: 'payload-top' },
  }));
  const finalStep = store.getStep(step.id);
  check('supervise top-level completion_payload persisted', finalStep.completion_payload_present === true && finalStep.completion_payload.contract_version === 2);
  cleanup(store, path);
}

// --- child PID wired into open lease via heartbeat ---
{
  const { store, path } = makeStore('child-pid');
  const plan = store.createPlan({ title: 'child pid' });
  const step = store.addStep(plan.id, { title: 'pid step' });
  store.setPlanStatus(plan.id, 'active');
  const fakeHold = join(__dirname, 'fixtures', 'fake-pid-hold.mjs');
  let seenPid = null;
  const supPromise = supervise(store, {
    plan_id: plan.id, step_id: step.id, executor: 'pid-test', heartbeat_ms: 1000,
  }, async ({ heartbeat }) => {
    const child = spawn(process.execPath, [fakeHold], { stdio: ['ignore', 'pipe', 'inherit'] });
    heartbeat({ child_pid: child.pid });
    seenPid = child.pid;
    const beat = store.listExecutionLeases({ plan_id: plan.id, status: 'open' })[0];
    check('open lease records spawned child pid', Number(beat?.child_pid) === Number(child.pid));
    await new Promise((resolve) => child.on('close', resolve));
    return { verdict: 'pass', attempt: { what_tried: 'pid test', result: 'ok', verdict: 'pass', executor: 'pid-test' } };
  });
  const sup = await supPromise;
  check('child pid supervise closes cleanly', sup.outcome === 'success' && seenPid != null);
  check('child pid test leaves no open lease', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
}

// --- child exit before terminal closes lease (no open lease left) ---
{
  const { store, path } = makeStore('child-crash');
  const plan = store.createPlan({ title: 'child crash' });
  const step = store.addStep(plan.id, { title: 'crash step' });
  store.setPlanStatus(plan.id, 'active');
  const sup = await supervise(store, {
    plan_id: plan.id, step_id: step.id, executor: 'child-crash', heartbeat_ms: 1000,
  }, async ({ heartbeat }) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    heartbeat({ child_pid: child.pid });
    await sleep(1200);
    return { verdict: 'pass', attempt: { what_tried: 'should cancel', result: 'x', verdict: 'pass' } };
  });
  check('child exit yields cancelled supervise outcome', sup.cancelled === true || sup.outcome === 'cancelled');
  check('child crash leaves no open lease', store.listExecutionLeases({ plan_id: plan.id, status: 'open' }).length === 0);
  cleanup(store, path);
}

// --- integration failure before lease success terminal close ---
{
  const { store, path } = makeStore('integrate-fail-close');
  const repo = join(tmpdir(), `pl-int-fail-close-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const plan = store.createPlan({ title: 'integrate fail close' });
  const step = store.addStep(plan.id, {
    title: 'forced integrate fail',
    context: 'OWNED_PATH: out/proof.txt',
    acceptance_criteria: 'REQUIRED_ARTIFACT: out/proof.txt',
  });
  store.setPlanStatus(plan.id, 'active');
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  pool.integrateSuccess = async (entry, opts) => {
    throw new IntegrationError('forced integration failure before terminal close', {
      branch: entry.branch,
      recoverable: true,
    });
  };
  const fakeCli = join(__dirname, 'fixtures', 'fake-integrate-cli.mjs');
  const runInjected = (s, d, hooks = {}) => spawnFake(fakeCli, hooks.cwd).then((out) => {
    const parsed = JSON.parse(out);
    return { isError: false, result: parsed.result, cost: 0, tin: 0, tout: 0, turns: 1, model: 'test' };
  });
  const stepRunner = createParallelStepRunner({
    store, inject: true, executorId: 'runner-parallel',
    dispatchPlanForStep: () => ({ policy: { warnings: [], requires_override_reason: false }, dispatchRole: '', roleResolution: { mode: 'local' }, requestedModel: '' }),
    runInjected, runAgent: async () => null, budgetOrLimitStop: () => false,
    usage: { cost: 0, in: 0, out: 0, turns: 0, agents: 0 }, cursorModelCatalog: { models: [] },
    worktreePool: pool, checkPortReady: async () => true,
  });
  await runParallelSupervisor(store, { plan_id: plan.id, max_workers: 1, max_attempts_per_step: 1, stepRunner });
  const finalStep = store.getStep(step.id);
  const closedLease = store.db.prepare('SELECT * FROM execution_leases WHERE step_id=? ORDER BY id DESC LIMIT 1').get(step.id);
  const activity = store.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true, limit: 1 })[0];
  const terminalEvents = (activity?.events || []).filter((ev) => ev.event_type === 'terminal');
  const completionEvents = (activity?.events || []).filter((ev) => ev.event_type === 'completion');
  check('integration failure closes lease as failed', closedLease?.outcome === 'failed');
  check('integration failure leaves step failed not done', finalStep.status === 'failed');
  check('integration failure emits execution_failure not completion', completionEvents.length === 0 && terminalEvents.length >= 1);
  cleanup(store, path);
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- MCP path: integration failure before lease success terminal close ---
{
  const { store, path } = makeStore('integrate-fail-mcp');
  const repo = join(tmpdir(), `pl-int-fail-mcp-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const plan = store.createPlan({ title: 'integrate fail mcp' });
  const step = store.addStep(plan.id, {
    title: 'mcp forced integrate fail',
    context: 'OWNED_PATH: out/mcp-proof.txt',
    acceptance_criteria: 'REQUIRED_ARTIFACT: out/mcp-proof.txt',
  });
  store.setPlanStatus(plan.id, 'active');
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  pool.integrateSuccess = async (entry) => {
    throw new IntegrationError('forced MCP integration failure before terminal close', {
      branch: entry.branch,
      recoverable: true,
    });
  };
  const runAgent = async (s, dispatch, hooks = {}) => {
    const cwd = hooks.cwd || process.cwd();
    mkdirSync(join(cwd, 'out'), { recursive: true });
    writeFileSync(join(cwd, 'out/mcp-proof.txt'), 'mcp-proof', 'utf8');
    store.recordAttempt(s.id, {
      what_tried: 'mcp agent pass',
      result: 'done via mcp',
      verdict: 'pass',
      executor: 'runner-parallel',
      completion_payload: {
        contract_version: 2,
        outcome: 'success',
        artifacts: [{ path: 'out/mcp-proof.txt', kind: 'file', note: '' }],
        commands: [],
        limitations: [],
      },
    });
    return { cost: 0, tin: 0, tout: 0, turns: 1, model: 'test' };
  };
  const stepRunner = createParallelStepRunner({
    store, inject: false, executorId: 'runner-parallel',
    dispatchPlanForStep: () => ({ policy: { warnings: [], requires_override_reason: false }, dispatchRole: '', roleResolution: { mode: 'local' }, requestedModel: '' }),
    runInjected: async () => null, runAgent, budgetOrLimitStop: () => false,
    usage: { cost: 0, in: 0, out: 0, turns: 0, agents: 0 }, cursorModelCatalog: { models: [] },
    worktreePool: pool, checkPortReady: async () => true,
  });
  await runParallelSupervisor(store, { plan_id: plan.id, max_workers: 1, max_attempts_per_step: 1, stepRunner });
  const finalStep = store.getStep(step.id);
  const closedLease = store.db.prepare('SELECT * FROM execution_leases WHERE step_id=? ORDER BY id DESC LIMIT 1').get(step.id);
  const activity = store.listRecentActivity({ plan_id: plan.id, step_id: step.id, include_events: true, limit: 1 })[0];
  const lifecycleTerminal = (activity?.events || []).filter((ev) => ev.event_type === 'completion' || ev.event_type === 'execution_failure');
  const lastLifecycle = lifecycleTerminal[lifecycleTerminal.length - 1];
  check('MCP integration failure closes lease as failed', closedLease?.outcome === 'failed');
  check('MCP integration failure leaves step failed not done', finalStep.status === 'failed');
  check('MCP lease terminal lifecycle is execution_failure not completion', lastLifecycle?.event_type === 'execution_failure');
  cleanup(store, path);
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- cherry-pick conflict fails closed with recoverable branch metadata ---
{
  const repo = join(tmpdir(), `pl-cherry-conflict-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  mkdirSync(join(repo, 'shared'), { recursive: true });
  writeFileSync(join(repo, 'shared/conflict.txt'), 'line1\nline2-root\nline3\n');
  execFileSync('git', ['add', 'shared/conflict.txt'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'root conflict base'], { cwd: repo, stdio: 'ignore' });
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const entry = await pool.allocate({ planId: 7, stepId: 8, runId: 'conflict-run' });
  writeFileSync(join(entry.cwd, 'shared/conflict.txt'), 'line1\nline2-worker\nline3\n');
  writeFileSync(join(repo, 'shared/conflict.txt'), 'line1\nline2-root-changed\nline3\n');
  execFileSync('git', ['add', 'shared/conflict.txt'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'root diverges before integrate'], { cwd: repo, stdio: 'ignore' });
  let conflictErr = null;
  try {
    await pool.integrateSuccess(entry, { message: 'conflicting worker commit' });
  } catch (err) {
    conflictErr = err;
  }
  check('cherry-pick conflict throws IntegrationError', conflictErr != null && conflictErr.name === 'IntegrationError');
  check('cherry-pick conflict preserves recoverable branch metadata', !!conflictErr?.details?.branch);
  let cherryPickActive = false;
  try {
    execFileSync('git', ['rev-parse', '-q', 'CHERRY_PICK_HEAD'], { cwd: repo, stdio: 'ignore' });
    cherryPickActive = true;
  } catch {}
  check('cherry-pick HEAD aborted (integration root clean)', cherryPickActive === false);
  check('integration root content unchanged after conflict', normalizeLf(readFileSync(join(repo, 'shared/conflict.txt'), 'utf8')) === 'line1\nline2-root-changed\nline3\n');
  const branches = execFileSync('git', ['branch', '--list', 'plan-ledger/wt/*'], { cwd: repo, encoding: 'utf8' });
  check('recoverable temp branch still exists after failed integrate', branches.includes(entry.branch));
  check('failed integrate does not land worker line in root', !normalizeLf(readFileSync(join(repo, 'shared/conflict.txt'), 'utf8')).includes('line2-worker'));
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

// --- orphan cleanup removes temporary branch ---
{
  const repo = join(tmpdir(), `pl-orphan-branch-${process.pid}-${Date.now().toString(36)}`);
  initGitRepo(repo);
  const pool = createWorktreePool({ repoRoot: repo, worktreeBase: join(repo, '.wt') });
  const entry = await pool.allocate({ planId: 3, stepId: 4, runId: 'orphan-branch' });
  const branch = entry.branch;
  check('orphan worktree exists before cleanup', existsSync(entry.path));
  pool.cleanupOrphans({ openLeases: [] });
  check('orphan cleanup removes worktree path', !existsSync(entry.path));
  const after = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf8' });
  check('orphan cleanup removes temporary branch', !after.includes(branch));
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
}

console.log(`\nparallel-supervisor regression OK (${pass} checks)\n`);
