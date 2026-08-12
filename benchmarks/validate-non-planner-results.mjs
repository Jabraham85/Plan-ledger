#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const auditsDir = join(repoRoot, 'docs', 'audits');

const pass1Path = join(auditsDir, '.non-planner-pass-1.json');
const pass2Path = join(auditsDir, '.non-planner-pass-2.json');
const consolidatedJsonPath = join(auditsDir, 'plan-ledger-performance-results.json');
const consolidatedMdPath = join(auditsDir, 'plan-ledger-performance.md');

const requiredLocalIds = [
  'node_process_startup_baseline',
  'cli_help_module_load',
  'cli_roundtrip_list_plans_cold',
  'cli_roundtrip_list_plans_warm',
  'db_open_cold',
  'db_open_warm',
  'read_list_plans',
  'read_open_plan',
  'read_get_step',
  'write_add_step',
  'write_update_step',
  'write_record_attempt',
  'next_step_peek',
  'ready_steps_peek',
  'list_cursor_models_local_env_override',
  'resolve_role_local',
  'get_plan_roster_local',
  'execution_lease_open',
  'execution_lease_heartbeat',
  'execution_lease_close',
  'activity_start',
  'activity_append_event',
  'runner_preflight_local',
  'board_server_startup',
  'board_api_meta',
  'board_api_plans',
  'board_api_plan_detail',
  'board_page_index',
];

function fail(msg) {
  console.error(`VALIDATION_FAIL: ${msg}`);
  process.exit(1);
}

function assertFile(path) {
  if (!existsSync(path)) fail(`missing required file: ${path}`);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validatePass(run, name) {
  if (!Array.isArray(run.benchmarks)) fail(`${name}: benchmarks is not an array`);
  for (const id of requiredLocalIds) {
    const row = run.benchmarks.find((b) => b.id === id);
    if (!row) fail(`${name}: missing benchmark '${id}'`);
    const n = row?.stats?.n ?? 0;
    if (n < 30) fail(`${name}: benchmark '${id}' has n=${n}, expected >= 30`);
  }
  const guard = run.production_db_guard || {};
  if (guard.path_isolation_verified !== true) fail(`${name}: production path isolation not verified`);
  if (guard.production_identity_used_by_benchmark !== false) fail(`${name}: production identity used by benchmark`);
}

function validateNoGarbledAscii(text, label) {
  if (text.includes('ΓÇö')) fail(`${label}: contains garbled 'ΓÇö'`);
  if (text.includes('—')) fail(`${label}: contains non-ASCII em dash`);
}

assertFile(pass1Path);
assertFile(pass2Path);
assertFile(consolidatedJsonPath);
assertFile(consolidatedMdPath);

const pass1 = loadJson(pass1Path);
const pass2 = loadJson(pass2Path);
const consolidated = loadJson(consolidatedJsonPath);
const consolidatedMd = readFileSync(consolidatedMdPath, 'utf8');

validatePass(pass1, 'pass-1');
validatePass(pass2, 'pass-2');

if (!Array.isArray(consolidated.commands) || consolidated.commands.length < 2) {
  fail('consolidated report: commands[] missing or too short');
}
for (const c of consolidated.commands) {
  if (typeof c.command !== 'string' || !c.command.trim()) fail('consolidated report: invalid command entry');
  if (c.exit_code !== 0) fail(`consolidated report: non-zero exit code for '${c.command}'`);
  validateNoGarbledAscii(String(c.output || ''), 'consolidated command output');
}

validateNoGarbledAscii(JSON.stringify(consolidated), 'consolidated JSON');
validateNoGarbledAscii(consolidatedMd, 'consolidated markdown');

console.log('VALIDATION_OK: raw pass files exist and meet >=30 local samples each');
console.log('VALIDATION_OK: consolidated report exists, has reproducible commands, and no garbled dash text');
