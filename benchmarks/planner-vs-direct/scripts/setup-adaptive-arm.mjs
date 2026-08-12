#!/usr/bin/env node
/**
 * Reset the cost-aware specialist arm from the frozen task template.
 * Existing benchmark arms and the hidden grader are intentionally untouched.
 */
import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(__dirname, "..");
const destination = join(benchmarkRoot, "arms", "adaptive");

if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}
mkdirSync(dirname(destination), { recursive: true });
cpSync(join(benchmarkRoot, "task-template"), destination, { recursive: true });
cpSync(join(benchmarkRoot, "task-spec.md"), join(destination, "task-spec.md"));

const relativeSpecialists = "../../specialists";
writeFileSync(
  join(destination, ".plan-roles.json"),
  JSON.stringify(
    {
      roles: {
        "scheduling-architect": {
          agent: "generalPurpose",
          charter: `${relativeSpecialists}/scheduling-architect.md`,
          model: "gpt-5-mini",
          note: "Short read-only design pass.",
        },
        "scheduler-implementer": {
          agent: "generalPurpose",
          charter: `${relativeSpecialists}/scheduler-implementer.md`,
          model: "gpt-5.3-codex",
          note: "Code-specialized implementation and correction rounds.",
        },
        "schedule-test-engineer": {
          agent: "generalPurpose",
          charter: `${relativeSpecialists}/schedule-test-engineer.md`,
          model: "gpt-5-mini",
          note: "Read-only black-box contract audit.",
        },
        "scheduler-perf-engineer": {
          agent: "generalPurpose",
          charter: `${relativeSpecialists}/scheduler-perf-engineer.md`,
          model: "gpt-5.3-codex",
          note: "Conditional: dispatch only from measured test evidence.",
        },
      },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log("setup: copied task-template -> arms/adaptive");
console.log("setup: wrote adaptive role map; direct/planner/orchestrated arms untouched");
console.log("setup: hidden grader not exposed");
