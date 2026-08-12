/**
 * Renewable resource-constrained job scheduler.
 * Small instances: iterative deepening + backtracking for minimum makespan.
 * Large instances: event-driven parallel SGS + left compression.
 * @param {{ resources: number[], jobs: Array<{ id: string, duration: number, demand: number[], deps: string[] }> }} instance
 * @returns {Array<{ id: string, start: number }>}
 */
export function solve(instance) {
  const { jobs } = instance;
  const n = jobs.length;
  if (n === 0) return [];

  const ctx = buildContext(instance);
  const lowerBound = computeLowerBound(ctx);

  if (n <= 24) {
    const optimal = solveByDeepening(ctx, lowerBound);
    if (optimal) return optimal;
  }

  const serial = serialSgs(ctx);
  const parallel = eventParallelSgs(ctx);
  const serialMs = makespanFrom(serial, ctx);
  const parallelMs = makespanFrom(parallel, ctx);

  const best = parallelMs < serialMs ? parallel : serial;
  compressLeft(best, ctx);
  return ctx.ids.map((id) => ({ id, start: best.get(id) }));
}

function buildContext(instance) {
  const { resources, jobs } = instance;
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const ids = jobs.map((j) => j.id);

  const successors = new Map(ids.map((id) => [id, []]));
  const preds = new Map(ids.map((id) => [id, []]));

  for (const job of jobs) {
    for (const dep of job.deps) {
      successors.get(dep).push(job.id);
      preds.get(job.id).push(dep);
    }
  }

  for (const id of ids) {
    successors.get(id).sort();
    preds.get(id).sort();
  }

  const topo = topologicalSort(ids, preds, successors);
  const est = new Map();
  const eft = new Map();

  for (const id of topo) {
    const job = jobById.get(id);
    let earliest = 0;
    for (const dep of preds.get(id)) {
      earliest = Math.max(earliest, eft.get(dep));
    }
    est.set(id, earliest);
    eft.set(id, earliest + job.duration);
  }

  const tail = new Map(ids.map((id) => [id, 0]));
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i];
    const job = jobById.get(id);
    let best = job.duration;
    for (const succ of successors.get(id)) {
      best = Math.max(best, job.duration + tail.get(succ));
    }
    tail.set(id, best);
  }

  const horizon = computeLowerBound({ resources, jobs, ids, tail });

  const lst = new Map();
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i];
    const job = jobById.get(id);
    const succs = successors.get(id);
    const latestFinish = succs.length === 0 ? horizon : Math.min(...succs.map((s) => lst.get(s)));
    lst.set(id, latestFinish - job.duration);
  }

  return { resources, jobs, jobById, ids, successors, preds, topo, est, eft, tail, lst };
}

function topologicalSort(ids, preds, successors) {
  const indegree = new Map(ids.map((id) => [id, preds.get(id).length]));
  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const order = [];

  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const succ of successors.get(id)) {
      const next = indegree.get(succ) - 1;
      indegree.set(succ, next);
      if (next === 0) {
        queue.push(succ);
        queue.sort();
      }
    }
  }

  return order;
}

function computeLowerBound(ctx) {
  const { resources, jobs, tail, ids } = ctx;
  const critical = Math.max(...ids.map((id) => tail.get(id)));
  const resourceBounds = resources.map((cap, r) => {
    let work = 0;
    for (const job of jobs) {
      work += job.duration * job.demand[r];
    }
    return Math.ceil(work / cap);
  });
  return Math.max(critical, ...resourceBounds);
}

function makespanFrom(starts, ctx) {
  let ms = 0;
  for (const id of ctx.ids) {
    const job = ctx.jobById.get(id);
    ms = Math.max(ms, starts.get(id) + job.duration);
  }
  return ms;
}

function comparePriority(ctx, a, b) {
  const jobA = ctx.jobById.get(a);
  const jobB = ctx.jobById.get(b);
  const slackA = ctx.lst.get(a) - ctx.est.get(a);
  const slackB = ctx.lst.get(b) - ctx.est.get(b);
  const keysA = [slackA, -ctx.tail.get(a), -jobA.demand.reduce((s, d) => s + d, 0), -jobA.duration, a];
  const keysB = [slackB, -ctx.tail.get(b), -jobB.demand.reduce((s, d) => s + d, 0), -jobB.duration, b];
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return keysA[i] < keysB[i] ? -1 : 1;
  }
  return 0;
}

function createProfile(resources) {
  return resources.map(() => []);
}

function profileUsage(profile, t, r) {
  const row = profile[r];
  return t < row.length ? row[t] : 0;
}

function canPlace(job, start, profile, resources) {
  const end = start + job.duration;
  for (let t = start; t < end; t++) {
    for (let r = 0; r < resources.length; r++) {
      const demand = job.demand[r];
      if (demand === 0) continue;
      if (profileUsage(profile, t, r) + demand > resources[r]) return false;
    }
  }
  return true;
}

