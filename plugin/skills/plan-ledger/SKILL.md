---
description: >-
  Use when planning or executing multi-step work via the plan-ledger CLI bridge and visual board —
  any task with several stages, anything in an existing plan, or when the user mentions
  plans/steps/context/"avoid past mistakes". Keeps working context small by storing plans,
  per-step context, a role per step, and a failure log on disk.
---

# plan-ledger working discipline

plan-ledger is **external working memory** accessed through **`src/ledger-cli.mjs`** (JSON CLI
bridge) — not `mcp__plan-ledger__*` MCP tools. The durable truth lives in SQLite; your job is to
keep your *own* context small.

**Progressive disclosure** via the bridge:

| Level | CLI operation | Use it to… |
|------|------|-----------|
| 0 | `list_plans` | see what exists (title + keywords + status only) |
| 1 | `open_plan` | understand one plan + find the step to work (step index only) |
| 2 | `get_step` / `next_step` | pull ONE step's full context to actually work it |

Every `/plan-ledger` turn opens the visual board first: `board --input '{"command":"open",…}'`.
Cross-workspace Cursor uses the bridge documented in `docs/CURSOR.md` §1; repo-local MCP remains
optional for RAG/templates/recall extras.

## Planner-start requirement

Before drafting a new plan, run `planner_start` with bounded keywords and persist consulted plan
ids on the draft (`draft_plan_id`). Use `completed` matches as finished evidence and keep
`related_active` separate as in-flight context.

## Active update cadence

During execution, send concise chat updates at dispatch, material phase changes, blockers,
verification, reassignment, and completion, plus at least every **3 minutes** during quiet work.
Keep board activity telemetry heartbeats at least once per **minute**.

Privacy boundary: operational telemetry only (phase/status/progress/files/artifacts/commands and
dispatch rationale). Never include private reasoning.
Operational fields: `plan_id`, `step_id`, `run_id`, `session_ref`, `role`, `agent`,
`requested_model`, `actual_model`, `model_source`, `phase`, `action_summary`, `command_summary`,
`status`, `outcome`, `verification_state`, `blocker`, `progress_completed`, `progress_total`,
`file_count`, `artifact_count`, `recent_artifacts`, `metadata`, `updated_at`, `ended_at`.

## When to reach for it

- A task has multiple stages, or will outlive one session → **make a plan** (`create_plan`
  + `add_step` per stage). Each step's `context` must be self-contained, have a concrete
  `acceptance_criteria`, and carry a `role` (the specialist that executes it — see below). If a
  step's success is checkable by a command, its `context` SHOULD open with a first line
  `VERIFY: <command>` — the headless runner enforces it.
- **Decompose by shared concern, not one-command-per-step.** Steps that would each reload the
  same contract/spec belong in one step (benchmark v1: 3 steps re-transmitted one contract to
  cold processes — 2.88M input tokens; `docs/BENCHMARK_2026-07.md` §6 item 2).
- **Reference shared specs, never copy them into step contexts.** Keep the spec in the repo (or
  `rag_ingest` it under a codename) and cite the path/codename plus a `RAG:` starter line instead
  of pasting spec text into N step contexts (benchmark v1: one spec was re-serialized ~6× at plan
  creation — 26k output tokens; `docs/BENCHMARK_2026-07.md` §6 item 3).
- You're continuing work → `list_plans` to orient, `open_plan` the relevant one, then work it.
- Mid-task you learn something the *next* step needs → `write_carry_forward` into that step.
  This is how context survives a reset: write it forward, don't hold it in your head.
- You learn a **durable truth** any future work should know (how the code behaves, a decision, a
  pitfall) → `absorb_findings`. Carry-forward is for the next step; findings are for the project.
  `recall` and every future brief surface them. See `docs/FINDINGS.md`.

## Approval boundary

For every new multi-step request, the first phase is planning only:
1. Create the complete plan as `draft`, including all steps, roles/models, context, acceptance
   criteria, dependencies, and verification commands.
2. Present the whole plan and explicitly ask for approval. Stop without claiming or executing a
   step and without editing implementation files.
3. Only explicit approval authorizes `set_plan_status(active)`. Once approved, run the execution
   loop autonomously until completion without asking between steps.
4. If the user requests changes, revise and re-present the complete draft; wait for approval again.

**Declare the plan's knowledge up front (RAG).** When decomposing a plan, list every source
the steps will need (repo folders, design docs, dependency gits, external sites/wikis). Check
`rag_status`; `rag_ingest` anything missing under a stable codename. Give each step a first
`context` line `RAG: <codename> — start: "<query>"[; "<query>"]` so its agent starts grounded
instead of rediscovering sources mid-step (`docs/RAG.md`).

## Roles — who executes a step

Every step carries a `role`: the `~/.claude/agents/` specialist that executes it (architect,
implementer, test-engineer, debugger, refactor-surgeon, build-devops, perf-engineer,
researcher, tech-writer, ui-designer, ux-architect, game-designer). Assign at plan creation —
pick the specialist whose discipline the step's core difficulty lives in. A role map
(`.plan-roles.json` / `~/.claude/plan-roles.json`) may rename, re-charter, or disable a role;
resolve through it before dispatch. The base `~/.claude/plan-roles.json` also carries the
model-tier policy — architect/debugger resolve to opus, all other specialists to sonnet — so
dispatch always resolves a role's model through the map, and the orchestrator may still escalate
a single crux dispatch to opus by passing `model` on that Agent call. Full schema: plan-ledger
`docs/ROLES.md`.

