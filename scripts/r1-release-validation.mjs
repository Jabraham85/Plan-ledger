#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDbIdentity } from '../src/db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);
const AUDITS_DIR = join(REPO_ROOT, 'docs', 'audits');

const RELEASE_REPORT_PATH = join(AUDITS_DIR, 'r1-release-validation-report.json');
const RELEASE_SUMMARY_PATH = join(AUDITS_DIR, 'r1-release-validation-summary.md');
const MATRIX_JSON_PATH = join(AUDITS_DIR, 'r1-release-readiness-matrix.json');
const MATRIX_MD_PATH = join(AUDITS_DIR, 'r1-release-readiness-matrix.md');

function nowIso() { return new Date().toISOString(); }
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }
function safeTail(text, max = 2000) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(s.length - max);
}
function fail(message, extra = {}) {
  const err = new Error(message);
  err.extra = extra;
  throw err;
}
function normalizePathLike(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}
function tryRealPath(value) {
  try { return normalizePathLike(realpathSync.native ? realpathSync.native(value) : realpathSync(value)); } catch { return ''; }
}
function identitiesMatch(expectedDbPath, foundIdentityOrPath) {
  const expectedIdentity = canonicalDbIdentity(expectedDbPath);
  const foundIdentity = String(foundIdentityOrPath || '');
  if (!foundIdentity) return false;
  if (foundIdentity === expectedIdentity) return true;
  if (canonicalDbIdentity(foundIdentity) === expectedIdentity) return true;
  const expectedReal = tryRealPath(expectedDbPath);
  const foundReal = tryRealPath(foundIdentity);
  if (expectedReal && foundReal && expectedReal === foundReal) return true;
  if (expectedReal && normalizePathLike(foundIdentity) === expectedReal) return true;
  return false;
}
function requireNumber(value, label) {
  if (!Number.isFinite(value)) fail(`missing or non-numeric metric: ${label}`);
  return Number(value);
}
function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`missing or malformed object: ${label}`);
  return value;
}

