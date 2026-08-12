#!/usr/bin/env node
// sync-global-skill.mjs — install/update the user-global /plan-ledger skill from the repo
// canonical template. Injects absolute Node + repo paths so the skill never silently drifts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const CANONICAL_SKILL = join(REPO_ROOT, '.cursor', 'skills', 'plan-ledger', 'SKILL.md');
const GLOBAL_SKILL_DIR = join(homedir(), '.cursor', 'skills', 'plan-ledger');
const GLOBAL_SKILL = join(GLOBAL_SKILL_DIR, 'SKILL.md');
const GLOBAL_COMPACT = join(GLOBAL_SKILL_DIR, 'SKILL.compact.md');
const BRIDGE_MANIFEST = join(homedir(), '.cursor', 'plan-ledger-bridge.json');

const NODE = process.env.PLAN_LEDGER_NODE || process.execPath;
const CLI = join(REPO_ROOT, 'src', 'ledger-cli.mjs');

function substitute(template) {
  return template
    .replaceAll('{{PLAN_LEDGER_NODE}}', NODE.replace(/\\/g, '\\\\'))
    .replaceAll('{{PLAN_LEDGER_REPO}}', REPO_ROOT.replace(/\\/g, '\\\\'))
    .replaceAll('{{PLAN_LEDGER_CLI}}', CLI.replace(/\\/g, '\\\\'));
}

function extractCompact(fullSkill) {
  const start = fullSkill.indexOf('\n# plan-ledger working discipline');
  const bridgeStart = fullSkill.indexOf('\n## Bridge invocation');
  const approvalStart = fullSkill.indexOf('\n## Mandatory approval boundary');
  if (start === -1 || bridgeStart === -1 || approvalStart === -1) {
    throw new Error('canonical skill missing expected section anchors');
  }
  const frontmatterEnd = fullSkill.indexOf('---', 4);
  const frontmatter = fullSkill.slice(0, frontmatterEnd + 3);
  const bridge = fullSkill.slice(bridgeStart, approvalStart);
  const approval = fullSkill.slice(approvalStart, fullSkill.indexOf('\n## Roles', approvalStart));
  const parallelStart = fullSkill.indexOf('\n## Parallel orchestration');
  const executionStart = fullSkill.indexOf('\n## Execution dispatch');
  const execAnchor = parallelStart !== -1 ? parallelStart : executionStart;
  if (execAnchor === -1) {
    throw new Error('canonical skill missing Parallel orchestration or Execution dispatch section');
  }
  const execution = fullSkill.slice(execAnchor);
  return `${frontmatter}

# Plan-ledger

Use the JSON CLI bridge (\`src/ledger-cli.mjs\`) as external working memory — **not** the
\`plan-ledger\` MCP server. This skill is available in every workspace as \`/plan-ledger\`;
Cursor's built-in \`/plan\` remains separate.

The canonical, fully detailed operating discipline is:
\`${CANONICAL_SKILL.replace(/\\/g, '/')}\`

Read that file first when it exists and follow it. The rules below are the required fallback if
the checkout is temporarily unavailable.

${bridge.trim()}

${approval.trim()}

${execution.trim()}
`;
}

function main() {
  const template = readFileSync(CANONICAL_SKILL, 'utf8');
  if (!template.includes('{{PLAN_LEDGER_NODE}}')) {
    throw new Error(`${CANONICAL_SKILL} must keep {{PLAN_LEDGER_NODE}} placeholders — restore the template before syncing`);
  }
  const resolved = substitute(template);
  mkdirSync(GLOBAL_SKILL_DIR, { recursive: true });
  const compact = extractCompact(resolved);
  writeFileSync(GLOBAL_SKILL, compact, 'utf8');
  writeFileSync(GLOBAL_COMPACT, compact, 'utf8');
  writeFileSync(BRIDGE_MANIFEST, `${JSON.stringify({
    node: NODE,
    cli: CLI,
    repo: REPO_ROOT,
    global_skill: GLOBAL_SKILL,
    canonical_skill: CANONICAL_SKILL,
    synced_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  process.stdout.write(`sync-global-skill OK\n  canonical: ${CANONICAL_SKILL}\n  global:    ${GLOBAL_SKILL}\n  manifest:  ${BRIDGE_MANIFEST}\n`);
}

try {
  main();
} catch (error) {
  console.error(`[sync-global-skill] ${error.message}`);
  process.exitCode = 1;
}
