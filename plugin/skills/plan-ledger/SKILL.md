---
description: >-
  Use when planning or executing multi-step work that benefits from external memory —
  any task with several stages, anything in an existing plan-ledger plan, or when the
  user mentions plans/steps/context/"avoid past mistakes". Keeps working context small
  by storing plans, per-step context, a role per step, and a failure log in the
  plan-ledger MCP server.
---

# plan-ledger working discipline

plan-ledger is **external working memory**. The durable truth — plans, per-step context,
carry-forward notes, the role that executes each step, and the failure log — lives in its
database, not in your context window. Your job is to keep your *own* context small and let
the store hold the rest.

Tools are `mcp__plan-ledger__*`. There are three disclosure levels — never pull a deeper
level than the task needs:

| Level | Tool | Use it to… |
|------|------|-----------|
| 0 | `list_plans` | see what exists (title + keywords + status only) |
| 1 | `open_plan` | understand one plan + find the step to work (step index only) |
| 2 | `get_step` / `next_step` | pull ONE step's full context to actually work it |

**RAG sidecar.** To ground a step in an external corpus (a repo, docs tree, dependency git,
or website you didn't write), the `rag_*` tools do slim, cited retrieval — the loop is
`rag_query` → `rag_expand`/narrow → `rag_cite`. See plan-ledger `docs/RAG.md`.

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

## Parallel dispatch (do this before the one-at-a-time loop)

Call `ready_steps <plan_id>` first — it returns every pending step whose `builds_on`/`blocks`
dependencies are already satisfied (the full concurrently-launchable frontier, not just the
lowest-idx step; same dependency gate as `next_step`). When it returns more than one step,
DISPATCH THE WHOLE FRONTIER CONCURRENTLY — one Agent-tool call per ready step in a single batch —
then run the review gate on each as it reports. Fall back to the sequential loop below only when
the frontier is a single step or the steps genuinely must serialize. (The headless
`npm run orchestrate` runner is still sequential — a `--parallel` flag is a documented follow-up
in `scripts/runner.mjs`; this rule is for interactive orchestration, where concurrent Agent-tool
calls actually run in parallel.)

## The execution loop (one step at a time)

1. `next_step <plan_id>` → the next WORKABLE step, with full context (blocked steps are
   skipped). `{complete}` = plan done; `{all_blocked}` = everything left waits on the user.
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
   keeps it open and remembered.
6. `write_carry_forward` anything the next step needs; `link_items` with relation `builds_on`
   when a step depends on earlier work. Then loop to 1, or stop if the user wanted a single
   step. Working-loop tool results carry a `directive` — follow it; don't end your turn while
   a workable step remains unless the user scoped the run.

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