function runNode(command, args = [], env = {}) {
  const startedAt = nowIso();
  const out = spawnSync(process.execPath, ['--no-warnings', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  const endedAt = nowIso();
  return {
    command,
    exit_code: out.status ?? (out.error ? 1 : 0),
    signal: out.signal ?? null,
    started_at: startedAt,
    ended_at: endedAt,
    elapsed_ms: null,
    stdout: String(out.stdout ?? ''),
    stderr: String(out.stderr ?? ''),
    output: safeTail(`${out.stdout ?? ''}${out.stderr ?? ''}`),
    timed_out: out.error?.code === 'ETIMEDOUT',
    error: out.error ? String(out.error.message || out.error) : '',
  };
}

function runFunctionalSuite() {
  const tests = [
    'test/terminalization-reconciliation.mjs',
    'test/completion-gate.mjs',
    'test/execution-lifecycle.mjs',
    'test/dispatch-policy.mjs',
    'test/stale-recovery.mjs',
    'test/c4-pre-v13-upgrade.mjs',
    'test/c4-telemetry-health.mjs',
    'test/live-activity-ui.mjs',
    'test/board-routes.mjs',
    'test/ledger-cli.mjs',
    'test/mcp-e2e.mjs',
  ];
  return tests.map((path) => runNode(`node ${path}`, [path]));
}

function parseJsonStdout(runResult, label) {
  try {
    return JSON.parse(runResult.stdout);
  } catch (error) {
    fail(`${label} produced malformed JSON stdout`, { error: String(error?.message || error), output: runResult.output });
  }
}

function benchmarkCompletionValidator() {
  const run = runNode(
    'node benchmarks/completion-validator.mjs',
    ['benchmarks/completion-validator.mjs'],
  );
  const parsed = parseJsonStdout(run, 'completion-validator benchmark');
  requireObject(parsed, 'completion-validator root');
  const p95 = requireNumber(parsed.p95_ms, 'completion-validator.p95_ms');
  const iterations = requireNumber(parsed.iterations, 'completion-validator.iterations');
  const violations = [];
  if (run.exit_code !== 0) violations.push(`nonzero_exit:${run.exit_code}`);
  if (iterations < 1000) violations.push(`iterations_below_floor:${iterations}`);
  if (parsed.pass !== true || p95 > 2) violations.push(`p95_budget_exceeded:${p95}>2`);
  return { run, parsed, pass: violations.length === 0, violations };
}

function benchmarkReconciliation() {
  const run = runNode(
    'node benchmarks/reconciliation-latency.mjs',
    ['benchmarks/reconciliation-latency.mjs'],
  );
  const parsed = parseJsonStdout(run, 'reconciliation-latency benchmark');
  const stats = requireObject(parsed.stats_ms, 'reconciliation-latency.stats_ms');
  const p95 = requireNumber(stats.p95, 'reconciliation-latency.stats_ms.p95');
  const measured = requireNumber(parsed.measured_operations, 'reconciliation-latency.measured_operations');
  const mutated = parsed.all_samples_mutated === true;
  const violations = [];
  if (run.exit_code !== 0) violations.push(`nonzero_exit:${run.exit_code}`);
  if (measured < 100) violations.push(`measured_operations_below_floor:${measured}`);
  if (!mutated) violations.push('not_all_samples_mutated');
  if (p95 > 5) violations.push(`p95_budget_exceeded:${p95}>5`);
  return { run, parsed, pass: violations.length === 0, violations };
}

function benchmarkC3DispatchRecovery() {
  const run = runNode(
    'node benchmarks/c3-dispatch-recovery.mjs',
    ['benchmarks/c3-dispatch-recovery.mjs'],
  );
  const parsed = parseJsonStdout(run, 'c3-dispatch-recovery benchmark');
  const policy = requireObject(parsed.policy_evaluation, 'c3.policy_evaluation');
  const open = requireObject(parsed.execution_lease_open, 'c3.execution_lease_open');
  const heartbeat = requireObject(parsed.execution_lease_heartbeat, 'c3.execution_lease_heartbeat');
  const close = requireObject(parsed.execution_lease_close, 'c3.execution_lease_close');

  const policyP95 = requireNumber(policy.p95, 'c3.policy_evaluation.p95');
  const openP95 = requireNumber(open.p95, 'c3.execution_lease_open.p95');
  const heartbeatP95 = requireNumber(heartbeat.p95, 'c3.execution_lease_heartbeat.p95');
  const closeP95 = requireNumber(close.p95, 'c3.execution_lease_close.p95');
  const policyN = requireNumber(policy.n, 'c3.policy_evaluation.n');
  const leaseN = requireNumber(open.n, 'c3.execution_lease_open.n');

  const violations = [];
  if (run.exit_code !== 0) violations.push(`nonzero_exit:${run.exit_code}`);
  if (policyN < 1000) violations.push(`policy_samples_below_floor:${policyN}`);
  if (leaseN < 30) violations.push(`lease_samples_below_floor:${leaseN}`);
  if (policyP95 > 1) violations.push(`policy_p95_budget_exceeded:${policyP95}>1`);
  if (openP95 > 2.5 || heartbeatP95 > 2.5 || closeP95 > 2.5) {
    violations.push(`lease_p95_budget_exceeded:open=${openP95},heartbeat=${heartbeatP95},close=${closeP95}>2.5`);
  }
  return { run, parsed, pass: violations.length === 0, violations };
}

function benchmarkC4(tempRoot) {
  const outPath = join(tempRoot, 'c4-non-planner-latency.json');
  const run = runNode(
    `node benchmarks/non-planner-latency.mjs --samples 30 --external-samples 10 --run-label r1-release --out "${outPath}"`,
    ['benchmarks/non-planner-latency.mjs', '--samples', '30', '--external-samples', '10', '--run-label', 'r1-release', '--out', outPath],
  );
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch (error) {
    fail('c4 benchmark report missing or malformed', { out_path: outPath, error: String(error?.message || error) });
  }
  const bench = Array.isArray(parsed?.benchmarks) ? parsed.benchmarks : null;
  if (!bench) fail('c4 benchmark report missing benchmarks array');

  const byId = (id) => bench.find((b) => b?.id === id);
  const needBench = (id) => {
    const row = byId(id);
    if (!row) fail(`c4 benchmark missing metric: ${id}`);
    const stats = requireObject(row.stats, `${id}.stats`);
    const n = requireNumber(stats.n, `${id}.stats.n`);
    const p95 = requireNumber(stats.p95, `${id}.stats.p95`);
    return { row, n, p95 };
  };

  const append = needBench('activity_append_event_1000');
  const startup = needBench('board_server_startup');
  const meta = needBench('board_api_meta');
  const plans = needBench('board_api_plans');
  const detail = needBench('board_api_plan_detail');

  const appendSamples = requireNumber(append.row.sample_count, 'activity_append_event_1000.sample_count');
  const violations = [];
  if (run.exit_code !== 0) violations.push(`nonzero_exit:${run.exit_code}`);
  if (appendSamples < 1000) violations.push(`append_samples_below_floor:${appendSamples}`);
  if (append.p95 > 1) violations.push(`append_p95_budget_exceeded:${append.p95}>1`);
  if (startup.n < 30 || meta.n < 30 || plans.n < 30 || detail.n < 30) {
    violations.push(`startup_endpoint_samples_below_floor:startup=${startup.n},meta=${meta.n},plans=${plans.n},detail=${detail.n}`);
  }
  if (startup.p95 > 120) violations.push(`startup_p95_budget_exceeded:${startup.p95}>120`);
  if (meta.p95 > 1 || plans.p95 > 1 || detail.p95 > 1) {
    violations.push(`endpoint_p95_budget_exceeded:meta=${meta.p95},plans=${plans.p95},detail=${detail.p95}>1`);
  }
  const external = bench.filter((b) => b?.external === true).map((b) => ({
    id: b.id,
    n: b?.stats?.n ?? 0,
    p95_ms: b?.stats?.p95 ?? null,
    mean_ms: b?.stats?.mean ?? null,
  }));
  return { run, parsed, external, pass: violations.length === 0, violations };
}

function ensureOkEnvelope(parsed, label) {
  if (!parsed || parsed.ok !== true || typeof parsed.result !== 'object') {
    fail(`${label} returned malformed CLI envelope`, { envelope: parsed });
  }
  return parsed.result;
}

async function boardOpenVerification(tempRoot) {
  const boardDb = join(tempRoot, 'board-open-verify.db');
  const expectedIdentity = canonicalDbIdentity(boardDb);
  const port = await findFreePort();
  const env = {
    PLAN_LEDGER_DB: boardDb,
    PLAN_LEDGER_WEB_PORT: String(port),
    PLAN_LEDGER_NO_OPEN: '1',
  };
  const createPlanRun = runNode(
    'node src/ledger-cli.mjs create_plan --input ...',
    ['src/ledger-cli.mjs', 'create_plan', '--input', JSON.stringify({ title: 'r1 board verify plan', keywords: ['r1', 'board'] })],
    env,
  );
  const planEnvelope = parseJsonStdout(createPlanRun, 'board-open create_plan');
  const createdPlan = ensureOkEnvelope(planEnvelope, 'board-open create_plan');

  const addStepRun = runNode(
    'node src/ledger-cli.mjs add_step --input ...',
    ['src/ledger-cli.mjs', 'add_step', '--input', JSON.stringify({ plan_id: createdPlan.id, title: 'board verify step' })],
    env,
  );
  const stepEnvelope = parseJsonStdout(addStepRun, 'board-open add_step');
  const createdStep = ensureOkEnvelope(stepEnvelope, 'board-open add_step');

  const openRun = runNode(
    'node src/ledger-cli.mjs board --input ...',
    ['src/ledger-cli.mjs', 'board', '--input', JSON.stringify({ command: 'open', plan_id: createdPlan.id, step_id: createdStep.id })],
    env,
  );
  const openEnvelope = parseJsonStdout(openRun, 'board-open command');
  const opened = ensureOkEnvelope(openEnvelope, 'board-open command');
  if (opened.mode !== 'open') fail('board-open returned unexpected mode', { mode: opened.mode });
  const returnedIdentity = String(opened.db_identity || '');
  if (!identitiesMatch(boardDb, returnedIdentity) && !identitiesMatch(boardDb, opened.db_path || '')) {
    fail('board-open returned unexpected db identity', { expected: expectedIdentity, found: opened.db_identity });
  }
  if (!opened.url || !String(opened.url).includes(`plan_id=${createdPlan.id}`) || !String(opened.url).includes(`step_id=${createdStep.id}`)) {
    fail('board-open returned URL without required deep link ids', { url: opened.url });
  }
  if (opened.open_suppressed !== true || opened.opened_browser !== false) {
    fail('board-open no-browser suppression contract failed', { open_suppressed: opened.open_suppressed, opened_browser: opened.opened_browser });
  }

  const base = `http://127.0.0.1:${opened.port || port}`;
  let meta;
  let plan;
  let step;
  try {
    try {
      meta = await awaitJson(`${base}/api/meta`);
      plan = await awaitJson(`${base}/api/plans/${createdPlan.id}`);
      step = await awaitJson(`${base}/api/steps/${createdStep.id}`);
    } catch (error) {
      fail('board-open verification HTTP probes failed', { error: String(error?.message || error), base });
    }
    if (meta?.service !== 'plan-ledger-board') fail('board-open verification service mismatch', { meta });
    const metaIdentity = String(meta?.db_identity || '');
    if (!identitiesMatch(boardDb, metaIdentity) && !identitiesMatch(boardDb, meta?.db_path || '')) {
      fail('board-open verification db identity mismatch', { expected: expectedIdentity, found: meta?.db_identity });
    }
    if (Number(plan?.id) !== Number(createdPlan.id) || Number(step?.id) !== Number(createdStep.id)) {
      fail('board-open verification deep-link entities mismatch', { plan, step, expected_plan_id: createdPlan.id, expected_step_id: createdStep.id });
    }
  } finally {
    if (opened.started_server && Number.isInteger(opened.server_pid) && opened.server_pid > 0) {
      try { process.kill(opened.server_pid, 'SIGTERM'); } catch { /* best effort */ }
    }
  }

  return {
    commands: [createPlanRun, addStepRun, openRun],
    verification: {
      base_url: base,
      expected_db_path: boardDb,
      expected_db_identity: expectedIdentity,
      returned_db_identity: opened.db_identity,
      returned_url: opened.url,
      reused_existing: opened.reused_existing,
      started_server: opened.started_server,
      server_pid: opened.server_pid ?? null,
      verified_plan_id: plan.id,
      verified_step_id: step.id,
      no_browser_mode: opened.open_suppressed === true && opened.opened_browser === false,
      passed: true,
    },
  };
}

async function awaitJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) fail(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function findFreePort() {
  const net = await import('node:net');
  return await new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = Number(addr?.port);
      server.close((closeErr) => {
        if (closeErr) rejectPort(closeErr);
        else resolvePort(port);
      });
    });
  });
}

