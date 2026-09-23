#!/usr/bin/env node
// runner.mjs — orchestrate a plan by spawning a FRESH headless Claude agent per
// step. Each step runs in its own process → true context reset, no hand-holding.
//
//   node scripts/runner.mjs --plan <id>            DRY RUN (default): print the
//                                                   execution plan + the per-step
//                                                   prompt, spawn nothing, mutate nothing.
//   node scripts/runner.mjs --plan <id> --live      ACTUALLY spawn agents. COSTS MONEY
//                                                   and lets agents act autonomously.
//   --max-attempts N   give up on a step after N spawns (default 2)
//   --max-steps N      stop after N steps this run
//   --model NAME       pass a model to `claude`
//   --permission-mode M  claude permission mode for --live (default acceptEdits;
//                        fully-unattended runs need bypassPermissions — your call)
//
// Design decisions (from the step context), settled:
//  1. pass/fail = re-read step.status from the DB after the agent exits (the agent
//     calls record_attempt, which sets done/failed). No fragile stdout parsing.
//  2. stop = per-step spawn counter capped at --max-attempts (prevents looping on a
//     step the agent leaves unfinished), then pause for a human.
//  3. safety = DRY RUN by default; --live is explicit.
//  4. model/effort = optional --model passthrough.
//
// VERIFY gate (benchmark-v1 improvement #1, docs/BENCHMARK_2026-07.md §6): an optional
// first line in step.context, `VERIFY: <command>` (same convention as `RAG:`, see
// docs/RAG.md §10). After the agent exits — BOTH modes — the runner runs the command
// (scripts/runner-lib.mjs: parseVerify/runVerify/applyVerifyGate) and a claimed pass
// (inject VERDICT line, or MCP-mode step reaching status=done) is downgraded to
// verdict=fail with the command's output tail appended when it doesn't exit 0.
// Per-step usage logging (improvement #4): every attempt this runner records also gets
// a "usage: in=… out=… cost=$… turns=… model=…" line appended to its result field.
//
// PARALLEL MODE (--parallel): continuous-refill dispatch via runParallelSupervisor.
// Peeks readySteps(), claims non-conflicting steps up to --max-workers, refills
// each slot immediately on completion (never waits for a whole batch). Sequential
// mode remains the default single-step path below.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Store, defaultDbPath } from '../src/db.mjs';
import { reapLoop } from '../src/supervisor.mjs';
import { runParallelSupervisor, clampMaxWorkers } from '../src/parallel-supervisor.mjs';
import { DEFAULT_STAFF_ROLES, resolveRole, listCursorModels } from '../src/roles.mjs';
import { evaluateDispatchPolicy } from '../src/dispatch-policy.mjs';
import { parseVerify, applyVerifyGate, formatUsageLine, appendUsageToLatestAttempt,
  parseFindings, formatFindingLines, pickBrief, FINDINGS_INSTRUCTIONS } from './runner-lib.mjs';
import {
  runDispatchPreflight,
  parseGovernanceHints,
  parseCompletionContract,
  evaluateCompletionContract,
  detectNoncomplianceEscalation,
  safeActivitySummary,
} from './execution-governance.mjs';
import { createWorktreePool, defaultWorktreeBase } from './worktree-pool.mjs';
import { createParallelStepRunner } from './runner-step.mjs';

// Resolve a directly-spawnable claude binary. On Windows the PATH `claude` is a
// .cmd shim that Node's spawn can't launch without a shell — but it wraps a real
// claude.exe, so prefer that (same class of gotcha as the postject .cmd issue).
// Returns { cmd, prependArgs }: normally prependArgs is empty (cmd IS the
// executable). Testability hook: CLAUDE_BIN pointing at a .mjs/.js/.cjs file is
// run via THIS node instead of exec'd directly — spawn() without a shell can't
// launch a script by file association on Windows — so a fake CLI stub can be
// dropped in for tests with no OS-level shebang support. Node stops parsing its
// OWN flags once it sees a script FILE (as opposed to -e/-p) to run, so every
// arg after it lands in the stub's process.argv unparsed.
function resolveClaude() {
  if (process.env.CLAUDE_BIN) {
    const bin = process.env.CLAUDE_BIN;
    if (/\.(mjs|js|cjs)$/i.test(bin)) return { cmd: process.execPath, prependArgs: [bin] };
    return { cmd: bin, prependArgs: [] };
  }
  if (process.platform === 'win32') {
    const exe = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return { cmd: exe, prependArgs: [] };
  }
  return { cmd: 'claude', prependArgs: [] };
}
const claudeResolved = resolveClaude();

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const planId = val('--plan') ? Number(val('--plan')) : null;
const projectId = val('--project') ? Number(val('--project')) : null; // continuous mode: chain all plans in a project
const live = flag('--live');
const maxAttempts = Number(val('--max-attempts', 2));
const maxSteps = Number(val('--max-steps', 0)) || Infinity;
const maxPlans = Number(val('--max-plans', 0)) || Infinity;
const maxTotalUsd = Number(val('--max-total-usd', 0)) || 0; // hard spend ceiling for the whole run (0 = none)
const retryOnLimit = flag('--retry-on-limit'); // on a usage/rate-limit stop, sleep + retry until it gets through
const retryMinutes = Number(val('--retry-minutes', 30)) || 30;
const maxRetries = Number(val('--max-retries', 48)) || 48; // safety cap (48 × 30min ≈ 24h)
const model = val('--model');
const dispatchOverrideReason = val('--dispatch-override-reason', process.env.PLAN_LEDGER_DISPATCH_OVERRIDE_REASON || '').trim();
const permissionMode = val('--permission-mode', 'acceptEdits');
const allowedTools = val('--allowed-tools') || val('--allowedTools'); // comma/space list; scopes what agents may do
const budgetUsd = val('--budget'); // per-agent USD cap (claude --max-budget-usd)
const inject = flag('--inject'); // inject step context into a DIRECT prompt (no MCP in agent); runner records + tracks usage
const lean = flag('--lean'); // spawn agents with --strict-mcp-config so they skip the workspace's MCP/tool baggage (only the step's own tools)
const heartbeatMs = Math.min(60_000, Math.max(1_000, Number(val('--heartbeat-ms', process.env.PLAN_LEDGER_HEARTBEAT_MS || 60_000)) || 60_000));
const parallel = flag('--parallel');
const maxWorkers = clampMaxWorkers(Number(val('--max-workers', 2)));
const repoRoot = val('--repo-root', process.cwd());
const worktreeBase = val('--worktree-base', defaultWorktreeBase(repoRoot));
const skipWorktrees = flag('--skip-worktrees');
const usage = { cost: 0, in: 0, out: 0, turns: 0, agents: 0 };
const cursorModelCatalog = listCursorModels();

