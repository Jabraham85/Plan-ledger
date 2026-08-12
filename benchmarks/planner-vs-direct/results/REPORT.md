# Direct vs planner vs orchestration — run report

Run date: 2026-07-16  
Benchmark seed: `0x504c414e`  
Agent runs: one per arm (`n=1`)

## Result

- Adaptive cost-aware specialists: **95.95/100**
  - Dispatches: lightweight scheduling architect → code-specialized implementer → lightweight test engineer
  - Performance engineer: **not dispatched**; the test gate measured 9.02 ms median on an 80-job stress case
  - Correction rounds: 0
  - Feasibility: 50.00
  - Quality: 45.95
  - Feasible cases: 49/49
  - Hard timeouts: 0
  - Average combined solve time: 0.86 ms; p95: 1.09 ms
- Multi-agent orchestration: **95.95/100**
  - Handoffs: architect → implementer → test engineer (one correction round) → performance engineer
  - Feasibility: 50.00
  - Quality: 45.95
  - Feasible cases: 49/49
  - Hard timeouts: 0
  - Average combined solve time: 2.03 ms; p95: 2.84 ms
- Explicit planner: **95.95/100**
  - Feasibility: 50.00
  - Quality: 45.95
  - Feasible cases: 49/49
  - Hard timeouts: 0
  - Average combined solve time: 16.40 ms; p95: 117.48 ms
- Direct/no-plan: **86.68/100**
  - Feasibility: 44.90
  - Quality: 41.78
  - Feasible cases: 44/49
  - Hard timeouts: 5
- Observed planner delta: **+9.27 points**
- Adaptive score delta vs single planner: **0.00 points**
- Adaptive runtime vs single planner: **19.07× faster average**, **107.38× faster p95**
- Orchestrated score delta vs single planner: **0.00 points**
- Orchestrated runtime vs single planner: **8.08× faster average**, **41.38× faster p95**
- Proven safe upper bound: **98.43**, possibly not tight

All implementations were deterministic, preserved their inputs, and passed validation on every
case they completed. The direct arm's five invalid cases were all hard 400 ms combined-call
timeouts; there were no dependency, capacity, completeness, mutation, or determinism failures.

## Non-saturation guarantee

The calibration case has one resource of capacity 3 and three independent duration-1 jobs with
demand 2. Its resource-work lower bound is 2, while exhaustive search proves the optimum makespan
is 3. Because quality is scored against the lower bound, even an optimum solver cannot score 100.

## Protocol notes

- All treatments used the same parent-model family and tool access. The first two used parallel isolated
  subagent runs. This is an orchestration control, not independently provable from the saved files.
- The direct prompt prohibited explicit plans/checklists. The planner prompt required written
  decomposition, staged verification, a risk register, and reassessment.
- The orchestration treatment used fresh specialist contexts and handed forward only the task,
  implementation, and role report. The test engineer identified an unsafe latent fallback; a
  correction round repaired it before the performance engineer optimized the verified solution.
- The first orchestration treatment role-prompted generic agents and unconditionally ran four
  stages. It is retained as an over-provisioned handoff baseline, not evidence of cost-aware
  specialist selection.
- The adaptive treatment used four lean project-local role charters but dispatched only three
  agents. Architecture and testing used a lightweight model; implementation used a code-focused
  model. The measured public test gate passed, so the performance role was skipped. The dispatch
  record is `adaptive-dispatch.json`; exact token counts were unavailable.
- The hidden grader was not copied into any arm.
- The public fork smoke originally contained an impossible makespan ceiling (5 with capacity 1;
  proven optimum 7). Both arms independently identified it. The ceiling was corrected to 7 in
  both arm copies before hidden grading; neither implementation was changed.
- Grading uses a fresh worker per case and a hard 400 ms budget across both determinism calls.
  Invalid or timed-out cases contribute zero feasibility and zero quality.

## Interpretation

This run shows that all planning treatments produced complete solvers, while the direct arm chose
a heavier search strategy that timed out on five cases. Neither orchestration treatment improved
the single planner's already-high quality score. The adaptive treatment matched that quality with
three targeted dispatches, no correction round, no unnecessary performance pass, and the fastest
observed solver under the same hidden workload.
It does **not** establish that planning caused the improvement: each arm was generated once, the
prompt treatment includes verification discipline as well as planning, runtime thresholds are
machine-sensitive, and the orchestrated arm used four fresh agent contexts (more total compute).
Repeat with multiple independently generated treatment sets and record token usage before generalizing.
