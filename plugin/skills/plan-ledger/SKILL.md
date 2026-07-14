---
description: >-
  Use when planning or executing multi-step work that benefits from external memory —
  any task with several stages, anything in an existing plan-ledger plan, or when the
  user mentions plans/steps/context/"avoid past mistakes". Keeps working context small
  by storing plans, per-step context, and a failure log in the plan-ledger MCP server.
---

# plan-ledger working discipline

plan-ledger is **external working memory**. The durable truth — plans, per-step context,
carry-forward notes, and the failure log — lives in its database, not in your context
window. Your job is to keep your *own* context small and let the store hold the rest.

Tools are `mcp__plan-ledger__*`. There are three disclosure levels — never pull a deeper
level than the task needs:

| Level | Tool | Use it to… |
|------|------|-----------|
| 0 | `list_plans` | see what exists (title + keywords + status only) |
| 1 | `open_plan` | understand one plan + find the step to work (step index only) |
| 2 | `get_step` / `next_step` | pull ONE step's full context to actually work it |

## When to reach for it

- A task has multiple stages, or will outlive one session → **make a plan** (`create_plan`
  + `add_step` per stage). Each step's `context` must be self-contained and have a concrete
  `acceptance_criteria`.
- You're continuing work → `list_plans` to orient, `open_plan` the relevant one, then `work`.
- Mid-task you learn something the *next* step needs → `write_carry_forward` into that step.
  This is how context survives a reset: write it forward, don't hold it in your head.

## The execution loop (one step at a time)

1. `next_step <plan_id>` → the next WORKABLE step, with full context (blocked steps are
   skipped). `{complete}` = plan done; `{all_blocked}` = everything left waits on the user.
2. **Read `attempts` before doing anything.** Each is `{ what_tried, result, verdict }`. If an
   approach already has a `fail` verdict, do NOT repeat it — choose a different one and say
   why. This is the whole point of the failure log.
3. Do the work using only this step's `context` + `tools`. Resist pulling unrelated plans
   or steps into context.
4. `record_attempt` — **always log failures too**, with `what_tried` specific enough that
   "don't repeat this" is actionable. `pass` finishes the step; `fail`/`partial` keeps it
   open and remembered.
5. `write_carry_forward` anything the next step needs; `link_items` with relation `builds_on`
   when a step depends on earlier work, so the chain back is explicit.
6. Move to the next step (loop), or stop and report if the user wanted a single step.
   Working-loop tool results include a `directive` — follow it; do not end your turn
   while a workable step remains unless the user scoped the run.

## Rules

- **Pull narrow.** Prefer `open_plan`'s index over loading every step body.
- **Write failures down immediately**, before retrying — a lost failure gets repeated.
- **Carry context forward explicitly** instead of relying on it staying in your window.
- Don't invent plans for trivial one-shot tasks; this is for multi-step or cross-session work.

The `/plan` command is the manual front door (`/plan new`, `/plan board`, `/plan work <id>`);
this skill is the behavior to follow whenever plan-ledger is in play, command or not.
