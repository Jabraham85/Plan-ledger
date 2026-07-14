# Roles — role-based step dispatch

Reference for anyone (developer or orchestrator session) assigning a `role` to a
plan-ledger step or running the dispatch/review loop.

Every step can name the specialist agent that executes it. The `role` value is the
filename stem of an agent charter in `~/.claude/agents/<role>.md`; the orchestrator
dispatches the step to that agent and reviews its report against the step's
`acceptance_criteria` and the role's own Definition of done. Empty `role` (`''`, the
default) means the orchestrator decides at dispatch time.

## The 12 roles

Derived from each agent file's frontmatter `description` — read the file for the full
charter, Report format, and Definition of done.

| role | use for |
|---|---|
| `architect` | system design before code: module boundaries, API/data contracts, migration-safe schema changes, decomposing epics into ordered steps — never implementation code (writing up an already-chosen decision → tech-writer) |
| `implementer` | implementing code to an existing spec/design across the stack, incl. web dashboards/HTML+JS frontends and the 3D-asset pipeline (Meshy gen, glb→fbx, headless import, sockets, retargeting); hands back when the spec is ambiguous |
| `test-engineer` | test suites, fixtures, and assertions — the content that runs inside a harness — edge cases, coverage gaps, flaky tests caused by test/harness code (product-code causes → debugger; runner machinery → build-devops) |
| `debugger` | reproducing + root-causing a known defect, incl. security defects, product-code flakes, and same-environment behavior divergence (editor vs packaged, host vs client); minimal fix plus a red-then-green regression test |
| `refactor-surgeon` | behavior-preserving restructuring: dedup, dead code, simplification, API/naming cleanup — tests green before and after |
| `build-devops` | build systems, CI-style automation, packaging, dev tooling; the runner/log-parsing machinery that executes headless suites; toolchain/env drift (versions, PATH, encodings, lockfiles); data-migration/backfill scripts with mandatory dry-run |
| `perf-engineer` | profiling, memory, algorithmic cost; optimizes only measured hotspots, proves wins with before/after numbers |
| `researcher` | multi-source technical research, evaluations, prior-art scans; cited, confidence-labeled findings — never code |
| `tech-writer` | design docs, ADRs/design records for decisions whose direction is already chosen (open decisions → architect), READMEs, runbooks, references, player-facing text; verifies every command/path/symbol against the repo |
| `ui-designer` | visual design: layout, typography, color, tokens, mockups, HUD composition; a bare "design screen X" routes here — ux-architect only when the ask is explicitly flows/states/inputs/navigation |
| `ux-architect` | user flows, IA, screen state machines, input mappings, onboarding sequencing, usability audits (not visual styling) |
| `game-designer` | mechanics, progression curves, economies, balance tuning — numbers-first specs mapped to data-driven homes (not gameplay code) |

## How a step gets its role

- **Storage:** `steps.role` (`TEXT NOT NULL DEFAULT ''`) in `../src/db.mjs`; the
  2026-07 migration adds it to existing DBs (`steps` and `template_steps`).
- **Plan creation:** `add_step` takes a `role` param (`../src/server.mjs`). The `/plan new`
  flow requires one per step — pick the specialist whose discipline the step's core
  difficulty lives in.
- **Backfill:** if a step reaches dispatch untagged, pick a role from the table and
  `update_step(step_id, role: "<name>")`. Passing an empty string clears it.
- **Templates:** `template_steps` carry `role` too — `save_as_template` copies it out and
  `instantiate_template` copies it back in.

## Dispatch + review gate (interactive sessions)

Source of truth: the **"Roles — who executes a step"** section of
`~/.claude/commands/plan.md`. Summary:

- **Dispatch, don't do.** The orchestrator briefs the step's role agent (Agent tool,
  `subagent_type` = the role) with the step's `context` + `acceptance_criteria` +
  `carry_forward` + `lessons`. Self-execute only trivial mechanical steps; never
  delegate ledger bookkeeping.
- **Review gate, every dispatch (4 points):** (1) evidence first — quoted build/test
  output, real paths, screenshots; claims without evidence are an automatic send-back;
  (2) check `acceptance_criteria`, then the role's `## Definition of done` box by box;
  (3) unmet → `SendMessage` the same agent a numbered correction list, **max 3
  send-back rounds**, then finish it yourself or `record_attempt` fail with the lesson;
  (4) `record_attempt` always notes `role=<name>, review_rounds=<n>` in `what_tried`.
- `next_step` bakes this into its `directive` field: role-tagged steps come back with an
  explicit "DISPATCH it to the \"<role>\" agent … max 3 rounds" instruction
  (`../src/server.mjs`, `next_step` handler).

## How headless runs adopt roles

Headless `claude -p` agents can't be spawned *as* a subagent type, so
`../scripts/runner.mjs` (`roleLines`, used by both `buildPrompt` and
`buildDirectPrompt`/`--inject`) prepends this to the step prompt instead:

> Adopt the "\<role\>" role: read `~/.claude/agents/<role>.md` FIRST and follow its
> operating principles, evidence rules, and Definition of done as your own. Your
> report must use its Report format.

Run headless (per `/plan`'s project loop):

```sh
npm run orchestrate -- --project <id> --live --retry-on-limit
```

Preview a step's prompt — role line included — without spawning anything (dry run is
the default):

```sh
node scripts/runner.mjs --plan <id>
```

Expected output includes the plan's pending steps and, for a role-tagged step, the
`Adopt the "<role>" role: read ~/.claude/agents/<role>.md FIRST …` line.

## Adding or editing a role

1. Create `~/.claude/agents/<role>.md` with YAML frontmatter: `name`, `description`
   (the routing text — say what to *use it for* and what it's *NOT for*), optional
   `tools:` allowlist (only `researcher` uses one today). The body is the charter and
   **must** end with `## Report format` and `## Definition of done` sections — the
   review gate checks the DoD box by box, and the headless prompt tells agents to
   report in the Report format.
2. Add the role to the table in `~/.claude/commands/plan.md` and in this file.
3. Pickup: the headless runner sees the file immediately (it just tells agents to read
   the path). New/edited agent files are picked up by the interactive session too —
   observed to hot-load within minutes, no restart needed (a restart guarantees it).
   The piece that DOES need a reconnect is the **plan-ledger MCP server**: the `role`
   param is validated by the zod schema loaded at server start (`../src/server.mjs`),
   so sessions connected before the field existed must reconnect the server before
   `add_step`/`update_step` accept `role`.
