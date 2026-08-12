/**
 * Renewable resource-constrained job scheduler.
 * @param {{ resources: number[], jobs: Array<{ id: string, duration: number, demand: number[], deps: string[] }> }} instance
 * @returns {Array<{ id: string, start: number }>}
 */
export function solve(instance) {
  const resources = instance.resources;
  const jobs = instance.jobs;
  const n = jobs.length;

  if (n === 0) return [];

  const graph = buildGraph(jobs);
  const topoOrder = kahnTopologicalOrder(jobs, graph.predecessors, graph.successors);
  const meta = computeMetadata(jobs, graph, topoOrder, resources);
  const guards = computeGuards(meta, n);

  const fallback = buildFallbackSchedule(graph, resources, topoOrder, meta.horizonSafe, guards);
  let best = fallback;
  let bestMakespan = makespanFromMap(best, graph.jobById);

  if (guards.runEnsemble) {
    const rules = buildPriorityRules(meta, guards.ensembleRuleCount);
    for (const compareReady of rules) {
      const candidate = serialScheduleGeneration(
        graph,
        resources,
        topoOrder,
        meta.horizonSafe,
        compareReady,
        guards,
      );
      if (!candidate) continue;

      const compacted = guards.runCompaction
        ? compactSchedule(candidate, graph, resources, meta.horizonSafe, guards)
        : candidate;

      const ms = makespanFromMap(compacted, graph.jobById);
      if (ms < bestMakespan || (ms === bestMakespan && lexLessSchedule(compacted, best, jobs))) {
        bestMakespan = ms;
        best = compacted;
      }
    }
  }

  return jobs.map((job) => ({ id: job.id, start: best.get(job.id) }));
}

/** @param {Array<{ id: string, duration: number, demand: number[], deps: string[] }>} jobs */
function buildGraph(jobs) {
  /** @type {Map<string, { id: string, duration: number, demand: number[], deps: string[] }>} */
  const jobById = new Map();
  /** @type {Map<string, string[]>} */
  const predecessors = new Map();
  /** @type {Map<string, string[]>} */
  const successors = new Map();

  for (const job of jobs) {
    jobById.set(job.id, job);
    predecessors.set(job.id, [...job.deps].sort());
    successors.set(job.id, []);
  }

  for (const job of jobs) {
    for (const dep of job.deps) {
      successors.get(dep).push(job.id);
    }
  }

  for (const job of jobs) {
    successors.get(job.id).sort();
  }

  return { jobById, predecessors, successors };
}

function kahnTopologicalOrder(jobs, predecessors, successors) {
  const inDegree = new Map();
  for (const job of jobs) {
    inDegree.set(job.id, predecessors.get(job.id).length);
  }

  /** @type {string[]} */
  const ready = [];
  for (const job of jobs) {
    if (inDegree.get(job.id) === 0) ready.push(job.id);
  }
  ready.sort();

  /** @type {string[]} */
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);

    for (const succ of successors.get(id)) {
      const next = inDegree.get(succ) - 1;
      inDegree.set(succ, next);
      if (next === 0) insertSortedById(ready, succ);
    }
  }

  return order;
}

/** @param {string[]} list */
function insertSortedById(list, id) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] < id) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, id);
}

/** @param {string[]} ready @param {(a: string, b: string) => number} compareReady */
function insertSortedByCompare(ready, id, compareReady) {
  let lo = 0;
  let hi = ready.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareReady(ready[mid], id) < 0) lo = mid + 1;
    else hi = mid;
  }
  ready.splice(lo, 0, id);
}

