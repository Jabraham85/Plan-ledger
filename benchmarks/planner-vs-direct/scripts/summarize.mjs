#!/usr/bin/env node
/**
 * Combine two grade JSON reports into results/summary.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(__dirname, "..");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  let direct = null;
  let planner = null;
  let out = join(benchmarkRoot, "results", "summary.json");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--direct" && argv[i + 1]) direct = resolve(argv[++i]);
    else if (argv[i] === "--planner" && argv[i + 1]) planner = resolve(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) out = resolve(argv[++i]);
  }
  if (!direct || !planner) {
    throw new Error(
      "Usage: node summarize.mjs --direct <direct.json> --planner <planner.json> [--out summary.json]",
    );
  }
  return { direct, planner, out };
}

function delta(a, b) {
  return round(a - b, 2);
}

function round(x, d) {
  return Math.round(x * 10 ** d) / 10 ** d;
}

function armSummary(report) {
  const fd = report.failureDecomposition ?? {};
  return {
    overallScore: report.overallScore,
    feasibilityPoints: report.feasibilityPoints,
    qualityPoints: report.qualityPoints,
    feasibilityFraction: report.feasibilityFraction,
    qualityFraction: report.qualityFraction,
    invalidCaseCount: report.invalidCases?.length ?? 0,
    failureDecomposition: {
      timeout: fd.timeout ?? 0,
      threw: fd.threw ?? 0,
      validation: fd.validation ?? 0,
      nondeterministic: fd.nondeterministic ?? 0,
      inputMutated: fd.inputMutated ?? 0,
      worker: fd.worker ?? 0,
      otherInvalid: fd.otherInvalid ?? 0,
    },
    runtimeMs: report.runtime?.totalMs,
  };
}

const { direct: directPath, planner: plannerPath, out } = parseArgs(process.argv);
const direct = loadJson(directPath);
const planner = loadJson(plannerPath);

const safeUpperBound =
  direct.mathematicalCeiling?.maxOverallScore ??
  planner.mathematicalCeiling?.maxOverallScore;

const summary = {
  benchmark: "planner-vs-direct",
  comparedAt: new Date().toISOString(),
  statisticalNote:
    "n=1 per arm (single session each). Observed score deltas are indicative only; this protocol does not establish causal attribution between prompt style and outcomes.",
  orchestrationControls: {
    note:
      "Same model and tool access across arms are orchestration controls recorded by the operator. They are not independently auditable from benchmark artifacts alone.",
    promptTreatment:
      "Direct arm forbids planning artifacts; planner arm requires explicit decomposition, staged verification, and reassessment before/during implementation.",
  },
  direct: armSummary(direct),
  planner: armSummary(planner),
  comparison: {
    scoreDeltaPlannerMinusDirect: delta(planner.overallScore, direct.overallScore),
    feasibilityDelta: delta(planner.feasibilityPoints, direct.feasibilityPoints),
    qualityDelta: delta(planner.qualityPoints, direct.qualityPoints),
    timeoutDelta: delta(
      (planner.failureDecomposition?.timeout ?? 0),
      (direct.failureDecomposition?.timeout ?? 0),
    ),
    otherInvalidDelta: delta(
      (planner.invalidCases?.length ?? 0) - (planner.failureDecomposition?.timeout ?? 0),
      (direct.invalidCases?.length ?? 0) - (direct.failureDecomposition?.timeout ?? 0),
    ),
    safeUpperBound,
    safeUpperBoundNote:
      "Proven safe upper bound on overall score (possibly not tight). Quality is scored against theoretical lower bounds, not true optima; the calibration case has a proven integrality gap.",
  },
  sources: { direct: directPath, planner: plannerPath },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n", "utf8");

console.log("planner-vs-direct summary");
console.log("  NOTE: n=1 per arm — indicative only, not causal");
console.log(
  `  direct:   ${summary.direct.overallScore} (F=${summary.direct.feasibilityPoints} Q=${summary.direct.qualityPoints}) invalid=${summary.direct.invalidCaseCount} timeout=${summary.direct.failureDecomposition.timeout}`,
);
console.log(
  `  planner:  ${summary.planner.overallScore} (F=${summary.planner.feasibilityPoints} Q=${summary.planner.qualityPoints}) invalid=${summary.planner.invalidCaseCount} timeout=${summary.planner.failureDecomposition.timeout}`,
);
console.log(`  delta:    ${summary.comparison.scoreDeltaPlannerMinusDirect} (planner - direct)`);
console.log(
  `  failures: timeoutΔ=${summary.comparison.timeoutDelta} otherInvalidΔ=${summary.comparison.otherInvalidDelta}`,
);
console.log(
  `  safe upper bound: ${summary.comparison.safeUpperBound} (possibly not tight)`,
);
console.log(`  wrote:    ${out}`);
