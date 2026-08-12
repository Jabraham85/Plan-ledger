// global-skill.mjs — validate user-global /plan-ledger skill + bridge manifest without
// destructively rewriting live Cursor config. Run: node test/global-skill.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(root, 'src', 'ledger-cli.mjs');
const canonicalSkill = join(root, '.cursor', 'skills', 'plan-ledger', 'SKILL.md');
const pluginSkill = join(root, 'plugin', 'skills', 'plan-ledger', 'SKILL.md');
const globalSkill = join(homedir(), '.cursor', 'skills', 'plan-ledger', 'SKILL.md');
const bridgeManifest = join(homedir(), '.cursor', 'plan-ledger-bridge.json');
const userMcp = join(homedir(), '.cursor', 'mcp.json');
const dbPath = join(tmpdir(), `plan-ledger-global-skill-db-${process.pid}.db`);
const outsideCwd = join(tmpdir(), `plan-ledger-outside-${process.pid}`);
const testPort = 45000 + (process.pid % 10000);

let pass = 0;
let boardPid = null;
const check = (label, cond) => { assert.ok(cond, label); console.log(`  ok  ${label}`); pass++; };

const STALE_PARALLEL_PATTERNS = [
  /DISPATCH THE WHOLE FRONTIER/i,
  /runner is still sequential/i,
  /documented follow-up/i,
  /single batch/i,
  /Promise\.all/i,
  /claim:true.*whole frontier/i,
  /atomically claims every/i,
];

const REQUIRED_PARALLEL_PATTERNS = [
  [/implementer-first/i, 'implementer-first dispatch'],
  [/continuous.*refill|refill.*slot|refill that slot/i, 'continuous slot refill'],
  [/OWNED_PATH|OWNED_GLOB/i, 'path ownership declarations'],
  [/worktree/i, 'git worktree isolation'],
  [/validate:r1-release/i, 'R1 release gate'],
  [/claim:false/i, 'peek-before-claim (claim:false)'],
  [/\blimit\b/i, 'ready_steps limit parameter'],
  [/automatic supervision|execution lease/i, 'automatic supervision / leases'],
  [/--parallel.*--inject|--inject.*--parallel|inject.*safe default/i, 'inject as safe parallel default'],
];

function assertParallelOperatingModel(label, text) {
  for (const pattern of STALE_PARALLEL_PATTERNS) {
    check(`${label} forbids stale pattern ${pattern}`, !pattern.test(text));
  }
  for (const [pattern, name] of REQUIRED_PARALLEL_PATTERNS) {
    check(`${label} documents ${name}`, pattern.test(text));
  }
}

const runCli = (operation, args, extraEnv = {}, cwd = outsideCwd) => {
  const env = {
    ...process.env,
    PLAN_LEDGER_DB: dbPath,
    PLAN_LEDGER_WEB_PORT: String(testPort),
    PLAN_LEDGER_NO_OPEN: '1',
    ...extraEnv,
  };
  const p = spawnSync(process.execPath, [cliPath, operation, '--input', JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf8',
  });
  let body;
  try { body = p.stdout.trim() ? JSON.parse(p.stdout) : null; } catch { body = null; }
  return { ...p, body, dbPath };
};