function summarizeCommands(commands) {
  return commands.map((c) => ({
    command: c.command,
    exit_code: c.exit_code,
    output: safeTail(c.output, 800),
  }));
}

function buildMatrix({ functionalRuns, benchmarks, boardVerification }) {
  const byCommand = new Map(functionalRuns.map((r) => [r.command, r]));
  const bench = benchmarks;
  const allFunctionalPass = functionalRuns.every((r) => r.exit_code === 0);
  const c1 = bench.c1;
  const c2 = bench.c2;
  const c3 = bench.c3;
  const c4 = bench.c4;

  const rows = [
    { area: 'C1 evidence gate', checks: ['completion payload gate', 'legacy_unknown semantics'], evidence: ['node test/completion-gate.mjs', 'node benchmarks/completion-validator.mjs'], pass: allFunctionalPass && c1?.pass === true },
    { area: 'C2 terminalization integrity', checks: ['reconciliation blockers', 'close-path atomicity', 'migration additive/idempotent'], evidence: ['node test/terminalization-reconciliation.mjs', 'node test/execution-lifecycle.mjs', 'node benchmarks/reconciliation-latency.mjs'], pass: allFunctionalPass && c2?.pass === true },
    { area: 'C3 dispatch/recovery', checks: ['policy mismatch enforcement', 'deadline semantics', 'bounded/atomic reassignment', 'migration additive/idempotent'], evidence: ['node test/dispatch-policy.mjs', 'node test/stale-recovery.mjs', 'node benchmarks/c3-dispatch-recovery.mjs'], pass: allFunctionalPass && c3?.pass === true },
    { area: 'C4 telemetry/board health', checks: ['ordered events', 'pre-v13 upgrade', 'marker semantics', 'health API/UI', 'migration/additive compatibility'], evidence: ['node test/c4-pre-v13-upgrade.mjs', 'node test/c4-telemetry-health.mjs', 'node test/live-activity-ui.mjs', 'node test/board-routes.mjs', 'node benchmarks/non-planner-latency.mjs'], pass: allFunctionalPass && c4?.pass === true && boardVerification?.passed === true },
    { area: 'CLI/MCP compatibility', checks: ['ledger CLI bridge', 'MCP e2e contract'], evidence: ['node test/ledger-cli.mjs', 'node test/mcp-e2e.mjs'], pass: (byCommand.get('node test/ledger-cli.mjs')?.exit_code === 0) && (byCommand.get('node test/mcp-e2e.mjs')?.exit_code === 0) },
  ];
  return rows;
}

