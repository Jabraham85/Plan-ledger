#!/usr/bin/env node
// c3-dispatch-recovery.mjs — local C3 benchmark for dispatch policy + lease ops.
import { performance } from 'node:perf_hooks';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';
import { evaluateDispatchPolicy } from '../src/dispatch-policy.mjs';

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const pick = (p) => sorted[Math.max(0, Math.min(n - 1, Math.ceil((p / 100) * n) - 1))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    min: sorted[0],
    p50: pick(50),
    p95: pick(95),
    max: sorted[n - 1],
    mean: sum / n,
  };
}

function round(v) { return Math.round(v * 1000) / 1000; }

function measureLeaseCycle(store, plan, {
  executor = 'bench-c3',
  dispatch_policy = null,
  lease_policy = null,
} = {}) {
  const step = store.addStep(plan.id, {
    title: 'Lease bench step',
    context: 'Implementation work.',
    acceptance_criteria: 'done',
    role: 'implementer',
  });
  const tOpen = performance.now();
  const opened = store.openExecutionLease({
    plan_id: plan.id,
    step_id: step.id,
    executor,
    dispatch_policy,
    lease_policy,
  });
  const openMs = performance.now() - tOpen;

  const tBeat = performance.now();
  store.heartbeatExecutionLease(opened.lease.id, { phase: 'execute', action_summary: 'bench heartbeat' });
  const heartbeatMs = performance.now() - tBeat;

  const tClose = performance.now();
  store.closeExecutionLease(opened.lease.id, { outcome: 'success', terminal_summary: 'bench close' });
  const closeMs = performance.now() - tClose;
  return { openMs, heartbeatMs, closeMs };
}

const policySamples = 1000;
const leaseSamples = 60;
const leaseWarmupSamples = 20;
const diskObservationSamples = 20;
const dbPath = join(tmpdir(), `plan-ledger-c3-bench-${process.pid}.db`);
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });

// Gate deterministic store/SQL overhead independently from filesystem fsync
// jitter. A separate WAL-backed observation below keeps real disk latency visible.
const store = new Store(':memory:');
const plan = store.createPlan({ title: 'C3 benchmark plan' });
store.setPlanStatus(plan.id, 'active');

const leaseArgs = {
  dispatch_policy: {
    task_modality: 'implementation',
    required_artifact_type: 'code_patch',
    preferred_role: 'implementer',
    fallback_roles: ['implementer', 'debugger'],
  },
  lease_policy: {
    first_artifact_deadline_ms: 60000,
    heartbeat_interval_ms: 20000,
    stale_after_ms: 120000,
    max_auto_reassignments: 1,
  },
};

// Warm SQLite/page cache and JIT the lease path before measured samples.
for (let i = 0; i < leaseWarmupSamples; i++) {
  measureLeaseCycle(store, plan, leaseArgs);
}

const openValues = [];
const heartbeatValues = [];
const closeValues = [];
for (let i = 0; i < leaseSamples; i++) {
  // Measured samples use a one-step plan so close-path reconciliation stays O(1).
  const measurePlan = store.createPlan({ title: `C3 lease measure ${i + 1}` });
  store.setPlanStatus(measurePlan.id, 'active');
  const sample = measureLeaseCycle(store, measurePlan, leaseArgs);
  openValues.push(sample.openMs);
  heartbeatValues.push(sample.heartbeatMs);
  closeValues.push(sample.closeMs);
}

const openStat = stats(openValues);
const heartbeatStat = stats(heartbeatValues);
const closeStat = stats(closeValues);

const diskObservation = (() => {
  const diskStore = new Store(dbPath);
  const values = { open: [], heartbeat: [], close: [] };
  for (let i = 0; i < diskObservationSamples; i++) {
    const diskPlan = diskStore.createPlan({ title: `C3 disk observation ${i + 1}` });
    diskStore.setPlanStatus(diskPlan.id, 'active');
    const sample = measureLeaseCycle(diskStore, diskPlan, leaseArgs);
    values.open.push(sample.openMs);
    values.heartbeat.push(sample.heartbeatMs);
    values.close.push(sample.closeMs);
  }
  diskStore.close();
  return {
    samples: diskObservationSamples,
    note: 'Observed WAL-backed wall time; reported separately because fsync scheduling is environmental.',
    execution_lease_open: stats(values.open),
    execution_lease_heartbeat: stats(values.heartbeat),
    execution_lease_close: stats(values.close),
  };
})();

const policyStat = (() => {
  const ms = [];
  for (let i = 0; i < policySamples; i++) {
    const t0 = performance.now();
    evaluateDispatchPolicy({
      step: {
        title: `Implement C3 case ${i}`,
        context: 'Apply implementation patch and update deterministic tests.',
        acceptance_criteria: 'Code patch and test report pass.',
        role: i % 2 === 0 ? 'architect' : 'implementer',
        dispatch_policy: leaseArgs.dispatch_policy,
      },
      explicit_role: i % 2 === 0 ? 'architect' : 'implementer',
      resolved_model: 'gpt-5.3-codex',
      available_models: ['gpt-5.3-codex', 'claude-sonnet-5-thinking-high'],
      override_reason: i % 2 === 0 ? `benchmark override ${i}` : '',
    });
    ms.push(performance.now() - t0);
  }
  return stats(ms);
})();

store.close();
for (const suf of ['', '-wal', '-shm']) rmSync(dbPath + suf, { force: true });

const result = {
  benchmark: 'c3-dispatch-recovery',
  storage_mode: 'in_memory_deterministic_gate',
  policy_evaluation: Object.fromEntries(Object.entries(policyStat).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
  execution_lease_open: Object.fromEntries(Object.entries(openStat).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
  execution_lease_heartbeat: Object.fromEntries(Object.entries(heartbeatStat).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
  execution_lease_close: Object.fromEntries(Object.entries(closeStat).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
  disk_observation: Object.fromEntries(Object.entries(diskObservation).map(([key, value]) => [
    key,
    value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]))
      : value,
  ])),
  warmup: { lease_cycles: leaseWarmupSamples },
  budgets: {
    policy_eval_p95_max_ms: 1,
    lease_operation_p95_max_ms: 2.5,
  },
};

const failures = [];
if (policyStat.n !== policySamples) failures.push(`policy sample count mismatch (${policyStat.n}/${policySamples})`);
if (openStat.n !== leaseSamples || heartbeatStat.n !== leaseSamples || closeStat.n !== leaseSamples) {
  failures.push(`lease sample count mismatch (open=${openStat.n}, heartbeat=${heartbeatStat.n}, close=${closeStat.n}; expected ${leaseSamples})`);
}
if (policyStat.p95 > 1) failures.push(`policy evaluation p95 ${round(policyStat.p95)}ms exceeds 1ms`);
if (openStat.p95 > 2.5) failures.push(`execution lease open p95 ${round(openStat.p95)}ms exceeds 2.5ms`);
if (heartbeatStat.p95 > 2.5) failures.push(`execution lease heartbeat p95 ${round(heartbeatStat.p95)}ms exceeds 2.5ms`);
if (closeStat.p95 > 2.5) failures.push(`execution lease close p95 ${round(closeStat.p95)}ms exceeds 2.5ms`);

console.log(JSON.stringify(result, null, 2));
if (failures.length) {
  for (const failure of failures) console.error(`[c3-benchmark] ${failure}`);
  process.exit(1);
}
