#!/usr/bin/env node
/**
 * Hidden deterministic grader for planner-vs-direct scheduling benchmark.
 * Node >= 22, zero dependencies.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

const BENCHMARK_SEED = 0x504c414e; // "PLAN"
const FEASIBILITY_WEIGHT = 50;
const QUALITY_WEIGHT = 50;
const CALIBRATION_CASE_WEIGHT = 5;
const DEFAULT_CASE_WEIGHT = 1;
const PER_CASE_TIMEOUT_MS = 400;
const WORKER_READY_TIMEOUT_MS = 10_000;

const WORKER_URL = new URL("./worker.mjs", import.meta.url);

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// Theory: lower bound, makespan, validation
// ---------------------------------------------------------------------------

function jobById(instance) {
  return new Map(instance.jobs.map((j) => [j.id, j]));
}

function criticalPathLength(instance) {
  const byId = jobById(instance);
  const memo = new Map();

  function longestFrom(id) {
    if (memo.has(id)) return memo.get(id);
    const job = byId.get(id);
    let best = job.duration;
    for (const dep of job.deps) {
      best = Math.max(best, longestFrom(dep) + job.duration);
    }
    memo.set(id, best);
    return best;
  }

  let cp = 0;
  for (const job of instance.jobs) {
    cp = Math.max(cp, longestFrom(job.id));
  }
  return cp;
}

/** Documented theoretical lower bound: max(critical-path, per-resource work bounds). */
export function theoreticalLowerBound(instance) {
  const cp = criticalPathLength(instance);
  let resourceBound = 0;
  for (let r = 0; r < instance.resources.length; r++) {
    let work = 0;
    for (const job of instance.jobs) {
      work += job.duration * job.demand[r];
    }
    resourceBound = Math.max(
      resourceBound,
      Math.ceil(work / instance.resources[r]),
    );
  }
  return Math.max(cp, resourceBound);
}

function scheduleMakespan(instance, schedule) {
  const byId = jobById(instance);
  let m = 0;
  for (const entry of schedule) {
    const job = byId.get(entry.id);
    m = Math.max(m, entry.start + job.duration);
  }
  return m;
}

function validateSchedule(instance, schedule) {
  const errors = [];
  const byId = jobById(instance);

  if (!Array.isArray(schedule)) {
    return ["schedule is not an array"];
  }
  if (schedule.length !== instance.jobs.length) {
    errors.push(`expected ${instance.jobs.length} entries, got ${schedule.length}`);
  }

  const seen = new Set();
  for (const entry of schedule) {
    if (!entry || typeof entry.id !== "string") {
      errors.push("entry missing string id");
      continue;
    }
    if (!Number.isInteger(entry.start) || entry.start < 0) {
      errors.push(`job ${entry.id}: start must be nonnegative integer`);
    }
    if (!byId.has(entry.id)) {
      errors.push(`unknown job id ${entry.id}`);
    }
    if (seen.has(entry.id)) {
      errors.push(`duplicate job id ${entry.id}`);
    }
    seen.add(entry.id);
  }

  for (const job of instance.jobs) {
    if (!seen.has(job.id)) {
      errors.push(`missing job ${job.id}`);
    }
  }

  if (errors.length > 0) return errors;

  const startOf = new Map(schedule.map((e) => [e.id, e.start]));

  for (const job of instance.jobs) {
    for (const dep of job.deps) {
      const depJob = byId.get(dep);
      const depEnd = startOf.get(dep) + depJob.duration;
      if (startOf.get(job.id) < depEnd) {
        errors.push(`dependency violated: ${job.id} starts before ${dep} finishes`);
      }
    }
  }

  const makespan = scheduleMakespan(instance, schedule);
  for (let t = 0; t < makespan; t++) {
    const usage = instance.resources.map(() => 0);
    for (const job of instance.jobs) {
      const s = startOf.get(job.id);
      if (s <= t && t < s + job.duration) {
        for (let r = 0; r < instance.resources.length; r++) {
          usage[r] += job.demand[r];
        }
      }
    }
    for (let r = 0; r < instance.resources.length; r++) {
      if (usage[r] > instance.resources[r]) {
        errors.push(`resource ${r} exceeded at t=${t} (${usage[r]} > ${instance.resources[r]})`);
      }
    }
  }

  return errors;
}

