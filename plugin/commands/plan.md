---
description: Work with plan-ledger via the JSON CLI bridge and visual board.
argument-hint: "new <title> | approve [id] | list | open <id> | board [id] | work <id> | next <id> | done <step_id>"
---

You are driving **plan-ledger** (external working memory over the JSON CLI bridge) for the user.

Parse `$ARGUMENTS`: the first word is the subcommand, the rest are its arguments.
If `$ARGUMENTS` is empty, treat it as `board` (open the visual board for all plans).

**Every invocation:** open the visual board first via `board` `"command":"open"` (see
`.cursor/skills/plan-ledger/SKILL.md` § Bridge invocation). All ledger I/O uses
`src/ledger-cli.mjs` — not MCP. Honor progressive disclosure — pull only the level you need:
`list_plans` (surface) → `open_plan` (step index) → `get_step`/`next_step` (one step's full body).

**Planner-start preflight (required for new plans):** before decomposing a new goal, run
`planner_start` with bounded keywords and record consulted ids on the draft (`draft_plan_id`).
Treat `completed` matches as finished evidence and keep `related_active` separate.

**Execution visibility contract:** send concise chat updates at dispatch, material phase changes,
blockers, verification, reassignment, and completion, and at least every **3 minutes** during quiet
work. Keep board activity telemetry at least once per **minute**. Updates are operational telemetry
only (phase/status/progress/files/artifacts/commands/dispatch rationale), never private reasoning.
Operational fields: `plan_id`, `step_id`, `run_id`, `session_ref`, `role`, `agent`,
`requested_model`, `actual_model`, `model_source`, `phase`, `action_summary`, `command_summary`,
`status`, `outcome`, `verification_state`, `blocker`, `progress_completed`, `progress_total`,
`file_count`, `artifact_count`, `recent_artifacts`, `metadata`, `updated_at`, `ended_at`.

**RAG sidecar.** To ground a step in an external corpus (a repo, docs tree, dependency git, or
website you didn't write), the `rag_*` tools do slim, cited retrieval — the loop is
`rag_query` → `rag_expand`/narrow → `rag_cite`. See plan-ledger `docs/RAG.md`.

**Be autonomous and self-motivated.** When the user sets you working, drive the project forward
on your own: pick steps, pick the best approach, and **move from one plan to the next without
asking**. Never present a menu of "do you want A, B, or stop?" — decide and act. The only time you
stop is when there is genuinely nothing left you can work on; if something needs the user, **mark
it blocked, note exactly what you need, and move to the next workable plan** rather than halting.

**Approval boundary — mandatory.** Create and present the complete plan while it is `draft` before
doing implementation work. A draft must include every step, role/model, context, acceptance
criteria, dependency, and verification command. Ask for explicit approval and stop. Do not claim
or dispatch a step, edit implementation files, or activate the plan in the planning turn. On an
explicit "approve", "approved", "go ahead", "looks good", or equivalent, set the plan `active` and
immediately execute autonomously until completion. Requested revisions are not approval: revise
the draft, show the complete plan again, and wait.

**Work at the PLAN level, never the step level.** The user names a *plan* (by id, title, or
keyword) and says "work / continue / complete" it — they do NOT pick step numbers. YOU always
auto-select which step to do: the **lowest workable step** (what `next_step` returns — it skips
blocked steps and steps whose `builds_on`/`blocks`-linked dependency steps aren't done yet,
reporting them in `skipped_blocked_steps` with a reason). When a plan
finishes, auto-advance to the next workable plan in the project. If the user prompts something
like "continue the X plan" or "keep going" without using `/plan`, follow this same behavior anyway.

**Resolving a plan reference:** if the argument is a number, it's a plan id. Otherwise
`list_plans` and match the word(s) against title/keywords. One match → use it. Several →
show the candidates and ask which. None → say so.

## Roles — who executes a step

Every step carries a `role` (the `role` param on add_step/update_step): the `~/.claude/agents/`
specialist that executes it. Assign at plan creation; reassign at dispatch if the step turned out
to be different work than planned.

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
entry may rename the executing agent (`agent` = any subagent_type, built-ins included), point at a
`charter` file, set a `model`, or disable the role (`false`). The base `~/.claude/plan-roles.json`
now carries the model-tier policy itself — architect/debugger resolve to opus, all other specialists
to sonnet — so dispatch always resolves a role's model through the map; the orchestrator may still
escalate a single crux dispatch to opus by passing `model` on that Agent call. Dispatch with
`subagent_type` = the resolved agent (+ `model` if set and accepted); when the resolved agent
differs from the role name and a charter exists, the brief MUST open with "read + adopt <charter path>", and the review-gate
DoD comes from that charter. Unknown or disabled role → treat the step as untagged: pick from the
table (or the map's project roles — valid `role` values like the built-in twelve) and `update_step`.
Full schema/precedence: plan-ledger `docs/ROLES.md` § Customizing the roster.

**Dispatch, don't do.** When working a step, YOU are the orchestrator and reviewer; the role agent
does the work. Compose the brief from the step's `context` + `acceptance_criteria` + `carry_forward`
+ `lessons` (+ file_refs) and launch it via the Agent tool (`subagent_type` = the role). Self-execute
only trivial mechanical steps (minutes of work, zero design decisions) and ALL ledger bookkeeping —
never delegate ledger calls to the role agent.

**Review gate — mandatory, every dispatch.** When the role agent reports:
1. **Evidence first.** Build/test output quoted verbatim, real file paths (spot-check the repo),
   screenshots for visual work. Claims without evidence = automatic send-back.
2. Check the step's `acceptance_criteria`, then the role's `## Definition of done` (bottom of its
   agent file), box by box against the report.
3. Unmet → `add_note(step_id, author: "orchestrator", body: <numbered correction list>)` so the
   back-and-forth is permanent on the step, THEN `SendMessage` the SAME agent the same list. When
   it replies, `add_note(step_id, author: <role>, body: <reply summary>)`. **Max 3 rounds**; then
   finish it yourself or record_attempt `fail` with the lesson.
4. `record_attempt` ALWAYS notes `role=<name>, review_rounds=<n>` in `what_tried`, and sets its
   `layman` param to a plain-English "what was done + thoughts" summary in basic terms (distinct
   from `what_tried`) — every dispatched step gets one (or `set_layman(step_id, text)` after the fact).

A BLOCKED report (spec fork, contradiction, missing decision) is not a failure — resolve the fork
yourself if it's yours to make, escalate via blocked status if it's the user's, then re-dispatch.

## Subcommands

**`new <title…>`**  (optionally `… from <template>`)
1. Run `planner_start`, then `create_plan` with the title; infer 3–8 `keywords` and a tight one-paragraph `summary`
   (what + why) from the title and conversation.
2. If the user wrote **`from <template>`**, `instantiate_template(<template>, <plan_id>)` to seed
   the steps, then tailor each cloned step to the goal. OTHERWISE **decompose** the goal into
   **self-contained steps**, `add_step` for each. Every step MUST have a `context` executable in a
   fresh session with no other memory, a concrete `acceptance_criteria`, the `tools` it will use,
   and a `role` from the Roles table (who executes it — pick the specialist whose discipline the
   step's core difficulty lives in). If the step's success is checkable by a command, its `context`
   SHOULD open with a first line `VERIFY: <command>` — the headless runner enforces it. If the goal
   is vague, ask 1–2 clarifying questions BEFORE writing steps.
   - **Decompose by shared concern, not one-command-per-step.** Steps that would each reload the
     same contract/spec belong in one step (benchmark v1: 3 steps re-transmitted one contract to
     cold processes — 2.88M input tokens; `docs/BENCHMARK_2026-07.md` §6 item 2).
   - **Reference shared specs, never copy them into step contexts.** Keep the spec in the repo (or
     `rag_ingest` it under a codename) and cite the path/codename plus a `RAG:` starter line
     instead of pasting spec text into N step contexts (benchmark v1: one spec was re-serialized
     ~6× at plan creation — 26k output tokens; `docs/BENCHMARK_2026-07.md` §6 item 3).
3. **Declare the plan's knowledge up front (RAG).** While decomposing, list every source the
   steps will need (repo folders, design docs, dependency gits, external sites/wikis). Check
   `rag_status`; `rag_ingest` anything missing under a stable codename (`frontier-docs`, not
   `plan98-docs`). Then give each step a first line in its `context` of the form
   `RAG: <codename> — start: "<query>"[; "<query>"]` naming the source(s) and 1–3 starter
   queries. Step agents run those queries first (`rag_query`, then `rag_expand`/narrow as
   needed) and cite chunk ids — so they start grounded instead of rediscovering sources
   mid-step. Full guide: `docs/RAG.md`.
4. Keep the plan `draft`. Show the whole plan as a board, including role/model, dependencies,
   acceptance criteria, and verification for every step.
5. Ask **"Approve plan #<id> to begin execution?"** and stop. Never begin step 1 in this turn.

Governed/headless dispatch must enforce: preflight gates before work, required final-line
`COMPLETION_JSON` evidence, unsupported pass rejection, one-correction noncompliance then recommend
reassignment, deterministic override reasons for material dispatch mismatch, bounded transient
retries, and atomic failure on partial publish.

**Execution lease + verification disposition contract (mandatory).** Every claimed step runs inside
one execution lease: `open_execution_lease` (atomic CAS-claim + activity binding), heartbeats on
a bounded cadence (default 20s; 60s ceiling), `close_execution_lease` at the terminal event with
`outcome` and optional `step_verdict`/`attempt`/`disposition`. Every closed step MUST carry a
verification disposition (`verified` | `deferred` | `blocked` | `not_applicable` |
`legacy_unknown`) — `pass` verdicts auto-set `verified`, everything else uses
`set_step_disposition`. A plan cannot be `set_plan_status(done)` while any step is active, any
lease is open, any activity run is non-terminal, or any closed step lacks a disposition. Use
`assess_plan_terminalization` to see the current blockers. The board, MCP server, and runner all
boot a background reaper (60–120s cadence) that closes stale/dead leases as `cancelled`.

**`approve [<id|name>]`** — resolve the named draft plan (or the most recently presented draft),
`set_plan_status(<id>, "active")`, then enter `work <id>` immediately and run every workable step
until completion. Equivalent explicit approval in normal conversation follows the same path.

**`template list | show <name> | save <plan_id> as <name>`** — `list_templates` /
`get_template` / `save_as_template`. Apply one with `/plan new <goal> from <name>` or
`instantiate_template(<name>, <plan_id>)`.

**`brief`** — `project_brief`: print a compact whole-project snapshot (every plan + progress,
recent lessons, code-graphs). Use at the START of a session to orient without reading anything.

**`recall <query…>`** — `recall(<query>)`: ask the project anything; print the ranked hits
across plans, steps, and the failure log (`type · title · snippet`). Use before starting work to
pull what's already known/tried (e.g. `/plan recall windows exe signing`). Offer to open the top hit.

**`list`** — `list_plans` (optionally a status/query from args); print the surface index only:
`#id · title · status · done/total · keywords`.

**`open <id>`** — `open_plan <id>`; show the summary + ordered step index (titles + status). Don't
expand step bodies unless asked.

**`board [id]`** — render a text board.
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

**`work [<id|name>]`** (also: `continue`, `run`, `auto`, `complete`) — the **autonomous** entry point.
Name a PLAN to start there, or omit it and let the project pick. Then **drive the whole project
forward on your own — across steps AND across plans — choosing the best path, never asking.**
You are self-motivated: keep working until nothing is workable. Only stop to ask if the user
explicitly scoped it ("just one step" / "just this plan").

If the selected plan is `draft`, present it in full and ask for explicit approval instead of
executing it.

**Parallel pool.** Peek `ready_steps(plan_id, claim:false, limit:N)`, count free worker slots,
exclude path-conflicting write steps (`OWNED_PATH:` / `OWNED_GLOB:` / `file_refs`), claim only the
selected non-conflicting steps, dispatch, and **refill each slot immediately** when a worker
finishes — never claim the whole frontier in one batch. Parallel write mode uses isolated Git
worktrees and serialized cherry-pick integration; failed work is not integrated. Fall back to the
sequential loop below when only one step is ready or paths conflict. Headless:
`node scripts/runner.mjs --plan <id> --live --parallel --inject --max-workers 4` (sequential is
default without `--parallel`). Release gate: `npm run validate:r1-release`. Details:
`docs/audits/parallel-supervisor-design.md`.

**Inner loop — work a plan's steps:**
1. `next_step(plan_id, claim:true, executor:"claude-interactive")` → atomically claim the next
   **workable** step (blocked/dependency-waiting steps are skipped; full context + embedded
   lessons). Shapes: a step → work it · `{all_blocked}` → `set_plan_status(blocked)`, outer loop ·
   `{all_in_progress}` → do not duplicate or mark done; wait/recover the active executor ·
   `{complete}` → `set_plan_status(done)`, outer loop.
2. Announce ("Working #<plan> step 4/8: <title>"); the claim already set it `in_progress`.
3. Read its `carry_forward` and **`attempts`** FIRST. NEVER repeat an approach already marked `fail`.
   Read its **`brain`** too: recorded facts about this step's code, already re-checked against the source
   (anything whose file changed arrives `suspect` — verify it before relying on it). Put them in the brief.
4. **DISPATCH per the Roles section** (resolve the role per **Roster overrides** first): brief the
   step's resolved agent (Agent tool) with the step's
   `context` + `acceptance_criteria` + `carry_forward` + `lessons`, then run the **review gate**
   (evidence → acceptance_criteria → the role's Definition of done; send-back via SendMessage, max
   3 rounds). No `role` on the step → pick one from the table now (and `update_step` it). Self-execute
   only trivial mechanical steps. **Always pick the best path yourself** — decide and act.
5. `record_attempt` (`pass` finishes it; `partial`/`fail` is logged and kept) — always noting
   `role=<name>, review_rounds=<n>` and setting `layman` (plain-English what-was-done + thoughts).
   If the step taught **durable truths** (a fact about the code/system, a decision, a lesson, a
   pitfall — not a log of actions), `absorb_findings(step_id, findings)` with a `subject` and
   `evidence` (`path:line`) on each; use `slot` for single-valued settings, `supersedes` to correct one, and
   `depends_on` for the `brain` ids you relied on (so they are re-checked together). It dedups for you
   (zero model calls) — never skip it to "avoid duplicates". Universal claims ("only", "all", "no …")
   need a repo-wide search as proof. If a `brain` fact turned out wrong, `resolve_finding` it (revised/retracted).
   First time in a project: `set_project_root` so findings link to their files and go stale when code changes.
6. `write_carry_forward` anything the next step needs, then loop to 1.

**When a step is BLOCKED** (genuinely needs the user — a decision only they can make, a credential, the editor/PIE reopened, or an external action you can't perform):
- `record_attempt` a `partial`/`fail` stating exactly what's needed, `set_step_status(<step>, blocked)`, `write_carry_forward` the unblock note.
- **Do NOT stop or ask.** Call `next_step` again — it skips the blocked step and hands you the next
  workable one. Mark the whole plan blocked only when it returns `{all_blocked}`.

**Outer loop — pick the next plan:**
- Call `next_plan` (optionally scoped to `project_id`). Found one → run the inner loop on it.
- `{complete}` → **only now stop.** Give one summary: what completed, and for each blocked item,
  exactly what you need from the user to unblock it.

For long unattended runs, the orchestrator does this same project loop headless — a FRESH process per step (true context reset) + usage-limit auto-retry:
`npm run orchestrate -- --project <id> --live --retry-on-limit`
Role-tagged steps make each headless agent read + adopt `~/.claude/agents/<role>.md` (its prompt says so),
so the same specialist charters apply unattended.

**Never end your turn mid-loop.** Working-loop tool results (`next_step`, `record_attempt`,
`set_step_status`) carry a `directive` field — follow it. Before stopping, check once more: if
`next_step` or `list_plans` shows anything workable, you are not done. A text message saying what
you'll do next is not doing it — make the tool call instead.

**`next <id>`** — `next_step <id>`; show just that step's full context (what to do right now).

**`done <step_id>`** — `record_attempt <step_id>` with `verdict: pass` and a one-line
`what_tried` summarizing what was done.

Keep output tight — the point of plan-ledger is a *small* working context. Don't echo full
step bodies unless the user is actively working that step.
