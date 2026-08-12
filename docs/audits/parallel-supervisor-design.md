# Parallel supervisor design

## Goal

Add opt-in, bounded parallel execution without bypassing the existing completion,
terminalization, stale-recovery, or telemetry contracts.

## Existing foundation

- `LedgerStore.readySteps()` computes the dependency-aware frontier.
- Execution leases already support heartbeat, stale and first-artifact deadlines,
  bounded reassignment, and activity health.
- Completion validation and plan reconciliation already run on terminal paths.
- `scripts/runner.mjs` is sequential by default; `--parallel` opts into the continuous-refill
  supervisor and reuses the existing lease/completion path.

## Runtime contract

Parallel mode uses a continuously refilled slot pool:

1. Peek at the ready frontier without claiming it.
2. Select only enough non-conflicting steps to fill empty slots.
3. Atomically claim each selected step immediately before dispatch.
4. Run each step through the existing lease supervisor and completion gate.
5. Release its path lock and worktree in `finally`.
6. Refill that slot as soon as it becomes empty; do not wait for a batch.

`--parallel` is opt-in. Sequential mode keeps its current behavior.

## Module changes

### `src/parallel-supervisor.mjs`

Own the slot pool, continuous refill loop, path-lock queue, stop/drain behavior,
and aggregate result. It accepts a step-runner callback so deterministic tests do
not need a real model process.

### `src/path-ownership.mjs`

Normalize and compare repository-relative ownership declared through step file
references and `OWNED_PATH:` / `OWNED_GLOB:` context hints. Exact files and
directory-prefix globs are mutually exclusive. A conflicting step waits without
being claimed.

### `scripts/worktree-pool.mjs`

Create one Git worktree per running write-capable step and remove it in `finally`.
Worktree names include plan, step, and run IDs. Startup cleanup removes orphaned
worktrees that have no open lease.

### `src/supervisor.mjs`

Extend the existing lease wrapper to supervise a spawned process, persist its PID,
heartbeat automatically, probe owned paths for new artifacts, and close through
the same C1-C4 terminal path.

### `src/db.mjs`

Add a bounded ready-claim contract. `readySteps({ claim: true, limit: N })` must
claim at most `N`; the default remains unlimited for compatibility. Parallel mode
may instead peek and use `claimStep()` when path filtering is required.

### `scripts/runner.mjs`

Extract one-step execution for reuse by both modes. Add:

- `--parallel`
- `--max-workers N` (default 2, bounded maximum)
- `--repo-root PATH`
- `--worktree-base PATH`
- `--skip-worktrees` for explicit test/read-only use

Parallel execution passes the worktree as the child working directory. Budget,
rate-limit, and stop conditions prevent new claims while existing slots drain.

### Dispatch

Capability fit remains authoritative. Automatic ties prefer `implementer`, and
project-local attempt history may rank valid fallback roles. Persist the selected
role, reliability sample, and rationale with lease metadata. Explicit roles and
C3 override-reason enforcement remain unchanged.

## Failure semantics

- Preflight, worktree creation, model failure, or invalid completion evidence:
  close the lease as failed and free the slot.
- Child crash or supervisor interruption: close as abandoned, return the step to
  pending when safe, and clean its worktree.
- Stale heartbeat or first-artifact miss: use existing C3 reaping and bounded
  reassignment; never add a separate recovery path.
- Path overlap: wait without claiming, so it cannot create false in-progress work.
- Global budget/rate limit: stop refilling, drain active slots, and report paused.

Every terminal transition continues through `closeExecutionLease()` and
`recordAttempt()` so C1 validation, C2 reconciliation, C3 recovery, and C4 events
stay atomic and observable.

## Verification

Deterministic tests must cover:

- Worker bound and immediate refill after one worker finishes.
- Dependency gating and bounded claiming.
- Exact-file and directory-prefix conflict serialization.
- Worktree creation, cleanup, and orphan recovery.
- Automatic heartbeat and first artifact promotion.
- One worker crashing without stopping unrelated slots.
- Bounded stale recovery.
- Sequential behavior when `--parallel` is absent.
- No duplicate lifecycle events or open leases after completion.

The final gate is `npm run validate:r1-release` after the complete test suite.