`docs/ROLES.md`.

**Implementer-first dispatch.** Concrete artifact/code steps default to `implementer`, informed by
historical attempt evidence. Use architect/ui/perf roles only when their capability is materially
required — not when the deliverable is implementation.

## Parallel orchestration (bounded pool, continuous refill)

Never claim the whole frontier in one batch. Before dispatch:

1. **Peek:** `ready_steps(plan_id, claim:false, limit:N)`.
2. **Select:** count free worker slots; exclude path-conflicting write steps (`OWNED_PATH:`,
   `OWNED_GLOB:`, `file_refs` overlap).
3. **Claim only selected steps:** `ready_steps(..., claim:true, limit:N)` or per-step claim after
   path filtering.
4. **Dispatch**; when a worker finishes, **refill that slot immediately** — no batch barrier.

Parallel write mode requires isolated Git worktrees, serialized/cherry-picked integration of verified
commits, and a clean integration tree; failed work is not integrated. Full contract:
`docs/audits/parallel-supervisor-design.md`.

**Automatic supervision:** every claimed step uses execution leases (heartbeat, child PID,
first-artifact observation, bounded stale recovery, C1-C4 terminalization). Do not hand-maintain a
duplicate lifecycle.

## Headless runner

Sequential is default (no `--parallel`). Opt-in parallel:

```sh
node scripts/runner.mjs --plan <id> --live --parallel --inject --max-workers 4
```

`--inject` keeps completion/integration under the supervisor before terminal success. Release gate:
`npm run validate:r1-release` after focused/full tests.

## The execution loop (sequential fallback)

Never enter this loop for a `draft` plan. Present it and wait for approval first.

1. `next_step(plan_id, claim:true, executor:"claude-interactive")` → atomically claim the next
   WORKABLE step, with full context (blocked/dependency-waiting steps are skipped).
   `{complete}` = plan done; `{all_blocked}` = everything left waits; `{all_in_progress}` =
   another executor owns all remaining work, so do not duplicate or mark the plan done.
2. **Read `attempts` before doing anything.** Each is `{ what_tried, result, verdict }`. If an
   approach already has a `fail` verdict, do NOT repeat it — choose a different one and say
   why. This is the whole point of the failure log.
3. **Dispatch, don't do.** YOU are the orchestrator and reviewer; the step's role agent does
   the work. Brief it (Agent tool, `subagent_type` = the resolved role) from the step's
   `context` + `acceptance_criteria` + `carry_forward` + `lessons`. Self-execute only trivial
   mechanical steps and ALL ledger bookkeeping — never delegate ledger calls.
4. **Review gate (mandatory).** When the agent reports: evidence first (build/test output
   verbatim, real paths, screenshots — no evidence = send-back); check the step's
   `acceptance_criteria` then the role's `## Definition of done` box by box; unmet →
   `add_note(step_id, author: "orchestrator", body: <numbered correction list>)` to make the
   back-and-forth permanent on the step, THEN `SendMessage` the SAME agent the same list. When it
   replies, `add_note(step_id, author: <role>, body: <reply summary>)`. Max 3 rounds, then finish
   it yourself or `record_attempt fail`.
5. `record_attempt` — **always log failures too**, noting `role=<name>, review_rounds=<n>` and
   a `what_tried` specific enough that "don't repeat this" is actionable, plus a `layman` param:
   a plain-English "what was done + thoughts" summary in basic terms for a human skimmer (distinct
   from `what_tried`) — every dispatched step gets one. `pass` finishes the step; `fail`/`partial`
   keeps it open and remembered. If the step taught durable truths, `absorb_findings` them too
   (subject + evidence each; `slot` for settings, `supersedes` to correct) — it dedups for you.
6. `write_carry_forward` anything the next step needs; `link_items` with relation `builds_on`
   when a step depends on earlier work. Then loop to 1, or stop if the user wanted a single
   step. Working-loop tool results carry a `directive` — follow it; don't end your turn while
   a workable step remains unless the user scoped the run.

Governance gates for injected/headless dispatch: preflight must pass before work, completion must
end with `COMPLETION_JSON`, unsupported pass claims are rejected, repeated noncompliance recommends
reassignment, dispatch-policy mismatches require explicit override reasons, retries are bounded, and
partial publish outcomes fail atomically.

A BLOCKED report (spec fork, missing decision, credential, external action) is not a failure:
resolve the fork if it's yours, escalate via `set_step_status(blocked)` if it's the user's,
then `next_step` again (it skips the blocked step). Mark the whole plan blocked only on
`{all_blocked}`.

## Rules

- **Pull narrow.** Prefer `open_plan`'s index over loading every step body.
- **Write failures down immediately**, before retrying — a lost failure gets repeated.
- **Carry context forward explicitly** instead of relying on it staying in your window.
- Don't invent plans for trivial one-shot tasks; this is for multi-step or cross-session work.

The `/plan` command is the manual front door (`/plan new`, `/plan board`, `/plan work <id>`);
this skill is the behavior to follow whenever plan-ledger is in play, command or not.
