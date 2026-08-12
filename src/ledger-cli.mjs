#!/usr/bin/env node
// ledger-cli.mjs — non-MCP JSON CLI bridge over src/db.mjs.
// Default DB path comes from defaultDbPath() (PLAN_LEDGER_DB override).

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store, canonicalDbIdentity, defaultDbPath } from './db.mjs';
import { listProjectStaff } from './roles.mjs';

const STATUS_ICON = {
  done: '✅',
  in_progress: '▶',
  pending: '⬚',
  failed: '✗',
  blocked: '⏸',
  skipped: '⤼',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const BOARD_SERVER_ENTRY = join(REPO_ROOT, 'web', 'server.mjs');

function fail(message, details = {}) {
  const err = new Error(message);
  err.details = details;
  throw err;
}

function parseJson(text, where) {
  try { return JSON.parse(text); } catch (e) { fail(`invalid JSON in ${where}: ${e.message}`); }
}

async function readStdinIfPiped() {
  if (process.stdin.isTTY) return null;
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  const trimmed = body.trim();
  return trimmed ? parseJson(trimmed, 'stdin') : null;
}

function parseArgv(argv) {
  let operation = null;
  let input = null;
  let inputFile = null;
  let showHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      showHelp = true;
      continue;
    }
    if (token === '--input' || token === '--json') {
      input = argv[++i];
      if (input == null) fail(`${token} requires a JSON string`);
      continue;
    }
    if (token.startsWith('--input=')) {
      input = token.slice('--input='.length);
      continue;
    }
    if (token === '--input-file') {
      inputFile = argv[++i];
      if (inputFile == null) fail('--input-file requires a path');
      continue;
    }
    if (token.startsWith('-')) fail(`unknown flag: ${token}`);
    if (operation != null) fail(`unexpected positional argument: ${token}`);
    operation = token;
  }
  return { operation, input, inputFile, showHelp };
}

function usage() {
  return [
    'plan-ledger non-MCP JSON CLI',
    '',
    'Usage:',
    '  node src/ledger-cli.mjs <operation> --input \'{"k":"v"}\'',
    '  echo \'{"operation":"list_plans","args":{}}\' | node src/ledger-cli.mjs',
    '',
    'Input contract:',
    '  JSON object of args, or envelope { "operation": "...", "args": { ... } }',
    '',
    'Board open/launch:',
    '  node src/ledger-cli.mjs board --input \'{"command":"open","plan_id":12,"step_id":40}\'',
    '  command accepts optional project_id, plan_id, step_id',
    '',
    'Output contract:',
    '  Success: { "ok": true, "operation": "...", "db_path": "...", "result": ... }',
    '  Error:   stderr line + { "ok": false, "operation": "...", "error": { ... } }',
  ].join('\n');
}

function parsePositiveId(raw, label) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { invalid: true, value: raw, reason: `${label} must be a positive integer` };
  return { value: n };
}

function buildBoardUrl(args, port) {
  const url = new URL(`http://127.0.0.1:${port}/`);
  const ids = {
    project_id: parsePositiveId(args.project_id, 'project_id'),
    plan_id: parsePositiveId(args.plan_id, 'plan_id'),
    step_id: parsePositiveId(args.step_id, 'step_id'),
  };
  const ignored = {};
  for (const [key, parsed] of Object.entries(ids)) {
    if (!parsed) continue;
    if (parsed.invalid) {
      ignored[key] = { value: parsed.value, reason: parsed.reason };
      continue;
    }
    url.searchParams.set(key, String(parsed.value));
  }
  return { url: url.toString(), ignored };
}

async function probeBoard(port, expectedDbIdentity, timeoutMs = 700) {
  const metaUrl = `http://127.0.0.1:${port}/api/meta`;
  try {
    const res = await fetch(metaUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: 'incompatible', reason: `service on 127.0.0.1:${port} does not expose plan-ledger metadata` };
    let data = null;
    try { data = await res.json(); } catch { return { status: 'incompatible', reason: 'service metadata response is not valid JSON' }; }
    if (data?.service !== 'plan-ledger-board' || typeof data?.db_identity !== 'string') {
      return { status: 'incompatible', reason: 'service on port is not a plan-ledger board instance' };
    }
    if (data.db_identity !== expectedDbIdentity) {
      return {
        status: 'mismatch',
        reason: `plan-ledger board on 127.0.0.1:${port} is using a different DB identity`,
        found_db_path: data.db_path ?? null,
        found_db_identity: data.db_identity,
      };
    }
    return { status: 'match', db_path: data.db_path ?? null, db_identity: data.db_identity };
  } catch {
    return { status: 'absent' };
  }
}

