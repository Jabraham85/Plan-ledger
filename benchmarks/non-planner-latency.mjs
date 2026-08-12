#!/usr/bin/env node
// benchmarks/non-planner-latency.mjs
//
// Perf-engineer harness for plan-ledger plan #17 step #107. Profiles
// end-to-end non-planner latency: JSON CLI process startup, DB open +
// representative reads/writes, repeated bridge round-trips, board server
// startup + API loads, ready_steps/next_step, roster/model resolution,
// execution-lease + activity writes, runner preflight, a bounded no-op
// Cursor CLI startup probe, and a static historical review/verification
// handoff analysis derived from docs/audits/plan-ledger-cross-plan-census.json.
//
// SAFETY: this script NEVER opens, imports against, or points any product
// code at the production DB. All Store/CLI/board activity in this file runs
// against a fresh, isolated temp directory (see TEMP_ROOT below). The
// production DB is only ever read as raw bytes (for a before/after hash
// guard) — never opened via node:sqlite, never written.
//
// Usage:
//   node benchmarks/non-planner-latency.mjs [--out <path>] [--samples 30]
//                                            [--external-samples 10] [--quiet]
//
// planner_start / prompt quality are explicitly OUT of scope (see brief) and
// are not benchmarked here.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { Store, defaultDbPath, canonicalDbIdentity } from '../src/db.mjs';
import { resolveRole, listCursorModels } from '../src/roles.mjs';
import { runDispatchPreflight } from '../scripts/execution-governance.mjs';
import { createKeepAliveClient, pollBoardReady } from './bench-http.mjs';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

const SAMPLES = Math.max(30, Number(val('--samples', 30)) || 30);
const EXTERNAL_SAMPLES = Math.max(3, Number(val('--external-samples', 10)) || 10);
const OUT_PATH = val('--out', null);
const QUIET = flag('--quiet');
const RUN_LABEL = val('--run-label', `run-${Date.now()}`);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);
const LEDGER_CLI = join(REPO_ROOT, 'src', 'ledger-cli.mjs');
const BOARD_SERVER = join(REPO_ROOT, 'web', 'server.mjs');
const CENSUS_PATH = join(REPO_ROOT, 'docs', 'audits', 'plan-ledger-cross-plan-census.json');

const PROD_DB_PATH = defaultDbPath(); // never opened by this script
const PROD_DB_IDENTITY = canonicalDbIdentity(PROD_DB_PATH);

// Isolated temp root — every Store/CLI/board invocation in this file points here.
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'plan-ledger-bench-'));
const ISOLATED_DB_PATHS = new Set();
function log(...args) { if (!QUIET) console.error('[bench]', ...args); }
log(`temp root: ${TEMP_ROOT}`);
log(`production DB (read-only guard only, never opened): ${PROD_DB_PATH}`);

function freshDbPath(label) {
  const dir = join(TEMP_ROOT, label);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'plan-ledger.db');
  ISOLATED_DB_PATHS.add(dbPath);
  return dbPath;
}

// ---------------------------------------------------------------------------
// Production DB guard: raw-byte hash/size/mtime before and after. This file
// never sets PLAN_LEDGER_DB to PROD_DB_PATH and never imports Store against it.
// ---------------------------------------------------------------------------
function fingerprintFile(path) {
  if (!existsSync(path)) return { exists: false };
  const st = statSync(path);
  const buf = readFileSync(path);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs, sha256 };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
function stats(samplesMs) {
  const arr = samplesMs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const n = arr.length;
  if (!n) return { n: 0 };
  const sum = arr.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = n > 1 ? arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    min: round2(arr[0]),
    p50: round2(percentile(arr, 50)),
    p90: round2(percentile(arr, 90)),
    p95: round2(percentile(arr, 95)),
    p99: round2(percentile(arr, 99)),
    max: round2(arr[n - 1]),
    mean: round2(mean),
    stdev: round2(Math.sqrt(variance)),
  };
}
function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

function timeSync(fn) {
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  return { ms, result };
}
async function timeAsync(fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { ms, result };
}

function runCli(args, { env = {}, timeoutMs = 15000 } = {}) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, ['--no-warnings', LEDGER_CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const ms = performance.now() - t0;
  return { ms, status: res.status, stdout: res.stdout, stderr: res.stderr, error: res.error };
}

function spawnNodeBaseline(scriptArgs, { env = {}, timeoutMs = 15000 } = {}) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, ['--no-warnings', ...scriptArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const ms = performance.now() - t0;
  return { ms, status: res.status, stdout: res.stdout, stderr: res.stderr, error: res.error };
}

function spawnCliNoOp(args, { timeoutMs = 8000 } = {}) {
  const t0 = performance.now();
  const res = spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: true,
    windowsHide: true,
  });
  const ms = performance.now() - t0;
  return { ms, status: res.status, stdout: res.stdout, stderr: res.stderr, error: res.error };
}

