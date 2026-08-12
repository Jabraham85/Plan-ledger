---
name: plan-ledger
description: >-
  Work with plan-ledger through the JSON CLI bridge and visual board — create, list, open, work,
  and render plans in external working memory. Use when planning or executing multi-step work: any
  task with several stages, anything already in a plan-ledger plan, or when the user mentions
  plans/steps/context/roles/"avoid past mistakes". Keeps working context small by storing plans,
  per-step context, and a failure log on disk instead of in the model's head.
---

# plan-ledger working discipline (Cursor)

You are driving **plan-ledger** (external working memory over the JSON CLI bridge) for the user.
This is the Cursor-native counterpart to the Claude Code plan-ledger command; invoke it explicitly
as `/plan-ledger` (`/plan` is Cursor's built-in Plan Mode), or let it auto-attach when
plan-ledger is in play. The plan-ledger loop, roles table, and dispatch/review gate are identical
to the Claude Code surface — only the *ledger I/O mechanism* differs (see Bridge invocation).

Parse the invocation the same way a command would: the first word is the subcommand, the rest are
its arguments. No subcommand → treat it as `board` (open the visual board for all plans).

## Bridge invocation (required — not MCP)

Do **not** use `mcp__plan-ledger__*` tools or assume a `plan-ledger` MCP server is configured.
All ledger reads and writes go through the tested JSON CLI bridge at an absolute path.

**Installed paths** (refreshed by `npm run sync:global-skill` from the Plan-ledger repo):

| Key | Path |
|---|---|
| Node | `{{PLAN_LEDGER_NODE}}` |
| CLI | `{{PLAN_LEDGER_CLI}}` |
| Repo | `{{PLAN_LEDGER_REPO}}` |

Run the bridge from **any cwd** — DB location follows `defaultDbPath()` / `PLAN_LEDGER_DB`, not
the shell cwd. On Windows, quote paths that contain spaces.

```powershell
& "{{PLAN_LEDGER_NODE}}" "{{PLAN_LEDGER_CLI}}" <operation> --input '<json-args>'
```

**Output contract:** success → stdout `{ "ok": true, "operation": "...", "db_path": "...", "result": ... }`;
failure → nonzero exit, stderr `[plan-ledger-cli] …`, stdout `{ "ok": false, "error": … }`.

Operation names are snake_case and match the ledger surface: `list_plans`, `open_plan`, `get_step`,
`next_step`, `ready_steps`, `next_plan`, `create_plan`, `add_step`, `update_step`, `link_items`,
`approve_plan`, `set_plan_status`, `set_step_status`, `record_attempt`, `write_carry_forward`,
`add_note`, `set_layman`, `assign_step`, `get_plan_roster`, `list_project_staff`, `board`, etc.
(See `node {{PLAN_LEDGER_CLI}} --help` or `src/ledger-cli.mjs` handlers for the full list.)

**Progressive disclosure** — pull only the level you need: `list_plans` (surface) → `open_plan`
(step index) → `get_step`/`next_step` (one step's full body). Never dump every step body when an
index will do. At session start, call `list_projects` + `set_current_project` (or `list_plans`) once
to orient — which project is current, what plans exist, what's active.

**Bridge-only scope.** Templates, `recall`, `project_brief`, file refs, code-graph, and RAG tools
are **not** on the CLI bridge. When working inside the Plan-ledger checkout with repo-local MCP
(`.cursor/mcp.json`), those extras remain available; cross-workspace `/plan-ledger` sessions use
the bridge for the core plan loop only.

### Visual board — every `/plan-ledger` invocation

Before any other ledger work, open the visual board so the user always sees plan context.
Use `board` with `"command":"open"` (alias `"launch"`). Set `PLAN_LEDGER_NO_OPEN=1` **only**
in automated tests — never suppress the browser for user-facing runs.

```powershell
& "{{PLAN_LEDGER_NODE}}" "{{PLAN_LEDGER_CLI}}" board --input '{"command":"open","project_id":<optional>,"plan_id":<optional>,"step_id":<optional>}'
```

| Subcommand | When to open | Deep-link args |
|---|---|---|
| *(none)* / `board` | immediately | omit ids → all plans |
| `new` | after the draft plan exists | `plan_id` |
| `approve`, `work`, `continue`, `run`, `complete` | immediately; again after claiming a step | `plan_id`; add `step_id` once known |
| `list`, `open <id>` | immediately | `plan_id` when resolved |
| `next <id>` | after fetching the step | `plan_id` + `step_id` |

Default board port is `4319` (`PLAN_LEDGER_WEB_PORT`). Do **not** reuse port `4321` if a demo
board is already bound there — leave an existing listener alone unless it matches this DB.

**Be autonomous and self-motivated.** When the user sets you working, drive the project forward on
your own: pick steps, pick the best approach, and **move from one plan to the next without asking**.
Never present a menu of "do you want A, B, or stop?" — decide and act. The only time you stop is
when there is genuinely nothing left to work on; if something needs the user, **mark it blocked,
note exactly what you need, and move to the next workable plan** rather than halting.

## Mandatory approval boundary

Planning and execution are separate phases:
1. For a new multi-step request, create the **entire** plan first while it remains `draft`: all
   steps, roles/models, self-contained context, acceptance criteria, dependencies, and verification.
2. Present the complete plan (board open + text summary) and explicitly ask for approval. **Stop
   there. Do not claim, dispatch, edit implementation files, or run any plan step while draft.**
3. Only an explicit user approval ("approve", "approved", "go ahead", "looks good", or equivalent)
   authorizes execution. On approval, `approve_plan` or `set_plan_status(<id>, "active")`, then
   immediately run the autonomous work loop until completion.
4. Requested plan changes are not approval: update the draft, re-present the whole revised plan,
   and wait again.

## Planner-start preflight (required for new plans)

Before decomposing any **new** plan, run bounded prior-plan discovery:

1. Call `planner_start` with a bounded keyword set (`max_keywords <= 8`) derived from the goal.
2. Use only `completed` matches as finished evidence. Treat `related_active` as in-flight context,
   never as done proof.
3. Persist consulted provenance on the draft (`draft_plan_id`) so `open_plan` shows
   `consulted_plans` (consulted ids + relation/status at consult time).
4. In your plan summary or notes, explicitly record which consulted plan ids informed the draft.

## Active chat updates + telemetry cadence

Execution must stay visible in chat and on the board:

- **Chat updates (required):** send concise updates at dispatch start, material phase changes,
  blockers, verification start/result, reassignment, and completion.
- **Quiet-work heartbeat:** if no material event occurred, send a concise status update at least
  every **3 minutes**.
- **Board telemetry cadence:** heartbeat/update activity at least once per **minute** while work is
  active.
- **Privacy boundary:** updates include operational telemetry only (phase, progress, files,
  artifacts, commands, status, blocker, outcome, dispatch rationale). Never include private
  reasoning or chain-of-thought.
- **Operational fields (exact):** `plan_id`, `step_id`, `run_id`, `session_ref`, `role`, `agent`,
  `requested_model`, `actual_model`, `model_source`, `phase`, `action_summary`, `command_summary`,
  `status`, `outcome`, `verification_state`, `blocker`, `progress_completed`, `progress_total`,
  `file_count`, `artifact_count`, `recent_artifacts`, `metadata`, `updated_at`, `ended_at`.

## Governance + evidence contract (runner/dispatch)

For governed dispatch (especially injected/headless execution):

1. **Preflight gates first:** fail fast on workspace/model/path/port prerequisites before dispatch.
2. **COMPLETION_JSON required:** terminal report must end in machine-checkable
   `COMPLETION_JSON` evidence (artifacts/commands/session).
3. **Unsupported pass rejection:** a `pass` claim without verifiable artifact or successful command
   evidence is rejected.
4. **One-correction reassignment:** first noncompliant completion gets one correction; repeated
   noncompliance recommends reassignment instead of repeated resumes.
5. **Deterministic dispatch override reason:** when policy flags material role mismatch, require an
   explicit override reason and persist it.
6. **Retries + atomic failure:** transient operations may retry with bounded backoff; partial
   publish outcomes are treated as atomic failure and must not silently half-apply.

### Live Activity troubleshooting

If live activity appears stale or missing:

- Check `/api/activity/current` and `/api/activity/recent` for the scoped plan/step.
- Confirm heartbeat cadence (`updated_at`) and stale threshold.
- Verify run key consistency (`plan_id`, `step_id`, `run_id`, `session_ref`).
- Confirm terminal events were appended on completion/failure.
- If status is stale and no owner is active, recover or reassign before redispatch.

## Execution lease + verification disposition contract

Every claimed step MUST run inside one **execution lease**. Lease lifecycle:

1. `open_execution_lease(plan_id, step_id, executor, run_id, session_ref, requested_model, ...)` —
   atomically CAS-claims (or adopts) the step and opens a bound activity run. Fails cleanly if
   another executor already holds it.
2. `heartbeat_execution_lease(lease_id, patch)` on a bounded cadence (default 20s, floor 1s, ceil
   60s). Every tick refreshes `last_heartbeat_at`; the reaper closes any lease older than
   `stale_after_ms` as `cancelled`.
3. `close_execution_lease(lease_id, {outcome, step_verdict, disposition, attempt, terminal_summary})`
   at the terminal event. `outcome` ∈ `success | failed | partial | blocked | cancelled | abandoned`.
   Close is atomic: activity terminalizes, lease closes, optional `record_attempt` and
   disposition set — one transaction.

**Verification disposition** is now first-class. Every closed step (`done | skipped | blocked`)
MUST carry one of `verified | deferred | blocked | not_applicable | legacy_unknown`. `verified` is
automatic when `record_attempt` verdict is `pass`; the others require an explicit
`set_step_disposition(step_id, disposition, reason)` call. **A plan cannot be marked `done`** while
any step is active, any lease is open, any activity is non-terminal, or any closed step lacks a
disposition. Use `assess_plan_terminalization(plan_id)` to see exactly what blocks completion.

**Reap cadence.** The board, MCP server, and runner all boot a background reaper on a
60–120 second cadence (`PLAN_LEDGER_REAP_INTERVAL_MS` / `PLAN_LEDGER_REAP_STALE_MS`). Stale/dead
executors are recovered automatically; you never need to hand-clean lease rows.

**Work at the PLAN level, never the step level.** The user names a *plan* (by id, title, or
keyword) and says "work / continue / complete" it — they do NOT pick step numbers. YOU always
auto-select which step to do: the **lowest workable step** (what `next_step` returns — it skips
blocked steps and steps whose dependencies aren't done yet, reporting them in
`skipped_blocked_steps` with a reason). When a plan finishes, auto-advance to the next workable
plan in the project.

**Resolving a plan reference:** a number is a plan id. Otherwise `list_plans` and match the word(s)
against title/keywords. One match → use it. Several → show candidates and ask which. None → say so.

## Roles — who executes a step

Every step carries a `role`: the specialist that executes it. The charters live in
`~/.claude/agents/<role>.md` — Cursor 3.x reads that directory natively (it also reads
`.cursor/agents/` and `.claude/agents/` project-local), so the **same 12 charters** back both
clients. Assign a role at plan creation; reassign at dispatch if the step turned out to be
different work than planned.

| role | use for |
|---|---|
| architect | system design, decomposition, contracts/schemas, epic → ordered steps |
| implementer | implementing code to an existing spec/design (incl. web frontends, 3D-asset pipeline runs) |
| test-engineer | specs/tests, coverage gaps, fixtures; flakes caused by test code |
| debugger | reproducing + root-causing failures (incl. security defects); minimal fix + regression proof |
| refactor-surgeon | behavior-preserving cleanup, dedup, dead code, API tidying |
| build-devops | build systems, CI, automation scripts, packaging, env/toolchain drift, data migrations |
| perf-engineer | profiling, memory, algorithmic cost, perf budgets |
| researcher | multi-source technical research/evaluations with citations |
| tech-writer | design docs, ADRs, READMEs, runbooks, player-facing text |
| ui-designer | visual design: layout/type/color/tokens/mockups/HUD looks |
| ux-architect | flows, IA, interaction patterns, usability audits, onboarding |
| game-designer | mechanics, balance curves, economies, progression |

**Roster overrides.** Before dispatching, resolve the step's `role` through the role map if
override files exist: `.plan-roles.json` in the repo root, then `~/.claude/plan-roles.json`
(`projects.<current project>.roles`, then `roles`) — first layer defining the role key wins. An
entry may rename the executing agent (`agent`), point at a `charter` file, set a `model`, or
disable the role (`false`). When the resolved agent differs from the role name and a charter
exists, the brief MUST open with "read + adopt <charter path>", and the review-gate Definition of
done comes from that charter. Unknown/disabled role → treat as untagged: pick from the table and
`update_step`. Full schema/precedence: plan-ledger `docs/ROLES.md` § Customizing the roster.

**Implementer-first dispatch.** Concrete artifact/code work defaults to `implementer`, informed by
historical attempt evidence. Use architect/ui/perf specialists only when their capability is
materially required — do not tag implementation output with design-only roles.

## Parallel orchestration

Never claim the whole ready frontier before slot and path checks. Maintain a **bounded worker pool**
and **refill each free slot immediately** when a worker finishes — no fixed batch barrier.

**Interactive loop:**
1. **Peek:** `ready_steps(plan_id, claim:false, limit:N)` — dependency-ready frontier, unclaimed.
2. **Select:** count empty worker slots; drop steps whose `OWNED_PATH:` / `OWNED_GLOB:` / `file_refs`
   overlap an in-flight write. Pick only enough non-conflicting steps to fill slots.
3. **Claim:** claim **only the selected steps** — `ready_steps(..., claim:true, limit:N)` or per-step
   claim after path filtering. Never `claim:true` on the full frontier blindly.
4. **Dispatch + review** each claimed step; on finish, refill that slot before waiting on others.

Default sequential `next_step` remains fine when parallelism adds no value.

**Path ownership + worktrees.** Concurrent **write** steps declare ownership in `context`:
`OWNED_PATH: path/to/file-or-dir`, `OWNED_GLOB: src/foo/**`, plus matching `file_refs`. Overlapping
ownership serializes — conflicting steps wait **unclaimed**. Parallel write mode needs a clean
integration tree: each write worker uses an isolated Git worktree; verified commits are
serialized/cherry-picked before a dependent overlapping worker starts; failed work is not integrated.

Mechanics: `docs/audits/parallel-supervisor-design.md`, README § The orchestrator.

**Automatic supervision (mandatory).** Do not duplicate lifecycle by hand. Every claimed step runs
through execution leases — open, bounded heartbeat (child PID persisted), first-artifact observation,
bounded stale recovery, then `close_execution_lease` on the C1-C4 terminal path. The reaper closes
stale leases; use `assess_plan_terminalization` before marking a plan done.

## Execution dispatch

**Dispatch, don't do.** When working a step, YOU are the orchestrator and reviewer; a full,
independent Cursor agent does the work. Compose its self-contained brief from the step's `context`
+ `acceptance_criteria` + `carry_forward` + `lessons` (+ file_refs), then:

1. Resolve the assigned model from Staff (`list_project_staff` / `get_plan_roster`) and verify it
   appears in the authenticated `agent models` output. Never silently substitute Composer or trust
   an opaque subagent's self-identification.
2. Launch a **fresh full Cursor CLI session** (the programmable equivalent of `/new`):
   `agent -p --output-format json --model "<resolved model>" --trust --force --workspace "<repo>" "<brief>"`.
   On native Windows, if `agent` is not on PATH, use
   `%LOCALAPPDATA%\cursor-agent\agent.cmd`. Each independent invocation returns a real
   `session_id`; record it with `model_source:"cursor-cli"` in `record_attempt`.
3. Parallel-ready steps run as separate CLI processes per the pool rules above. Do **not** use Cursor
   Subagent/Task calls for model-assigned work: their backend model is not authoritative enough for
   the execution roster.
4. If the standalone CLI is absent, install it using Cursor's documented native installer and run
   `agent login`; do not push setup work back to the user. If authentication definitively fails,
   mark the step blocked with the exact error.
5. Self-execute directly only for trivial mechanical steps and **ALL ledger bookkeeping** (via the
   CLI bridge).

**Review gate — mandatory, every dispatch.** When the role agent reports:
1. **Evidence first.** Build/test output quoted verbatim, real file paths (spot-check the repo),
   screenshots for visual work. Claims without evidence = automatic send-back.
2. Check the step's `acceptance_criteria`, then the role's `## Definition of done` (bottom of its
   charter file), box by box against the report.
3. Unmet → `add_note(step_id, author: "orchestrator", body: <numbered correction list>)` so the
   feedback is durable, then send the SAME agent that list — resume/continue that session. When it
   replies, `add_note` a concise reply summary under the role name. **Max 3 rounds**; then finish
   it yourself or `record_attempt` `fail` with the lesson.
4. `record_attempt` ALWAYS notes `role=<name>, review_rounds=<n>` in `what_tried`, and sets its
   `layman` field to a basic-language "what was done + thoughts" summary for human skimming.

A BLOCKED report (spec fork, contradiction, missing decision) is not a failure — resolve the fork
yourself if it's yours to make, escalate via blocked status if it's the user's, then re-dispatch.

## Headless runner

Sequential mode is the default (omit `--parallel`). Opt-in parallel:

```sh
node scripts/runner.mjs --plan <id> --live --parallel --inject --max-workers 4
```

`--inject` is the safe default for write-capable parallel runs: completion and integration stay
under the supervisor — worker output is validated before cherry-pick, and failed work is not
integrated. Without `--parallel`, the runner walks one step at a time via `next_step({ claim: true })`.

**Release gate:** after focused or full tests, `npm run validate:r1-release` — fail-closed before
treating parallel supervision as release-ready.

## Subcommands

### `new <title…>`
1. Open the board (all plans), run `planner_start` with bounded keywords, then `create_plan` with
   the title; infer 3–8 `keywords` and a tight one-paragraph `summary` from the title and
   conversation. Record consulted plan ids on the draft.
2. **Decompose** the goal into **self-contained steps** and `add_step` each. Every step MUST have
   a `context` executable in a fresh session with no other memory, concrete `acceptance_criteria`,
   the `tools` it will use, and a `role` from the table.
3. Keep the plan `draft`. Open the board for the new `plan_id` and show the **whole** plan,
   including every step's role/model, dependencies, acceptance criteria, and verification command.
4. Ask: **"Approve plan #<id> to begin execution?"** Then stop.

### `approve [<id|name>]`
Open the board for the draft plan. Resolve it, `approve_plan` / `set_plan_status(<id>, "active")`,
then enter `work <id>` immediately and continue autonomously through all workable steps.

### `list`
Open the board (all plans). `list_plans`; print the surface index:
`#id · title · status · done/total · keywords`.

### `open <id>`
Open the board for the plan. `open_plan <id>`; show summary + ordered step index. Don't expand
step bodies unless asked.

### `board [id]`
Open the visual board (`board` `command:"open"` with optional `plan_id`). Also render text via
`board` `command:"show"` or `command:"list"`.

### `work [<id|name>]`  (also `continue`, `run`, `auto`, `complete`)
Open the board for the target plan (add `step_id` once a step is claimed). The **autonomous**
entry point — drive the whole project forward across steps AND plans without asking.

If the selected plan is `draft`, present the complete plan and ask for explicit approval.

**Parallel pool:** run the peek/select/claim/refill loop above (bounded slots, path ownership,
continuous refill). Fall back to sequential `next_step` when only one step is ready or paths conflict.

**Inner loop (sequential fallback or single-slot):**
1. `next_step <plan_id>` (pass `claim:true` for autonomous runs). Draft plans return
   `awaiting_approval: true` — stop and ask for approval.
2. Announce ("Working #<plan> step N/M: <title>"). Open board with `plan_id` + `step_id`.
3. Read `carry_forward` and **`attempts`** FIRST. NEVER repeat an approach marked `fail`.
4. **DISPATCH** per Roles (implementer-first for concrete code); self-execute only trivial
   mechanical steps and ledger bookkeeping.
5. `record_attempt` — always noting `role=<name>, review_rounds=<n>` and `layman`.
6. `write_carry_forward`, loop to 1 (or refill a parallel slot).
7. Send concise chat updates at required lifecycle events, plus every 3 minutes during quiet work.

**Outer loop:** `next_plan` until `{complete}`.

**Never end your turn mid-loop** while anything workable remains.

### `next <id>`
Open board for the plan. `next_step <id>`; show that step's full context.

### `done <step_id>`
`record_attempt` with `verdict: pass` and a one-line `what_tried`.

Keep output tight — the point of plan-ledger is a *small* working context. Don't echo full step
bodies unless the user is actively working that step.

## Global skill sync

After changing this file, run from the Plan-ledger repo:

```sh
npm run sync:global-skill
```

That copies the compact global skill to `~/.cursor/skills/plan-ledger/SKILL.md` with resolved
absolute paths and writes `~/.cursor/plan-ledger-bridge.json` so drift is detectable.
