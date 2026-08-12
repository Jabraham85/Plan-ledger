import { solve } from "./src/scheduler.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function validate(instance, schedule) {
  const byId = new Map(instance.jobs.map((j) => [j.id, j]));
  assert(schedule.length === instance.jobs.length, "schedule length mismatch");
  const seen = new Set();
  for (const entry of schedule) {
    assert(typeof entry.id === "string", "entry id must be string");
    assert(Number.isInteger(entry.start) && entry.start >= 0, "start must be nonnegative integer");
    assert(byId.has(entry.id), `unknown job id ${entry.id}`);
    assert(!seen.has(entry.id), `duplicate job id ${entry.id}`);
    seen.add(entry.id);
  }
  for (const job of instance.jobs) {
    for (const dep of job.deps) {
      const depJob = byId.get(dep);
      const depStart = schedule.find((e) => e.id === dep).start;
      const start = schedule.find((e) => e.id === job.id).start;
      assert(start >= depStart + depJob.duration, `dependency violated: ${job.id} after ${dep}`);
    }
  }
  const makespan = Math.max(
    ...instance.jobs.map((j) => schedule.find((e) => e.id === j.id).start + j.duration),
  );
  for (let t = 0; t < makespan; t++) {
    const usage = instance.resources.map(() => 0);
    for (const job of instance.jobs) {
      const start = schedule.find((e) => e.id === job.id).start;
      if (start <= t && t < start + job.duration) {
        job.demand.forEach((d, r) => {
          usage[r] += d;
        });
      }
    }
    usage.forEach((u, r) => {
      assert(u <= instance.resources[r], `capacity exceeded at t=${t} on resource ${r}`);
    });
  }
}

const chain = {
  resources: [2],
  jobs: [
    { id: "a", duration: 2, demand: [1], deps: [] },
    { id: "b", duration: 3, demand: [1], deps: ["a"] },
    { id: "c", duration: 1, demand: [1], deps: ["b"] },
  ],
};

const pack = {
  resources: [2],
  jobs: [
    { id: "x", duration: 2, demand: [2], deps: [] },
    { id: "y", duration: 2, demand: [2], deps: [] },
  ],
};

const fork = {
  resources: [1],
  jobs: [
    { id: "root", duration: 1, demand: [1], deps: [] },
    { id: "left", duration: 2, demand: [1], deps: ["root"] },
    { id: "right", duration: 3, demand: [1], deps: ["root"] },
    { id: "join", duration: 1, demand: [1], deps: ["left", "right"] },
  ],
};

const cases = [
  { name: "chain", instance: chain, maxMakespan: 6 },
  { name: "packing", instance: pack, maxMakespan: 4 },
  { name: "fork", instance: fork, maxMakespan: 7 },
];

let passed = 0;
for (const tc of cases) {
  const snap = JSON.stringify(tc.instance);
  const schedule = solve(tc.instance);
  assert(JSON.stringify(tc.instance) === snap, "solve() must not mutate instance");
  validate(tc.instance, schedule);
  const makespan = Math.max(
    ...tc.instance.jobs.map((j) => schedule.find((e) => e.id === j.id).start + j.duration),
  );
  assert(makespan <= tc.maxMakespan, `${tc.name}: makespan ${makespan} exceeds ${tc.maxMakespan}`);
  passed++;
}

console.log(`public-smoke: ${passed}/${cases.length} cases passed`);
