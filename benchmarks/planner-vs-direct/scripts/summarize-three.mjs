#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (argv[i]?.startsWith("--") && argv[i + 1]) args[argv[i].slice(2)] = resolve(argv[i + 1]);
  }
  if (!args.direct || !args.planner || !args.orchestrated || !args.out) {
    throw new Error("Usage: summarize-three.mjs --direct <json> --planner <json> --orchestrated <json> --out <json>");
  }
  return args;
}

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function arm(report) {
  return {
    score: report.overallScore,
    feasibilityPoints: report.feasibilityPoints,
    qualityPoints: report.qualityPoints,
    feasibleCases: report.metadata.caseCount - report.failureDecomposition.totalInvalid,
    totalCases: report.metadata.caseCount,
    timeouts: report.failureDecomposition.timeout,
    averageSolveMs: report.runtime.averageMs,
    p95SolveMs: report.runtime.p95Ms,
    totalGradeMs: report.runtime.totalMs,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

const paths = parseArgs(process.argv);
const direct = read(paths.direct);
const planner = read(paths.planner);
const orchestrated = read(paths.orchestrated);

const summary = {
  benchmark: "planner-vs-direct-with-agent-handoffs",
  statisticalNote: "One generated implementation per treatment (n=1); indicative only.",
  treatments: {
    direct: "One agent, explicit planning artifacts forbidden.",
    planner: "One agent, explicit decomposition and staged reassessment required.",
    orchestrated: "Fresh architect -> implementer -> test-engineer correction -> performance-engineer handoffs.",
  },
  direct: arm(direct),
  planner: arm(planner),
  orchestrated: arm(orchestrated),
  comparison: {
    orchestratedMinusDirectScore: round(orchestrated.overallScore - direct.overallScore),
    orchestratedMinusPlannerScore: round(orchestrated.overallScore - planner.overallScore),
    orchestratedVsPlannerAverageSolveSpeedup: round(planner.runtime.averageMs / orchestrated.runtime.averageMs),
    orchestratedVsPlannerP95SolveSpeedup: round(planner.runtime.p95Ms / orchestrated.runtime.p95Ms),
    safeUpperBound: orchestrated.mathematicalCeiling.maxOverallScore,
  },
  sources: paths,
};

mkdirSync(dirname(paths.out), { recursive: true });
writeFileSync(paths.out, JSON.stringify(summary, null, 2) + "\n", "utf8");

console.log(`direct:       ${summary.direct.score} (${summary.direct.feasibleCases}/${summary.direct.totalCases} feasible)`);
console.log(`planner:      ${summary.planner.score} (${summary.planner.feasibleCases}/${summary.planner.totalCases} feasible)`);
console.log(`orchestrated: ${summary.orchestrated.score} (${summary.orchestrated.feasibleCases}/${summary.orchestrated.totalCases} feasible)`);
console.log(`orchestrated score delta vs planner: ${summary.comparison.orchestratedMinusPlannerScore}`);
console.log(`orchestrated average solve speedup vs planner: ${summary.comparison.orchestratedVsPlannerAverageSolveSpeedup}x`);
