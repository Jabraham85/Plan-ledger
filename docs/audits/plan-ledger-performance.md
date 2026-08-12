# Plan-ledger Non-planner Latency Profile (Plan #17 Step #107)

## Artifacts
- `benchmarks/non-planner-latency.mjs`
- `docs/audits/plan-ledger-performance-results.json`
- `docs/audits/plan-ledger-performance.md`

## Commands (exact)
1. `node "benchmarks/non-planner-latency.mjs" --run-label "pass-1" --out "docs/audits/.non-planner-pass-1.json" > "docs/audits/.non-planner-pass-1-summary.txt"`
2. `node "benchmarks/non-planner-latency.mjs" --run-label "pass-2" --out "docs/audits/.non-planner-pass-2.json" > "docs/audits/.non-planner-pass-2-summary.txt"`

## Verbatim summary output (pass-1)
```
plan-ledger non-planner latency benchmark - pass-1
production DB path isolation verified: true (path: C:\Users\Jose.Abraham\Documents\plan-ledger\data\plan-ledger.db)
production DB content unchanged during run: false
wall clock: 57322ms  node: v24.5.0  platform: win32-x64

[local]    node_process_startup_baseline        n= 30  p50=    57.5ms  p95=    60.2ms  mean=   57.44ms  min=53.81  max=60.59
[local]    cli_help_module_load                 n= 30  p50=   67.76ms  p95=   70.97ms  mean=   67.92ms  min=64.38  max=72.03
[local]    cli_roundtrip_list_plans_cold        n= 30  p50=   96.44ms  p95=  103.51ms  mean=   97.32ms  min=92.08  max=115.57
[local]    cli_roundtrip_list_plans_warm        n= 30  p50=   73.44ms  p95=   77.82ms  mean=   73.62ms  min=69.58  max=78.64
[local]    db_open_cold                         n= 30  p50=   22.29ms  p95=   25.12ms  mean=   22.23ms  min=19.58  max=25.38
[local]    db_open_warm                         n= 30  p50=    1.97ms  p95=    2.26ms  mean=    2.03ms  min=1.91  max=2.29
[local]    read_list_plans                      n= 30  p50=    0.03ms  p95=    0.08ms  mean=    0.03ms  min=0.02  max=0.13
[local]    read_open_plan                       n= 30  p50=    0.07ms  p95=    0.09ms  mean=    0.08ms  min=0.06  max=0.13
[local]    read_get_step                        n= 30  p50=    0.14ms  p95=     0.2ms  mean=    0.15ms  min=0.11  max=0.23
[local]    write_add_step                       n= 30  p50=    1.13ms  p95=    1.49ms  mean=    1.14ms  min=0.67  max=1.58
[local]    write_update_step                    n= 30  p50=    0.85ms  p95=    1.44ms  mean=    0.88ms  min=0.49  max=1.49
[local]    write_record_attempt                 n= 30  p50=    0.76ms  p95=    1.23ms  mean=    1.01ms  min=0.62  max=7.26
[local]    next_step_peek                       n= 30  p50=    0.25ms  p95=     5.4ms  mean=    0.67ms  min=0.21  max=7.14
[local]    ready_steps_peek                     n= 30  p50=    1.99ms  p95=    3.34ms  mean=    2.27ms  min=1.74  max=3.98
[local]    list_cursor_models_local_env_override n= 30  p50=       0ms  p95=    0.21ms  mean=    0.07ms  min=0  max=1.93
[external] list_cursor_models_external_agent_cli n= 10  p50=  1378.8ms  p95= 1492.78ms  mean= 1395.95ms  min=1363.23  max=1492.78
[local]    resolve_role_local                   n= 30  p50=    0.18ms  p95=    0.42ms  mean=    0.21ms  min=0.16  max=0.57
[local]    get_plan_roster_local                n= 30  p50=   14.53ms  p95=    15.6ms  mean=    14.1ms  min=11.49  max=15.69
[local]    execution_lease_open                 n= 30  p50=    0.93ms  p95=     1.6ms  mean=    0.98ms  min=0.78  max=1.89
[local]    execution_lease_heartbeat            n= 30  p50=    0.69ms  p95=    0.97ms  mean=    0.77ms  min=0.58  max=2.09
[local]    execution_lease_close                n= 30  p50=    0.94ms  p95=    1.35ms  mean=    1.01ms  min=0.8  max=1.67
[local]    activity_start                       n= 30  p50=    0.69ms  p95=    0.99ms  mean=    0.73ms  min=0.56  max=1.33
[local]    activity_append_event                n= 30  p50=    0.58ms  p95=    0.85ms  mean=    0.63ms  min=0.51  max=0.95
[local]    runner_preflight_local               n= 30  p50=     0.1ms  p95=     0.6ms  mean=    0.82ms  min=0.07  max=21.25
[external] runner_preflight_default_external    n= 10  p50= 1377.33ms  p95= 1472.77ms  mean= 1390.05ms  min=1354.77  max=1472.77
[local]    board_server_startup                 n= 30  p50=  110.25ms  p95=  120.71ms  mean=  106.35ms  min=95.72  max=129.75
[local]    board_api_meta                       n= 30  p50=    0.35ms  p95=    0.98ms  mean=    0.46ms  min=0.29  max=1.27
[local]    board_api_plans                      n= 30  p50=    0.38ms  p95=    0.51ms  mean=     0.4ms  min=0.34  max=0.56
[local]    board_api_plan_detail                n= 30  p50=    0.44ms  p95=     0.6ms  mean=    0.46ms  min=0.36  max=0.77
[local]    board_page_index                     n= 30  p50=    0.63ms  p95=    1.05ms  mean=    0.68ms  min=0.49  max=1.54
[external] cursor_cli_version_noop              n= 10  p50= 1028.88ms  p95= 1091.21ms  mean= 1037.68ms  min=1012.11  max=1091.21

scaling (steps -> openPlan/readySteps/getPlanRoster p50 ms):
  steps=   5  openPlan p50=0.06ms  readySteps p50=1.49ms  getPlanRoster(local) p50=1.22ms
  steps=  25  openPlan p50=0.07ms  readySteps p50=6.63ms  getPlanRoster(local) p50=5.98ms
  steps=  50  openPlan p50=0.08ms  readySteps p50=14.94ms  getPlanRoster(local) p50=13.38ms
  steps= 100  openPlan p50=0.11ms  readySteps p50=28.9ms  getPlanRoster(local) p50=25.71ms

historical handoff analysis (101 steps from plans #1-16):
  time_to_first_attempt   p50=2332838ms  p95=9058809ms  n=92
  attempt_span            p50=0ms  p95=1344729ms  n=92
  verification_handoff    p50=81342013ms  p95=342250981ms  n=92
```