if (!planId && !projectId) { console.error('usage: runner.mjs (--plan <id> | --project <id>) [--live] [--parallel] [--max-workers N] [--repo-root PATH] [--worktree-base PATH] [--skip-worktrees] [--inject] [--lean] [--max-plans N] [--max-steps N] [--budget USD] [--model NAME] [--dispatch-override-reason "..."]'); process.exit(2); }
if (parallel && projectId) { console.error('--parallel requires --plan (not --project continuous mode)'); process.exit(2); }

const dbPath = defaultDbPath();
const store = new Store(dbPath);

// Orphan sweep: steps THIS RUN claimed in_progress whose agent never recorded an
// attempt get reset to pending on pause/stop, so a dead agent doesn't leave the
// step wedged "running" on the board. Only ids we claimed are touched — other
// concurrent runs' in_progress steps are left alone.
const markedInProgress = new Map(); // step_id -> attempts count at claim time (this run only)
function trackClaim(step) {
  markedInProgress.set(step.id, step.attempts?.length ?? 0);
}
const executorId = inject ? 'runner-inject' : 'runner-mcp';
function sweepOrphans() {
  for (const [id, n] of markedInProgress) {
    try {
      const st = store.getStep(id);
      if (st.status === 'in_progress' && st.attempts.length === n) {
        store.setStepStatus(id, 'pending');
        console.log(`  ♻ step #${id} was left in_progress with no attempt recorded — reset to pending.`);
      }
    } catch {}
  }
  markedInProgress.clear();
}
sweepOrphans(); // startup: nothing tracked yet (a fresh run never resets other runs' steps)

// Boot the same bounded reaper the board/MCP use so orphan execution leases
// (from a previous crashed runner, an agent that died between open/close, or
// a deadline breach mid-run) close as `cancelled` within one interval and
// stop blocking plan-done invariants. Tick once at startup and then run in
// the background for the lifetime of this run.
const reapInterval = Math.max(5_000, Number(process.env.PLAN_LEDGER_REAP_INTERVAL_MS) || 60_000);
const reapStale = Math.max(5_000, Number(process.env.PLAN_LEDGER_REAP_STALE_MS) || 120_000);
const reaper = reapLoop(store, {
  interval_ms: reapInterval,
  stale_after_ms: reapStale,
  logger: (msg) => console.log(`  ${msg}`),
  onReap: (res) => {
    for (const r of (res.reaped || [])) {
      console.log(`  ♻ reaped stale lease #${r.lease_id} (plan #${r.plan_id}, step #${r.step_id}): ${r.reason}`);
    }
  },
});
const leasePolicyTemplate = {
  first_artifact_deadline_ms: 30 * 60 * 1000,
  heartbeat_interval_ms: heartbeatMs,
  stale_after_ms: Math.max(30_000, heartbeatMs * 3),
  max_auto_reassignments: Math.max(0, Number(process.env.PLAN_LEDGER_MAX_AUTO_REASSIGNMENTS ?? 1) || 0),
};
process.on('SIGINT', () => {
  try { reaper.stop(); } catch {}
  try { sweepOrphans(); } catch {}
  store.close();
  process.exit(130);
});

function dispatchPlanForStep(step) {
  const explicitRole = String(step.role ?? '').trim();
  const policy = evaluateDispatchPolicy({
    step,
    explicit_role: explicitRole,
    candidate_roles: DEFAULT_STAFF_ROLES,
    resolved_model: '',
    available_models: cursorModelCatalog.models || [],
  });
  const dispatchRole = explicitRole || policy.selected_role || '';
  const roleResolution = resolveRole(dispatchRole, { cwd: process.cwd(), projectName: store.projectNameForPlan(step.plan_id) });
  const requestedModel = model ?? (roleResolution.mode === 'dispatch' ? (roleResolution.model || '') : '');
  const resolvedPolicy = evaluateDispatchPolicy({
    step,
    explicit_role: explicitRole,
    candidate_roles: DEFAULT_STAFF_ROLES,
    resolved_model: requestedModel,
    available_models: cursorModelCatalog.models || [],
  });
  return { policy: resolvedPolicy, dispatchRole, roleResolution, requestedModel };
}

function roleLines(r, policy = null) {
  if (r.mode !== 'dispatch') return [];
  const lines = [];
  if (policy?.required_capabilities?.length) {
    lines.push(`Dispatch policy required capabilities: ${policy.required_capabilities.map((c) => `${c.capability}(${c.weight})`).join(', ')}`);
    lines.push(`Dispatch policy selected role: ${policy.selected_role} (${policy.selection_mode})`);
  }
  if (r.global_context) lines.push(`Persistent "${r.role}" rules (apply across projects): ${r.global_context}`);
  if (r.charter) lines.push(`Adopt the "${r.role}" role: read ${r.charter} FIRST and follow its operating ` +
    `principles, evidence rules, and Definition of done as your own. Your report must use its Report format.`);
  return lines;
}