try {
  check('canonical skill exists', existsSync(canonicalSkill));
  const canonical = readFileSync(canonicalSkill, 'utf8');
  check('canonical skill keeps path placeholders', canonical.includes('{{PLAN_LEDGER_NODE}}')
    && canonical.includes('{{PLAN_LEDGER_CLI}}')
    && canonical.includes('{{PLAN_LEDGER_REPO}}'));
  check('canonical skill forbids MCP ledger tools', /Do \*\*not\*\* use `mcp__plan-ledger__\*`/i.test(canonical));
  check('canonical skill requires board open every invocation', /Visual board — every/i.test(canonical)
    && /"command":"open"/.test(canonical));
  check('canonical skill requires planner_start prior-plan discovery on new plans',
    /planner_start/i.test(canonical) && /consulted[_ -]?plan/i.test(canonical));
  check('canonical skill states chat update cadence + board telemetry cadence',
    /every 3 minutes/i.test(canonical) && /once per\s+\*{0,2}minute/i.test(canonical));
  assertParallelOperatingModel('canonical skill', canonical);

  check('plugin skill exists', existsSync(pluginSkill));
  const plugin = readFileSync(pluginSkill, 'utf8');
  assertParallelOperatingModel('plugin skill', plugin);

  check('global skill exists (run npm run sync:global-skill if missing)', existsSync(globalSkill));
  const global = readFileSync(globalSkill, 'utf8');
  check('global skill references ledger-cli bridge', global.includes('ledger-cli.mjs'));
  check('global skill has resolved node path', !global.includes('{{PLAN_LEDGER_NODE}}')
    && /node\.exe|node"/i.test(global));
  check('global skill has resolved repo path', global.includes('Plan-ledger'));
  check('global skill does not assume plan-ledger MCP', !/mcp__plan-ledger__\*.*required/i.test(global)
    && !/user-global `plan-ledger` MCP server/i.test(global));
  check('global skill includes planner_start + consulted-id provenance guidance',
    /planner_start/i.test(global) && /consulted[_ -]?plan/i.test(global));
  check('global skill includes active chat update cadence guidance',
    /every 3 minutes/i.test(global) && /once per\s+\*{0,2}minute/i.test(global));
  assertParallelOperatingModel('global skill', global);

  check('canonical skill under 500 lines', canonical.split('\n').length <= 500);

  check('bridge manifest exists', existsSync(bridgeManifest));
  const manifest = JSON.parse(readFileSync(bridgeManifest, 'utf8'));
  check('manifest points at repo cli', resolve(manifest.cli) === resolve(cliPath));
  check('manifest cli file exists', existsSync(manifest.cli));
  check('manifest node exists', existsSync(manifest.node));

  check('user mcp.json exists', existsSync(userMcp));
  const mcpRaw = readFileSync(userMcp, 'utf8');
  let mcp;
  try { mcp = JSON.parse(mcpRaw); } catch (e) { assert.fail(`user mcp.json invalid JSON: ${e.message}`); }
  check('user mcp.json preserves unrelated servers', mcp.mcpServers?.['atlassian-mcp-server'] != null
    && mcp.mcpServers?.['marauders-ledger-rag'] != null);
  check('user mcp.json removed plan-ledger server only', mcp.mcpServers?.['plan-ledger'] == null);

  mkdirSync(outsideCwd, { recursive: true });
  const created = runCli('create_project', { name: 'GlobalSkillProject', description: 'outside repo cwd' }, {}, outsideCwd);
  check('bridge works outside repo cwd', created.status === 0 && created.body?.ok === true);
  check('outside cwd honors PLAN_LEDGER_DB override', created.body.db_path.includes('plan-ledger-global-skill-db'));

  const projectId = created.body.result.id;
  const plan = runCli('create_plan', {
    title: 'Global skill bridge smoke',
    summary: 'validate cross-workspace bridge',
    keywords: ['global', 'skill'],
  }, {}, outsideCwd);
  const planId = plan.body.result.id;
  const step = runCli('add_step', {
    plan_id: planId,
    title: 'Bridge step',
    context: 'Run from outside repo',
    role: 'build-devops',
    acceptance_criteria: 'CLI ok',
  }, {}, outsideCwd);

  const boardOpen = runCli('board', {
    command: 'open',
    project_id: projectId,
    plan_id: planId,
    step_id: step.body.result.id,
  }, {}, outsideCwd);
  boardPid = boardOpen.body?.result?.server_pid ?? null;
  check('board open from outside repo succeeds with NO_OPEN', boardOpen.status === 0
    && boardOpen.body.result.mode === 'open'
    && boardOpen.body.result.open_suppressed === true
    && boardOpen.body.result.opened_browser === false);
  check('board open deep-link includes ids', /project_id=\d+/.test(boardOpen.body.result.url)
    && /plan_id=\d+/.test(boardOpen.body.result.url)
    && /step_id=\d+/.test(boardOpen.body.result.url));

  console.log(`\nglobal-skill regression OK (${pass} checks)`);
} catch (error) {
  console.error(`\nglobal-skill regression FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (Number.isInteger(boardPid) && boardPid > 0) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(boardPid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(boardPid, 'SIGTERM'); } catch {}
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });
  rmSync(outsideCwd, { recursive: true, force: true });
}
