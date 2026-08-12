#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, defaultDbPath } from "../../../src/db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(__dirname, "..");
const armRoot = join(benchmarkRoot, "arms", "multichat");
const store = new Store(defaultDbPath());

try {
  const project = store.createProject({
    name: `Planner multichat benchmark ${new Date().toISOString()}`,
    description: "Visible top-level Cursor chats coordinated through Plan-ledger.",
  });
  const plan = store.createPlan({
    project_id: project.id,
    title: "Solve scheduling benchmark with visible specialist chats",
    keywords: ["benchmark", "multichat", "specialists", "scheduler"],
    summary: "Each role runs in a new top-level Cursor chat with a visibly selected model.",
  });

  const architect = store.addStep(plan.id, {
    title: "Design the bounded scheduling algorithm",
    role: "architect",
    tools: ["read", "plan-ledger"],
    context: `Arm root: ${armRoot}\nRead specialists/scheduling-architect.md from the benchmark root. Read only task-spec.md, public-smoke.mjs, and the scheduler stub. Do not edit files or inspect grader/results/other arms.`,
    acceptance_criteria: "A sub-500-word handoff specifies one deterministic feasible algorithm, stable tie-breakers, bounded complexity, risks, and verification.",
  });
  const implementer = store.addStep(plan.id, {
    title: "Implement the accepted scheduler design",
    role: "implementer",
    tools: ["edit", "shell", "plan-ledger"],
    context: `Arm root: ${armRoot}\nRead specialists/scheduler-implementer.md from the benchmark root. Edit only src/scheduler.mjs. Use the architect's carry-forward; do not inspect grader/results/other arms.`,
    acceptance_criteria: "Only src/scheduler.mjs changes; public-smoke reports 3/3 passed; implementation is deterministic, pure, feasible, and finitely bounded.",
  });
  const tester = store.addStep(plan.id, {
    title: "Audit scheduler correctness and measured runtime",
    role: "test-engineer",
    tools: ["read", "shell", "plan-ledger"],
    context: `Arm root: ${armRoot}\nRead specialists/schedule-test-engineer.md from the benchmark root. Do not edit files or inspect grader/results/other arms. Run public and focused black-box checks plus one moderate stress measurement.`,
    acceptance_criteria: "Evidence covers completeness, dependencies, capacities, purity, determinism, edge cases, and measured runtime; verdict is pass, correction required, or performance review required.",
  });
  const performance = store.addStep(plan.id, {
    title: "Optimize only if the test gate measured a performance risk",
    role: "perf-engineer",
    tools: ["read", "edit", "shell", "plan-ledger"],
    context: `Arm root: ${armRoot}\nRead specialists/scheduler-perf-engineer.md from the benchmark root. Dispatch only if step ${tester.id} provides a reproducible performance concern; otherwise mark this step skipped.`,
    acceptance_criteria: "Either skipped with the test evidence cited, or a measured hotspot is improved with before/after numbers and public smoke remains green.",
  });

  store.link(implementer.id, { to_step_id: architect.id, relation: "builds_on", note: "Requires architecture handoff." });
  store.link(tester.id, { to_step_id: implementer.id, relation: "builds_on", note: "Tests the completed implementation." });
  store.link(performance.id, { to_step_id: tester.id, relation: "builds_on", note: "Conditional on measured test evidence." });
  store.setPlanStatus(plan.id, "active");

  const dispatch = {
    projectId: project.id,
    planId: plan.id,
    armRoot,
    steps: {
      architect: architect.id,
      implementer: implementer.id,
      tester: tester.id,
      performance: performance.id,
    },
  };
  writeFileSync(join(armRoot, "dispatch.json"), JSON.stringify(dispatch, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(dispatch, null, 2));
} finally {
  store.close();
}