function schedulesEqual(a, b) {
  const norm = (s) =>
    [...s]
      .map((e) => ({ id: e.id, start: e.start }))
      .sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Exhaustive optimum (tiny instances only — calibration guard)
// ---------------------------------------------------------------------------

function isScheduleFeasible(instance, assignment) {
  const byId = jobById(instance);
  for (const job of instance.jobs) {
    for (const dep of job.deps) {
      const depJob = byId.get(dep);
      if (assignment[job.id] < assignment[dep] + depJob.duration) {
        return false;
      }
    }
  }
  const makespan = Math.max(
    ...instance.jobs.map((j) => assignment[j.id] + j.duration),
  );
  for (let t = 0; t < makespan; t++) {
    const usage = instance.resources.map(() => 0);
    for (const job of instance.jobs) {
      const s = assignment[job.id];
      if (s <= t && t < s + job.duration) {
        for (let r = 0; r < instance.resources.length; r++) {
          usage[r] += job.demand[r];
        }
      }
    }
    for (let r = 0; r < instance.resources.length; r++) {
      if (usage[r] > instance.resources[r]) return false;
    }
  }
  return true;
}

function exhaustiveOptimum(instance, horizon) {
  const jobs = instance.jobs;
  const n = jobs.length;
  let best = Infinity;
  const cur = {};

  function dfs(idx) {
    if (idx === n) {
      if (isScheduleFeasible(instance, cur)) {
        const m = Math.max(...jobs.map((j) => cur[j.id] + j.duration));
        best = Math.min(best, m);
      }
      return;
    }
    const job = jobs[idx];
    let minStart = 0;
    for (const dep of job.deps) {
      const depJob = jobs.find((j) => j.id === dep);
      minStart = Math.max(minStart, cur[dep] + depJob.duration);
    }
    for (let s = minStart; s <= horizon; s++) {
      cur[job.id] = s;
      const partialM = Math.max(
        ...jobs.slice(0, idx + 1).map((j) => cur[j.id] + j.duration),
      );
      if (partialM >= best) continue;
      let ok = true;
      for (let t = 0; t < partialM && ok; t++) {
        const usage = instance.resources.map(() => 0);
        for (let i = 0; i <= idx; i++) {
          const j = jobs[i];
          const st = cur[j.id];
          if (st <= t && t < st + j.duration) {
            for (let r = 0; r < instance.resources.length; r++) {
              usage[r] += j.demand[r];
            }
          }
        }
        for (let r = 0; r < instance.resources.length; r++) {
          if (usage[r] > instance.resources[r]) ok = false;
        }
      }
      if (!ok) continue;
      dfs(idx + 1);
    }
  }

  dfs(0);
  return best;
}

// ---------------------------------------------------------------------------
// Startup calibration assertions (integrality gap proof)
// ---------------------------------------------------------------------------

const CALIBRATION_INSTANCE = {
  resources: [3],
  jobs: [
    { id: "g0", duration: 1, demand: [2], deps: [] },
    { id: "g1", duration: 1, demand: [2], deps: [] },
    { id: "g2", duration: 1, demand: [2], deps: [] },
  ],
};

function runStartupAssertions() {
  const lb = theoreticalLowerBound(CALIBRATION_INSTANCE);
  if (lb !== 2) {
    throw new Error(`calibration LB assertion failed: expected 2, got ${lb}`);
  }
  const opt = exhaustiveOptimum(CALIBRATION_INSTANCE, 6);
  if (opt !== 3) {
    throw new Error(`calibration optimum assertion failed: expected 3, got ${opt}`);
  }
  if (opt <= lb) {
    throw new Error(`calibration gap missing: optimum ${opt} <= LB ${lb}`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic hidden case generators (>= 48 cases)
// ---------------------------------------------------------------------------

function makeChainCase(rng, idx) {
  const len = randInt(rng, 4, 9);
  const cap = randInt(rng, 1, 4);
  const jobs = [];
  for (let i = 0; i < len; i++) {
    jobs.push({
      id: `ch${idx}_${i}`,
      duration: randInt(rng, 1, 4),
      demand: [randInt(rng, 0, cap)],
      deps: i === 0 ? [] : [`ch${idx}_${i - 1}`],
    });
  }
  return { resources: [cap], jobs };
}

function makeForkCase(rng, idx) {
  const branches = randInt(rng, 2, 4);
  const cap = randInt(rng, 1, 3);
  const rootDur = randInt(rng, 1, 3);
  const jobs = [
    { id: `fk${idx}_root`, duration: rootDur, demand: [randInt(rng, 1, cap)], deps: [] },
  ];
  const leaves = [];
  for (let b = 0; b < branches; b++) {
    const leafId = `fk${idx}_b${b}`;
    jobs.push({
      id: leafId,
      duration: randInt(rng, 1, 5),
      demand: [randInt(rng, 1, cap)],
      deps: [`fk${idx}_root`],
    });
    leaves.push(leafId);
  }
  jobs.push({
    id: `fk${idx}_join`,
    duration: randInt(rng, 1, 2),
    demand: [randInt(rng, 1, cap)],
    deps: leaves,
  });
  return { resources: [cap], jobs };
}

function makePackingCase(rng, idx) {
  const cap = randInt(rng, 2, 5);
  const n = randInt(rng, 5, 10);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const demand = randInt(rng, 1, cap);
    jobs.push({
      id: `pk${idx}_${i}`,
      duration: randInt(rng, 1, 3),
      demand: [demand],
      deps: [],
    });
  }
  return { resources: [cap], jobs };
}

function makeMixedDagCase(rng, idx) {
  const cap = randInt(rng, 2, 4);
  const n = randInt(rng, 6, 10);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const deps = [];
    const depCount = i === 0 ? 0 : randInt(rng, 1, Math.min(2, i));
    const used = new Set();
    while (deps.length < depCount) {
      const d = randInt(rng, 0, i - 1);
      const depId = `mx${idx}_${d}`;
      if (!used.has(depId)) {
        used.add(depId);
        deps.push(depId);
      }
    }
    jobs.push({
      id: `mx${idx}_${i}`,
      duration: randInt(rng, 1, 4),
      demand: [randInt(rng, 1, cap)],
      deps,
    });
  }
  if (!isAcyclic(jobs)) {
    jobs[jobs.length - 1].deps = [];
  }
  return { resources: [cap], jobs };
}

function isAcyclic(jobs) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const state = new Map();
  function visit(id) {
    const s = state.get(id) ?? 0;
    if (s === 1) return false;
    if (s === 2) return true;
    state.set(id, 1);
    for (const d of byId.get(id).deps) {
      if (!visit(d)) return false;
    }
    state.set(id, 2);
    return true;
  }
  for (const j of jobs) {
    if (!visit(j.id)) return false;
  }
  return true;
}

function makeAdversarialCase(rng, idx) {
  const variant = idx % 3;
  if (variant === 0) {
    const a = `ad${idx}_A`;
    return {
      resources: [3, 3],
      jobs: [
        { id: a, duration: 3, demand: [3, 0], deps: [] },
        { id: `ad${idx}_B`, duration: 3, demand: [0, 3], deps: [] },
        { id: `ad${idx}_C`, duration: 2, demand: [2, 2], deps: [] },
        { id: `ad${idx}_D`, duration: 2, demand: [2, 2], deps: [a] },
      ],
    };
  }
  if (variant === 1) {
    const jobs = [];
    for (let i = 0; i < 8; i++) {
      jobs.push({
        id: `ad${idx}_j${i}`,
        duration: 1,
        demand: [2],
        deps: i > 0 && i % 3 === 0 ? [`ad${idx}_j${i - 1}`] : [],
      });
    }
    return { resources: [3], jobs };
  }
  return {
    resources: [4],
    jobs: [
      { id: `ad${idx}_x`, duration: 4, demand: [3], deps: [] },
      { id: `ad${idx}_y`, duration: 1, demand: [3], deps: [`ad${idx}_x`] },
      { id: `ad${idx}_z`, duration: 1, demand: [3], deps: [] },
      { id: `ad${idx}_w`, duration: 1, demand: [3], deps: [] },
    ],
  };
}

function generateHiddenCases() {
  const rng = mulberry32(BENCHMARK_SEED);
  const cases = [];

  for (let i = 0; i < 12; i++) {
    cases.push({
      id: `chains-${String(i).padStart(2, "0")}`,
      group: "chains",
      weight: DEFAULT_CASE_WEIGHT,
      instance: makeChainCase(rng, i),
    });
  }
  for (let i = 0; i < 12; i++) {
    cases.push({
      id: `forks-${String(i).padStart(2, "0")}`,
      group: "forks",
      weight: DEFAULT_CASE_WEIGHT,
      instance: makeForkCase(rng, i),
    });
  }
  for (let i = 0; i < 12; i++) {
    cases.push({
      id: `packing-${String(i).padStart(2, "0")}`,
      group: "packing",
      weight: DEFAULT_CASE_WEIGHT,
      instance: makePackingCase(rng, i),
    });
  }
  for (let i = 0; i < 8; i++) {
    cases.push({
      id: `mixed-dag-${String(i).padStart(2, "0")}`,
      group: "mixed-dag",
      weight: DEFAULT_CASE_WEIGHT,
      instance: makeMixedDagCase(rng, i),
    });
  }
  for (let i = 0; i < 4; i++) {
    cases.push({
      id: `adversarial-${String(i).padStart(2, "0")}`,
      group: "adversarial",
      weight: DEFAULT_CASE_WEIGHT,
      instance: makeAdversarialCase(rng, i),
    });
  }
  cases.push({
    id: "calibration-gap-00",
    group: "calibration",
    weight: CALIBRATION_CASE_WEIGHT,
    instance: deepClone(CALIBRATION_INSTANCE),
    gap: { lowerBound: 2, provenOptimum: 3 },
  });

  if (cases.length < 48) {
    throw new Error(`case generator produced only ${cases.length} cases`);
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Mathematical ceiling (proven safe upper bound, possibly not tight)
// ---------------------------------------------------------------------------

function computeMathematicalCeiling(cases) {
  let wSum = 0;
  let qualityNumer = 0;
  for (const c of cases) {
    const lb = theoreticalLowerBound(c.instance);
    const opt = c.gap?.provenOptimum ?? lb;
    const bestRatio = lb / opt;
    qualityNumer += c.weight * bestRatio;
    wSum += c.weight;
  }
  const maxQualityFraction = qualityNumer / wSum;
  return {
    maxOverallScore: FEASIBILITY_WEIGHT + QUALITY_WEIGHT * maxQualityFraction,
    maxFeasibilityPoints: FEASIBILITY_WEIGHT,
    maxQualityPoints: QUALITY_WEIGHT * maxQualityFraction,
    maxQualityFraction,
    totalCaseWeight: wSum,
  };
}

// ---------------------------------------------------------------------------
// Worker-based per-case execution (hard 400ms combined budget)
// ---------------------------------------------------------------------------

function runCaseInWorker(schedulerPath, instance) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { schedulerPath },
    });

    let settled = false;
    let caseTimer = null;
    let readyTimer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (caseTimer) clearTimeout(caseTimer);
      if (readyTimer) clearTimeout(readyTimer);
      worker.terminate().catch(() => {});
      resolve(payload);
    };

    readyTimer = setTimeout(() => {
      finish({
        kind: "worker_boot_timeout",
        error: `worker failed to become ready within ${WORKER_READY_TIMEOUT_MS}ms`,
        elapsedMs: WORKER_READY_TIMEOUT_MS,
      });
    }, WORKER_READY_TIMEOUT_MS);

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        clearTimeout(readyTimer);
        readyTimer = null;
        caseTimer = setTimeout(() => {
          finish({
            kind: "timeout",
            error: `combined solve budget exceeded ${PER_CASE_TIMEOUT_MS}ms (worker terminated)`,
            elapsedMs: PER_CASE_TIMEOUT_MS,
          });
        }, PER_CASE_TIMEOUT_MS);
        worker.postMessage({ type: "solve", instance: deepClone(instance) });
        return;
      }

      if (msg.type === "fatal") {
        finish({
          kind: "worker_fatal",
          error: msg.error,
          elapsedMs: 0,
        });
        return;
      }

      if (msg.type === "result") {
        if (msg.elapsedMs > PER_CASE_TIMEOUT_MS) {
          finish({
            kind: "timeout",
            error: `combined solve calls took ${round(msg.elapsedMs, 2)}ms > ${PER_CASE_TIMEOUT_MS}ms`,
            elapsedMs: msg.elapsedMs,
            partial: msg,
          });
          return;
        }
        finish({
          kind: "completed",
          ...msg,
        });
      }
    });

    worker.on("error", (err) => {
      finish({
        kind: "worker_error",
        error: err?.message ?? String(err),
        elapsedMs: 0,
      });
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        finish({
          kind: "worker_exit",
          error: `worker exited with code ${code}`,
          elapsedMs: 0,
        });
      }
    });
  });
}

