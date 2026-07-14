---
description: Work with plan-ledger — create, list, open, work, and render plans held in the external MCP working-memory store.
argument-hint: "new <title> | list | open <id> | board [id] | work <id> | next <id> | done <step_id>"
---

You are driving **plan-ledger** (external working memory over MCP). Parse `$ARGUMENTS`:
the first word is the subcommand, the rest are its arguments. If `$ARGUMENTS` is empty,
treat it as `board` (show all plans).

All actions use the `mcp__plan-ledger__*` tools. Honor progressive disclosure: pull only
the level you need (`list_plans` → `open_plan` → `get_step`). Never dump a whole plan's
step bodies when an index will do.

## Subcommands

### `new <title…>`
1. `create_plan` with the title. Infer 3–8 `keywords` and a tight one-paragraph `summary`
   (what + why) from the title and surrounding conversation.
2. Decompose the goal into **self-contained steps** and `add_step` each one. Every step MUST have:
   - `context`: everything needed to do *that* step in a fresh session with no other memory.
   - `acceptance_criteria`: a concrete pass condition.
   - `tools`: the tools/MCP that step will use.
   If the goal is vague, ask 1–2 clarifying questions BEFORE writing steps.
3. Show the resulting plan as a board (see `board`).

### `list`
Call `list_plans` (optionally pass a status/query parsed from the args) and print the
surface index only: `id · title · status · done/total · keywords`.

### `open <id>`
`open_plan <id>` and show the summary + the ordered step index (titles + status). Do not
expand step bodies unless asked.

### `board [id]`
Render a readable text board.
- No id → `list_plans`, one line per plan: `#id  STATUS  done/total  title  [keywords]`.
- With id → `open_plan <id>`, then a tree:
  ```
  #<id> <title>   ▸ <status>   (<done>/<total> done)
  <summary>
    1 ✅ <step title>            done
    2 ▶ <step title>            in_progress
    3 ⬚ <step title>            pending
    4 ✗ <step title>            failed (N attempts)
  ```
  Use `✅ done · ▶ in_progress · ⬚ pending · ✗ failed · ⏸ blocked · ⤼ skipped`. Pull
  attempt counts via `open_plan` only; do not load full step context for the board.

### `work [<id|name>]`  (also `continue`, `run`, `auto`, `complete`)
**Autonomous** entry point — name a PLAN to start, or omit and let the project pick. Drive the
whole project forward on your own, across steps AND plans, choosing the best path, never asking.
INNER LOOP (a plan's steps):
1. `next_step <plan_id>` → the next WORKABLE step (blocked steps are skipped). Three shapes:
   a step → work it · `{all_blocked}` → `set_plan_status(blocked)` → OUTER LOOP · `{complete}` → `set_plan_status(done)` → OUTER LOOP.
2. Announce ("Working #<plan> step 4/8: <title>") and `set_step_status(<step>, in_progress)`.
3. Read `carry_forward` + `attempts` first. NEVER repeat an approach with a `fail` verdict.
4. Do the work using this step's `context` + `tools`. Pick the best path yourself — don't ask.
5. `record_attempt` (`pass` finishes it; `partial`/`fail` is logged).
6. `write_carry_forward` what the next step needs, then loop to 1.
BLOCKED (a step genuinely needs the user): `record_attempt` partial/fail with what's needed,
`set_step_status(blocked)`, `write_carry_forward` the unblock note — then DON'T stop: `next_step`
again (it skips the blocked step). Mark the whole plan blocked only when it says `all_blocked`.
OUTER LOOP (next plan): `list_plans` → pick the best workable plan (not complete/blocked, prereqs met) and run its inner loop. None workable → only now stop and summarize what completed + what each blocked item needs.
Only deviate if the user scoped it ("just one step" / "just this plan"). For long unattended runs the orchestrator does this headless with a fresh process per step + usage-limit auto-retry.
**Never end your turn mid-loop.** Tool results carry a `directive` field — follow it. Before
stopping, check once more: if `next_step` or `list_plans` shows anything workable, you are not
done. A text message saying what you'll do next is not doing it — make the tool call instead.

### `next <id>`
`next_step <id>` and show just that step's full context — what to do right now.

### `done <step_id>`
Shortcut: `record_attempt <step_id>` with `verdict: pass` and a one-line `what_tried`
summarizing what was done.

Keep output tight. The point of plan-ledger is a *small* working context — don't echo
full step bodies unless the user is actively working that step.