function checkPortReady(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

// Compact inlines for the step payload the runner already holds (nextStep embeds
// lessons + file_refs): one line per lesson (max 5), path+note per cited file.
const oneLine = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
function lessonLines(step) {
  const ls = (step.lessons || []).slice(0, 5);
  return ls.length
    ? ['\nLessons from past failures elsewhere — do NOT repeat these:',
       ...ls.map((l) => `- tried: ${oneLine(l.what_tried)} → ${oneLine(l.result || l.verdict)}`)]
    : [];
}
// Brief in (plan #134): the brain's relevant LIVE findings for this step, ranked
// against the step's own words. First re-hash the source files findings rest on
// (schema v5), so anything whose file changed is briefed as SUSPECT, not as fact.
// Remembers which findings were briefed, so what the agent learns can be linked
// to them. Never breaks the brief if the query fails.
const briefedIds = new Map(); // step.id → finding ids shown in its brief
function findingLines(step) {
  try {
    const st = store.checkStale();
    if (st.suspected.length) console.log(`  🧠 ${st.suspected.length} finding(s) now suspect — source changed: ${st.changed_files.join(', ')}`);
    const q = `${step.title}\n${step.context || ''}\n${step.acceptance_criteria || ''}`;
    const hits = pickBrief((text, k) => store.queryFindings({ plan_id: step.plan_id, query: text, limit: k, status: 'live' }), q, { limit: 5 });
    briefedIds.set(step.id, hits.map((h) => h.id));
    return formatFindingLines(hits);
  } catch { return []; }
}
// Findings out (plan #134): absorb the agent's FINDINGS line. Never fails the step.
// root = the agent's working directory, so file paths in its evidence are linked
// (and later checked for staleness).
function absorbFrom(step, text) {
  const pf = parseFindings(text);
  if (pf.error) console.log(`  ⚠ findings: ${pf.error}`);
  if (!pf.findings.length) return;
  try {
    const r = store.absorbFindings(pf.findings, { step_id: step.id, source: `runner:${step.role || 'agent'}`,
      root: process.cwd(), briefed: briefedIds.get(step.id) || [] });
    console.log(`  🧠 findings absorbed: ${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    const re = [...new Set(r.results.flatMap((x) => x.suspected || []))];
    if (re.length) console.log(`  🧠 re-opened for re-evaluation: ${re.map((i) => `#${i}`).join(', ')}`);
  } catch (e) { console.log(`  ⚠ findings not absorbed: ${e.message}`); }
}
function fileRefLines(step) {
  const refs = step.file_refs || [];
  return refs.length
    ? ['\nCited files (read only what this step needs):',
       ...refs.map((f) => `- [${f.role}] ${f.path}${f.note ? ` — ${oneLine(f.note, 120)}` : ''}`)]
    : [];
}

function buildPrompt(step, dispatch) {
  const r = dispatch.roleResolution;
  const dispatchRole = dispatch.dispatchRole;
  return [
    `You are executing exactly ONE step of a plan, using the plan-ledger MCP tools. Do only this step, then stop.`,
    `Plan #${step.plan_id}, step #${step.id} (position ${step.idx}): "${step.title}".`,
    ...roleLines(r, dispatch.policy),
    ``,
    ...lessonLines(step),
    ...findingLines(step),
    ...fileRefLines(step),
    ``,
    `1. Call get_step(${step.id}) for its full context, acceptance_criteria, carry_forward, attempts, and any lessons.`,
    `2. Read the attempts and lessons FIRST — do NOT repeat an approach already marked failed.`,
    `3. Do the work to satisfy the acceptance criteria, using only this step's context and tools.`,
    `4. Call record_attempt(${step.id}, …): verdict "pass" on success, "fail"/"partial" otherwise, with a specific what_tried.`,
    `   Always include executor: "runner-mcp"${dispatchRole ? ` and role: "${dispatchRole}"` : ''} in the record_attempt arguments.`,
    `5. If anything must reach the next step, call write_carry_forward.`,
    `6. If you learned DURABLE truths (facts, decisions, lessons, pitfalls — not a log of actions), call ` +
      `absorb_findings(step_id: ${step.id}, source: "runner:mcp", findings: [...]) with subject + evidence for each.`,
    `Keep your context small — do not load other plans or steps.`,
  ].join('\n');
}

// Shared spawn+parse for both agent modes. `fallback` is what an unparseable/
// failed spawn resolves to — the modes deliberately differ: MCP mode falls back
// to null (judge by DB state only, record_attempt already ran in-agent), inject
// mode falls back to an explicit error-shaped result (the RUNNER must record a
// fail attempt, so it needs a real object).
function spawnClaude(args, fallback = null, hooks = {}) {
  const spawnOpts = { stdio: ['ignore', 'pipe', 'inherit'] };
  if (hooks.cwd) spawnOpts.cwd = hooks.cwd;
  return new Promise((resolve) => {
    let out = '';
    const started = Date.now();
    const child = spawn(claudeResolved.cmd, [...claudeResolved.prependArgs, ...args], spawnOpts);
    let hb = null;
    if (hooks.onStart) hooks.onStart({ pid: child.pid });
    if (hooks.onHeartbeat) {
      hb = setInterval(() => {
        hooks.onHeartbeat({
          elapsed_ms: Date.now() - started,
          output_chars: out.length,
        });
      }, hooks.heartbeat_ms || heartbeatMs);
    }
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      if (hb) clearInterval(hb);
      if (hooks.onClose) hooks.onClose({ elapsed_ms: Date.now() - started });
      try {
        const r = JSON.parse(out), u = r.usage || {};
        resolve({ isError: !!r.is_error, apiErrorStatus: r.api_error_status || null, stopReason: r.stop_reason || '', result: r.result || '', cost: r.total_cost_usd || 0, turns: r.num_turns || 0,
          tin: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), tout: u.output_tokens || 0 });
      } catch { resolve(fallback); }
    });
    child.on('error', (e) => {
      if (hb) clearInterval(hb);
      console.error('  spawn error:', e.message);
      resolve(fallback);
    });
  });
}

// MCP mode also captures the agent's JSON result — NOT to judge pass/fail (that
// stays DB-driven via record_attempt), but so usage-limit stops are visible here
// too. Before this, only --inject mode could detect a 429/limit, so the default
// mode burned max-attempts on limit errors and "paused for a human" instead of
// sleeping and retrying.
function runAgent(step, dispatch, hooks = {}) {
  const r = dispatch.roleResolution; // one deterministic policy pass per step
  const args = ['-p', buildPrompt(step, dispatch), '--output-format', 'json', '--permission-mode', permissionMode];
  if (lean) args.push('--strict-mcp-config'); // note: non-inject mode needs plan-ledger MCP, so --lean suits --inject
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (budgetUsd) args.push('--max-budget-usd', budgetUsd);
  const m = dispatch.requestedModel || null; // CLI --model beats role-map model
  if (m) args.push('--model', m);
  return spawnClaude(args, null, hooks).then((res) => res && { ...res, model: m }); // unparseable/empty → judge by DB state only, as before
}

