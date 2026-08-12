#!/usr/bin/env node
/**
 * Reset only the multi-agent orchestration arm from the frozen task template.
 * Existing direct/planner arm implementations are intentionally untouched.
 */
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(__dirname, "..");
const destination = join(benchmarkRoot, "arms", "orchestrated");

if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}
mkdirSync(dirname(destination), { recursive: true });
cpSync(join(benchmarkRoot, "task-template"), destination, { recursive: true });
cpSync(join(benchmarkRoot, "task-spec.md"), join(destination, "task-spec.md"));

console.log("setup: copied task-template -> arms/orchestrated");
console.log("setup: direct/planner arms untouched; grader not exposed");