async function waitForBoard(port, expectedDbIdentity, timeoutMs = 9000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeBoard(port, expectedDbIdentity);
    if (probe.status === 'match' || probe.status === 'mismatch' || probe.status === 'incompatible') return probe;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { status: 'timeout' };
}

function launchBoardDetached(port, dbPath) {
  const child = spawn(process.execPath, [BOARD_SERVER_ENTRY], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PLAN_LEDGER_WEB_PORT: String(port),
      PLAN_LEDGER_DB: dbPath,
    },
  });
  child.unref();
  return child.pid ?? null;
}

function tryOpenWith(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openSystemBrowser(url) {
  if (process.env.PLAN_LEDGER_NO_OPEN === '1') return { opened: false, suppressed: true };
  const methods = process.platform === 'win32'
    ? [
        ['rundll32', ['url.dll,FileProtocolHandler', url]],
        ['cmd', ['/c', 'start', '', url]],
      ]
    : process.platform === 'darwin'
      ? [['open', [url]]]
      : [['xdg-open', [url]]];
  for (const [cmd, args] of methods) {
    if (tryOpenWith(cmd, args)) return { opened: true, suppressed: false, method: cmd };
  }
  return { opened: false, suppressed: false };
}

function boardList(store, args) {
  const plans = store.listPlans({
    status: args.status,
    query: args.query,
    project_id: args.project_id,
    all: args.all,
  });
  const text = plans.length
    ? plans.map((p) => `#${p.id}  ${String(p.status).toUpperCase()}  ${p.done}/${p.steps}  ${p.title}  [${p.keywords.join(', ')}]`).join('\n')
    : '(no plans)';
  return { mode: 'list', plans, text };
}

function boardShow(store, args) {
  if (args.plan_id == null) return boardList(store, args);
  const plan = store.openPlan(Number(args.plan_id));
  const lines = [];
  const done = plan.steps.filter((s) => s.status === 'done').length;
  lines.push(`#${plan.id} ${plan.title}   ▸ ${plan.status}   (${done}/${plan.steps.length} done)`);
  lines.push(plan.summary || '');

  // Prior-plan provenance: which already-existing plans this draft consulted during
  // planning preflight, labeled completed vs related-active (surface only, no bodies).
  if (Array.isArray(plan.consulted_plans) && plan.consulted_plans.length) {
    lines.push(`  consulted prior plans: ${plan.consulted_plans
      .map((c) => `#${c.consulted_plan_id} (${c.relation})`).join(', ')}`);
  }

  const includeAttempts = args.include_attempt_counts !== false;
  for (const s of plan.steps) {
    const icon = STATUS_ICON[s.status] ?? '⬚';
    let tail = s.status;
    if (includeAttempts && s.status === 'failed') {
      const attempts = store.getStep(s.id).attempts_total;
      tail += ` (${attempts} attempts)`;
    }
    lines.push(`  ${s.idx} ${icon} ${s.title}    ${tail}`);
  }
  return { mode: 'show', plan, text: lines.join('\n') };
}

async function boardOpen(args) {
  const port = Number(process.env.PLAN_LEDGER_WEB_PORT) || 4319;
  const dbPath = defaultDbPath();
  const expectedDbIdentity = canonicalDbIdentity(dbPath);
  const { url, ignored } = buildBoardUrl(args, port);
  const probe = await probeBoard(port, expectedDbIdentity);
  let startedServer = false;
  let serverPid = null;
  if (probe.status === 'mismatch') {
    fail(probe.reason, {
      expected_db_path: dbPath,
      expected_db_identity: expectedDbIdentity,
      found_db_path: probe.found_db_path,
      found_db_identity: probe.found_db_identity,
    });
  }
  if (probe.status === 'incompatible') {
    fail(`cannot launch board on 127.0.0.1:${port}: ${probe.reason}`);
  }
  if (probe.status === 'absent') {
    serverPid = launchBoardDetached(port, dbPath);
    startedServer = true;
    const ready = await waitForBoard(port, expectedDbIdentity);
    if (ready.status === 'mismatch') {
      fail(ready.reason, {
        expected_db_path: dbPath,
        expected_db_identity: expectedDbIdentity,
        found_db_path: ready.found_db_path,
        found_db_identity: ready.found_db_identity,
      });
    }
    if (ready.status === 'incompatible') {
      fail(`board started on 127.0.0.1:${port}, but endpoint is incompatible with plan-ledger metadata`);
    }
    if (ready.status !== 'match') fail(`board did not become ready on 127.0.0.1:${port}`);
  }
  const browser = openSystemBrowser(url);
  return {
    mode: 'open',
    url,
    port,
    db_path: dbPath,
    db_identity: expectedDbIdentity,
    reused_existing: probe.status === 'match',
    started_server: startedServer,
    server_pid: serverPid,
    opened_browser: browser.opened,
    open_suppressed: browser.suppressed,
    browser_method: browser.method ?? null,
    ignored_query_params: ignored,
  };
}

const handlers = {
  list_projects: (store) => store.listProjects(),
  create_project: (store, args) => store.createProject({ name: args.name, description: args.description }),
  set_current_project: (store, args) => store.setCurrentProject(Number(args.project_id)),
  set_project_status: (store, args) => store.setProjectStatus(Number(args.project_id), args.status),

  list_plans: (store, args) => store.listPlans(args ?? {}),
  open_plan: (store, args) => store.openPlan(Number(args.plan_id)),
  get_step: (store, args) => store.getStep(Number(args.step_id)),
  next_plan: (store, args) => {
    const plan = store.nextPlan(args.project_id != null ? Number(args.project_id) : undefined);
    return plan ?? { complete: true };
  },

  planner_start: (store, args) => store.plannerStart(args ?? {}),
  record_plan_consultation: (store, args) => store.recordPlanConsultation(Number(args.plan_id), args ?? {}),

  create_plan: (store, args) => store.createPlan(args ?? {}),
  update_plan: (store, args) => store.updatePlan(Number(args.plan_id), args ?? {}),
  add_step: (store, args) => store.addStep(Number(args.plan_id), args),
  update_step: (store, args) => store.updateStep(Number(args.step_id), args),
  link_items: (store, args) => store.link(Number(args.from_step_id), args),

  approve_plan: (store, args) => {
    const id = Number(args.plan_id);
    const plan = store.openPlan(id);
    if (plan.status === 'draft') return { activated: true, plan: store.setPlanStatus(id, 'active') };
    if (plan.status === 'active') return { activated: false, reason: 'already_active', plan };
    fail(`cannot approve plan #${id} from status "${plan.status}"`);
  },
  next_step: (store, args) => {
    const id = Number(args.plan_id);
    const plan = store.openPlan(id);
    if (plan.status === 'draft') {
      return {
        awaiting_approval: true,
        plan,
        directive: `Plan #${id} is draft. Approve it explicitly (approve_plan or set_plan_status active) before executing steps.`,
      };
    }
    const step = store.nextStep(id, { claim: !!args.claim, executor: String(args.executor ?? '') });
    return step ?? { complete: true, plan_id: id };
  },
  ready_steps: (store, args) => {
    const id = Number(args.plan_id);
    const plan = store.openPlan(id);
    if (plan.status === 'draft') {
      return {
        awaiting_approval: true,
        plan,
        steps: [],
        directive: `Plan #${id} is draft. Approve it explicitly before claiming/dispatching steps.`,
      };
    }
    return {
      steps: store.readySteps(id, {
        claim: !!args.claim,
        executor: String(args.executor ?? ''),
        limit: args.limit,
      }),
    };
  },
  set_plan_status: (store, args) => store.setPlanStatus(Number(args.plan_id), args.status, {
    force: !!args.force, reason: args.reason ?? '',
  }),
  set_step_status: (store, args) => store.setStepStatus(Number(args.step_id), args.status),

  record_attempt: (store, args) => store.recordAttempt(Number(args.step_id), args),
  write_carry_forward: (store, args) => store.writeCarryForward(Number(args.step_id), args.note, { append: args.append }),
  add_note: (store, args) => store.addNote(Number(args.step_id), args),
  set_layman: (store, args) => store.setLayman(Number(args.step_id), String(args.text ?? '')),

  assign_step: (store, args) => store.assignStep(Number(args.step_id), args),
  get_plan_roster: (store, args) => store.getPlanRoster(Number(args.plan_id), { cwd: args.cwd ?? process.cwd() }),
  list_project_staff: (store, args) => {
    const projectName = args.project_name ?? store.getProject(Number(args.project_id ?? store.currentProjectId())).name;
    return listProjectStaff(projectName);
  },

  start_activity: (store, args) => store.startActivity(args ?? {}),
  heartbeat_activity: (store, args) => store.upsertActivityHeartbeat(args ?? {}),
  append_activity_event: (store, args) => store.appendActivityEvent(args ?? {}),
  list_current_activity: (store, args) => store.listCurrentActivity(args ?? {}),
  list_recent_activity: (store, args) => store.listRecentActivity(args ?? {}),

  open_execution_lease: (store, args) => store.openExecutionLease(args ?? {}),
  heartbeat_execution_lease: (store, args) => {
    const { lease_id, ...patch } = args ?? {};
    return store.heartbeatExecutionLease(Number(lease_id), patch);
  },
  close_execution_lease: (store, args) => {
    const { lease_id, ...rest } = args ?? {};
    return store.closeExecutionLease(Number(lease_id), rest);
  },
  reap_stale_leases: (store, args) => store.reapStaleLeases(args ?? {}),
  list_execution_leases: (store, args) => store.listExecutionLeases(args ?? {}),
  get_execution_lease: (store, args) => store.getExecutionLease(Number(args.lease_id)),

  set_step_disposition: (store, args) => store.setStepDisposition(Number(args.step_id), args ?? {}),
  assess_plan_terminalization: (store, args) => store.assessPlanTerminalization(Number(args.plan_id)),
  assess_plan_reconciliation: (store, args) => store.assessPlanReconciliation(Number(args.plan_id), {
    source: args.source,
    strict: args.strict,
  }),
  assess_completion_backfill: (store) => store.assessCompletionBackfill(),
  assess_activity_backfill: (store) => store.assessActivityBackfill(),

  board: (store, args) => {
    const command = String(args.command ?? (args.plan_id != null ? 'show' : 'list')).toLowerCase();
    if (command === 'list') return boardList(store, args);
    if (command === 'show') return boardShow(store, args);
    if (command === 'open' || command === 'launch') return boardOpen(args);
    fail(`unknown board command: ${command}`, { valid_commands: ['list', 'show', 'open', 'launch'] });
  },
};

async function main() {
  const cli = parseArgv(process.argv.slice(2));
  if (cli.showHelp) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const hasFlagInput = cli.input != null || cli.inputFile != null;
  const stdinPayload = hasFlagInput ? null : await readStdinIfPiped();
  if (stdinPayload && hasFlagInput) fail('provide input from flags OR stdin, not both');

  let payload = {};
  if (cli.input != null) payload = parseJson(cli.input, '--input');
  else if (cli.inputFile != null) payload = parseJson(readFileSync(cli.inputFile, 'utf8'), cli.inputFile);
  else if (stdinPayload) payload = stdinPayload;

  let operation = cli.operation;
  let args = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'operation' in payload) {
    if (operation && operation !== payload.operation) fail(`operation mismatch: argv="${operation}" vs input="${payload.operation}"`);
    operation = payload.operation;
    args = payload.args ?? {};
  }
  if (!operation) fail('operation is required (argv or input.operation)');
  if (!handlers[operation]) fail(`unknown operation: ${operation}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('input args must be a JSON object');

  const dbPath = defaultDbPath();
  const boardOnlyOpen = operation === 'board'
    && ['open', 'launch'].includes(String(args.command ?? '').toLowerCase());
  if (boardOnlyOpen) {
    const result = await handlers.board(null, args);
    process.stdout.write(`${JSON.stringify({ ok: true, operation, db_path: dbPath, result }, null, 2)}\n`);
    return;
  }

  const store = new Store(dbPath);
  try {
    const result = await handlers[operation](store, args);
    process.stdout.write(`${JSON.stringify({ ok: true, operation, db_path: dbPath, result }, null, 2)}\n`);
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (error) {
  const operation = (() => {
    try { return parseArgv(process.argv.slice(2)).operation ?? null; } catch { return null; }
  })();
  const message = error?.message ?? String(error);
  console.error(`[plan-ledger-cli] ${message}`);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    operation,
    error: { message, ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}) },
  }, null, 2)}\n`);
  process.exitCode = 1;
}