// INJECTION MODE — give the agent its task DIRECTLY (no MCP, no get_step/record_attempt
// plumbing) and let the RUNNER record the outcome from the agent's JSON. Removes the
// per-agent MCP tool-schema overhead and the indirection that makes cold agents fumble.
function buildDirectPrompt(step, dispatch) {
  const r = dispatch.roleResolution;
  const verifyCmd = parseVerify(step.context);
  return [
    step.title, '',
    ...roleLines(r, dispatch.policy),
    step.context,
    step.acceptance_criteria ? `\nAcceptance: ${step.acceptance_criteria}` : '',
    step.carry_forward ? `\nCarried context: ${step.carry_forward}` : '',
    ...lessonLines(step),
    ...findingLines(step),
    ...fileRefLines(step),
    // B2: state the REAL permission set — inject agents get whatever --allowed-tools
    // the runner was passed (default Write,Read); never contradict it in the prompt.
    `\nWork in the current directory. Available tools: ${allowedTools || 'Write, Read'}. When done, state briefly what you did.`,
    // VERIFY gate: tell the agent up front, in plain language, that a claimed pass
    // will be objectively checked — not just left as a line in its own context.
    verifyCmd ? `\nThis step will be VERIFIED after you finish by running: \`${verifyCmd}\` (in this working ` +
      `directory) — it must exit 0. A "VERDICT: pass" is OVERRIDDEN to "fail" if that command fails, so make ` +
      `sure it actually passes before you report pass.` : '',
    ...FINDINGS_INSTRUCTIONS,
    `The FINAL LINE of your output MUST be exactly one machine-checkable JSON contract:`,
    `COMPLETION_JSON: {"contract_version":1,"verdict":"pass|fail|partial|blocked","summary":"<short user-facing summary>","outputs":["<key output>"],"artifacts":[{"path":"<relative-or-absolute-path>","kind":"file","note":"<why it matters>"}],"commands":[{"command":"<important command you ran>","exit_code":0}],"unresolved_gaps":["<gap>"],"session_id":"<if known>"}`,
    `Do not add text after COMPLETION_JSON. Unsupported pass claims are rejected by governance gates.`,
  ].filter(Boolean).join('\n');
}

function runInjected(step, dispatch, hooks = {}) {
  const args = ['-p', buildDirectPrompt(step, dispatch), '--output-format', 'json',
    '--permission-mode', permissionMode, '--allowedTools', allowedTools || 'Write,Read'];
  if (lean) args.push('--strict-mcp-config'); // inject mode needs no MCP → truly lean per-step agent
  if (budgetUsd) args.push('--max-budget-usd', budgetUsd);
  const m = dispatch.requestedModel || null; // CLI --model beats role-map model
  if (m) args.push('--model', m);
  return spawnClaude(args, { isError: true, apiErrorStatus: null, stopReason: '', result: '', cost: 0, turns: 0, tin: 0, tout: 0 }, hooks)
    .then((res) => ({ ...res, model: m }));
}

// Stop the whole run on a spend ceiling or a real usage/rate-limit error. The CLI gives
// no proactive "% of limit", so we (a) cap on a self-set $ ceiling, (b) detect an actual
// limit hit (HTTP 429 / "usage limit reached") and stop cleanly rather than hammering.
let stopAll = null, stopKind = null, warned95 = false;
function budgetOrLimitStop(res) {
  // Trust the structured signals (HTTP status / stop_reason). Only regex the free-text
  // result when the run actually ERRORED — a successful agent merely *mentioning*
  // "rate limit" or "quota" in its report must not stop the whole run.
  const limitText = /usage limit|rate.?limit|limit reached|quota|insufficient.*credit|resets? at/i;
  if (res && (res.apiErrorStatus === 429 ||
      limitText.test(res.stopReason || '') ||
      (res.isError && limitText.test(res.result || '')))) {
    stopAll = `usage/rate limit hit${res.apiErrorStatus ? ` (HTTP ${res.apiErrorStatus})` : ''}${res.result ? ' — ' + res.result.replace(/\s+/g, ' ').slice(0, 220) : ''}`;
    stopKind = 'limit';
    return true;
  }
  if (maxTotalUsd) {
    if (!warned95 && usage.cost >= 0.95 * maxTotalUsd) { warned95 = true; console.log(`  ⚠ ~95% of the $${maxTotalUsd} budget ($${usage.cost.toFixed(2)} spent) — will stop at the ceiling.`); }
    if (usage.cost >= maxTotalUsd) { stopAll = `spend ceiling reached: $${usage.cost.toFixed(2)} ≥ $${maxTotalUsd}`; stopKind = 'budget'; return true; }
  }
  return false;
}