function computeMetadata(jobs, graph, topoOrder, resources) {
  const { jobById, predecessors, successors } = graph;

  /** @type {Map<string, number>} */
  const est = new Map();
  for (const id of topoOrder) {
    let earliest = 0;
    for (const pred of predecessors.get(id)) {
      earliest = Math.max(earliest, est.get(pred) + jobById.get(pred).duration);
    }
    est.set(id, earliest);
  }

  /** @type {Map<string, number>} */
  const cpRemainder = new Map();
  const revTopo = [...topoOrder].reverse();
  for (const id of revTopo) {
    const duration = jobById.get(id).duration;
    const succs = successors.get(id);
    if (succs.length === 0) {
      cpRemainder.set(id, duration);
    } else {
      let tail = 0;
      for (const succ of succs) {
        tail = Math.max(tail, cpRemainder.get(succ));
      }
      cpRemainder.set(id, duration + tail);
    }
  }

  const cpLength = Math.max(...[...cpRemainder.values()]);

  let resourceWorkLB = 0;
  for (let r = 0; r < resources.length; r++) {
    let work = 0;
    for (const job of jobs) {
      work += job.duration * job.demand[r];
    }
    resourceWorkLB = Math.max(resourceWorkLB, Math.ceil(work / resources[r]));
  }

  const lb = Math.max(cpLength, resourceWorkLB);
  const sumDurations = jobs.reduce((sum, job) => sum + job.duration, 0);
  const horizonSafe = sumDurations;

  /** @type {Map<string, number>} */
  const lst = new Map();
  /** @type {Map<string, number>} */
  const lft = new Map();
  for (const id of revTopo) {
    const duration = jobById.get(id).duration;
    const succs = successors.get(id);
    if (succs.length === 0) {
      lft.set(id, lb);
    } else {
      let minLst = Infinity;
      for (const succ of succs) {
        minLst = Math.min(minLst, lst.get(succ));
      }
      lft.set(id, minLst);
    }
    lst.set(id, lft.get(id) - duration);
  }

  /** @type {Map<string, number>} */
  const slack = new Map();
  for (const id of topoOrder) {
    slack.set(id, lst.get(id) - est.get(id));
  }

  /** @type {Map<string, { maxRatio: number, sumRatio: number }>} */
  const loadScore = new Map();
  for (const job of jobs) {
    let maxRatio = 0;
    let sumRatio = 0;
    for (let r = 0; r < resources.length; r++) {
      const cap = resources[r];
      const ratio = cap > 0 ? job.demand[r] / cap : 0;
      maxRatio = Math.max(maxRatio, ratio);
      sumRatio += job.duration * ratio;
    }
    loadScore.set(job.id, { maxRatio, sumRatio });
  }

  return {
    est,
    cpRemainder,
    lft,
    lst,
    slack,
    loadScore,
    lb,
    cpLength,
    resourceWorkLB,
    horizonSafe,
  };
}

function computeGuards(meta, n) {
  const horizon = meta.horizonSafe;
  const HUGE_HORIZON = 50_000;
  const LARGE_HORIZON = 10_000;

  const runEnsemble = horizon <= HUGE_HORIZON;
  const runCompaction = horizon <= LARGE_HORIZON && n <= 500;

  let ensembleRuleCount = 4;
  if (horizon > LARGE_HORIZON) ensembleRuleCount = 2;
  if (horizon > HUGE_HORIZON) ensembleRuleCount = 0;

  const maxCompactionShifts = Math.min(n * 4, 2_000);

  return {
    runEnsemble,
    runCompaction,
    ensembleRuleCount,
    maxCompactionShifts,
  };
}

/**
 * @param {ReturnType<typeof computeMetadata>} meta
 * @param {number} count
 * @returns {Array<(a: string, b: string) => number>}
 */
function buildPriorityRules(meta, count) {
  /** @type {Array<(a: string, b: string) => number>} */
  const rules = [
    (a, b) => {
      const slackA = meta.slack.get(a);
      const slackB = meta.slack.get(b);
      if (slackA !== slackB) return slackA - slackB;
      const lftA = meta.lft.get(a);
      const lftB = meta.lft.get(b);
      if (lftA !== lftB) return lftA - lftB;
      return a.localeCompare(b);
    },
    (a, b) => {
      const cpA = meta.cpRemainder.get(a);
      const cpB = meta.cpRemainder.get(b);
      if (cpA !== cpB) return cpB - cpA;
      return a.localeCompare(b);
    },
    (a, b) => {
      const loadA = meta.loadScore.get(a);
      const loadB = meta.loadScore.get(b);
      if (loadA.maxRatio !== loadB.maxRatio) return loadB.maxRatio - loadA.maxRatio;
      if (loadA.sumRatio !== loadB.sumRatio) return loadB.sumRatio - loadA.sumRatio;
      return a.localeCompare(b);
    },
    (a, b) => {
      const slackA = meta.slack.get(a);
      const slackB = meta.slack.get(b);
      if (slackA !== slackB) return slackA - slackB;
      const cpA = meta.cpRemainder.get(a);
      const cpB = meta.cpRemainder.get(b);
      if (cpA !== cpB) return cpB - cpA;
      const loadA = meta.loadScore.get(a);
      const loadB = meta.loadScore.get(b);
      if (loadA.maxRatio !== loadB.maxRatio) return loadB.maxRatio - loadA.maxRatio;
      return a.localeCompare(b);
    },
  ];

  return rules.slice(0, count);
}

