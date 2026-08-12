/**
 * Renewable resource-constrained job scheduler.
 * @param {{ resources: number[], jobs: Array<{ id: string, duration: number, demand: number[], deps: string[] }> }} instance
 * @returns {Array<{ id: string, start: number }>}
 */
export function solve(instance) {
  const jobs = instance.jobs;
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const bounds = computeBounds(instance, jobById);
  const successorCount = computeSuccessorCounts(jobs);
  const rankPos = computeRankPositionalWeight(jobs, jobById);

  const priorityRules = [
    (a, b) => bounds.lft.get(a.id) - bounds.lft.get(b.id) || cmpId(a, b),
    (a, b) =>
      bounds.lst.get(a.id) - bounds.lst.get(b.id) ||
      b.duration - a.duration ||
      cmpId(a, b),
    (a, b) =>
      bounds.slack(a) - bounds.slack(b) ||
      b.duration - a.duration ||
      cmpId(a, b),
    (a, b) => b.duration - a.duration || cmpId(a, b),
    (a, b) => sumDemand(b) - sumDemand(a) || cmpId(a, b),
    (a, b) => successorCount.get(b.id) - successorCount.get(a.id) || cmpId(a, b),
    (a, b) => rankPos.get(b.id) - rankPos.get(a.id) || cmpId(a, b),
    (a, b) => bounds.est.get(a.id) - bounds.est.get(b.id) || cmpId(a, b),
    (a, b) => b.duration * sumDemand(b) - a.duration * sumDemand(a) || cmpId(a, b),
  ];

  let best = null;
  let bestMs = Infinity;

  for (const rule of priorityRules) {
    ({ best, bestMs } = pickBest(
      best,
      bestMs,
      leftShift(serialSGS(instance, jobById, rule), instance, jobById, bounds.est),
      jobById,
    ));
    ({ best, bestMs } = pickBest(
      best,
      bestMs,
      leftShift(parallelSGS(instance, jobById, rule), instance, jobById, bounds.est),
      jobById,
    ));
  }

  if (jobs.length <= 14) {
    const orders = buildSearchOrders(jobs, jobById, bounds, rankPos);
    for (const order of orders) {
      const searched = branchAndBound(instance, jobById, bounds, order);
      ({ best, bestMs } = pickBest(best, bestMs, searched, jobById));
    }
  }

  if (!best) {
    best = serialSGS(instance, jobById, priorityRules[0]);
  }

  return best;
}

function cmpId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sumDemand(job) {
  return job.demand.reduce((s, d) => s + d, 0);
}

function pickBest(best, bestMs, schedule, jobById) {
  if (!schedule) return { best, bestMs };
  const ms = makespan(schedule, jobById);
  if (ms < bestMs) return { best: schedule, bestMs: ms };
  return { best, bestMs };
}

function makespan(schedule, jobById) {
  let ms = 0;
  for (const entry of schedule) {
    const job = jobById.get(entry.id);
    ms = Math.max(ms, entry.start + job.duration);
  }
  return ms;
}

function computeBounds(instance, jobById) {
  const est = new Map();
  const eft = new Map();

  const visitEst = (id, stack) => {
    if (est.has(id)) return est.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const job = jobById.get(id);
    let v = 0;
    for (const dep of job.deps) {
      v = Math.max(v, visitEst(dep, stack) + jobById.get(dep).duration);
    }
    stack.delete(id);
    est.set(id, v);
    eft.set(id, v + job.duration);
    return v;
  };

  for (const job of instance.jobs) visitEst(job.id, new Set());

  const lft = new Map();
  const lst = new Map();
  const successors = new Map(instance.jobs.map((j) => [j.id, []]));
  for (const job of instance.jobs) {
    for (const dep of job.deps) successors.get(dep).push(job.id);
  }

  const visitLft = (id, stack) => {
    if (lft.has(id)) return lft.get(id);
    if (stack.has(id)) return eft.get(id);
    stack.add(id);
    const job = jobById.get(id);
    const succs = successors.get(id);
    let v =
      succs.length === 0
        ? eft.get(id)
        : Math.min(...succs.map((s) => visitLft(s, stack) - jobById.get(s).duration));
    stack.delete(id);
    lft.set(id, v);
    lst.set(id, v - job.duration);
    return v;
  };

  for (const job of instance.jobs) visitLft(job.id, new Set());

  const resourceLb = resourceLowerBound(instance);
  const slack = (job) => lst.get(job.id) - est.get(job.id);

  return { est, eft, lft, lst, slack, resourceLb };
}

function resourceLowerBound(instance) {
  const cap = instance.resources;
  let lb = 0;
  for (let r = 0; r < cap.length; r++) {
    let work = 0;
    for (const job of instance.jobs) work += job.duration * job.demand[r];
    lb = Math.max(lb, Math.ceil(work / cap[r]));
  }
  return lb;
}