function classifyFailure(result) {
  if (result.kind === "timeout" || result.kind === "worker_boot_timeout") {
    return "timeout";
  }
  if (result.kind === "worker_fatal" || result.kind === "worker_error" || result.kind === "worker_exit") {
    return "worker";
  }
  if (!result.ok) return "threw";
  if (result.inputMutated) return "input_mutated";
  if (!schedulesEqual(result.schedule1, result.schedule2)) return "nondeterministic";
  return "validation";
}

async function gradeCase(schedulerPath, testCase) {
  const { id, group, weight, instance } = testCase;
  const result = {
    id,
    group,
    weight,
    feasible: false,
    failureKind: null,
    errors: [],
    makespan: null,
    lowerBound: theoreticalLowerBound(instance),
    qualityRatio: 0,
    runtimeMs: 0,
    determinismOk: false,
    inputMutated: false,
    timedOut: false,
  };

  const workerResult = await runCaseInWorker(schedulerPath, instance);
  result.runtimeMs = workerResult.elapsedMs ?? 0;

  if (workerResult.kind !== "completed") {
    result.failureKind = classifyFailure(workerResult);
    result.timedOut = result.failureKind === "timeout";
    result.errors.push(workerResult.error ?? workerResult.kind);
    return result;
  }

  if (!workerResult.ok) {
    result.failureKind = "threw";
    result.errors.push(`solve threw: ${workerResult.error}`);
    return result;
  }

  result.inputMutated = workerResult.inputMutated;
  if (result.inputMutated) {
    result.failureKind = "input_mutated";
    result.errors.push("solve() mutated input instance");
  }

  result.determinismOk = schedulesEqual(workerResult.schedule1, workerResult.schedule2);
  if (!result.determinismOk) {
    result.failureKind = result.failureKind ?? "nondeterministic";
    result.errors.push("nondeterministic output across two calls");
  }

  const valErrors = validateSchedule(instance, workerResult.schedule1);
  if (valErrors.length > 0) {
    result.failureKind = result.failureKind ?? "validation";
    result.errors.push(...valErrors);
  }

  if (result.errors.length === 0) {
    result.feasible = true;
    result.makespan = scheduleMakespan(instance, workerResult.schedule1);
    result.qualityRatio = Math.min(1, result.lowerBound / result.makespan);
  } else if (!result.failureKind) {
    result.failureKind = "validation";
  }

  return result;
}

