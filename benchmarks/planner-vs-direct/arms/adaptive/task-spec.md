# Renewable Resource-Constrained Job Scheduling

Implement a deterministic scheduler for a single-machine benchmark. Your deliverable is one ESM module.

## Deliverable

Create `src/scheduler.mjs` exporting:

```js
/**
 * @param {SchedulingInstance} instance
 * @returns {ScheduleEntry[]}
 */
export function solve(instance) { /* ... */ }
```

Do not modify any other files.

## Input: `SchedulingInstance`

```ts
type SchedulingInstance = {
  resources: number[];   // renewable capacity per resource index, positive integers
  jobs: Job[];
};

type Job = {
  id: string;            // unique identifier
  duration: number;      // positive integer processing time
  demand: number[];      // length === resources.length, nonnegative integers
  deps: string[];        // job IDs that must finish before this job starts
};
```

Assume inputs are well-formed: unique job IDs, dependency references exist, acyclic dependency graph, positive durations and capacities, demand vectors aligned with resources.

## Output: `ScheduleEntry[]`

Return **exactly one** entry per input job:

```ts
type ScheduleEntry = { id: string; start: number };
```

Requirements:

1. **Completeness** — every input job ID appears once.
2. **Integer starts** — each `start` is a nonnegative integer.
3. **Dependencies** — if job `B` depends on job `A`, then `start(B) >= start(A) + duration(A)`.
4. **Renewable resources** — at every integer time `t`, for each resource `r`, the sum of `demand[r]` over jobs active at `t` (jobs with `start <= t < start + duration`) must not exceed `resources[r]`.

## Objective (grading quality)

Among feasible schedules, shorter **makespan** is better:

```
makespan = max(start(j) + duration(j)) over all jobs j
```

The hidden grader scores quality against a documented **theoretical lower bound** per instance (not against a reference schedule). The bound combines:

- **Critical-path length** — longest chain of processing times along dependency arcs.
- **Resource-work bound** — for each resource `r`, `ceil(sum_j duration(j) * demand[j][r] / capacity[r])`.

The per-instance lower bound is the maximum of those values. Quality rewards schedules whose makespan is close to this bound. Some instances have a proven gap between the bound and the true optimum; even a perfect solver therefore cannot achieve a perfect quality score across the full hidden suite.

## Determinism

`solve(instance)` must be **pure and deterministic**: same input object contents ⇒ identical output. Do not mutate the input. Do not use randomness, wall-clock time, network, or filesystem.

## Runtime expectation

Implementations should solve each instance in well under one second on a modern laptop for typical hidden cases. The grader enforces practical per-case timeouts. Efficient constructive heuristics, constraint propagation, or search with pruning are appropriate; exponential brute force over all permutations will time out.

## Public smoke tests

Run the visible checks in `public-smoke.mjs` from your assigned arm root before submitting. The hidden grader adds many more deterministic cases and stricter validation.
