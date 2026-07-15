---
name: plan-ledger
description: >-
  Work with plan-ledger — create, list, open, work, and render plans held in the external
  plan-ledger MCP working-memory store. Use when planning or executing multi-step work: any
  task with several stages, anything already in a plan-ledger plan, or when the user mentions
  plans/steps/context/roles/"avoid past mistakes". Keeps working context small by storing plans,
  per-step context, and a failure log in the MCP server instead of the model's head.
---

# plan-ledger working discipline (Cursor)

You are driving **plan-ledger** (external working memory over MCP) for the user. This is the
Cursor-native mirror of the `/plan` command; Cursor reads it as a Skill (invoke by name, or it
auto-attaches when plan-ledger is in play). The plan-ledger loop, roles table, and dispatch/review
gate are identical to the Claude Code surface — only the *dispatch mechanism* differs (see Roles).

Parse the invocation the same way a command would: the first word is the subcommand, the rest are
its arguments. No subcommand → treat it as `board` (show all plans).

All actions use the `mcp__plan-ledger__*` tools. Honor **progressive disclosure** — pull only the
level you need: `list_plans` (surface) → `open_plan` (step index) → `get_step`/`next_step` (one
step's full body). Never dump every step body when an index will do.

**Be autonomous and self-motivated.** When the user sets you working, drive the project forward on
your own: pick steps, pick the best approach, and **move from one plan to the next without asking**.
Never present a menu of "do you want A, B, or stop?" — decide and act. The only time you stop is
when there is genuinely nothing left to work on; if something needs the user, **mark it blocked,
note exactly what you need, and move to the next workable plan** rather than halting.

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

**Dispatch, don't do.** When working a step, YOU are the orchestrator and reviewer; the role agent
does the work. Compose the brief from the step's `context` + `acceptance_criteria` + `carry_forward`
+ `lessons` (+ file_refs) and launch the resolved role agent. Cursor has three dispatch paths, in
order of preference — **this is the one place that differs from Claude Code**:

1. **Cursor subagent** — invoke `/<role>` (e.g. `/implementer`) or issue a **Task tool** call
   targeting that subagent. Cursor delegates to the markdown+frontmatter charter under
   `~/.claude/agents/` (or `.cursor/agents/`), giving it its own context window and model. Fan out
   in parallel with concurrent Task calls when steps are independent.
2. **No subagents available** (headless `agent -p`, or a build where subagent delegation is off) —
   **read `~/.claude/agents/<role>.md` and adopt that charter yourself**, do the work in-context,
   then **self-review against its `## Definition of done`** before recording.
3. Self-execute directly only for trivial mechanical steps (minutes of work, zero design decisions)
   and **ALL ledger bookkeeping** — never delegate `mcp__plan-ledger__*` calls to the role agent.

(For reference, the Claude Code path is: `Agent` tool with `subagent_type = <role>`. Same charter,
same review gate — only the call differs. The server's own `directive` field spells out both.)

**Review gate — mandatory, every dispatch.** When the role agent reports:
1. **Evidence first.** Build/test output quoted verbatim, real file paths (spot-check the repo),
   screenshots for visual work. Claims without evidence = automatic send-back.
2. Check the step's `acceptance_criteria`, then the role's `## Definition of done` (bottom of its
   charter file), box by box against the report.
3. Unmet → send the SAME agent a numbered correction list (what failed, which DoD box, what
   evidence is missing) — resume/continue that subagent, or in the adopt-the-charter path revise
   in-context. **Max 3 rounds**; then finish it yourself or `record_attempt` `fail` with the lesson.
4. `record_attempt` ALWAYS notes `role=<name>, review_rounds=<n>` in `what_tried`.

A BLOCKED report (spec fork, contradiction, missing decision) is not a failure — resolve the fork
yourself if it's yours to make, escalate via blocked status if it's the user's, then re-dispatch.

## Subcommands

### `new <title…>`  (optionally `… from <template>`)
1. `create_plan` with the title; infer 3–8 `keywords` and a tight one-paragraph `summary`
   (what + why) from the title and conversation.
2. If the user wrote **`from <template>`**, `instantiate_template(<template>, <plan_id>)` to seed
   the steps, then tailor each cloned step. OTHERWISE **decompose** the goal into **self-contained
   steps** and `add_step` each. Every step MUST have a `context` executable in a fresh session with
   no other memory, a concrete `acceptance_criteria`, the `tools` it will use, and a `role` from the
   table (the specialist whose discipline the step's core difficulty lives in). Vague goal → ask
   1–2 clarifying questions BEFORE writing steps.
3. Show the new plan as a board.

### `template list | show <name> | save <plan_id> as <name>`
`list_templates` / `get_template` / `save_as_template`. Apply one with
`/plan new <goal> from <name>` or `instantiate_template(<name>, <plan_id>)`.

### `brief`
`project_brief`: print a compact whole-project snapshot (every plan + progress, recent lessons,
code-graphs). Use at the START of a session to orient without reading anything.

### `recall <query…>`
`recall(<query>)`: ask the project anything; print the ranked hits across plans, steps, and the
failure log (`type · title · snippet`). Use before starting work to pull what's already
known/tried. Offer to open the top hit.

### `list`
`list_plans` (optionally a status/query from args); print the surface index only:
`#id · title · status · done/total · keywords`.

### `open <id>`
`open_plan <id>`; show the summary + ordered step index (titles + status). Don't expand step
bodies unless asked.

### `board [id]`
Render a text board.
- No id → `list_plans`, one line per plan: `#id  STATUS  done/total  title  [keywords]`.
- With id → `open_plan <id>`, then a tree:
  ```
  #<id> <title>   ▸ <status>   (<done>/<total> done)
  <summary>
    1 ✅ <step>            done
    2 ▶ <step>            in_progress
    3 ⬚ <step>            pending
    4 ✗ <step>            failed (N attempts)
  ```
  Icons: `✅ done · ▶ in_progress · ⬚ pending · ✗ failed · ⏸ blocked · ⤼ skipped`. Use
  `open_plan` for counts; don't load full step context for the board.

### `work [<id|name>]`  (also `continue`, `run`, `auto`, `complete`)
The **autonomous** entry point. Name a PLAN to start there, or omit it and let the project pick.
Then **drive the whole project forward on your own — across steps AND across plans — choosing the
best path, never asking.** Keep working until nothing is workable.

**Inner loop — work a plan's steps:**
1. `next_step <plan_id>` → the next **workable** step (blocked steps skipped; full context +
   embedded lessons). Three shapes: a step → work it · `{all_blocked}` → `set_plan_status(blocked)`
   → outer loop · `{complete}` → `set_plan_status(done)` → outer loop.
2. Announce ("Working #<plan> step 4/8: <title>") and `set_step_status(<step>, in_progress)`.
3. Read its `carry_forward` and **`attempts`** FIRST. NEVER repeat an approach marked `fail`.
4. **DISPATCH per the Roles section** (resolve the role per Roster overrides first): brief the
   step's resolved agent via a Cursor subagent (`/<role>` or Task tool), or — no subagents — adopt
   its `~/.claude/agents/<role>.md` charter and self-review; then run the **review gate** (evidence
   → acceptance_criteria → the role's Definition of done; send-back, max 3 rounds). No `role` on the
   step → pick one from the table now (and `update_step` it). Self-execute only trivial mechanical
   steps. Always pick the best path yourself.
5. `record_attempt` (`pass` finishes it; `partial`/`fail` is logged and kept) — always noting
   `role=<name>, review_rounds=<n>`.
6. `write_carry_forward` anything the next step needs, then loop to 1.

**When a step is BLOCKED** (genuinely needs the user — a decision only they can make, a credential,
an external action you can't perform): `record_attempt` a `partial`/`fail` stating exactly what's
needed, `set_step_status(<step>, blocked)`, `write_carry_forward` the unblock note. **Do NOT stop or
ask.** Call `next_step` again — it skips the blocked step and hands you the next workable one. Mark
the whole plan blocked only when it returns `{all_blocked}`.

**Outer loop — pick the next plan:** `list_plans` → choose the best next **workable** plan (not
complete, not blocked, prerequisites satisfied; prefer the one that unblocks the most downstream
work). Found one → run the inner loop. **None workable → only now stop** with one summary: what
completed, and for each blocked item exactly what you need from the user.

For long unattended runs the orchestrator does this same project loop headless — a FRESH process per
step (true context reset) + usage-limit auto-retry:
`npm run orchestrate -- --project <id> --live --retry-on-limit`. In Cursor's headless CLI the
equivalent per-step process is `agent -p "<step brief>" --output-format json` (note: its `usage`
object reports token counts only — `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`
— not a dollar figure). Role-tagged steps make each headless agent read + adopt the role charter, so
the same specialists apply unattended.

**Never end your turn mid-loop.** Working-loop tool results (`next_step`, `record_attempt`,
`set_step_status`) carry a `directive` field — follow it. Before stopping, check once more: if
`next_step` or `list_plans` shows anything workable, you are not done. A text message saying what
you'll do next is not doing it — make the tool call instead.

### `next <id>`
`next_step <id>`; show just that step's full context (what to do right now).

### `done <step_id>`
`record_attempt <step_id>` with `verdict: pass` and a one-line `what_tried`.

Keep output tight — the point of plan-ledger is a *small* working context. Don't echo full step
bodies unless the user is actively working that step.
