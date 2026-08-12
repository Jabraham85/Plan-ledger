// parallel-supervisor.mjs — bounded continuous-refill parallel step dispatch.

import { PathLockRegistry, parseStepOwnership, selectNonConflictingSteps } from './path-ownership.mjs';

const DEFAULT_MAX_WORKERS = 2;
const MAX_WORKERS_CAP = 8;

function releaseClaimedStep(store, stepId, reason = 'parallel worker crashed') {
  try {
    const open = store.listExecutionLeases({ step_id: stepId, status: 'open' });
    for (const lease of open) {
      store.closeExecutionLease(lease.id, {
        outcome: 'abandoned',
        close_reason: reason,
        terminal_summary: reason,
        terminal_phase: 'execute',
      });
    }
  } catch {}
  try {
    const st = store.getStep(stepId);
    if (st.status === 'in_progress') store.setStepStatus(stepId, 'pending');
  } catch {}
}

export function clampMaxWorkers(n, cap = MAX_WORKERS_CAP) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_MAX_WORKERS;
  return Math.min(cap, Math.max(1, Math.floor(v)));
}

export async function runParallelSupervisor(store, {
  plan_id,
  max_workers = DEFAULT_MAX_WORKERS,
  max_workers_cap = MAX_WORKERS_CAP,
  executor = 'runner-parallel',
  max_steps = Infinity,
  max_attempts_per_step = Infinity,
  stepRunner,
  shouldStop = () => false,
  shouldPause = () => false,
  peekReady = (s, pid) => s.readySteps(pid, { claim: false }),
  claimStepFn = (s, stepId, exec) => s.claimStep(stepId, { executor: exec }),
  onSlotStart = () => {},
  onSlotEnd = () => {},
  onRefillBlocked = () => {},
  logger = () => {},
} = {}) {
  if (!store || !plan_id) throw new Error('runParallelSupervisor: store and plan_id are required');
  if (typeof stepRunner !== 'function') throw new Error('runParallelSupervisor: stepRunner is required');

  const workerLimit = clampMaxWorkers(max_workers, max_workers_cap);
  const pathLocks = new PathLockRegistry();
  const active = new Map(); // stepId -> Promise
  const attemptCounts = new Map();
  let stopRefilling = false;
  let paused = false;
  let stepsStarted = 0;
  let stepsFinished = 0;
  let lastError = null;
  const results = [];

  const log = (msg) => { try { logger(msg); } catch {} };

  function remainingReadyCount() {
    try {
      return (peekReady(store, plan_id) || []).length;
    } catch {
      return 0;
    }
  }

  async function dispatchOne(step) {
    const ownership = parseStepOwnership(step);
    if (pathLocks.conflictsWithActive(ownership)) return false;

    const claim = claimStepFn(store, step.id, executor);
    if (!claim?.claimed) return false;

    pathLocks.acquire(step.id, ownership);
    stepsStarted++;
    attemptCounts.set(step.id, (attemptCounts.get(step.id) || 0) + 1);
    onSlotStart({ step, ownership, active_count: active.size + 1 });

    const runPromise = (async () => {
      try {
        const result = await stepRunner({
          step,
          ownership,
          executor,
          releasePathLock: () => pathLocks.release(step.id),
        });
        results.push({ step_id: step.id, ok: true, result });
        return result;
      } catch (err) {
        lastError = err;
        results.push({ step_id: step.id, ok: false, error: err });
        releaseClaimedStep(store, step.id, err?.message || 'parallel worker crashed');
      } finally {
        pathLocks.release(step.id);
        stepsFinished++;
        active.delete(step.id);
        onSlotEnd({ step_id: step.id, active_count: active.size });
        if (!stopRefilling && !shouldStop() && stepsStarted < max_steps) {
          await fillSlots();
        }
      }
    })();

    active.set(step.id, runPromise);
    return true;
  }

  async function fillSlots() {
    if (stopRefilling || shouldStop()) {
      stopRefilling = true;
      return 0;
    }
    if (shouldPause()) {
      paused = true;
      stopRefilling = true;
      return 0;
    }
    if (stepsStarted >= max_steps) {
      stopRefilling = true;
      return 0;
    }

    let filled = 0;
    while (active.size < workerLimit && stepsStarted < max_steps && !stopRefilling) {
      const ready = (peekReady(store, plan_id) || []).filter((step) => {
        const n = attemptCounts.get(step.id) || 0;
        return n < max_attempts_per_step;
      });
      if (!ready.length) break;

      const slotsLeft = Math.min(workerLimit - active.size, max_steps - stepsStarted);
      const batch = selectNonConflictingSteps(ready, pathLocks, { max: slotsLeft });
      if (!batch.length) {
        onRefillBlocked({ ready_count: ready.length, active_count: active.size });
        break;
      }

      let dispatched = false;
      for (const step of batch) {
        if (active.size >= workerLimit || stepsStarted >= max_steps) break;
        // eslint-disable-next-line no-await-in-loop
        const ok = await dispatchOne(step);
        if (ok) {
          filled++;
          dispatched = true;
        }
      }
      if (!dispatched) break;
    }
    return filled;
  }

  await fillSlots();

  while (active.size > 0) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.race([...active.values()]);
  }

  const readyLeft = remainingReadyCount();
  const inProgressLeft = store.db.prepare(
    "SELECT COUNT(*) c FROM steps WHERE plan_id=? AND status='in_progress'",
  ).get(plan_id)?.c ?? 0;

  let status = 'complete';
  if (stopRefilling && shouldStop()) status = 'paused';
  else if (paused || (readyLeft > 0 && inProgressLeft === 0 && stepsStarted >= max_steps)) status = 'paused';
  else if (readyLeft > 0 || inProgressLeft > 0) status = 'busy';

  return {
    status,
    worker_limit: workerLimit,
    steps_started: stepsStarted,
    steps_finished: stepsFinished,
    results,
    stop_refilling: stopRefilling,
    paused,
    last_error: lastError,
    ready_remaining: readyLeft,
  };
}
