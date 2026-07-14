# Cursor integration surface — research findings (2026-07-14)

Plan-ledger step 505 (plan #96), role=researcher. Question: **What is Cursor's current (mid-2026) integration surface — MCP config, rules/AGENTS.md, custom commands, subagents, headless CLI — to drive a "plan tool works in Cursor too" design?**

**Verdict.** Cursor (current release **3.11**, Jul 10 2026 [4]) has converged hard on the same file conventions Claude Code uses, and in several places *reads Claude Code's own directories natively* (`.claude/agents/`, `.claude/skills/`, `AGENTS.md`, Claude Code hooks compat). The plan-ledger MCP server (verified locally: **42 tools**, Node ESM, `@modelcontextprotocol/sdk`, stdio) is configurable via `~/.cursor/mcp.json` / `.cursor/mcp.json` with env-var support; the old 40-tool cap that would have clipped it is gone as of Cursor 2.3/2.4's dynamic MCP loading. Slash commands exist (`.cursor/commands/*.md`) but are being superseded by Skills (`SKILL.md`); subagents (2.4+) are markdown+frontmatter files closely mirroring Claude Code's. Headless CLI (`agent -p`) emits JSON with token usage (no dollar cost).

---

## Findings

### 1. MCP — CONFIRMED (config), CONFIRMED (limit removal), CONFIRMED (approval UX)

- **Config locations** — CONFIRMED [1][10]: global `~/.cursor/mcp.json` (all projects), project `.cursor/mcp.json`. Root key `"mcpServers"`. Project-level wins on name collision (T3 corroboration [10-adjacent search corpus]; official doc states both locations [1]).
- **stdio support** — CONFIRMED [1]: `"type": "stdio"` with `command`, `args`, `env`, and `envFile` (envFile is stdio-only). Remote servers use `url` + `headers` (+ OAuth `auth`) over SSE or streamable HTTP.
- **Env vars** — CONFIRMED [1]: literal `env` map per server, plus interpolation in `command`/`args`/`env`/`url`/`headers`: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`.
- **Tool-count limit** — CONFIRMED (removal): the notorious 40-tool cap ("Exceeding total tools limit" warnings, well-documented through 2025 [11]) no longer applies. Cursor 2.4 (Jan 22 2026) moved MCP definitions to lazy/dynamic loading — "Agents load MCPs only when needed" [4] — and a Mar 3 2026 forum thread reports 80+ tools enabled with no warning, attributing it to dynamic context discovery [10]. Current official MCP docs contain **no** tool-count limit at all [1]. **Implication for plan-ledger's 42 tools: no clipping in current 3.x; would have exceeded the cap in pre-2.3 Cursor (≤2025).**
- **Approval UX** — CONFIRMED [1]: "Cursor asks for approval before using MCP tools by default"; MCP tools follow the same Run-Mode/allowlist system as terminal commands (auto-run configurable), with argument inspection before execution. A 42-tool server therefore works, but each tool call prompts unless the user allowlists — worth documenting in the plan-tool setup guide.

### 2. Rules — CONFIRMED (.mdc format), CONFIRMED (AGENTS.md), LIKELY (.cursorrules legacy)

- **`.cursor/rules/*.mdc`** — CONFIRMED [2]: frontmatter fields exactly `description`, `globs`, `alwaysApply`. Plain `.md` files in the rules dir are **ignored** (missing required frontmatter). Nested `.cursor/rules/` dirs anywhere in the repo are recognized. Four behaviors: Always (`alwaysApply: true`), Auto-Attached (`globs` set), Agent-Requested (`description` only), Manual (`@`-mention only). Best-practice guidance: keep rules under 500 lines [2]. Precedence: Team Rules → Project Rules → User Rules [2].
- **AGENTS.md** — CONFIRMED [2]: natively supported at project root **and any subdirectory**; nested files combine with parents, more-specific wins. This is now the officially promoted "simple markdown" instruction path. CLAUDE.md is *not* mentioned in the rules doc [2].
- **`.cursorrules` (legacy)** — LIKELY: deprecated since Cursor ~0.43 (late 2024); third-party guidance as of Apr 2026 says it "still works for now" but "won't receive new Cursor features" [12]. The current official rules doc no longer mentions it at all [2] — treat as dead for new integrations. (Single fetched source on "still works" → LIKELY, not CONFIRMED.)
- **Rules → Skills drift** — CONFIRMED [4][5]: 2.4 added `/migrate-to-skills`, which converts *dynamic* rules (`alwaysApply: false`, no globs) into Skills. Rules with explicit triggers stay rules.

### 3. Commands — CONFIRMED (mechanism), with a supersession caveat

- **Custom slash commands** — CONFIRMED [4][5][6-era changelog 1.6 via search corpus]: markdown files in `.cursor/commands/` (project) and `~/.cursor/commands/` (user/global); filename = command name; body = prompt template; triggered by typing `/` in Agent chat (editor and CLI). Introduced in Cursor 1.6 (Sep 2025). No frontmatter required.
- **Superseded by Skills (2.4, Jan 2026)** — CONFIRMED [4][5]: the old docs URL `/docs/context/commands` now serves the **Skills** page. Skills live in `.cursor/skills/<name>/SKILL.md` or `.agents/skills/<name>/SKILL.md` (project), `~/.cursor/skills/`, `~/.agents/skills/` (user), **plus legacy-compat dirs `.claude/skills/` and `.codex/skills/` (project and user)** [5]. SKILL.md frontmatter: `name` (required, must match folder), `description` (required), `paths` (glob scoping), `disable-model-invocation` (true = behaves like a classic explicit slash command), `metadata`. Optional `scripts/`, `references/`, `assets/` subdirs; progressive on-demand loading. `/migrate-to-skills` converts legacy commands with `disable-model-invocation: true` [5].
- **Status of `.cursor/commands` in 3.x** — LIKELY: the 3.9 changelog's unified Customize page still lists "commands" as a managed entity alongside skills [4-changelog index], and forum activity shows `.cursor/commands` in active (if buggy-in-Cloud) use; but new work should target SKILL.md. **Design note: shipping a plan-tool skill in `.claude/skills/` gets picked up by both Claude Code and Cursor.**

### 4. Subagents — CONFIRMED (format + invocation), Cursor 2.4+ (Jan 22 2026)

- **Definition** — CONFIRMED [3][4][13]: markdown + YAML frontmatter. Locations: project `.cursor/agents/`, **`.claude/agents/`**, `.codex/agents/`; user `~/.cursor/agents/`, `~/.claude/agents/`, `~/.codex/agents/` [3]. (The `.claude/agents/` cross-read is stated only in official docs [3]; third-party guide [13] confirms the `.cursor/agents/` locations and all field semantics but doesn't mention the compat dirs → the compat-dir claim alone is LIKELY.)
- **Frontmatter** — CONFIRMED [3][13]: `name` (lowercase-hyphen, defaults from filename), `description` (parent agent reads it to decide delegation — the direct analogue of Claude Code's `subagent_type` hint text), `model` (`inherit` | model ID, with bracket params e.g. `claude-opus-4-8[effort=high,context=300k]`), `readonly` (bool — no file edits or state-changing shell), `is_background` (bool — async, parent doesn't block).
- **Invocation** — CONFIRMED [3]: (a) explicit `/name` or natural-language mention; (b) automatic delegation from descriptions; (c) **parallel via concurrent Task tool calls** — Cursor literally uses a Task tool like Claude Code's Agent tool; (d) `/in-cloud` / `/babysit` for remote execution; (e) resume by agent ID. Built-ins: `explore` (codebase search), `bash` (shell), `browser` (MCP browser control) [3][4]. Nested subagent launches (subagent spawning subagent) supported as of 2.5, with depth limits [3]. Available in both editor and CLI [4].
- **Answer to the brief's question "can a Cursor agent spawn another with a distinct system prompt?"** — Yes: custom subagents carry their own prompt (the markdown body), own context window, own tool access, own model; parents fan out in parallel [3][4][13].

### 5. Headless / CLI — CONFIRMED (mechanics), with one naming caveat

- **Binary & install** — CONFIRMED [6][9]: the CLI binary is now **`agent`** (2.4's "upgraded CLI" [4]); install via `curl https://cursor.com/install -fsS | bash` (macOS/Linux/WSL) or `irm 'https://cursor.com/install?win32=true' | iex` (native Windows). UNCERTAIN: whether the pre-2.4 `cursor-agent` name still works as an alias — current docs never mention it; scripts should call `agent`.
- **Headless runs** — CONFIRMED [6][7][8]: `agent -p "<prompt>"` (print mode) with `--output-format text|json|stream-json` (valid only with `--print`/inferred print), `--stream-partial-output`, `--model`, `--mode=plan|ask` (default agent) / `--plan` shorthand, `--sandbox enabled|disabled`, `--force`/`--yolo` to actually apply edits in print mode (otherwise changes are proposed only). Sessions: `agent ls`, `agent resume`, `--continue` (= `--resume=-1`), `--resume="<id>"`. CI auth via `CURSOR_API_KEY` env var [7]. Claude Code hooks compatibility added in 2.4 [4].
- **Usage reporting** — CONFIRMED (tokens) / CONFIRMED (no cost): per Cursor staff (Jul 1 2026), the headless JSON `usage` object reports **`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` — token counts only, no dollar figure** [14]. Result envelope fields: `type`, `subtype`, `is_error`, `duration_ms`, `duration_api_ms`, `result`, `session_id`, `request_id` [8]. Cost is a backlog item; Teams/Enterprise can get per-request cost via Admin API `POST /teams/filtered-usage-events` (`tokenUsage.totalCents`, `chargedCents`) [14] (single source → LIKELY for the Admin-API detail). Note: the public output-format doc page does not yet document the `usage` object [8] — docs lag the shipped behavior; verify empirically at integration time.

---

## Evidence — source list

| # | URL | Title | Date | Tier | Anchor (searchable) | Supports |
|---|-----|-------|------|------|--------------------|----------|
| 1 | https://cursor.com/docs/mcp | Cursor Docs — MCP | undated (live, fetched 2026-07-14) | T1 | `mcpServers`, `envFile`, `${workspaceFolder}` | F1 |
| 2 | https://cursor.com/docs/rules | Cursor Docs — Rules | undated (live 2026-07-14) | T1 | `alwaysApply`, `AGENTS.md` | F2 |
| 3 | https://cursor.com/docs/subagents | Cursor Docs — Subagents | undated (live 2026-07-14) | T1 | `is_background`, `.cursor/agents/` | F4 |
| 4 | https://cursor.com/changelog/2-4 (+ /changelog index) | Cursor 2.4 — Subagents, Skills | 2026-01-22 (index to 3.11, 2026-07-10) | T1 | `SKILL.md`, `--resume=-1` | F1,F3,F4,F5, versions |
| 5 | https://cursor.com/docs/skills | Cursor Docs — Skills | undated (live 2026-07-14) | T1 | `disable-model-invocation`, `.agents/skills/` | F3 |
| 6 | https://cursor.com/docs/cli/overview | Cursor Docs — CLI overview | undated (live 2026-07-14) | T1 | `--mode=plan`, `cursor.com/install` | F5 |
| 7 | https://cursor.com/docs/cli/headless | Cursor Docs — CLI headless | undated (live 2026-07-14) | T1 | `--yolo`, `CURSOR_API_KEY` | F5 |
| 8 | https://cursor.com/docs/cli/reference/output-format | Cursor Docs — Output format | undated (live 2026-07-14) | T1 | `duration_api_ms`, `request_id` | F5 |
| 9 | https://cursor.com/docs/cli/installation | Cursor Docs — CLI installation | undated (live 2026-07-14) | T1 | `agent --version` | F5 |
| 10 | https://forum.cursor.com/t/regarding-the-quantity-limit-of-mcp-tools/153432 | Regarding the quantity limit of MCP tools | 2026-03-03 | T3 | "more than 80 tools enabled" | F1 (limit removal) |
| 11 | https://forum.cursor.com/t/mcp-server-40-tool-limit-in-cursor-is-this-frustrating-your-workflow/81627 (+ github.com/cursor/cursor #3369, via search) | 40-tool limit threads | 2025 | T3 | "Exceeding total tools limit" | F1 (historical cap) |
| 12 | https://www.flowql.com/en/blog/guides/cursor-rules-deprecated-libraries/ | Cursor deprecated .cursorrules | 2026-04-24 | T3 | ".cursorrules is deprecated as of Cursor 0.43" | F2 (legacy status) |
| 13 | https://medium.com/@codeandbird/cursor-subagents-complete-guide-5853e8d39176 | Cursor Subagents — Complete Guide | 2026-03-18 | T3 | `is_background`, `.cursor/agents/` | F4 (independent confirm) |
| 14 | https://forum.cursor.com/t/cost-information-in-cursor-cli-headless-mode/164583 | Cost information in cursor CLI headless mode (staff reply) | 2026-07-01 | T2 (Cursor staff) | `cacheReadTokens`, `filtered-usage-events` | F5 (usage) |

**Local ground truth read:** `C:\Users\AI\Documents\plan-ledger\src\server.mjs` (grep `"  title: '"` → **42** tool registrations; server `name: 'plan-ledger'`), `C:\Users\AI\Documents\plan-ledger\package.json` (`"type": "module"`, dep `@modelcontextprotocol/sdk`). Light check command: `grep -c "  title: '" src/server.mjs` → `42`.

## Contrarian pass

- **Tool limit**: actively searched "40 tools limit removed/increased" — 2025-era T3/T4 pages still assert 40 (or 80) caps; weighed against the Jan 2026 changelog's dynamic loading [4] and the Mar 2026 user report [10]; stale-SEO explanation preferred. No official sentence says "the limit is removed" — flagged in F1 wording.
- **Usage reporting**: the docs page [8] omits the `usage` object, and older forum threads (Oct 2025) say tokens are *missing* from stream-json; the Jul 2026 staff reply [14] supersedes both for `json` output. Docs/behavior mismatch flagged.
- **Commands**: searched for a live standalone commands doc — `/docs/commands` 404s; `/docs/context/commands` serves Skills; forum shows `.cursor/commands` broken in Cursor Cloud (thread 142997). Weighed as "supported but sunsetting".
- Empty/near-empty queries: "cursor-agent alias deprecated 3.x" (nothing authoritative on whether the old binary name still resolves).

## What I could not confirm

1. Whether `cursor-agent` still works as a binary alias post-2.4 rename → resolve by running the installer in a sandbox or checking the install script.
2. Exact ship version that removed the 40-tool cap (2.3 vs 2.4) — forum says "below 2.3" warned; changelog 2.4 describes dynamic loading. Resolve: changelog 2.3 diff or empirical test with the 42-tool server.
3. `.claude/agents/` and `.claude/skills/` cross-reads rest on the official docs alone (no fetched second source) → resolve empirically: drop a test agent/skill in `.claude/` and open Cursor.
4. `.cursorrules` still loading in 3.x (T3 claim, Apr 2026) → 2-minute empirical test.
5. Nested-subagent depth limit value (docs say "limitations on depth" without a number).

## Decisions & trade-offs

- Interpreted "2.x" in the brief as "current Cursor" — Cursor is on **3.11** as of Jul 10 2026; findings are validated against 3.x docs with 2.4/2.5 feature-introduction versions noted.
- docs.cursor.com now 308-redirects to cursor.com/docs; cited the live URLs.
- Skipped T4 SEO setup guides except as leads; skipped paywalled/unfetchable pages.
- Saturation: by the skills/subagents/CLI fetches, new sources only repeated the docs; stopped there.

## Self-check (Definition of done)

- [x] Question restated + verdict — top of doc.
- [x] Inline [n] citations resolving to the source table with URL/date/tier/anchor.
- [x] 2+ independent sources on load-bearing claims, or explicit downgrade (compat dirs, Admin API, .cursorrules → LIKELY).
- [x] Every finding labeled; "What I could not confirm" present (5 items).
- [x] Version check vs local ground truth — plan-ledger server.mjs 42 tools / ESM / MCP SDK read and named.
- [x] Contrarian pass reported incl. empty queries.
- [x] N/A comparison matrix (not a comparison brief) — capability mapping given per question instead.
- [x] 6+ distinct origins (cursor.com docs, cursor.com changelog, forum.cursor.com ×3, flowql.com, medium.com) with T1/T2 behind each major finding.
- [x] Saved deliverable: this file, `C:\Users\AI\Documents\plan-ledger\docs\research\cursor-surface-2026-07.md`.