function computeSuccessorCounts(jobs) {
  const counts = new Map(jobs.map((j) => [j.id, 0]));
  for (const job of jobs) {
    for (const dep of job.deps) counts.set(dep, counts.get(dep) + 1);
  }
  return counts;
}

function computeRankPositionalWeight(jobs, jobById) {
  const successors = new Map(jobs.map((j) => [j.id, []]));
  for (const job of jobs) {
    for (const dep of job.deps) successors.get(dep).push(job.id);
  }

  const memo = new Map();
  const weight = (id) => {
    if (memo.has(id)) return memo.get(id);
    const job = jobById.get(id);
    let w = job.duration;
    for (const succ of successors.get(id)) w += weight(succ);
    memo.set(id, w);
    return w;
  };

  const ranks = new Map();
  for (const job of jobs) ranks.set(job.id, weight(job.id));
  return ranks;
}

function serialSGS(instance, jobById, priority) {
  const unscheduled = new Set(instance.jobs.map((j) => j.id));
  const starts = new Map();

  while (unscheduled.size > 0) {
    const eligible = [...unscheduled].filter((id) =>
      jobById.get(id).deps.every((d) => starts.has(d)),
    );
    eligible.sort((a, b) => priority(jobById.get(a), jobById.get(b)));

    const pick = eligible[0];
    const job = jobById.get(pick);
    const ready =
      job.deps.length === 0
        ? 0
        : Math.max(...job.deps.map((d) => starts.get(d) + jobById.get(d).duration));
    starts.set(pick, earliestFeasibleStart(job, ready, starts, instance, jobById));
    unscheduled.delete(pick);
  }

  return toSchedule(instance.jobs, starts);
}

function parallelSGS(instance, jobById, priority) {
  const n = instance.jobs.length;
  const starts = new Map();
  let t = 0;
  let scheduled = 0;

  const isEligible = (job) => {
    if (starts.has(job.id)) return false;
    return job.deps.every((d) => {
      const depStart = starts.get(d);
      return depStart !== undefined && depStart + jobById.get(d).duration <= t;
    });
  };

  while (scheduled < n) {
    const eligible = instance.jobs.filter(isEligible);
    eligible.sort(priority);

    let started = false;
    const pending = [...eligible];
    while (pending.length > 0) {
      let progressed = false;
      for (let i = 0; i < pending.length; i++) {
        const job = pending[i];
        if (!canScheduleAt(job, t, starts, instance, jobById)) continue;
        starts.set(job.id, t);
        scheduled++;
        started = true;
        progressed = true;
        pending.splice(i, 1);
        break;
      }
      if (!progressed) break;
    }

    if (scheduled === n) break;

    if (!started) {
      const nextFinish = instance.jobs
        .filter((j) => starts.has(j.id))
        .map((j) => starts.get(j.id) + j.duration)
        .filter((ft) => ft > t);
      const nextReady = instance.jobs
        .filter((j) => !starts.has(j.id))
        .map((job) =>
          job.deps.length === 0
            ? 0
            : Math.max(...job.deps.map((d) => starts.get(d) + jobById.get(d).duration)),
        )
        .filter((r) => r > t);
      const next = [...nextFinish, ...nextReady];
      t = next.length === 0 ? t + 1 : Math.min(...next);
    } else {
      t++;
    }
  }

  return toSchedule(instance.jobs, starts);
}

function buildSearchOrders(jobs, jobById, bounds, rankPos) {
  const base = [...jobs].sort((a, b) => a.id.localeCompare(b.id));
  const orders = [
    [...base].sort(
      (a, b) => bounds.lst.get(a.id) - bounds.lst.get(b.id) || cmpId(a, b),
    ),
    [...base].sort((a, b) => b.duration - a.duration || cmpId(a, b)),
    [...base].sort((a, b) => rankPos.get(b.id) - rankPos.get(a.id) || cmpId(a, b)),
    topologicalOrder(jobs, jobById).map((id) => jobById.get(id)),
  ];
  return orders;
}