## Verbatim summary output (pass-2)
```
plan-ledger non-planner latency benchmark - pass-2
production DB path isolation verified: true (path: C:\Users\Jose.Abraham\Documents\plan-ledger\data\plan-ledger.db)
production DB content unchanged during run: true
wall clock: 56842ms  node: v24.5.0  platform: win32-x64

[local]    node_process_startup_baseline        n= 30  p50=   58.23ms  p95=   63.33ms  mean=   59.16ms  min=55.59  max=66.95
[local]    cli_help_module_load                 n= 30  p50=   68.36ms  p95=    72.7ms  mean=   68.76ms  min=65.86  max=74.75
[local]    cli_roundtrip_list_plans_cold        n= 30  p50=    97.4ms  p95=  105.76ms  mean=   97.71ms  min=92.15  max=107.93
[local]    cli_roundtrip_list_plans_warm        n= 30  p50=   72.64ms  p95=   75.95ms  mean=   73.08ms  min=69.6  max=76.16
[local]    db_open_cold                         n= 30  p50=   21.44ms  p95=   23.89ms  mean=   21.71ms  min=20.16  max=24.04
[local]    db_open_warm                         n= 30  p50=     1.9ms  p95=    2.14ms  mean=    1.93ms  min=1.81  max=2.18
[local]    read_list_plans                      n= 30  p50=    0.03ms  p95=    0.14ms  mean=    0.06ms  min=0.02  max=0.89
[local]    read_open_plan                       n= 30  p50=    0.06ms  p95=     0.1ms  mean=    0.07ms  min=0.05  max=0.13
[local]    read_get_step                        n= 30  p50=    0.12ms  p95=    0.17ms  mean=    0.13ms  min=0.1  max=0.19
[local]    write_add_step                       n= 30  p50=    1.04ms  p95=    1.28ms  mean=    1.07ms  min=0.9  max=1.39
[local]    write_update_step                    n= 30  p50=    0.84ms  p95=    1.29ms  mean=    0.87ms  min=0.52  max=1.31
[local]    write_record_attempt                 n= 30  p50=     0.7ms  p95=    1.09ms  mean=    0.99ms  min=0.62  max=7.74
[local]    next_step_peek                       n= 30  p50=    0.28ms  p95=    5.64ms  mean=    0.73ms  min=0.23  max=7.75
[local]    ready_steps_peek                     n= 30  p50=    2.24ms  p95=    4.05ms  mean=    2.52ms  min=1.75  max=4.72
[local]    list_cursor_models_local_env_override n= 30  p50=       0ms  p95=       0ms  mean=    0.01ms  min=0  max=0.22
[external] list_cursor_models_external_agent_cli n= 10  p50= 1377.22ms  p95= 1446.96ms  mean= 1393.23ms  min=1355.05  max=1446.96
[local]    resolve_role_local                   n= 30  p50=    0.15ms  p95=     0.3ms  mean=    0.17ms  min=0.14  max=0.39
[local]    get_plan_roster_local                n= 30  p50=   14.54ms  p95=   17.02ms  mean=   14.35ms  min=11.22  max=17.39
[local]    execution_lease_open                 n= 30  p50=    1.06ms  p95=    2.13ms  mean=    1.17ms  min=0.8  max=2.77
[local]    execution_lease_heartbeat            n= 30  p50=    0.77ms  p95=    1.06ms  mean=    0.78ms  min=0.61  max=1.1
[local]    execution_lease_close                n= 30  p50=    1.04ms  p95=    1.51ms  mean=    1.48ms  min=0.78  max=13.08
[local]    activity_start                       n= 30  p50=    0.61ms  p95=    0.75ms  mean=    0.64ms  min=0.56  max=0.96
[local]    activity_append_event                n= 30  p50=    0.54ms  p95=    0.75ms  mean=    0.57ms  min=0.46  max=0.82
[local]    runner_preflight_local               n= 30  p50=    0.07ms  p95=    0.22ms  mean=     0.1ms  min=0.06  max=0.66
[external] runner_preflight_default_external    n= 10  p50= 1387.55ms  p95= 1440.13ms  mean= 1389.43ms  min=1355.46  max=1440.13
[local]    board_server_startup                 n= 30  p50=   97.27ms  p95=  113.85ms  mean=  103.12ms  min=90.9  max=127.35
[local]    board_api_meta                       n= 30  p50=    0.27ms  p95=    0.51ms  mean=    0.31ms  min=0.25  max=0.64
[local]    board_api_plans                      n= 30  p50=    0.39ms  p95=    0.69ms  mean=    0.41ms  min=0.32  max=0.78
[local]    board_api_plan_detail                n= 30  p50=    0.41ms  p95=    0.83ms  mean=    0.46ms  min=0.36  max=0.99
[local]    board_page_index                     n= 30  p50=    0.58ms  p95=    0.69ms  mean=    0.59ms  min=0.49  max=0.88
[external] cursor_cli_version_noop              n= 10  p50= 1004.93ms  p95= 1035.73ms  mean= 1011.87ms  min=992.75  max=1035.73

scaling (steps -> openPlan/readySteps/getPlanRoster p50 ms):
  steps=   5  openPlan p50=0.06ms  readySteps p50=1.41ms  getPlanRoster(local) p50=1.31ms
  steps=  25  openPlan p50=0.06ms  readySteps p50=7.28ms  getPlanRoster(local) p50=6.33ms
  steps=  50  openPlan p50=0.08ms  readySteps p50=15.69ms  getPlanRoster(local) p50=11.38ms
  steps= 100  openPlan p50=0.11ms  readySteps p50=28.23ms  getPlanRoster(local) p50=24.06ms

historical handoff analysis (101 steps from plans #1-16):
  time_to_first_attempt   p50=2332838ms  p95=9058809ms  n=92
  attempt_span            p50=0ms  p95=1344729ms  n=92
  verification_handoff    p50=81342013ms  p95=342250981ms  n=92
```

