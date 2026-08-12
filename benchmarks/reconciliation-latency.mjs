// reconciliation-latency.mjs — focused C2 local benchmark.
// Run: node benchmarks/reconciliation-latency.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';

const ITERATIONS = 120; // >= 100 measured reconciliation operations
const STEPS = 100;
const prevMode = process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
process.env.PLAN_LEDGER_AUTO_TERMINALIZE = 'enforce';

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};
const round3 = (n) => Math.round(n * 1000) / 1000;

const dbPath = join(tmpdir(), `plan-ledger-reconcile-bench-${process.pid}-${Date.now().toString(36)}.db`);
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

const store = new Store(dbPath);
try {
  const plan = store.createPlan({ title: 'reconciliation benchmark plan', keywords: ['bench', 'reconcile'] });
  const stepIds = [];
  for (let i = 0; i < STEPS; i++) {
    const s = store.addStep(plan.id, { title: `benchmark step ${i + 1}` });
    stepIds.push(s.id);
  }
  store.setPlanStatus(plan.id, 'active');
  // Seed a contradiction fixture once: all terminal + verified while plan is active.
  for (const id of stepIds) {
    store.recordAttempt(id, { what_tried: `seed-${id}`, verdict: 'pass' }, { reconcile: false });
  }
  store.setPlanStatus(plan.id, 'active');

  // Warm once (untimed) with the same setup shape used in timed samples.
  store.setPlanStatus(plan.id, 'active');
  store.reconcilePlanTerminalState(plan.id, { source: 'benchmark:warmup', strict: true });
  const samples = [];
  const mutationChecks = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Setup/reset OUTSIDE the timer: recreate an eligible active contradiction.
    store.setPlanStatus(plan.id, 'active');
    const t0 = process.hrtime.bigint();
    const reconcile = store.reconcilePlanTerminalState(plan.id, { source: 'benchmark', strict: true });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    samples.push(elapsedMs);
    mutationChecks.push(reconcile.mutated === true && reconcile.plan_status === 'done');
  }

  const p95 = percentile(samples, 95);
  const p50 = percentile(samples, 50);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const out = {
    benchmark: 'c2_reconcile_plan_terminal_state',
    mode: process.env.PLAN_LEDGER_AUTO_TERMINALIZE,
    measured_operations: samples.length,
    plan_steps: STEPS,
    measured_path: 'eligible_active_to_done_mutation_each_sample',
    all_samples_mutated: mutationChecks.every(Boolean),
    stats_ms: {
      min: round3(Math.min(...samples)),
      p50: round3(p50),
      p95: round3(p95),
      mean: round3(mean),
      max: round3(Math.max(...samples)),
    },
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.all_samples_mutated) {
    console.error('[bench] FAIL: at least one timed sample did not perform an active->done reconciliation mutation');
    process.exitCode = 1;
  }
  if (p95 > 5) {
    console.error(`[bench] FAIL: p95 ${round3(p95)}ms exceeds 5ms budget`);
    process.exitCode = 1;
  }
} finally {
  try { store.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  if (prevMode == null) delete process.env.PLAN_LEDGER_AUTO_TERMINALIZE;
  else process.env.PLAN_LEDGER_AUTO_TERMINALIZE = prevMode;
}