// Work one plan, one step at a time (each step = a fresh agent process = true context
// reset / "/clear"). Returns 'complete' (all steps done), 'paused' (needs a
// human), or 'busy' (remaining work is already owned by another executor).
let ran = 0;
async function workPlan(pid) {
  if (stopAll) return 'paused';
  const spawns = new Map();
  while (ran < maxSteps) {
    // Atomic claim: pick the lowest workable step AND CAS its status to
    // in_progress in one transaction. Two concurrent runners on the same DB can
    // never receive the same step this way. The peek path (claim:false) stays
    // available to agents that want to inspect without claiming.
    const step = store.nextStep(pid, { claim: true, executor: executorId });
    if (!step) return 'complete';
    if (step.all_in_progress) {
      console.log(`  ⏳ plan is not complete — remaining step(s) already in progress (${step.active_steps.map((s) => `#${s.id}`).join(', ')}).`);
      return 'busy';
    }
    if (step.all_blocked) {
      console.log(`  ⏸ every remaining step is blocked (${step.blocked_steps.map((b) => `#${b.id}`).join(', ')}) — needs a human.`);
      return 'paused';
    }
    const n = (spawns.get(step.id) || 0) + 1;
    spawns.set(step.id, n);
    if (n > maxAttempts) { console.log(`  ⏸ step #${step.id} unresolved after ${maxAttempts} attempt(s) — pausing for a human.`); return 'paused'; }
    console.log(`\n  ▶ step ${step.idx} (#${step.id}) attempt ${n}: ${step.title}`);
    trackClaim(step); // orphan sweep bookkeeping — status already in_progress via the atomic claim
    const dispatch = dispatchPlanForStep(step);
    const roleR = dispatch.roleResolution;
    const requestedModel = dispatch.requestedModel;
    const dispatchWarnings = [...(dispatch.policy.warnings || [])];
    if (dispatchWarnings.length) console.log(`  ⚠ dispatch policy: ${dispatchWarnings.join(' | ')}`);
    if (dispatch.policy.requires_override_reason) {
      if (!dispatchOverrideReason) {
        const summary = `Dispatch policy mismatch for explicit role "${dispatch.policy.explicit_role}" — override reason required.`;
        store.recordAttempt(step.id, {
          what_tried: '[dispatch-policy] blocked before dispatch (override reason missing)',
          result: `${summary}\nBest fit: ${dispatch.policy.best_match?.role || 'n/a'}\nWarnings: ${dispatchWarnings.join(' | ')}`,
          verdict: 'fail',
          role: dispatch.dispatchRole || '',
          executor: inject ? 'runner-inject' : 'runner-mcp',
          agent: roleR.mode === 'dispatch' ? (roleR.agent || dispatch.dispatchRole || '') : (dispatch.dispatchRole || ''),
          model: requestedModel,
          model_source: requestedModel ? 'runner-cli' : '',
        });
        console.log(`  ⛔ ${summary} Re-run with --dispatch-override-reason "...".`);
        return 'paused';
      }
      dispatch.policy.override_reason = dispatchOverrideReason;
      console.log(`  ⚠ override accepted: ${dispatchOverrideReason}`);
    }
    const runId = `run-${step.id}-${n}-${randomUUID().slice(0, 8)}`;
    // Step was already CAS-claimed by nextStep({claim:true}); adopt it into an
    // execution lease so the runner path uses the same unified lifecycle as
    // MCP/CLI/board callers. Failure to open (partial index collision, other
    // supervisor holds it) means somebody else already owns the step — we
    // release the claim by moving the step back to pending and treat this as
    // a busy race.
    let lease;
    try {
      const opened = store.openExecutionLease({
        plan_id: pid, step_id: step.id, run_id: runId,
        session_ref: `pending-${runId}`,
        executor: executorId,
        role: dispatch.dispatchRole || '',
        agent: roleR.mode === 'dispatch' ? (roleR.agent || dispatch.dispatchRole || '') : (dispatch.dispatchRole || ''),
        requested_model: requestedModel,
        actual_model: requestedModel,
        model_source: requestedModel ? 'runner-cli' : '',
        phase: 'preflight',
        action_summary: 'Running dispatch preflight checks.',
        progress_completed: 0,
        progress_total: 4,
        stale_after_ms: leasePolicyTemplate.stale_after_ms,
        deadline_ms: 30 * 60 * 1000, // 30-minute hard cap per attempt; reaped on breach
        dispatch_policy: dispatch.policy.dispatch_policy,
        lease_policy: leasePolicyTemplate,
        override_reason: dispatch.policy.override_reason || '',
        metadata: {
          dispatch_policy: dispatch.policy,
          lease_policy: leasePolicyTemplate,
          warnings: dispatchWarnings,
        },
      });
      lease = opened.lease;
    } catch (e) {
      console.log(`  ⚠ could not open execution lease for step #${step.id}: ${e.message}`);
      // Someone else races us — release the claim and skip.
      try { store.setStepStatus(step.id, 'pending'); } catch {}
      continue;
    }
    const activityKey = { plan_id: pid, step_id: step.id, run_id: runId, session_ref: `pending-${runId}` };
    // The remaining per-step work runs under this try/finally so an
    // unexpected throw always terminalizes the lease — an open lease means
    // reap_stale_leases eventually cancels the step; we want a clean close
    // whenever possible so telemetry stays accurate. Success paths call
    // closeExecutionLease explicitly with the observed outcome; the finally
    // is only a safety net for uncaught errors.
    let leaseAlreadyClosed = false;
    const closeLease = (opts) => {
      if (leaseAlreadyClosed) return;
      try { store.closeExecutionLease(lease.id, opts); leaseAlreadyClosed = true; }
      catch (e) { console.log(`  ⚠ close_execution_lease failed for lease #${lease.id}: ${e.message}`); }
    };
    try {
    const preflight = await runDispatchPreflight({
      cwd: process.cwd(),
      requested_model: requestedModel,
      context: step.context,
      acceptance: step.acceptance_criteria,
      model_catalog: cursorModelCatalog,
      check_port: checkPortReady,
    });
    if (!preflight.ok) {
      const summary = safeActivitySummary(`Preflight failed: ${preflight.summary}`);
      store.upsertActivityHeartbeat({
        ...activityKey,
        phase: 'preflight',
        status: 'failed',
        outcome: 'failed',
        verification_state: 'failed',
        action_summary: summary,
        blocker: summary,
      });
      store.appendActivityEvent({
        ...activityKey,
        event_type: 'terminal',
        phase: 'preflight',
        summary,
        status: 'failed',
        metadata: { checks: preflight.checks },
      });
      store.recordAttempt(step.id, {
        what_tried: `[governance:preflight] ${summary}`,
        result: preflight.checks.map((c) => `${c.ok ? 'ok' : 'fail'} ${c.name}: ${c.detail}`).join('\n'),
        verdict: 'fail',
        role: dispatch.dispatchRole || '',
        executor: inject ? 'runner-inject' : 'runner-mcp',
        agent: roleR.mode === 'dispatch' ? (roleR.agent || dispatch.dispatchRole || '') : (dispatch.dispatchRole || ''),
        model: requestedModel,
        model_source: requestedModel ? 'runner-cli' : '',
        session_ref: activityKey.session_ref,
      });
      closeLease({ outcome: 'failed', close_reason: 'preflight failed', terminal_phase: 'preflight', terminal_summary: summary });
      const after = store.getStep(step.id);
      console.log(`  ⛔ preflight failed: ${preflight.summary}`);
      console.log(`  → status: ${after.status}`);
      ran++;
      if (after.status === 'failed' && n >= maxAttempts) { console.log(`  ⏸ step #${step.id} failed ${n}× — pausing for a human.`); return 'paused'; }
      continue;
    }
    if (inject) {
      const hints = parseGovernanceHints({ context: step.context, acceptance: step.acceptance_criteria });
      const res = await runInjected(step, dispatch, {
        heartbeat_ms: heartbeatMs,
        onHeartbeat: ({ elapsed_ms }) => {
          store.upsertActivityHeartbeat({
            ...activityKey,
            phase: 'execute',
            status: 'in_progress',
            action_summary: safeActivitySummary(`dispatch running (${Math.round(elapsed_ms / 1000)}s elapsed)`),
            progress_completed: 1,
            progress_total: 4,
            artifact_count: 0,
            file_count: 0,
            metadata: { elapsed_ms },
          });
        },
      });
      usage.cost += res.cost; usage.in += res.tin; usage.out += res.tout; usage.turns += res.turns; usage.agents++;
      const completion = parseCompletionContract(res.result);
      const evaluated = evaluateCompletionContract({
        completion_parse: completion,
        required_artifacts: hints.required_artifacts,
        verify_commands: hints.declared_verify,
        cwd: process.cwd(),
      });
      const escalation = detectNoncomplianceEscalation({
        attempts: store.getStep(step.id).attempts,
        nextNoncompliant: !completion.ok,
      });
      const finalVerdict = escalation.escalate ? 'fail' : evaluated.verdict;
      const summary = escalation.escalate
        ? `${evaluated.summary} | ${escalation.recommendation}`
        : evaluated.summary;
      const usageStr = formatUsageLine({ tin: res.tin, tout: res.tout, cost: res.cost, turns: res.turns, model: res.model });
      const chosenAgent = roleR.mode === 'dispatch' ? (roleR.agent || dispatch.dispatchRole || '') : (dispatch.dispatchRole || '');
      const chosenModel = res.model || '';
      const modelSource = chosenModel ? 'runner-cli' : '';
      store.recordAttempt(step.id, {
        what_tried: completion.ok
          ? `[orchestrator:inject] ${safeActivitySummary(summary, 200)}`
          : `[governance:noncompliance] ${safeActivitySummary(summary, 200)}`,
        result: `${safeActivitySummary(summary, 360)}\n${usageStr}`,
        verdict: finalVerdict,
        role: dispatch.dispatchRole || '',
        executor: 'runner-inject',
        agent: chosenAgent,
        model: chosenModel,
        model_source: modelSource,
        session_ref: completion.ok ? (completion.contract.session_id || activityKey.session_ref) : activityKey.session_ref,
      });
      const terminalStatus = finalVerdict === 'pass' ? 'completed' : (finalVerdict === 'blocked' ? 'blocked' : 'failed');
      store.upsertActivityHeartbeat({
        ...activityKey,
        phase: 'review',
        status: terminalStatus,
        outcome: finalVerdict === 'pass' ? 'success' : (finalVerdict === 'partial' ? 'partial' : 'failed'),
        verification_state: finalVerdict === 'pass' ? 'passed' : 'failed',
        action_summary: safeActivitySummary(summary),
        progress_completed: finalVerdict === 'pass' ? 4 : 3,
        progress_total: 4,
        artifact_count: evaluated.artifact_count,
        file_count: evaluated.file_count,
      });
      store.appendActivityEvent({
        ...activityKey,
        event_type: 'terminal',
        phase: 'review',
        summary: safeActivitySummary(summary),
        status: terminalStatus,
        metadata: {
          dispatch_policy: dispatch.policy,
          completion_session_id: completion.ok ? (completion.contract.session_id || '') : '',
          checked_artifacts: evaluated.checked_artifacts,
          checked_commands: evaluated.checked_commands.map((c) => ({ command: c.command, exit_code: c.exit_code, ok: c.ok })),
          unresolved_gaps: evaluated.unresolved_gaps,
          reassign_recommended: escalation.escalate,
        },
      });
      closeLease({
        outcome: finalVerdict === 'pass' ? 'success' : (finalVerdict === 'blocked' ? 'blocked' : 'failed'),
        close_reason: escalation.escalate ? 'noncompliance escalation' : `inject verdict ${finalVerdict}`,
        terminal_phase: 'review',
        terminal_summary: safeActivitySummary(summary),
      });
      if (escalation.escalate) console.log(`  ⛔ ${escalation.recommendation}`);
      // Write-back: absorb durable findings from any agent whose output parsed —
      // a failing step can still teach true pitfalls. An errored run is skipped.
      if (!res.isError) absorbFrom(step, res.result);
      if (budgetOrLimitStop(res)) return 'paused';
    } else {
      // Latest attempt id BEFORE the spawn — lets us tell whether the in-agent
      // record_attempt call (via MCP) actually landed a NEW row afterward, so we
      // know which attempt to append the usage line to (and which to re-check
      // against VERIFY, never a stale/earlier one).
      const lastAttemptIdBefore = store.db.prepare('SELECT MAX(id) m FROM attempts WHERE step_id=?').get(step.id).m || 0;
      const res = await runAgent(step, dispatch, {
        heartbeat_ms: heartbeatMs,
        onHeartbeat: ({ elapsed_ms }) => {
          store.upsertActivityHeartbeat({
            ...activityKey,
            phase: 'execute',
            status: 'in_progress',
            action_summary: safeActivitySummary(`dispatch running (${Math.round(elapsed_ms / 1000)}s elapsed)`),
            progress_completed: 1,
            progress_total: 3,
            artifact_count: 0,
            file_count: 0,
            metadata: { elapsed_ms },
          });
        },
      });
      if (res) {
        usage.cost += res.cost; usage.in += res.tin; usage.out += res.tout; usage.turns += res.turns; usage.agents++;
        if (res.result) console.log(`  ⎿ ${res.result.replace(/\s+/g, ' ').slice(0, 300)}`);
        const usageStr = formatUsageLine({ tin: res.tin, tout: res.tout, cost: res.cost, turns: res.turns, model: res.model });
        const appended = appendUsageToLatestAttempt(store.db, step.id, lastAttemptIdBefore, usageStr);
        if (!appended.appended) console.log(`  (usage line skipped — no new attempt recorded on step #${step.id})`);
        if (budgetOrLimitStop(res)) return 'paused';
      }
      // VERIFY gate for MCP mode: the agent calls record_attempt itself (inside
      // the MCP tool loop), so there's no result text to intercept — instead,
      // re-check VERIFY after the agent exits and, if it claimed done (pass) but
      // VERIFY fails, record an OVERRIDING fail attempt and let recordAttempt's
      // own verdict handling put the step back to failed. The override attempt
      // still carries the observed CLI-selected model as its provenance so the
      // roster does not lose track of what actually just ran.
      const verifyCmd = parseVerify(step.context);
      if (verifyCmd) {
        const afterAgent = store.getStep(step.id);
        if (afterAgent.status === 'done') {
          const gated = applyVerifyGate('pass', 'agent claimed pass via record_attempt', verifyCmd, { cwd: process.cwd() });
          if (gated.verdict === 'fail') {
            const overrideAgent = roleR.mode === 'dispatch' ? (roleR.agent || dispatch.dispatchRole || '') : (dispatch.dispatchRole || '');
            const overrideModel = (typeof res !== 'undefined' && res && res.model) || dispatch.requestedModel || '';
            store.recordAttempt(step.id, {
              what_tried: `[orchestrator:verify-override] re-ran VERIFY (\`${verifyCmd}\`) after the step was marked done`,
              result: gated.resultText,
              verdict: 'fail',
              role: dispatch.dispatchRole || '',
              executor: 'runner-mcp',
              agent: overrideAgent,
              model: overrideModel,
              model_source: overrideModel ? 'runner-cli' : '',
            });
            console.log(`  ⛔ VERIFY override: step #${step.id} was done but \`${verifyCmd}\` failed — reverted to failed.`);
          } else {
            console.log(`  ✓ VERIFY passed: \`${verifyCmd}\``);
          }
        }
      }
      const post = store.getStep(step.id);
      const terminalStatus = post.status === 'done' ? 'completed' : (post.status === 'blocked' ? 'blocked' : 'failed');
      store.upsertActivityHeartbeat({
        ...activityKey,
        phase: 'review',
        status: terminalStatus,
        outcome: post.status === 'done' ? 'success' : (post.status === 'blocked' ? 'blocked' : 'failed'),
        verification_state: post.status === 'done' ? 'passed' : 'failed',
        action_summary: safeActivitySummary(`MCP dispatch finished with step status ${post.status}.`),
        progress_completed: post.status === 'done' ? 3 : 2,
        progress_total: 3,
      });
      store.appendActivityEvent({
        ...activityKey,
        event_type: 'terminal',
        phase: 'review',
        summary: safeActivitySummary(`MCP dispatch finished with step status ${post.status}.`),
        status: terminalStatus,
        metadata: {
          requested_model: requestedModel || '',
          observed_model: res?.model || '',
          dispatch_policy: dispatch.policy,
        },
      });
      // If the agent never called record_attempt over MCP, the step is still
      // in_progress here — treat that as `abandoned` so closeExecutionLease
      // resets the step back to pending (matches the pre-lease sweepOrphans
      // behavior). A recorded pass/fail/blocked already terminalized the step.
      const mcpOutcome = post.status === 'done' ? 'success'
        : post.status === 'blocked' ? 'blocked'
        : post.status === 'failed' ? 'failed'
        : 'abandoned';
      closeLease({
        outcome: mcpOutcome,
        close_reason: `mcp dispatch → step ${post.status}`,
        terminal_phase: 'review',
        terminal_summary: safeActivitySummary(`MCP dispatch finished with step status ${post.status}.`),
      });
    }
    const after = store.getStep(step.id);
    console.log(`  → status: ${after.status}`);
    ran++;
    if (after.status === 'failed' && n >= maxAttempts) { console.log(`  ⏸ step #${step.id} failed ${n}× — pausing for a human.`); return 'paused'; }
    } finally {
      // Safety-net: any uncaught error above leaves the lease dangling and blocks
      // completion invariants; close it as `abandoned` so reap_stale_leases does
      // not have to wait a full stale-window to recover the step.
      closeLease({ outcome: 'abandoned', close_reason: 'runner iteration exited without explicit terminal', terminal_phase: 'execute' });
    }
  }
  console.log(`  reached --max-steps (${maxSteps}) cap.`);
  return 'paused';
}

async function workPlanParallel(pid) {
  if (stopAll) return 'paused';
  const worktreePool = createWorktreePool({
    repoRoot,
    worktreeBase,
    skipWorktrees,
  });
  if (!skipWorktrees) {
    const clean = worktreePool.assertCleanForParallelWrite();
    if (!clean.ok) {
      console.error(`  ⛔ ${clean.reason}`);
      return 'paused';
    }
  }
  try {
    const openLeases = store.listExecutionLeases({ plan_id: pid, status: 'open' });
    worktreePool.cleanupOrphans({ openLeases });
  } catch {}

  const stepRunner = createParallelStepRunner({
    store,
    executorId: parallel ? 'runner-parallel' : executorId,
    inject,
    heartbeatMs,
    leasePolicyTemplate,
    dispatchPlanForStep,
    runInjected,
    runAgent,
    budgetOrLimitStop,
    usage,
    trackClaim,
    checkPortReady,
    cursorModelCatalog,
    dispatchOverrideReason,
    worktreePool,
    onStepComplete: ({ step }) => {
      const after = store.getStep(step.id);
      console.log(`  -> status: ${after.status}`);
    },
  });

  const parallelResult = await runParallelSupervisor(store, {
    plan_id: pid,
    max_workers: maxWorkers,
    executor: 'runner-parallel',
    max_steps: maxSteps,
    max_attempts_per_step: maxAttempts,
    stepRunner,
    shouldStop: () => !!stopAll,
    shouldPause: () => !!stopAll,
    logger: (msg) => console.log(`  ${msg}`),
    onSlotStart: ({ step, active_count }) => {
      console.log(`\n  >> step ${step.idx} (#${step.id}) [parallel slot ${active_count}/${maxWorkers}]: ${step.title}`);
    },
  });

  ran += parallelResult.steps_finished;
  if (stopAll) return 'paused';
  if (parallelResult.status === 'complete') return 'complete';
  if (parallelResult.ready_remaining === 0 && parallelResult.steps_finished > 0) return 'complete';
  return parallelResult.status === 'busy' ? 'busy' : 'paused';
}

const usageLine = () => { if (usage.agents) console.log(`\n  usage: ${usage.agents} agents · ${usage.turns} turns · in ${usage.in.toLocaleString()} tok · out ${usage.out.toLocaleString()} tok · $${usage.cost.toFixed(4)}`); };

// When the limit message names its reset time ("resets at 3pm" / "resets 14:30"),
// sleep until just past it instead of a blind fixed cadence — this is what makes
// the runner restart at the RIGHT time. Falls back to --retry-minutes when the
// message has no parseable time (sanity-capped at 12h in case of a bad parse).
function msUntilReset(text) {
  const m = /reset[s]?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text || '');
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = (m[3] || '').toLowerCase();
  if (h > 23 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const t = new Date(); t.setHours(h, min, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1); // that wall-clock time already passed today
  const ms = t.getTime() - Date.now() + 2 * 60000; // 2-min buffer past the reset
  return ms <= 12 * 3600000 ? ms : null;
}

// --- DRY RUN ---
if (!live) {
  if (projectId) {
    const queue = store.listPlans({ project_id: projectId })
      .filter((p) => p.status !== 'done' && p.status !== 'abandoned' && p.done < p.steps)
      .sort((a, b) => a.id - b.id);
    console.log(`\n  PROJECT #${projectId} — DRY RUN (continuous). Plans that would run, in order:`);
    queue.forEach((p, i) => console.log(`   ${i + 1}. plan #${p.id} [${p.status}] ${p.title}  (${p.done}/${p.steps})`));
    if (!queue.length) console.log('   (none — project fully worked)');
    console.log(`\n  DRY RUN — re-run with --live to work them back-to-back (a fresh agent per step; plan→done→next).`);
  } else {
    const plan = store.openPlan(planId);
    const pending = plan.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
    console.log(`\n  plan #${plan.id} "${plan.title}"  —  DRY RUN`);
    console.log(`  ${pending.length} step(s) to run: ${pending.map((s) => `#${s.id}`).join(', ') || '(none — plan complete)'}\n`);
    pending.forEach((s, i) => console.log(`   ${i + 1}. step #${s.id} [${s.status}] ${s.title}`));
    if (pending.length) {
      const mk = inject ? buildDirectPrompt : buildPrompt;
      const first = store.nextStep(plan.id); // the SAME payload a live agent gets (lessons + file_refs embedded)
      if (first && !first.all_blocked) {
        const dispatch = dispatchPlanForStep(first);
        console.log(`\n  --- ${inject ? 'LEAN (inject)' : 'MCP'} prompt for the next workable step (#${first.id})${lean ? ' [--strict-mcp-config]' : ''} ---\n`);
        console.log(mk(first, dispatch).split('\n').map((l) => '  | ' + l).join('\n'));
      }
    }
    console.log(`\n  DRY RUN — nothing spawned. Re-run with --live to execute (this costs money).`);
    if (parallel) {
      const frontier = store.readySteps(plan.id, { claim: false });
      console.log(`\n  PARALLEL DRY RUN — ${frontier.length} ready step(s), up to ${maxWorkers} concurrent workers.`);
      console.log(`  repo-root: ${repoRoot}`);
      console.log(`  worktree-base: ${skipWorktrees ? '(skipped)' : worktreeBase}`);
    }
  }
  store.close();
  process.exit(0);
}

// --- LIVE (one pass; the retry loop below re-runs it after a usage-limit stop) ---
async function runOnce() {
  if (projectId) {
    console.log(`\n  PROJECT #${projectId} — continuous LIVE run (plan → done → next workable; a fresh agent per step)`);
    let plansDone = 0, plansBlocked = 0;
    while (plansDone < maxPlans && ran < maxSteps && !stopAll) {
      const plan = store.nextPlan(projectId);
      if (!plan) {
        if (plansBlocked) console.log(`\n  ⚑ project paused — ${plansDone} plan(s) done, ${plansBlocked} blocked and waiting on you. Nothing else workable.`);
        else console.log('\n  ✅ project complete — no plans left to work.');
        return;
      }
      if (plan.status === 'draft') store.setPlanStatus(plan.id, 'active');
      console.log(`\n════════ PLAN #${plan.id}: ${plan.title} ════════`);
      const outcome = await workPlan(plan.id);
      if (outcome === 'busy') {
        console.log(`  ⏳ plan #${plan.id} still has active executors — leaving its status unchanged.`);
        return;
      }
      if (outcome !== 'complete') {
        // A budget/usage-limit/external stop is global — let the retry loop handle it; don't mark the plan or advance.
        if (stopAll) return;
        // Genuine "needs a human" pause: mark the plan blocked and KEEP GOING with the next workable plan.
        store.setPlanStatus(plan.id, 'blocked');
        plansBlocked++;
        console.log(`  ⚑ plan #${plan.id} blocked (needs a human) — marked; advancing to the next workable plan.`);
        continue;
      }
      store.setPlanStatus(plan.id, 'done');
      console.log(`  ✅ plan #${plan.id} done → advancing to the next.`);
      plansDone++;
    }
  } else {
    const outcome = parallel
      ? await workPlanParallel(planId)
      : await workPlan(planId);
    if (outcome === 'complete') { store.setPlanStatus(planId, 'done'); console.log('\n  ✅ plan complete.'); }
  }
}

let retries = 0;
while (true) {
  await runOnce();
  sweepOrphans(); // pause/stop path: un-wedge steps whose agent never reported
  if (!stopAll || stopKind !== 'limit' || !retryOnLimit) break; // done, or a non-retryable stop (budget/failure)
  if (retries >= maxRetries) { console.log(`\n  reached --max-retries (${maxRetries}); stopping. Re-run to continue later.`); break; }
  retries++;
  const resetMs = msUntilReset(stopAll);
  const sleepMs = resetMs ?? retryMinutes * 60000;
  const wakeAt = new Date(Date.now() + sleepMs).toLocaleTimeString();
  console.log(`\n  ⏳ ${stopAll}\n     ${resetMs ? 'limit reset time parsed — ' : ''}sleeping ${Math.round(sleepMs / 60000)} min, then retry #${retries}/${maxRetries} (~${wakeAt}). Ctrl-C to stop.`);
  stopAll = null; stopKind = null; // clear so the retry runs; resumes from DB state
  await sleep(sleepMs);
}

usageLine();
if (stopAll) console.log(`\n  ⛔ STOPPED — ${stopAll}\n     Re-run the same command to resume (all state is in the DB).`);
try { reaper.stop(); } catch {}
store.close();