function writeArtifacts(report, matrixRows) {
  mkdirSync(AUDITS_DIR, { recursive: true });
  writeFileSync(RELEASE_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const matrixJson = {
    schema_version: 1,
    generated_at: nowIso(),
    report_path: 'docs/audits/r1-release-validation-report.json',
    rows: matrixRows,
  };
  writeFileSync(MATRIX_JSON_PATH, JSON.stringify(matrixJson, null, 2) + '\n', 'utf8');

  const md = [
    '# R1 Release Readiness Matrix',
    '',
    `Generated: ${matrixJson.generated_at}`,
    '',
    '| Area | Checks | Evidence Commands | Status |',
    '|---|---|---|---|',
    ...matrixRows.map((r) => `| ${r.area} | ${r.checks.join('; ')} | ${r.evidence.join('<br>')} | ${r.pass ? 'PASS' : 'FAIL'} |`),
    '',
    'Run command: `node scripts/r1-release-validation.mjs`',
  ].join('\n');
  writeFileSync(MATRIX_MD_PATH, md + '\n', 'utf8');

  const summary = [
    '# R1 Release Validation Summary',
    '',
    `Generated: ${report.generated_at}`,
    `Outcome: ${report.outcome.toUpperCase()}`,
    '',
    `- Functional commands: ${report.functional.commands.length}`,
    `- Benchmark families: 4`,
    `- Board-open verification: ${report.board_open_verification.passed ? 'PASS' : 'FAIL'}`,
    `- Report JSON: \`docs/audits/r1-release-validation-report.json\``,
    `- Matrix JSON: \`docs/audits/r1-release-readiness-matrix.json\``,
  ].join('\n');
  writeFileSync(RELEASE_SUMMARY_PATH, summary + '\n', 'utf8');
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'plan-ledger-r1-release-'));
  const startedAt = nowIso();
  const allCommands = [];
  const failures = [];
  try {
    const functionalRuns = runFunctionalSuite();
    allCommands.push(...functionalRuns);
    for (const run of functionalRuns.filter((r) => r.exit_code !== 0)) {
      failures.push(`functional_failed:${run.command}`);
    }

    let c1 = null;
    let c2 = null;
    let c3 = null;
    let c4 = null;
    let boardOpen = null;

    try { c1 = benchmarkCompletionValidator(); allCommands.push(c1.run); } catch (error) { failures.push(`c1_benchmark_error:${String(error?.message || error)}`); }
    try { c2 = benchmarkReconciliation(); allCommands.push(c2.run); } catch (error) { failures.push(`c2_benchmark_error:${String(error?.message || error)}`); }
    try { c3 = benchmarkC3DispatchRecovery(); allCommands.push(c3.run); } catch (error) { failures.push(`c3_benchmark_error:${String(error?.message || error)}`); }
    try { c4 = benchmarkC4(tempRoot); allCommands.push(c4.run); } catch (error) { failures.push(`c4_benchmark_error:${String(error?.message || error)}`); }
    for (const b of [c1, c2, c3, c4]) {
      if (b && b.pass !== true) failures.push(...b.violations.map((v) => `benchmark_violation:${v}`));
    }
    try {
      boardOpen = await boardOpenVerification(tempRoot);
      allCommands.push(...boardOpen.commands);
      if (boardOpen.verification?.passed !== true) failures.push('board_open_verification_failed');
    } catch (error) {
      failures.push(`board_open_verification_error:${String(error?.message || error)}`);
    }

    const report = {
      schema_version: 1,
      generated_at: nowIso(),
      started_at: startedAt,
      ended_at: nowIso(),
      outcome: failures.length ? 'failed' : 'success',
      commands: summarizeCommands(allCommands),
      functional: {
        commands: functionalRuns.map((r) => ({ command: r.command, exit_code: r.exit_code })),
        pass: functionalRuns.every((r) => r.exit_code === 0),
      },
      benchmarks: {
        completion_validator: c1?.parsed ?? null,
        reconciliation_latency: c2?.parsed ?? null,
        c3_dispatch_recovery: c3?.parsed ?? null,
        c4_non_planner_latency: c4?.parsed ?? null,
      },
      benchmark_budget_checks: {
        c1_validation_p95_ms: { value: c1 ? round3(c1.parsed.p95_ms) : null, budget_max_ms: 2, pass: c1?.pass === true },
        c2_reconciliation_p95_ms: { value: c2 ? round3(c2.parsed.stats_ms.p95) : null, budget_max_ms: 5, pass: c2?.pass === true },
        c3_policy_p95_ms: { value: c3 ? round3(c3.parsed.policy_evaluation.p95) : null, budget_max_ms: 1, pass: c3 ? Number(c3.parsed.policy_evaluation.p95) <= 1 : false },
        c3_lease_open_p95_ms: { value: c3 ? round3(c3.parsed.execution_lease_open.p95) : null, budget_max_ms: 2.5, pass: c3 ? Number(c3.parsed.execution_lease_open.p95) <= 2.5 : false },
        c3_lease_heartbeat_p95_ms: { value: c3 ? round3(c3.parsed.execution_lease_heartbeat.p95) : null, budget_max_ms: 2.5, pass: c3 ? Number(c3.parsed.execution_lease_heartbeat.p95) <= 2.5 : false },
        c3_lease_close_p95_ms: { value: c3 ? round3(c3.parsed.execution_lease_close.p95) : null, budget_max_ms: 2.5, pass: c3 ? Number(c3.parsed.execution_lease_close.p95) <= 2.5 : false },
      },
      c4_budget_checks: (() => {
        const rows = Array.isArray(c4?.parsed?.benchmarks) ? c4.parsed.benchmarks : [];
        const g = (id) => rows.find((x) => x?.id === id);
        const append = g('activity_append_event_1000');
        const startup = g('board_server_startup');
        const meta = g('board_api_meta');
        const plans = g('board_api_plans');
        const detail = g('board_api_plan_detail');
        return {
          activity_append_event_1000: {
            sample_count: append?.sample_count ?? 0,
            p95_ms: append?.stats?.p95 ?? null,
            min_samples: 1000,
            budget_max_ms: 1,
            pass: (append?.sample_count ?? 0) >= 1000 && Number(append?.stats?.p95 ?? Infinity) <= 1,
          },
          board_server_startup: {
            samples: startup?.stats?.n ?? 0,
            p95_ms: startup?.stats?.p95 ?? null,
            min_samples: 30,
            budget_max_ms: 120,
            pass: Number(startup?.stats?.n ?? 0) >= 30 && Number(startup?.stats?.p95 ?? Infinity) <= 120,
          },
          board_api_meta: {
            samples: meta?.stats?.n ?? 0,
            p95_ms: meta?.stats?.p95 ?? null,
            min_samples: 30,
            budget_max_ms: 1,
            pass: Number(meta?.stats?.n ?? 0) >= 30 && Number(meta?.stats?.p95 ?? Infinity) <= 1,
          },
          board_api_plans: {
            samples: plans?.stats?.n ?? 0,
            p95_ms: plans?.stats?.p95 ?? null,
            min_samples: 30,
            budget_max_ms: 1,
            pass: Number(plans?.stats?.n ?? 0) >= 30 && Number(plans?.stats?.p95 ?? Infinity) <= 1,
          },
          board_api_plan_detail: {
            samples: detail?.stats?.n ?? 0,
            p95_ms: detail?.stats?.p95 ?? null,
            min_samples: 30,
            budget_max_ms: 1,
            pass: Number(detail?.stats?.n ?? 0) >= 30 && Number(detail?.stats?.p95 ?? Infinity) <= 1,
          },
        };
      })(),
      board_open_verification: boardOpen?.verification ?? { passed: false, error: 'not_collected' },
      external_environment_noise: {
        note: 'External process/model latency is reported separately and cannot excuse local budget failures.',
        c4_external_metrics: c4?.external ?? [],
      },
      failures,
      artifacts: [
        'docs/audits/r1-release-validation-report.json',
        'docs/audits/r1-release-validation-summary.md',
        'docs/audits/r1-release-readiness-matrix.json',
        'docs/audits/r1-release-readiness-matrix.md',
      ],
    };

    const matrixRows = buildMatrix({
      functionalRuns,
      benchmarks: { c1, c2, c3, c4 },
      boardVerification: boardOpen?.verification ?? { passed: false },
    });
    writeArtifacts(report, matrixRows);

    console.log(`[r1-release-validation] ${failures.length ? 'FAIL' : 'PASS'}`);
    console.log(`- report: docs/audits/r1-release-validation-report.json`);
    console.log(`- matrix: docs/audits/r1-release-readiness-matrix.json`);
    if (boardOpen?.verification?.base_url) {
      console.log(`- board-open verification: ${boardOpen.verification.passed ? 'PASS' : 'FAIL'} (${boardOpen.verification.base_url})`);
    }
    if (failures.length) {
      for (const entry of failures) console.error(`- failure: ${entry}`);
      process.exitCode = 1;
    }
  } catch (error) {
    const report = {
      schema_version: 1,
      generated_at: nowIso(),
      started_at: startedAt,
      ended_at: nowIso(),
      outcome: 'failed',
      error: String(error?.message || error),
      error_details: error?.extra ?? {},
      commands: summarizeCommands(allCommands),
      artifacts: [
        'docs/audits/r1-release-validation-report.json',
      ],
    };
    mkdirSync(AUDITS_DIR, { recursive: true });
    writeFileSync(RELEASE_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.error(`[r1-release-validation] FAIL: ${report.error}`);
    process.exitCode = 1;
  } finally {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

await main();
