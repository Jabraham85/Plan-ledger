/**
 * Renewable resource-constrained job scheduler.
 * @param {{ resources: number[], jobs: Array<{ id: string, duration: number, demand: number[], deps: string[] }> }} instance
 * @returns {Array<{ id: string, start: number }>}
 */
export function solve(instance) {
  const { resources, jobs } = instance;
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const totalDuration = jobs.reduce((sum, j) => sum + j.duration, 0);

  const successors = new Map(jobs.map((j) => [j.id, []]));
  for (const job of jobs) {
    for (const dep of job.deps) {
      successors.get(dep).push(job.id);
    }
  }

  const rank = computeBackwardRank(jobs, jobById, successors);
  const schedule = new Map();

  while (schedule.size < jobs.length) {
    const ready = jobs.filter((job) =>
      !schedule.has(job.id) && job.deps.every((dep) => schedule.has(dep)),
    );

    ready.sort((a, b) => {
      const rankDiff = rank.get(b.id) - rank.get(a.id);
      if (rankDiff !== 0) return rankDiff;
      const readyA = depReadyTime(a, schedule, jobById);
      const readyB = depReadyTime(b, schedule, jobById);
      if (readyA !== readyB) return readyA - readyB;
      return a.id.localeCompare(b.id);
    });

    const job = ready[0];
    const start = findEarliestFeasibleStart(job, schedule, jobById, resources, totalDuration);
    schedule.set(job.id, { id: job.id, start });
  }

  compactLeft(schedule, jobs, jobById, resources, totalDuration);

  return jobs.map((j) => schedule.get(j.id));
}

function topologicalOrder(jobs) {
  const inDegree = new Map(jobs.map((j) => [j.id, j.deps.length]));
  const queue = jobs.filter((j) => j.deps.length === 0).map((j) => j.id).sort();
  const order = [];

  while (queue.length > 0) {
    queue.sort();
    const id = queue.shift();
    order.push(id);
    for (const job of jobs) {
      if (job.deps.includes(id)) {
        const next = inDegree.get(job.id) - 1;
        inDegree.set(job.id, next);
        if (next === 0) queue.push(job.id);
      }
    }
  }

  return order;
}

function computeBackwardRank(jobs, jobById, successors) {
  const order = topologicalOrder(jobs);
  const rank = new Map();

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const job = jobById.get(id);
    const succs = successors.get(id);
    if (succs.length === 0) {
      rank.set(id, job.duration);
    } else {
      const maxSucc = Math.max(...succs.map((s) => rank.get(s)));
      rank.set(id, job.duration + maxSucc);
    }
  }

  return rank;
}

function depReadyTime(job, schedule, jobById) {
  let ready = 0;
  for (const dep of job.deps) {
    const entry = schedule.get(dep);
    const depJob = jobById.get(dep);
    ready = Math.max(ready, entry.start + depJob.duration);
  }
  return ready;
}

function usageAtTime(t, schedule, jobById, resources, extraJob = null, extraStart = 0, excludeId = null) {
  const usage = resources.map(() => 0);
  for (const [id, entry] of schedule) {
    if (id === excludeId) continue;
    const j = jobById.get(id);
    if (entry.start <= t && t < entry.start + j.duration) {
      for (let r = 0; r < resources.length; r++) {
        usage[r] += j.demand[r];
      }
    }
  }
  if (extraJob && extraStart <= t && t < extraStart + extraJob.duration) {
    for (let r = 0; r < resources.length; r++) {
      usage[r] += extraJob.demand[r];
    }
  }
  return usage;
}

function isIntervalFeasible(start, job, schedule, jobById, resources, excludeId = null) {
  for (let t = start; t < start + job.duration; t++) {
    const usage = usageAtTime(t, schedule, jobById, resources, job, start, excludeId);
    for (let r = 0; r < resources.length; r++) {
      if (usage[r] > resources[r]) return false;
    }
  }
  return true;
}

function findEarliestFeasibleStart(job, schedule, jobById, resources, horizon) {
  const earliest = depReadyTime(job, schedule, jobById);
  for (let t = earliest; t <= horizon; t++) {
    if (isIntervalFeasible(t, job, schedule, jobById, resources)) {
      return t;
    }
  }
  return earliest;
}

function compactLeft(schedule, jobs, jobById, resources, horizon) {
  const ordered = [...jobs].sort((a, b) => {
    const startDiff = schedule.get(a.id).start - schedule.get(b.id).start;
    if (startDiff !== 0) return startDiff;
    return a.id.localeCompare(b.id);
  });

  for (const job of ordered) {
    const entry = schedule.get(job.id);
    const earliest = depReadyTime(job, schedule, jobById);
    for (let t = earliest; t < entry.start; t++) {
      if (isIntervalFeasible(t, job, schedule, jobById, resources, job.id)) {
        entry.start = t;
        break;
      }
    }
  }
}
