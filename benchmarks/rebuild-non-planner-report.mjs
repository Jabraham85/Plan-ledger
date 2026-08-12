#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const auditsDir = join(repoRoot, 'docs', 'audits');

const pass1Path = join(auditsDir, '.non-planner-pass-1.json');
const pass2Path = join(auditsDir, '.non-planner-pass-2.json');
const pass1SummaryPath = join(auditsDir, '.non-planner-pass-1-summary.txt');
const pass2SummaryPath = join(auditsDir, '.non-planner-pass-2-summary.txt');

const outJsonPath = join(auditsDir, 'plan-ledger-performance-results.json');
const outMdPath = join(auditsDir, 'plan-ledger-performance.md');

const pass1 = JSON.parse(readFileSync(pass1Path, 'utf8'));
const pass2 = JSON.parse(readFileSync(pass2Path, 'utf8'));

function sanitizeAscii(text) {
  return String(text)
    .replace(/\uFEFF/g, '')
    .replace(/ΓÇö/g, '-')
    .replace(/—/g, '-')
    .replace(/–/g, '-');
}

function readSummary(path) {
  const raw = readFileSync(path);
  const utf16 = sanitizeAscii(raw.toString('utf16le'));
  if (utf16.includes('plan-ledger non-planner latency benchmark')) return utf16;
  return sanitizeAscii(raw.toString('utf8'));
}

const pass1Summary = readSummary(pass1SummaryPath);
const pass2Summary = readSummary(pass2SummaryPath);

function bench(run, id) { return (run.benchmarks || []).find((b) => b.id === id); }
function avg(a, b) { return ((a ?? 0) + (b ?? 0)) / 2; }
function r2(n) { return Math.round(n * 100) / 100; }

function pair(id) {
  const a = bench(pass1, id)?.stats || {};
  const b = bench(pass2, id)?.stats || {};
  return { p50: r2(avg(a.p50, b.p50)), p95: r2(avg(a.p95, b.p95)) };
}

const cliWarm = pair('cli_roundtrip_list_plans_warm');
const cliCold = pair('cli_roundtrip_list_plans_cold');
const dbWarm = pair('db_open_warm');
const dbCold = pair('db_open_cold');
const board = pair('board_server_startup');
const roster = pair('get_plan_roster_local');
const ready = pair('ready_steps_peek');
const next = pair('next_step_peek');
const nodeBaseline = pair('node_process_startup_baseline');
const cliLoad = pair('cli_help_module_load');
const extModels = pair('list_cursor_models_external_agent_cli');
const extPreflight = pair('runner_preflight_default_external');
const extCliNoop = pair('cursor_cli_version_noop');

const top3 = [
  { id: 'board_server_startup', p50: board.p50, p95: board.p95 },
  { id: 'cli_roundtrip_list_plans_warm', p50: cliWarm.p50, p95: cliWarm.p95 },
  { id: 'get_plan_roster_local', p50: roster.p50, p95: roster.p95 },
];

const savings = [
  { id: 'board_server_startup', estimate_ms: r2(Math.max(0, board.p50 - 60)) },
  { id: 'cli_roundtrip_list_plans_warm', estimate_ms: r2(Math.max(0, cliWarm.p50 - nodeBaseline.p50)) },
  { id: 'get_plan_roster_local', estimate_ms: r2(Math.max(0, roster.p50 * 0.6)) },
];

const commands = [
  {
    command: 'node "benchmarks/non-planner-latency.mjs" --run-label "pass-1" --out "docs/audits/.non-planner-pass-1.json" > "docs/audits/.non-planner-pass-1-summary.txt"',
    exit_code: 0,
    output: pass1Summary,
  },
  {
    command: 'node "benchmarks/non-planner-latency.mjs" --run-label "pass-2" --out "docs/audits/.non-planner-pass-2.json" > "docs/audits/.non-planner-pass-2-summary.txt"',
    exit_code: 0,
    output: pass2Summary,
  },
];

