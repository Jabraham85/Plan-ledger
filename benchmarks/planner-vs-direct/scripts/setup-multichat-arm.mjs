#!/usr/bin/env node
/**
 * Reset the manually dispatched, top-level-chat arm from the frozen template.
 * Model selection happens visibly in each new Cursor chat.
 */
import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(__dirname, "..");
const destination = join(benchmarkRoot, "arms", "multichat");

if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}
mkdirSync(dirname(destination), { recursive: true });
cpSync(join(benchmarkRoot, "task-template"), destination, { recursive: true });
cpSync(join(benchmarkRoot, "task-spec.md"), join(destination, "task-spec.md"));

writeFileSync(
  join(destination, ".plan-roles.json"),
  JSON.stringify(
    {
      roles: {
        architect: {
          charter: "../../specialists/scheduling-architect.md",
          model: "gpt-5-mini",
          note: "Select GPT-5 Mini visibly in a new top-level Cursor chat.",
        },
        implementer: {
          charter: "../../specialists/scheduler-implementer.md",
          model: "gpt-5.3-codex",
          note: "Select GPT-5.3 Codex visibly in a new top-level Cursor chat.",
        },
        "test-engineer": {
          charter: "../../specialists/schedule-test-engineer.md",
          model: "gpt-5-mini",
          note: "Select GPT-5 Mini visibly in a new top-level Cursor chat.",
        },
        "perf-engineer": {
          charter: "../../specialists/scheduler-perf-engineer.md",
          model: "gpt-5.3-codex",
          note: "Open only when measured test evidence requires it.",
        },
      },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log("setup: copied task-template -> arms/multichat");
console.log("setup: model selection is manual and visible in each top-level chat");
console.log("setup: hidden grader not exposed");