/**
 * @typedef {{ start: number, duration: number, demand: number[] }} ScheduledSlice
 */

/**
 * Renewable usage is piecewise-constant between job start/finish events.
 * @param {ScheduledSlice[]} scheduled
 * @param {number} start
 * @param {number} duration
 * @param {number[]} demand
 * @param {number[]} capacities
 */
function isFeasibleInterval(scheduled, start, duration, demand, capacities) {
  const end = start + duration;
  const resourceCount = capacities.length;

  for (let r = 0; r < resourceCount; r++) {
    if (demand[r] > capacities[r]) return false;
  }

  /** @type {ScheduledSlice[]} */
  const overlapping = [];
  /** @type {number[]} */
  const checkTimes = [start];
  for (const entry of scheduled) {
    const entryStart = entry.start;
    const entryEnd = entryStart + entry.duration;
    if (entryStart >= end || entryEnd <= start) continue;

    overlapping.push(entry);
    if (entryStart > start && entryStart < end) checkTimes.push(entryStart);
    if (entryEnd > start && entryEnd < end) checkTimes.push(entryEnd);
  }
  checkTimes.sort((a, b) => a - b);

  let prev = -1;
  for (const t of checkTimes) {
    if (t === prev) continue;
    prev = t;

    for (let r = 0; r < resourceCount; r++) {
      let usage = demand[r];
      for (const entry of overlapping) {
        if (entry.start <= t && t < entry.start + entry.duration) {
          usage += entry.demand[r];
        }
      }
      if (usage > capacities[r]) return false;
    }
  }

  return true;
}

/**
 * Exhaustive jump-point search within the planning horizon.
 * Renewable usage only changes at job start/finish events, so this visits every
 * earliest-feasible candidate without an attempt cap.
 *
 * @param {ScheduledSlice[]} scheduled
 * @param {number} minStart
 * @param {number} duration
 * @param {number[]} demand
 * @param {number[]} capacities
 * @param {number} horizon
 */
function findEarliestFeasibleStart(scheduled, minStart, duration, demand, capacities, horizon) {
  /** @type {Set<number>} */
  const jumpSet = new Set();
  jumpSet.add(minStart);
  for (const entry of scheduled) {
    if (entry.start >= minStart) jumpSet.add(entry.start);
    const finish = entry.start + entry.duration;
    if (finish >= minStart) jumpSet.add(finish);
  }
  const jumpPoints = [...jumpSet].sort((a, b) => a - b);

  let t = minStart;
  let jumpIdx = 0;

  while (t + duration <= horizon) {
    if (isFeasibleInterval(scheduled, t, duration, demand, capacities)) {
      return t;
    }

    while (jumpIdx < jumpPoints.length && jumpPoints[jumpIdx] <= t) jumpIdx++;
    if (jumpIdx < jumpPoints.length) {
      t = jumpPoints[jumpIdx];
    } else {
      t += 1;
    }
  }

  return null;
}

function minStartFromPredecessors(id, graph, startById) {
  const { jobById, predecessors } = graph;
  let minStart = 0;
  for (const pred of predecessors.get(id)) {
    minStart = Math.max(minStart, startById.get(pred) + jobById.get(pred).duration);
  }
  return minStart;
}

/**
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {number[]} resources
 * @param {string[]} topoOrder
 * @param {number} horizon
 * @param {(a: string, b: string) => number} compareReady
 * @param {ReturnType<typeof computeGuards>} guards
 * @returns {Map<string, number> | null}
 */