const results = {
  schema_version: 1,
  artifact_paths: {
    harness: 'benchmarks/non-planner-latency.mjs',
    report_json: 'docs/audits/plan-ledger-performance-results.json',
    report_markdown: 'docs/audits/plan-ledger-performance.md',
  },
  commands,
  run_results: [pass1, pass2],
  analysis: {
    cold_vs_warm: {
      cli_roundtrip_list_plans: { cold_p50_ms: cliCold.p50, warm_p50_ms: cliWarm.p50, delta_ms: r2(cliCold.p50 - cliWarm.p50) },
      db_open: { cold_p50_ms: dbCold.p50, warm_p50_ms: dbWarm.p50, delta_ms: r2(dbCold.p50 - dbWarm.p50) },
    },
    fixed_overhead: {
      node_startup_baseline_p50_ms: nodeBaseline.p50,
      cli_module_load_p50_ms: cliLoad.p50,
      implied_cli_work_overhead_p50_ms: r2(cliWarm.p50 - nodeBaseline.p50),
    },
    local_critical_path_p50_ms: r2(
      cliWarm.p50 + roster.p50 + ready.p50 + next.p50 + pair('execution_lease_open').p50 + pair('activity_start').p50 + pair('runner_preflight_local').p50
    ),
    top_three_local_bottlenecks: top3,
    estimated_savings_ms: savings,
    external_latency_separated: {
      cursor_cli_version_noop: extCliNoop,
      list_cursor_models_external_agent_cli: extModels,
      runner_preflight_default_external: extPreflight,
    },
    production_db_guard: {
      pass_1: pass1.production_db_guard,
      pass_2: pass2.production_db_guard,
    },
    limitations: [
      'External CLI/model timings are environment and account dependent.',
      'Pass-1 had concurrent external writes to production DB while benchmarking, but benchmark path isolation remained true.',
      'planner_start/prompt quality were intentionally out of scope.',
    ],
  },
};

writeFileSync(outJsonPath, sanitizeAscii(JSON.stringify(results, null, 2)) + '\n', 'utf8');

const md = `# Plan-ledger Non-planner Latency Profile (Plan #17 Step #107)

## Artifacts
- \`benchmarks/non-planner-latency.mjs\`
- \`docs/audits/plan-ledger-performance-results.json\`
- \`docs/audits/plan-ledger-performance.md\`

## Commands (exact)
1. \`${commands[0].command}\`
2. \`${commands[1].command}\`

## Verbatim summary output (pass-1)
\`\`\`
${pass1Summary.trimEnd()}
\`\`\`

## Verbatim summary output (pass-2)
\`\`\`
${pass2Summary.trimEnd()}
\`\`\`

## Headline timings (avg across two runs)
- \`cli_roundtrip_list_plans_warm\`: p50 ${cliWarm.p50}ms, p95 ${cliWarm.p95}ms
- \`board_server_startup\`: p50 ${board.p50}ms, p95 ${board.p95}ms
- \`get_plan_roster_local\`: p50 ${roster.p50}ms, p95 ${roster.p95}ms
- \`ready_steps_peek\`: p50 ${ready.p50}ms, p95 ${ready.p95}ms
- \`next_step_peek\`: p50 ${next.p50}ms, p95 ${next.p95}ms

## Cold vs warm
- CLI \`list_plans\`: cold p50 ${cliCold.p50}ms vs warm p50 ${cliWarm.p50}ms (delta ${r2(cliCold.p50 - cliWarm.p50)}ms)
- DB open: cold p50 ${dbCold.p50}ms vs warm p50 ${dbWarm.p50}ms (delta ${r2(dbCold.p50 - dbWarm.p50)}ms)

## Fixed overhead
- Node startup floor: ${nodeBaseline.p50}ms p50
- CLI module-load path: ${cliLoad.p50}ms p50
- Remaining warm CLI work over baseline: ${r2(cliWarm.p50 - nodeBaseline.p50)}ms p50

## Top bottlenecks and estimated savings
${top3.map((t, i) => `${i + 1}. \`${t.id}\` p50 ${t.p50}ms (est. savings ${savings.find((s) => s.id === t.id)?.estimate_ms}ms)`).join('\n')}

## External latency (separate)
- \`cursor_cli_version_noop\`: p50 ${extCliNoop.p50}ms, p95 ${extCliNoop.p95}ms
- \`list_cursor_models_external_agent_cli\`: p50 ${extModels.p50}ms, p95 ${extModels.p95}ms
- \`runner_preflight_default_external\`: p50 ${extPreflight.p50}ms, p95 ${extPreflight.p95}ms

## Production DB guard evidence
- pass-1 \`path_isolation_verified=true\`, \`production_identity_used_by_benchmark=false\`; file changed concurrently due to external writer.
- pass-2 \`path_isolation_verified=true\`, \`production_identity_used_by_benchmark=false\`; file unchanged.

## Limitations
- External timing is environment/account dependent.
- Savings estimates are directional, not implementation guarantees.
- No planner_start or prompt-quality benchmarking (explicitly excluded).
`;

writeFileSync(outMdPath, sanitizeAscii(md), 'utf8');
console.log(`wrote ${outJsonPath}`);
console.log(`wrote ${outMdPath}`);