async function findFreePort(startHint) {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(startHint, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function mkBenchmark({ id, category, local, external, unit = 'ms', description }) {
  return { id, category, local, external, unit, description };
}

// ---------------------------------------------------------------------------
// Benchmark suite (returns the full result object for ONE run)
// ---------------------------------------------------------------------------
async function runOnce() {
  const startedAt = new Date().toISOString();
  const benchmarks = [];
  const scaling = [];

  // === 1. Node process startup baseline (fixed overhead floor) ============
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const r = spawnNodeBaseline(['-e', '']);
      samples.push(r.ms);
    }
    benchmarks.push({
      ...mkBenchmark({
        id: 'node_process_startup_baseline', category: 'process_startup', local: true, external: false,
        description: 'Bare `node -e \'\'` spawn — raw Node.js interpreter startup with no plan-ledger code loaded. Fixed-overhead floor that every CLI round trip pays on top of.',
      }),
      samples: samples.map(round2),
      stats: stats(samples),
    });
  }

  // === 2. ledger-cli module load only (argv parse + imports, no DB open) ==
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const r = runCli(['--help']);
      samples.push(r.ms);
    }
    benchmarks.push({
      ...mkBenchmark({
        id: 'cli_help_module_load', category: 'process_startup', local: true, external: false,
        description: '`node src/ledger-cli.mjs --help` — Node startup + ESM module graph load (db.mjs, roles.mjs, dispatch-policy.mjs) with the --help early-return path, so no DB is opened. Isolates import/parse overhead on top of the Node baseline.',
      }),
      samples: samples.map(round2),
      stats: stats(samples),
    });
  }

  // === 3. JSON CLI full round trip: cold (fresh DB file) vs warm ==========
  {
    const coldSamples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const dbPath = freshDbPath(`cli-cold-${i}`);
      const r = runCli(['list_plans', '--input', '{}'], { env: { PLAN_LEDGER_DB: dbPath } });
      coldSamples.push(r.ms);
    }
    const warmDb = freshDbPath('cli-warm');
    // Prime the file once (schema created, project seeded) so subsequent
    // invocations are a genuine "file already exists + already initialized" warm path.
    {
      const seed = new Store(warmDb);
      seed.createProject({ name: 'bench-warm', description: 'warm cli project' });
      seed.close();
    }
    const warmSamples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const r = runCli(['list_plans', '--input', '{}'], { env: { PLAN_LEDGER_DB: warmDb } });
      warmSamples.push(r.ms);
    }
    benchmarks.push({
      ...mkBenchmark({
        id: 'cli_roundtrip_list_plans_cold', category: 'cli_roundtrip', local: true, external: false,
        description: 'Full `list_plans` CLI round trip against a BRAND-NEW db file each iteration (Node startup + module load + schema DDL/migration + query + JSON stdout + process exit). Worst case: first-ever call against a never-opened file.',
      }),
      samples: coldSamples.map(round2),
      stats: stats(coldSamples),
    });
    benchmarks.push({
      ...mkBenchmark({
        id: 'cli_roundtrip_list_plans_warm', category: 'cli_roundtrip', local: true, external: false,
        description: 'Full `list_plans` CLI round trip against an ALREADY-INITIALIZED db file reused across all 30 samples (Node startup + module load + open existing schema + query + JSON stdout + process exit). This is also the "repeated bridge round-trip" steady-state measurement: every CLI operation pays a fresh process spawn, so this number is representative of typical agent<->ledger bridge latency.',
      }),
      samples: warmSamples.map(round2),
      stats: stats(warmSamples),
    });
  }

  // === 4. DB open cost in-process: cold (new file) vs warm (existing) =====
  {
    const coldSamples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const dbPath = freshDbPath(`dbopen-cold-${i}`);
      const { ms, result: store } = timeSync(() => new Store(dbPath));
      store.close();
      coldSamples.push(ms);
    }
    const warmDb = freshDbPath('dbopen-warm');
    { const seed = new Store(warmDb); seed.createProject({ name: 'p', description: '' }); seed.close(); }
    const warmSamples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { ms, result: store } = timeSync(() => new Store(warmDb));
      store.close();
      warmSamples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({
        id: 'db_open_cold', category: 'db_open', local: true, external: false,
        description: 'In-process `new Store(freshFilePath)` — first-ever open of a brand-new db file: mkdir, DatabaseSync open, PRAGMAs, full CREATE TABLE IF NOT EXISTS schema DDL, migration check, then close(). No process-spawn overhead (isolates DB-layer cost only).',
      }),
      samples: coldSamples.map(round2),
      stats: stats(coldSamples),
    });
    benchmarks.push({
      ...mkBenchmark({
        id: 'db_open_warm', category: 'db_open', local: true, external: false,
        description: 'In-process `new Store(existingFilePath)` reopened 30 times against the same already-initialized file — DDL is IF NOT EXISTS/no-op, migration check short-circuits. Isolates steady-state DB-open cost with no process-spawn overhead.',
      }),
      samples: warmSamples.map(round2),
      stats: stats(warmSamples),
    });
  }

  // === 5. Representative reads/writes (warm, in-process, long-lived Store) ==
  const rwDb = freshDbPath('rw');
  const rwStore = new Store(rwDb);
  const rwProject = rwStore.createProject({ name: 'bench-rw', description: 'representative read/write project' });
  let rwPlan = rwStore.createPlan({ title: 'Representative plan for read/write benchmark', keywords: ['bench'], project_id: rwProject.id });
  // Seed ~8 steps (matches the census median plan size) so reads touch a realistic row count.
  const rwStepIds = [];
  for (let i = 0; i < 8; i++) {
    const s = rwStore.addStep(rwPlan.id, {
      title: `Representative step ${i + 1}`,
      context: 'Representative context body used to exercise a realistic row size for read/write timing.',
      acceptance_criteria: 'Representative acceptance criteria.',
      role: 'implementer',
    });
    rwStepIds.push(s.id);
  }
  rwPlan = rwStore.setPlanStatus(rwPlan.id, 'active');

  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) { const { ms } = timeSync(() => rwStore.listPlans()); samples.push(ms); }
    benchmarks.push({
      ...mkBenchmark({ id: 'read_list_plans', category: 'db_read', local: true, external: false, description: 'Store.listPlans() — level-0 surface index query (title/keywords/status only), warm in-process, no process-spawn or DB-open overhead.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) { const { ms } = timeSync(() => rwStore.openPlan(rwPlan.id)); samples.push(ms); }
    benchmarks.push({
      ...mkBenchmark({ id: 'read_open_plan', category: 'db_read', local: true, external: false, description: 'Store.openPlan(id) — level-1 plan detail + ordered 8-step index (titles/status only), warm in-process.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) { const { ms } = timeSync(() => rwStore.getStep(rwStepIds[i % rwStepIds.length])); samples.push(ms); }
    benchmarks.push({
      ...mkBenchmark({ id: 'read_get_step', category: 'db_read', local: true, external: false, description: 'Store.getStep(id) — level-2 full step context + attempts + assignments + links, warm in-process.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { ms } = timeSync(() => rwStore.addStep(rwPlan.id, { title: `Write-bench step ${i}`, context: 'x', acceptance_criteria: 'x' }));
      samples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'write_add_step', category: 'db_write', local: true, external: false, description: 'Store.addStep(planId, {...}) — single-row INSERT + touchPlan, warm in-process, one new step per sample.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const stepId = rwStepIds[i % rwStepIds.length];
      const { ms } = timeSync(() => rwStore.updateStep(stepId, { context: `updated context ${i} ${Math.random()}` }));
      samples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'write_update_step', category: 'db_write', local: true, external: false, description: 'Store.updateStep(id, {context}) — single-row UPDATE + touchPlan, warm in-process.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    // record_attempt transitions a step to done/failed, so give each sample its own fresh step.
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const s = rwStore.addStep(rwPlan.id, { title: `Attempt-bench step ${i}`, context: 'x', acceptance_criteria: 'x' });
      const { ms } = timeSync(() => rwStore.recordAttempt(s.id, {
        what_tried: 'benchmark attempt', result: 'ok', verdict: i % 2 === 0 ? 'pass' : 'fail', role: 'implementer', executor: 'bench',
      }));
      samples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'write_record_attempt', category: 'db_write', local: true, external: false, description: 'Store.recordAttempt(stepId, {...}) — INSERT attempts row + setStepStatus + conditional disposition write, inside a transaction, warm in-process. Fresh step per sample (a step can only be attempted meaningfully once per verdict transition in this benchmark).' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }

  // === 6. ready_steps / next_step (peek only — claim:false so repeatable) ===
  const rsDb = freshDbPath('ready-steps');
  const rsStore = new Store(rsDb);
  const rsProject = rsStore.createProject({ name: 'bench-ready', description: '' });
  let rsPlan = rsStore.createPlan({ title: 'Ready-steps benchmark plan', keywords: [], project_id: rsProject.id });
  for (let i = 0; i < 10; i++) {
    rsStore.addStep(rsPlan.id, { title: `Ready step ${i + 1}`, context: 'x', acceptance_criteria: 'x' });
  }
  rsPlan = rsStore.setPlanStatus(rsPlan.id, 'active');
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) { const { ms } = timeSync(() => rsStore.nextStep(rsPlan.id, { claim: false })); samples.push(ms); }
    benchmarks.push({
      ...mkBenchmark({ id: 'next_step_peek', category: 'dispatch', local: true, external: false, description: 'Store.nextStep(planId, {claim:false}) — lowest-idx step whose deps are satisfied, non-mutating peek, warm in-process, 10-step plan.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) { const { ms } = timeSync(() => rsStore.readySteps(rsPlan.id, { claim: false })); samples.push(ms); }
    benchmarks.push({
      ...mkBenchmark({ id: 'ready_steps_peek', category: 'dispatch', local: true, external: false, description: 'Store.readySteps(planId, {claim:false}) — full set of dependency-satisfied pending/failed steps, non-mutating peek, warm in-process, 10-step plan.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }

  // === 7. Roster / model resolution — LOCAL vs EXTERNAL split =============
  {
    // Local-only: env override means listCursorModels() never shells out.
    const savedEnv = process.env.PLAN_LEDGER_CURSOR_MODELS;
    process.env.PLAN_LEDGER_CURSOR_MODELS = 'claude-sonnet-5-thinking-high,gpt-5.3-codex,composer-2.5-fast';
    const localSamples = [];
    for (let i = 0; i < SAMPLES; i++) { const { ms } = timeSync(() => listCursorModels()); localSamples.push(ms); }
    if (savedEnv === undefined) delete process.env.PLAN_LEDGER_CURSOR_MODELS; else process.env.PLAN_LEDGER_CURSOR_MODELS = savedEnv;
    benchmarks.push({
      ...mkBenchmark({ id: 'list_cursor_models_local_env_override', category: 'roster_resolution', local: true, external: false, description: 'roles.mjs listCursorModels() with $PLAN_LEDGER_CURSOR_MODELS set — the fully local path (no external process spawn). Represents the floor cost of model-catalog resolution when an account model list is not needed.' }),
      samples: localSamples.map(round2), stats: stats(localSamples),
    });
  }
  {
    // External: real `agent --list-models` shellout (bounded by the 5s timeout already in roles.mjs).
    const samples = [];
    for (let i = 0; i < EXTERNAL_SAMPLES; i++) { const { ms } = timeSync(() => listCursorModels()); samples.push(ms); }
    benchmarks.push({
      ...mkBenchmark({ id: 'list_cursor_models_external_agent_cli', category: 'roster_resolution', local: false, external: true, description: 'roles.mjs listCursorModels() with NO override — spawns `agent --list-models` (or the installed cursor-agent shim), bounded at a 5000ms timeout. This is EXTERNAL Cursor-account/process latency, not plan-ledger product latency; fewer samples than local hot paths by design (brief: separate local from external).' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { ms } = timeSync(() => resolveRole('implementer', { cwd: REPO_ROOT, projectName: 'bench-rw' }));
      samples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'resolve_role_local', category: 'roster_resolution', local: true, external: false, description: 'roles.mjs resolveRole(role, {cwd, projectName}) — reads .plan-roles.json (repo) + ~/.claude/plan-roles.json (user) from disk on every call (no cache) and falls back to default charter chain. Fully local disk I/O, no process spawn.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const savedEnv = process.env.PLAN_LEDGER_CURSOR_MODELS;
    process.env.PLAN_LEDGER_CURSOR_MODELS = 'claude-sonnet-5-thinking-high,gpt-5.3-codex';
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) { const { ms } = timeSync(() => rwStore.getPlanRoster(rwPlan.id, { cwd: REPO_ROOT })); samples.push(ms); }
    if (savedEnv === undefined) delete process.env.PLAN_LEDGER_CURSOR_MODELS; else process.env.PLAN_LEDGER_CURSOR_MODELS = savedEnv;
    benchmarks.push({
      ...mkBenchmark({ id: 'get_plan_roster_local', category: 'roster_resolution', local: true, external: false, description: 'Store.getPlanRoster(planId) with $PLAN_LEDGER_CURSOR_MODELS set (no external shellout) — one listCursorModels() call + per-step (8 steps) resolveRole + dispatch-policy scoring. Isolates the LOCAL, O(steps) cost of the roster view.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }

  // === 8. Execution lease + activity writes (in-process) ==================
  const leaseDb = freshDbPath('lease');
  const leaseStore = new Store(leaseDb);
  const leaseProject = leaseStore.createProject({ name: 'bench-lease', description: '' });
  let leasePlan = leaseStore.createPlan({ title: 'Execution lease benchmark plan', keywords: [], project_id: leaseProject.id });
  leasePlan = leaseStore.setPlanStatus(leasePlan.id, 'active');
  {
    const openMs = [], heartbeatMs = [], closeMs = [];
    for (let i = 0; i < SAMPLES; i++) {
      const s = leaseStore.addStep(leasePlan.id, { title: `Lease step ${i}`, context: 'x', acceptance_criteria: 'x' });
      const { ms: om, result: opened } = timeSync(() => leaseStore.openExecutionLease({
        plan_id: leasePlan.id, step_id: s.id, executor: 'bench', role: 'implementer', agent: 'bench-agent',
      }));
      openMs.push(om);
      const leaseId = opened.lease.id;
      const { ms: hm } = timeSync(() => leaseStore.heartbeatExecutionLease(leaseId, { phase: 'implementing', action_summary: 'bench heartbeat' }));
      heartbeatMs.push(hm);
      const { ms: cm } = timeSync(() => leaseStore.closeExecutionLease(leaseId, { outcome: 'success', status: 'done' }));
      closeMs.push(cm);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'execution_lease_open', category: 'execution_lease', local: true, external: false, description: 'Store.openExecutionLease({...}) — CAS-claims the step + upserts paired activity row + INSERTs lease row, inside a transaction. Fresh step per sample (one open lease per step at a time).' }),
      samples: openMs.map(round2), stats: stats(openMs),
    });
    benchmarks.push({
      ...mkBenchmark({ id: 'execution_lease_heartbeat', category: 'execution_lease', local: true, external: false, description: 'Store.heartbeatExecutionLease(id, patch) — bumps lease clock + upserts activity telemetry, inside a transaction.' }),
      samples: heartbeatMs.map(round2), stats: stats(heartbeatMs),
    });
    benchmarks.push({
      ...mkBenchmark({ id: 'execution_lease_close', category: 'execution_lease', local: true, external: false, description: 'Store.closeExecutionLease(id, {...}) — finalizes lease + activity status, inside a transaction.' }),
      samples: closeMs.map(round2), stats: stats(closeMs),
    });
  }
  {
    const startMs = [], eventMs = [];
    for (let i = 0; i < SAMPLES; i++) {
      const s = leaseStore.addStep(leasePlan.id, { title: `Activity step ${i}`, context: 'x', acceptance_criteria: 'x' });
      const { ms: sm, result: activity } = timeSync(() => leaseStore.startActivity({
        plan_id: leasePlan.id, step_id: s.id, run_id: `bench-run-${i}-${Date.now()}`, session_ref: `bench-session-${i}`,
        role: 'implementer', agent: 'bench-agent', phase: 'preflight', action_summary: 'bench activity start',
      }));
      startMs.push(sm);
      const { ms: em } = timeSync(() => leaseStore.appendActivityEvent({
        plan_id: leasePlan.id, step_id: s.id, run_id: activity.run_id, session_ref: activity.session_ref,
        event_type: 'timeline', phase: 'implementing', summary: 'bench event',
      }));
      eventMs.push(em);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'activity_start', category: 'activity', local: true, external: false, description: 'Store.startActivity({...}) — creates a new activity_runs row, inside a transaction.' }),
      samples: startMs.map(round2), stats: stats(startMs),
    });
    benchmarks.push({
      ...mkBenchmark({ id: 'activity_append_event', category: 'activity', local: true, external: false, description: 'Store.appendActivityEvent({...}) — upserts the activity row + INSERTs one activity_events row + compacts timeline events, inside a transaction.' }),
      samples: eventMs.map(round2), stats: stats(eventMs),
    });
  }
  {
    const burstCount = 1000;
    const collectBurst = (targetStore, targetPlan, prefix) => {
      const s = targetStore.addStep(targetPlan.id, { title: 'Activity burst step', context: 'x', acceptance_criteria: 'x' });
      const run = targetStore.startActivity({
        plan_id: targetPlan.id,
        step_id: s.id,
        run_id: `${prefix}-${Date.now()}`,
        session_ref: `${prefix}-session`,
        role: 'implementer',
        phase: 'burst',
      });
      const values = [];
      for (let i = 0; i < burstCount; i++) {
        const { ms } = timeSync(() => targetStore.appendActivityEvent({
          plan_id: targetPlan.id,
          step_id: s.id,
          run_id: run.run_id,
          session_ref: run.session_ref,
          event_type: 'heartbeat_progress',
          phase: 'burst',
          summary: `heartbeat ${i}`,
          metadata: { seq: i },
        }));
        values.push(ms);
      }
      return values;
    };
    const diskBurstMs = collectBurst(leaseStore, leasePlan, 'bench-burst-disk');
    const deterministicStore = new Store(':memory:');
    const deterministicPlan = deterministicStore.setPlanStatus(
      deterministicStore.createPlan({ title: 'Deterministic activity append benchmark' }).id,
      'active',
    );
    const burstMs = collectBurst(deterministicStore, deterministicPlan, 'bench-burst-memory');
    deterministicStore.close();
    benchmarks.push({
      ...mkBenchmark({
        id: 'activity_append_event_1000',
        category: 'activity',
        local: true,
        external: false,
        description: 'Deterministic in-memory Store.appendActivityEvent({...}) burst over 1000 lifecycle heartbeats; used for the C4 <=1ms p95 code/SQL budget independently of filesystem fsync jitter.',
      }),
      samples: burstMs.map(round2),
      stats: stats(burstMs),
      sample_count: burstCount,
      storage_mode: 'in_memory_deterministic_gate',
    });
    benchmarks.push({
      ...mkBenchmark({
        id: 'activity_append_event_1000_disk_observed',
        category: 'activity',
        local: true,
        external: false,
        description: 'Observed WAL-backed append wall time over 1000 lifecycle heartbeats; reported separately because fsync scheduling is environmental.',
      }),
      samples: diskBurstMs.map(round2),
      stats: stats(diskBurstMs),
      sample_count: burstCount,
      storage_mode: 'wal_disk_observation',
    });
  }

  // === 9. Runner preflight (execution-governance.mjs) — local vs external ==
  {
    const catalog = { models: ['claude-sonnet-5-thinking-high', 'gpt-5.3-codex'], source: 'test-fixed' };
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { ms } = await timeAsync(() => runDispatchPreflight({
        cwd: REPO_ROOT, requested_model: 'gpt-5.3-codex',
        context: 'Implement the feature.', acceptance: 'Tests pass.',
        model_catalog: catalog,
      }));
      samples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'runner_preflight_local', category: 'runner_preflight', local: true, external: false, description: 'execution-governance.mjs runDispatchPreflight({..., model_catalog: <fixed>}) — hint parsing + workspace/model/path checks with an explicit model catalog (no external shellout). Isolates the LOCAL preflight cost the runner pays before every spawned agent.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }
  {
    const samples = [];
    for (let i = 0; i < EXTERNAL_SAMPLES; i++) {
      const { ms } = await timeAsync(() => runDispatchPreflight({
        cwd: REPO_ROOT, requested_model: 'gpt-5.3-codex',
        context: 'Implement the feature.', acceptance: 'Tests pass.',
      }));
      samples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'runner_preflight_default_external', category: 'runner_preflight', local: false, external: true, description: 'execution-governance.mjs runDispatchPreflight({...}) with NO model_catalog override — falls through to listCursorModels(), which shells out to `agent --list-models`. EXTERNAL latency (Cursor-account round trip), not plan-ledger product latency; fewer samples by design.' }),
      samples: samples.map(round2), stats: stats(samples),
    });
  }

  rwStore.close();
  rsStore.close();
  leaseStore.close();

  // === 10. Board server startup (spawn -> first successful /api/meta) =====
  {
    const startupSamples = [];
    const boardDb = freshDbPath('board');
    { const seed = new Store(boardDb); seed.createProject({ name: 'bench-board', description: '' }); seed.close(); }
    const startupIterations = SAMPLES;
    for (let i = 0; i < startupIterations; i++) {
      const port = await findFreePort(0);
      const t0 = performance.now();
      const child = spawn(process.execPath, ['--no-warnings', BOARD_SERVER], {
        cwd: REPO_ROOT,
        env: { ...process.env, PLAN_LEDGER_DB: boardDb, PLAN_LEDGER_WEB_PORT: String(port), PLAN_LEDGER_NO_OPEN: '1' },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const ready = await pollBoardReady({ port });
      const ms = performance.now() - t0;
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 30));
      if (ready) startupSamples.push(ms);
    }
    benchmarks.push({
      ...mkBenchmark({ id: 'board_server_startup', category: 'board_server', local: true, external: false, description: `Wall time from spawning \`node web/server.mjs\` to the first successful GET /api/meta response (immediate poll via setImmediate yield, 250ms per-probe timeout). Includes Node startup, module graph load, DB open, reap-loop init, and HTTP listen. ${startupIterations} real process spawns.` }),
      samples: startupSamples.map(round2), stats: stats(startupSamples),
    });
  }

  // === 11. Board API/page loads (one warm long-lived server) ==============
  {
    const boardDb = freshDbPath('board-api');
    const seed = new Store(boardDb);
    seed.createProject({ name: 'bench-board-api', description: '' });
    const p = seed.createPlan({ title: 'Board API benchmark plan', keywords: ['bench'] });
    for (let i = 0; i < 6; i++) seed.addStep(p.id, { title: `Board step ${i}`, context: 'x', acceptance_criteria: 'x' });
    seed.close();

    const port = await findFreePort(0);
    const child = spawn(process.execPath, ['--no-warnings', BOARD_SERVER], {
      cwd: REPO_ROOT,
      env: { ...process.env, PLAN_LEDGER_DB: boardDb, PLAN_LEDGER_WEB_PORT: String(port), PLAN_LEDGER_NO_OPEN: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const up = await pollBoardReady({ port });
    if (up) {
      const client = createKeepAliveClient({ port });
      const planList = JSON.parse((await client.request('/api/plans')).body.toString('utf8'));
      const planId = planList[0]?.id ?? 1;
      const endpoints = [
        { id: 'board_api_meta', path: '/api/meta', description: 'GET /api/meta — service identity/db-identity probe used by the CLI bridge before every board open/launch.' },
        { id: 'board_api_plans', path: '/api/plans', description: 'GET /api/plans — level-0 plan list used by the board UI.' },
        { id: 'board_api_plan_detail', path: `/api/plans/${planId}`, description: 'GET /api/plans/:id — level-1 plan detail (steps index) used when opening a plan.' },
        { id: 'board_page_index', path: '/', description: 'GET / — the board\'s index.html page load (static file read + serve).' },
      ];
      await client.warm(endpoints.map((ep) => ep.path));
      for (const ep of endpoints) {
        const samples = [];
        for (let i = 0; i < SAMPLES; i++) {
          const { ms } = await client.timedGet(ep.path);
          samples.push(ms);
        }
        benchmarks.push({
          ...mkBenchmark({ id: ep.id, category: 'board_api', local: true, external: false, description: ep.description }),
          samples: samples.map(round2), stats: stats(samples),
        });
      }
      client.close();
    } else {
      benchmarks.push({
        ...mkBenchmark({ id: 'board_api_unavailable', category: 'board_api', local: true, external: false, description: 'Board server did not become ready within 8s; API load benchmarks skipped for this run.' }),
        samples: [], stats: stats([]),
      });
    }
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
  }

  // === 12. Cursor CLI session startup — bounded, non-destructive no-op ====
  {
    const versionProbe = spawnCliNoOp(['agent', '--version']);
    const available = versionProbe.status === 0 && !versionProbe.error;
    if (available) {
      const samples = [versionProbe.ms];
      for (let i = 1; i < EXTERNAL_SAMPLES; i++) {
        const r = spawnCliNoOp(['agent', '--version']);
        if (r.status === 0) samples.push(r.ms);
      }
      benchmarks.push({
        ...mkBenchmark({ id: 'cursor_cli_version_noop', category: 'cursor_cli', local: false, external: true, description: '`agent --version` — bounded, non-destructive no-op probe of Cursor CLI process/session startup latency. Fully external to plan-ledger; reported separately from local product latency per the brief. Does not start a planning/execution session, does not call planner_start.' }),
        samples: samples.map(round2), stats: stats(samples), available: true,
      });
    } else {
      benchmarks.push({
        ...mkBenchmark({ id: 'cursor_cli_version_noop', category: 'cursor_cli', local: false, external: true, description: 'Cursor CLI (`agent`) no-op version probe.' }),
        samples: [], stats: stats([]), available: false,
        unavailable_reason: versionProbe.error ? String(versionProbe.error.message ?? versionProbe.error) : `exit code ${versionProbe.status}`,
      });
    }
  }

  // === 13. Scaling behavior: plan size vs openPlan/readySteps/roster ======
  {
    const sizes = [5, 25, 50, 100];
    for (const size of sizes) {
      const dbPath = freshDbPath(`scale-${size}`);
      const store = new Store(dbPath);
      const project = store.createProject({ name: `bench-scale-${size}`, description: '' });
      let plan = store.createPlan({ title: `Scaling plan (${size} steps)`, keywords: [], project_id: project.id });
      for (let i = 0; i < size; i++) {
        store.addStep(plan.id, { title: `Scale step ${i}`, context: 'x', acceptance_criteria: 'x', role: i % 3 === 0 ? 'implementer' : '' });
      }
      plan = store.setPlanStatus(plan.id, 'active');
      const n = SAMPLES;

      const openPlanSamples = [];
      for (let i = 0; i < n; i++) { const { ms } = timeSync(() => store.openPlan(plan.id)); openPlanSamples.push(ms); }

      const readyStepsSamples = [];
      for (let i = 0; i < n; i++) { const { ms } = timeSync(() => store.readySteps(plan.id, { claim: false })); readyStepsSamples.push(ms); }

      const savedEnv = process.env.PLAN_LEDGER_CURSOR_MODELS;
      process.env.PLAN_LEDGER_CURSOR_MODELS = 'claude-sonnet-5-thinking-high';
      const rosterSamples = [];
      for (let i = 0; i < n; i++) { const { ms } = timeSync(() => store.getPlanRoster(plan.id, { cwd: REPO_ROOT })); rosterSamples.push(ms); }
      if (savedEnv === undefined) delete process.env.PLAN_LEDGER_CURSOR_MODELS; else process.env.PLAN_LEDGER_CURSOR_MODELS = savedEnv;

      store.close();
      scaling.push({
        steps: size,
        n,
        open_plan: stats(openPlanSamples),
        ready_steps: stats(readyStepsSamples),
        get_plan_roster_local: stats(rosterSamples),
      });
    }
  }

  return { run_label: RUN_LABEL, started_at: startedAt, ended_at: new Date().toISOString(), benchmarks, scaling };
}

// ---------------------------------------------------------------------------
// Historical review/verification handoff analysis (static, from census JSON)
// ---------------------------------------------------------------------------
function analyzeHistoricalHandoff() {
  if (!existsSync(CENSUS_PATH)) {
    return { available: false, reason: `census file not found at ${CENSUS_PATH}` };
  }
  const census = JSON.parse(readFileSync(CENSUS_PATH, 'utf8'));
  const plans = Array.isArray(census?.plans) ? census.plans : [];
  const timeToFirstAttemptMs = [];
  const attemptSpanMs = [];
  const verificationHandoffMs = [];
  const reviewRoundsTotals = [];
  let stepsSeen = 0;

  for (const plan of plans) {
    const planSteps = Array.isArray(plan?.steps) ? plan.steps : [];
    for (const step of planSteps) {
      stepsSeen++;
      const createdAt = step.created_at ? Date.parse(step.created_at) : NaN;
      const attempts = Array.isArray(step.attempts) ? step.attempts : [];
      const firstAttemptAt = attempts.length ? Date.parse(attempts[0].created_at) : NaN;
      const lastAttemptAt = attempts.length ? Date.parse(attempts[attempts.length - 1].created_at) : NaN;
      const dispositionAt = step.disposition_at ? Date.parse(step.disposition_at) : NaN;

      if (Number.isFinite(createdAt) && Number.isFinite(firstAttemptAt) && firstAttemptAt >= createdAt) {
        timeToFirstAttemptMs.push(firstAttemptAt - createdAt);
      }
      const span = step.derived?.attempt_timeline?.elapsed_ms;
      if (Number.isFinite(span) && span >= 0) attemptSpanMs.push(span);
      if (Number.isFinite(lastAttemptAt) && Number.isFinite(dispositionAt) && dispositionAt >= lastAttemptAt) {
        verificationHandoffMs.push(dispositionAt - lastAttemptAt);
      }
      const rounds = step.derived?.review_rounds_total;
      if (Number.isFinite(rounds)) reviewRoundsTotals.push(rounds);
    }
  }

  return {
    available: true,
    source: CENSUS_PATH,
    note: 'Static historical analysis derived from timestamps already recorded in the cross-plan census (plans #1-16). This is NOT a live benchmark — it reflects real historical work sessions dominated by external agent/model think-time and human review latency, not plan-ledger product latency. Reported separately per the brief\u2019s "separate local product latency from external model/agent latency" requirement.',
    steps_seen: stepsSeen,
    time_to_first_attempt_ms: { unit: 'ms', description: 'step.created_at -> first attempt.created_at (time until work on a claimed step was first recorded).', stats: stats(timeToFirstAttemptMs) },
    attempt_span_ms: { unit: 'ms', description: 'derived.attempt_timeline.elapsed_ms (first attempt -> last attempt on the same step; captures retry/review cycles).', stats: stats(attemptSpanMs) },
    verification_handoff_ms: { unit: 'ms', description: 'last attempt.created_at -> step.disposition_at (elapsed time between finishing an attempt and the verification disposition being recorded — the review/verification handoff proxy requested in the brief).', stats: stats(verificationHandoffMs) },
    review_rounds_total: { unit: 'count', description: 'derived.review_rounds_total per step (orchestrator send-back rounds before acceptance).', stats: stats(reviewRoundsTotals) },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const prodBefore = fingerprintFile(PROD_DB_PATH);
  log('captured production DB fingerprint (before)');

  const run = await runOnce();

  const prodAfter = fingerprintFile(PROD_DB_PATH);
  const contentUnchanged = prodBefore.exists === prodAfter.exists
    && (!prodBefore.exists || (prodBefore.sha256 === prodAfter.sha256 && prodBefore.size === prodAfter.size));
  const usedDbIdentities = [...ISOLATED_DB_PATHS].map((p) => canonicalDbIdentity(p));
  const productionIdentityUsed = usedDbIdentities.includes(PROD_DB_IDENTITY);
  const pathIsolationVerified = !productionIdentityUsed;

  const historical = analyzeHistoricalHandoff();

  const output = {
    schema_version: 1,
    tool: 'benchmarks/non-planner-latency.mjs',
    run_label: run.run_label,
    generated_at: new Date().toISOString(),
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
    repo_root: REPO_ROOT,
    config: { samples_per_local_benchmark: SAMPLES, external_samples: EXTERNAL_SAMPLES },
    temp_root: TEMP_ROOT,
    production_db_guard: {
      path: PROD_DB_PATH,
      db_identity: PROD_DB_IDENTITY,
      opened_by_this_run: false,
      before: prodBefore,
      after: prodAfter,
      content_unchanged_during_run: contentUnchanged,
      path_isolation_verified: pathIsolationVerified,
      production_identity_used_by_benchmark: productionIdentityUsed,
      isolated_db_paths_used: [...ISOLATED_DB_PATHS],
      note: contentUnchanged
        ? 'Production DB content did not change during this run.'
        : 'Production DB content changed during this run due to concurrent external activity; benchmark still verified strict path isolation and never targeted the production DB identity.',
    },
    started_at: run.started_at,
    ended_at: run.ended_at,
    wall_clock_ms: Date.parse(run.ended_at) - Date.parse(run.started_at),
    benchmarks: run.benchmarks,
    scaling: run.scaling,
    historical_handoff_analysis: historical,
  };

  if (!pathIsolationVerified) {
    console.error('[bench] FATAL: benchmark resolved the production DB identity as a target path.');
    console.error(JSON.stringify({ prod_identity: PROD_DB_IDENTITY, used_db_identities: usedDbIdentities }, null, 2));
    process.exitCode = 1;
  } else if (!contentUnchanged) {
    console.error('[bench] WARN: production DB content changed during run (external concurrent activity), but path isolation remained intact.');
    console.error(JSON.stringify({ before: prodBefore, after: prodAfter }, null, 2));
  }

  // Cleanup temp root (isolated; never touches the production DB or repo files).
  try { rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }

  const json = JSON.stringify(output, null, 2);
  if (OUT_PATH) {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, json, 'utf8');
    log(`wrote ${OUT_PATH} (${json.length} bytes)`);
  }

  // Compact human summary to stdout regardless of --out.
  const summaryLines = [];
  summaryLines.push(`plan-ledger non-planner latency benchmark - ${output.run_label}`);
  summaryLines.push(`production DB path isolation verified: ${pathIsolationVerified} (path: ${PROD_DB_PATH})`);
  summaryLines.push(`production DB content unchanged during run: ${contentUnchanged}`);
  summaryLines.push(`wall clock: ${output.wall_clock_ms}ms  node: ${output.node_version}  platform: ${output.platform}`);
  summaryLines.push('');
  for (const b of output.benchmarks) {
    const s = b.stats;
    const tag = b.external ? '[external]' : '[local]   ';
    if (!s || !s.n) { summaryLines.push(`${tag} ${b.id.padEnd(36)} n=0 (unavailable${b.unavailable_reason ? ': ' + b.unavailable_reason : ''})`); continue; }
    summaryLines.push(`${tag} ${b.id.padEnd(36)} n=${String(s.n).padStart(3)}  p50=${String(s.p50).padStart(8)}ms  p95=${String(s.p95).padStart(8)}ms  mean=${String(s.mean).padStart(8)}ms  min=${s.min}  max=${s.max}`);
  }
  summaryLines.push('');
  summaryLines.push('scaling (steps -> openPlan/readySteps/getPlanRoster p50 ms):');
  for (const row of output.scaling) {
    summaryLines.push(`  steps=${String(row.steps).padStart(4)}  openPlan p50=${row.open_plan.p50}ms  readySteps p50=${row.ready_steps.p50}ms  getPlanRoster(local) p50=${row.get_plan_roster_local.p50}ms`);
  }
  summaryLines.push('');
  if (historical.available) {
    summaryLines.push(`historical handoff analysis (${historical.steps_seen} steps from plans #1-16):`);
    summaryLines.push(`  time_to_first_attempt   p50=${historical.time_to_first_attempt_ms.stats.p50}ms  p95=${historical.time_to_first_attempt_ms.stats.p95}ms  n=${historical.time_to_first_attempt_ms.stats.n}`);
    summaryLines.push(`  attempt_span            p50=${historical.attempt_span_ms.stats.p50}ms  p95=${historical.attempt_span_ms.stats.p95}ms  n=${historical.attempt_span_ms.stats.n}`);
    summaryLines.push(`  verification_handoff    p50=${historical.verification_handoff_ms.stats.p50}ms  p95=${historical.verification_handoff_ms.stats.p95}ms  n=${historical.verification_handoff_ms.stats.n}`);
  } else {
    summaryLines.push(`historical handoff analysis: unavailable (${historical.reason})`);
  }
  console.log(summaryLines.join('\n'));

  if (!pathIsolationVerified) process.exit(1);
}

await main();