// ---------------------------------------------------------------------------
// Grading loop
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let root = null;
  let out = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      root = resolve(argv[++i]);
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out = resolve(argv[++i]);
    }
  }
  if (!root || !out) {
    throw new Error("Usage: node grade.mjs --root <arm-root> --out <results.json>");
  }
  return { root, out };
}

export async function grade(root, outPath) {
  runStartupAssertions();
  const cases = generateHiddenCases();
  const ceiling = computeMathematicalCeiling(cases);
  const schedulerPath = join(root, "src", "scheduler.mjs");

  const started = performance.now();
  const caseResults = [];

  for (const tc of cases) {
    caseResults.push(await gradeCase(schedulerPath, tc));
  }

  const totalRuntimeMs = performance.now() - started;
  const feasibleCases = caseResults.filter((r) => r.feasible);
  const invalidCases = caseResults
    .filter((r) => !r.feasible)
    .map((r) => ({
      id: r.id,
      group: r.group,
      failureKind: r.failureKind,
      timedOut: r.timedOut,
      errors: r.errors,
    }));

  const failureDecomposition = {
    totalInvalid: invalidCases.length,
    timeout: caseResults.filter((r) => r.failureKind === "timeout").length,
    threw: caseResults.filter((r) => r.failureKind === "threw").length,
    validation: caseResults.filter((r) => r.failureKind === "validation").length,
    nondeterministic: caseResults.filter((r) => r.failureKind === "nondeterministic").length,
    inputMutated: caseResults.filter((r) => r.failureKind === "input_mutated").length,
    worker: caseResults.filter((r) => r.failureKind === "worker").length,
    otherInvalid: caseResults.filter(
      (r) =>
        !r.feasible &&
        !["timeout", "threw", "validation", "nondeterministic", "input_mutated", "worker"].includes(
          r.failureKind,
        ),
    ).length,
  };

  const feasibilityFraction = feasibleCases.length / caseResults.length;
  const feasibilityPoints = FEASIBILITY_WEIGHT * feasibilityFraction;

  let qualityNumer = 0;
  let weightSum = 0;
  const groupBreakdown = {};

  for (const r of caseResults) {
    if (!groupBreakdown[r.group]) {
      groupBreakdown[r.group] = {
        cases: 0,
        feasible: 0,
        qualityAllSum: 0,
        qualityFeasibleSum: 0,
      };
    }
    const g = groupBreakdown[r.group];
    g.cases++;
    weightSum += r.weight;
    if (r.feasible) {
      g.feasible++;
      g.qualityFeasibleSum += r.qualityRatio;
      qualityNumer += r.weight * r.qualityRatio;
    }
    g.qualityAllSum += r.feasible ? r.qualityRatio : 0;
  }

  for (const g of Object.values(groupBreakdown)) {
    g.avgQualityAllCases = g.cases > 0 ? round(g.qualityAllSum / g.cases, 4) : 0;
    g.avgQualityFeasibleCases =
      g.feasible > 0 ? round(g.qualityFeasibleSum / g.feasible, 4) : 0;
    delete g.qualityAllSum;
    delete g.qualityFeasibleSum;
  }

  const qualityFraction = weightSum > 0 ? qualityNumer / weightSum : 0;
  const qualityPoints = QUALITY_WEIGHT * qualityFraction;
  const overallScore = feasibilityPoints + qualityPoints;

  const runtimes = caseResults.map((r) => r.runtimeMs).sort((a, b) => a - b);
  const avgRuntimeMs =
    runtimes.reduce((a, b) => a + b, 0) / (runtimes.length || 1);
  const p95RuntimeMs =
    runtimes[Math.min(runtimes.length - 1, Math.floor(runtimes.length * 0.95))] ?? 0;

  const report = {
    overallScore: round(overallScore, 2),
    feasibilityPoints: round(feasibilityPoints, 2),
    qualityPoints: round(qualityPoints, 2),
    feasibilityFraction: round(feasibilityFraction, 4),
    qualityFraction: round(qualityFraction, 4),
    mathematicalCeiling: {
      maxOverallScore: round(ceiling.maxOverallScore, 2),
      maxQualityFraction: round(ceiling.maxQualityFraction, 4),
      note:
        "Proven safe upper bound (possibly not tight): quality uses the theoretical lower bound, and the calibration case has a proven integrality gap (LB=2, optimum=3). An optimum solver may score below this bound.",
    },
    failureDecomposition,
    groupBreakdown,
    invalidCases,
    runtime: {
      totalMs: round(totalRuntimeMs, 2),
      averageMs: round(avgRuntimeMs, 3),
      p95Ms: round(p95RuntimeMs, 3),
      perCaseBudgetMs: PER_CASE_TIMEOUT_MS,
    },
    metadata: {
      benchmark: "planner-vs-direct",
      seed: BENCHMARK_SEED,
      caseCount: cases.length,
      gradedAt: new Date().toISOString(),
      node: process.version,
      root,
      nRunsPerArm: 1,
      nRunsNote: "Single run per arm (n=1); outcomes are indicative, not statistically conclusive.",
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

function round(x, digits) {
  const m = 10 ** digits;
  return Math.round(x * m) / m;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { root, out } = parseArgs(process.argv);
  grade(root, out)
    .then((r) => {
      console.log(
        `grade: score=${r.overallScore}/100 (feasibility=${r.feasibilityPoints}, quality=${r.qualityPoints}) safeUpperBound=${r.mathematicalCeiling.maxOverallScore}`,
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