function serialScheduleGeneration(graph, resources, topoOrder, horizon, compareReady, guards) {
  const { jobById } = graph;
  const n = topoOrder.length;

  /** @type {Map<string, number>} */
  const startById = new Map();
  /** @type {ScheduledSlice[]} */
  const scheduled = [];

  /** @type {Map<string, number>} */
  const remainingPreds = new Map();
  for (const id of topoOrder) {
    remainingPreds.set(id, graph.predecessors.get(id).length);
  }

  /** @type {string[]} */
  const ready = topoOrder.filter((id) => remainingPreds.get(id) === 0);
  ready.sort(compareReady);

  let placed = 0;
  while (placed < n) {
    if (ready.length === 0) return null;

    const pick = ready.shift();

    const job = jobById.get(pick);
    const minStart = minStartFromPredecessors(pick, graph, startById);
    let start = findEarliestFeasibleStart(
      scheduled,
      minStart,
      job.duration,
      job.demand,
      resources,
      horizon,
    );

    if (start === null) {
      start = guaranteedFeasibleStart(scheduled, minStart, job.duration, job.demand, resources);
    }

    startById.set(pick, start);
    scheduled.push({ start, duration: job.duration, demand: job.demand });
    placed++;

    for (const succ of graph.successors.get(pick)) {
      const left = remainingPreds.get(succ) - 1;
      remainingPreds.set(succ, left);
      if (left === 0) insertSortedByCompare(ready, succ, compareReady);
    }
  }

  return startById;
}

function buildFallbackSchedule(graph, resources, topoOrder, horizon, guards) {
  /** @type {Map<string, number>} */
  const startById = new Map();
  /** @type {ScheduledSlice[]} */
  const scheduled = [];

  for (const id of topoOrder) {
    const job = graph.jobById.get(id);
    const minStart = minStartFromPredecessors(id, graph, startById);

    let start = findEarliestFeasibleStart(
      scheduled,
      minStart,
      job.duration,
      job.demand,
      resources,
      horizon,
    );

    if (start === null) {
      start = guaranteedFeasibleStart(scheduled, minStart, job.duration, job.demand, resources);
    }

    startById.set(id, start);
    scheduled.push({ start, duration: job.duration, demand: job.demand });
  }

  return startById;
}

/**
 * Deterministic placement after the latest scheduled finish (or minStart).
 * At that time no scheduled job is active (half-open intervals), so a
 * well-formed job whose demand fits each capacity is resource-feasible.
 *
 * @param {ScheduledSlice[]} scheduled
 * @param {number} minStart
 * @param {number} duration
 * @param {number[]} demand
 * @param {number[]} resources
 */
function guaranteedFeasibleStart(scheduled, minStart, duration, demand, resources) {
  let latestEnd = minStart;
  for (const entry of scheduled) {
    latestEnd = Math.max(latestEnd, entry.start + entry.duration);
  }
  const start = Math.max(minStart, latestEnd);

  if (isFeasibleInterval(scheduled, start, duration, demand, resources)) {
    return start;
  }

  let t = start + 1;
  while (!isFeasibleInterval(scheduled, t, duration, demand, resources)) {
    t += 1;
  }
  return t;
}

/**
 * @param {Map<string, number>} startById
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {number[]} resources
 * @param {number} horizon
 * @param {ReturnType<typeof computeGuards>} guards
 */
function compactSchedule(startById, graph, resources, horizon, guards) {
  const result = new Map(startById);
  const jobIds = [...result.keys()].sort((a, b) => {
    const sa = result.get(a);
    const sb = result.get(b);
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });

  let shifts = 0;
  for (const id of jobIds) {
    if (shifts >= guards.maxCompactionShifts) break;

    const job = graph.jobById.get(id);
    const current = result.get(id);
    const minStart = minStartFromPredecessors(id, graph, result);

    if (current <= minStart) continue;

    /** @type {ScheduledSlice[]} */
    const others = [];
    for (const [otherId, start] of result) {
      if (otherId === id) continue;
      const otherJob = graph.jobById.get(otherId);
      const otherEnd = start + otherJob.duration;
      if (otherEnd <= minStart) continue;
      others.push({ start, duration: otherJob.duration, demand: otherJob.demand });
    }

    const newStart = findEarliestFeasibleStart(
      others,
      minStart,
      job.duration,
      job.demand,
      resources,
      horizon,
    );

    if (newStart !== null && newStart < current) {
      result.set(id, newStart);
      shifts++;
    }
  }

  return result;
}

function makespanFromMap(startById, jobById) {
  let ms = 0;
  for (const [id, start] of startById) {
    ms = Math.max(ms, start + jobById.get(id).duration);
  }
  return ms;
}

/**
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @param {Array<{ id: string }>} jobs
 */
function lexLessSchedule(a, b, jobs) {
  const ids = jobs.map((job) => job.id).sort();
  for (const id of ids) {
    const sa = a.get(id);
    const sb = b.get(id);
    if (sa !== sb) return sa < sb;
  }
  return false;
}