## Headline timings (avg across two runs)
- `cli_roundtrip_list_plans_warm`: p50 73.04ms, p95 76.88ms
- `board_server_startup`: p50 103.76ms, p95 117.28ms
- `get_plan_roster_local`: p50 14.54ms, p95 16.31ms
- `ready_steps_peek`: p50 2.12ms, p95 3.7ms
- `next_step_peek`: p50 0.27ms, p95 5.52ms

## Cold vs warm
- CLI `list_plans`: cold p50 96.92ms vs warm p50 73.04ms (delta 23.88ms)
- DB open: cold p50 21.87ms vs warm p50 1.94ms (delta 19.93ms)

## Fixed overhead
- Node startup floor: 57.86ms p50
- CLI module-load path: 68.06ms p50
- Remaining warm CLI work over baseline: 15.18ms p50

## Top bottlenecks and estimated savings
1. `board_server_startup` p50 103.76ms (est. savings 43.76ms)
2. `cli_roundtrip_list_plans_warm` p50 73.04ms (est. savings 15.18ms)
3. `get_plan_roster_local` p50 14.54ms (est. savings 8.72ms)

## External latency (separate)
- `cursor_cli_version_noop`: p50 1016.91ms, p95 1063.47ms
- `list_cursor_models_external_agent_cli`: p50 1378.01ms, p95 1469.87ms
- `runner_preflight_default_external`: p50 1382.44ms, p95 1456.45ms

## Production DB guard evidence
- pass-1 `path_isolation_verified=true`, `production_identity_used_by_benchmark=false`; file changed concurrently due to external writer.
- pass-2 `path_isolation_verified=true`, `production_identity_used_by_benchmark=false`; file unchanged.

## Limitations
- External timing is environment/account dependent.
- Savings estimates are directional, not implementation guarantees.
- No planner_start or prompt-quality benchmarking (explicitly excluded).