function branchAndBound(instance, jobById, bounds, order) {
  const starts = new Map();
  let bestMs = Infinity;
  let bestStarts = null;
  const horizon = Math.max(bounds.resourceLb, bounds.lft.get(
    order.reduce((a, b) => (bounds.lft.get(a.id) > bounds.lft.get(b.id) ? a : b)).id,
  ));

  const dfs = (idx, lowerBound) => {
    if (lowerBound >= bestMs) return;
    if (idx === order.length) {
      const ms = currentMakespan(starts, jobById);
      if (ms < bestMs) {
        bestMs = ms;
        bestStarts = new Map(starts);
      }
      return;
    }

    const job = order[idx];
    const ready =
      job.deps.length === 0
        ? 0
        : Math.max(...job.deps.map((d) => starts.get(d) + jobById.get(d).duration));
    const maxStart = Math.max(horizon, ready) + sumDurationRemaining(order, idx, jobById);

    for (let t = ready; t <= maxStart; t++) {
      if (t + job.duration >= bestMs) break;
      if (!canScheduleAt(job, t, starts, instance, jobById)) continue;
      starts.set(job.id, t);
      const tailLb = Math.max(
        t + job.duration,
        readyBound(order, idx + 1, starts, jobById),
      );
      dfs(idx + 1, tailLb);
      starts.delete(job.id);
    }
  };

  dfs(0, bounds.resourceLb);
  return bestStarts ? toSchedule(instance.jobs, bestStarts) : null;
}

function sumDurationRemaining(order, idx, jobById) {
  let s = 0;
  for (let i = idx; i < order.length; i++) s += order[i].duration;
  return s;
}

function readyBound(order, idx, starts, jobById) {
  let lb = 0;
  for (let i = idx; i < order.length; i++) {
    const job = order[i];
    const ready =
      job.deps.length === 0
        ? 0
        : Math.max(...job.deps.map((d) => starts.get(d) + jobById.get(d).duration));
    lb = Math.max(lb, ready + job.duration);
  }
  return lb;
}

function currentMakespan(starts, jobById) {
  let ms = 0;
  for (const [id, start] of starts) {
    ms = Math.max(ms, start + jobById.get(id).duration);
  }
  return ms;
}

function earliestFeasibleStart(job, ready, starts, instance, jobById) {
  let t = ready;
  while (!canScheduleAt(job, t, starts, instance, jobById)) t++;
  return t;
}

function canScheduleAt(job, t, starts, instance, jobById) {
  const cap = instance.resources;
  for (let slot = t; slot < t + job.duration; slot++) {
    const usage = cap.map(() => 0);
    for (const [id, start] of starts) {
      const other = jobById.get(id);
      if (start <= slot && slot < start + other.duration) {
        for (let r = 0; r < cap.length; r++) usage[r] += other.demand[r];
      }
    }
    for (let r = 0; r < cap.length; r++) {
      if (usage[r] + job.demand[r] > cap[r]) return false;
    }
  }
  return true;
}

function leftShift(schedule, instance, jobById, est) {
  const byId = new Map(schedule.map((e) => [e.id, e.start]));
  const order = topologicalOrder(instance.jobs, jobById);

  for (const id of order) {
    const job = jobById.get(id);
    const depEnd =
      job.deps.length === 0
        ? 0
        : Math.max(...job.deps.map((d) => byId.get(d) + jobById.get(d).duration));
    const lower = Math.max(depEnd, est.get(id));
    let t = byId.get(id);
    while (t > lower) {
      const trial = new Map(byId);
      trial.set(id, t - 1);
      if (isScheduleFeasible(trial, instance, jobById)) {
        t--;
        byId.set(id, t);
      } else {
        break;
      }
    }
  }

  return toSchedule(instance.jobs, byId);
}

function topologicalOrder(jobs, jobById) {
  const indeg = new Map(jobs.map((j) => [j.id, j.deps.length]));
  const queue = jobs
    .filter((j) => j.deps.length === 0)
    .map((j) => j.id)
    .sort();
  const order = [];

  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const job of jobs) {
      if (!job.deps.includes(id)) continue;
      const d = indeg.get(job.id) - 1;
      indeg.set(job.id, d);
      if (d === 0) {
        queue.push(job.id);
        queue.sort();
      }
    }
  }

  return order;
}

function isScheduleFeasible(starts, instance, jobById) {
  for (const job of instance.jobs) {
    const start = starts.get(job.id);
    for (const dep of job.deps) {
      const depJob = jobById.get(dep);
      if (start < starts.get(dep) + depJob.duration) return false;
    }
  }

  const ms = Math.max(
    ...instance.jobs.map((j) => starts.get(j.id) + j.duration),
  );
  const cap = instance.resources;

  for (let t = 0; t < ms; t++) {
    const usage = cap.map(() => 0);
    for (const job of instance.jobs) {
      const start = starts.get(job.id);
      if (start <= t && t < start + job.duration) {
        for (let r = 0; r < cap.length; r++) usage[r] += job.demand[r];
      }
    }
    for (let r = 0; r < cap.length; r++) {
      if (usage[r] > cap[r]) return false;
    }
  }
  return true;
}

function toSchedule(jobs, starts) {
  return jobs.map((j) => ({ id: j.id, start: starts.get(j.id) }));
}