function place(job, start, profile) {
  const end = start + job.duration;
  for (let t = start; t < end; t++) {
    for (let r = 0; r < profile.length; r++) {
      const demand = job.demand[r];
      if (demand === 0) continue;
      while (profile[r].length <= t) profile[r].push(0);
      profile[r][t] += demand;
    }
  }
}

function remove(job, start, profile) {
  const end = start + job.duration;
  for (let t = start; t < end; t++) {
    for (let r = 0; r < profile.length; r++) {
      const demand = job.demand[r];
      if (demand === 0) continue;
      profile[r][t] -= demand;
    }
  }
}

function earliestStart(job, minStart, profile, resources) {
  let t = minStart;
  while (!canPlace(job, t, profile, resources)) t++;
  return t;
}

function solveByDeepening(ctx, lowerBound) {
  const maxTry = lowerBound + Math.max(0, ctx.jobs.length * 2);
  for (let target = lowerBound; target <= maxTry; target++) {
    const result = backtrack(ctx, target);
    if (result) return ctx.ids.map((id) => ({ id, start: result.get(id) }));
  }
  return null;
}

function backtrack(ctx, target) {
  const { resources, preds, est, jobById } = ctx;
  const profile = createProfile(resources);
  const starts = new Map();
  const order = [...ctx.topo];

  function predFinishOk(id, start) {
    for (const dep of preds.get(id)) {
      const depJob = jobById.get(dep);
      if (start < starts.get(dep) + depJob.duration) return false;
    }
    return true;
  }

  function dfs(index) {
    if (index === order.length) return true;

    const id = order[index];
    const job = jobById.get(id);
    const minStart = est.get(id);
    const maxStart = target - job.duration;
    if (maxStart < minStart) return false;

    for (let start = minStart; start <= maxStart; start++) {
      if (!predFinishOk(id, start)) continue;
      if (!canPlace(job, start, profile, resources)) continue;

      starts.set(id, start);
      place(job, start, profile);
      if (dfs(index + 1)) return true;
      remove(job, start, profile);
      starts.delete(id);
    }
    return false;
  }

  if (!dfs(0)) return null;
  return starts;
}

function serialSgs(ctx) {
  const { resources, ids, preds, successors, est, jobById } = ctx;
  const profile = createProfile(resources);
  const starts = new Map();
  const remainingPreds = new Map(ids.map((id) => [id, preds.get(id).length]));
  const remaining = new Set(ids);

  while (remaining.size > 0) {
    const eligible = [...remaining].filter((id) => remainingPreds.get(id) === 0);
    eligible.sort((a, b) => comparePriority(ctx, a, b));
    const id = eligible[0];
    const job = jobById.get(id);
    const start = earliestStart(job, est.get(id), profile, resources);
    starts.set(id, start);
    place(job, start, profile);
    remaining.delete(id);
    for (const succ of successors.get(id)) {
      remainingPreds.set(succ, remainingPreds.get(succ) - 1);
    }
  }

  return starts;
}

function eventParallelSgs(ctx) {
  const { resources, ids, preds, successors, est, jobById } = ctx;
  const profile = createProfile(resources);
  const starts = new Map();
  const remainingPreds = new Map(ids.map((id) => [id, preds.get(id).length]));
  const remaining = new Set(ids);
  let time = 0;

  while (remaining.size > 0) {
    const eligible = [...remaining].filter((id) => remainingPreds.get(id) === 0);
    eligible.sort((a, b) => comparePriority(ctx, a, b));

    let started = false;
    for (const id of eligible) {
      const job = jobById.get(id);
      const minStart = Math.max(time, est.get(id));
      if (!canPlace(job, minStart, profile, resources)) continue;

      starts.set(id, minStart);
      place(job, minStart, profile);
      remaining.delete(id);
      for (const succ of successors.get(id)) {
        remainingPreds.set(succ, remainingPreds.get(succ) - 1);
      }
      started = true;
    }

    if (started) {
      time++;
      continue;
    }

    const nextEligibleStart = eligible.length
      ? Math.min(...eligible.map((id) => earliestStart(ctx.jobById.get(id), Math.max(time, est.get(id)), profile, resources)))
      : time + 1;
    const nextCompletion = starts.size
      ? Math.min(
          ...[...starts.entries()].map(([id, start]) => start + ctx.jobById.get(id).duration),
        )
      : nextEligibleStart;

    time = Math.max(time + 1, Math.min(nextEligibleStart, nextCompletion));
  }

  return starts;
}

function compressLeft(starts, ctx) {
  const { resources, topo, preds, jobById } = ctx;
  const profile = createProfile(resources);

  for (const id of topo) {
    place(jobById.get(id), starts.get(id), profile);
  }

  for (const id of topo) {
    const job = jobById.get(id);
    let lower = 0;
    for (const dep of preds.get(id)) {
      lower = Math.max(lower, starts.get(dep) + jobById.get(dep).duration);
    }

    remove(job, starts.get(id), profile);
    const next = earliestStart(job, lower, profile, resources);
    starts.set(id, next);
    place(job, next, profile);
  }
}
