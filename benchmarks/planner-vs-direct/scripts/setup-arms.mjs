#!/usr/bin/env node
/**
 * Reset arm workspaces from task-template (grader stays hidden).
 */
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(__dirname, "..");
const templateRoot = join(benchmarkRoot, "task-template");
const armsRoot = join(benchmarkRoot, "arms");

const ARMS = ["direct", "planner"];

function copyTemplate(dest) {
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(templateRoot, dest, { recursive: true });
  // Symlink or copy task-spec at arm root for convenience
  cpSync(join(benchmarkRoot, "task-spec.md"), join(dest, "task-spec.md"));
}

mkdirSync(armsRoot, { recursive: true });
for (const arm of ARMS) {
  const dest = join(armsRoot, arm);
  copyTemplate(dest);
  console.log(`setup: copied task-template -> arms/${arm}`);
}

console.log("setup: complete (grader not exposed to arms)");
