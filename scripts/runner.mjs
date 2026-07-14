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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/db.mjs';

// Resolve a directly-spawnable claude binary. On Windows the PATH `claude` is a
// .cmd shim that Node's spawn can't launch without a shell — but it wraps a real
// claude.exe, so prefer that (same class of gotcha as the postject .cmd issue).
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === 'win32') {
    const exe = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
  }
  return 'claude';
}
const claudeBin = resolveClaude();

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
const permissionMode = val('--permission-mode', 'acceptEdits');
const allowedTools = val('--allowed-tools') || val('--allowedTools'); // comma/space list; scopes what agents may do
const budgetUsd = val('--budget'); // per-agent USD cap (claude --max-budget-usd)
const inject = flag('--inject'); // inject step context into a DIRECT prompt (no MCP in agent); runner records + tracks usage
const lean = flag('--lean'); // spawn agents with --strict-mcp-config so they skip the workspace's MCP/tool baggage (only the step's own tools)
const usage = { cost: 0, in: 0, out: 0, turns: 0, agents: 0 };

if (!planId && !projectId) { console.error('usage: runner.mjs (--plan <id> | --project <id>) [--live] [--inject] [--lean] [--max-plans N] [--max-steps N] [--budget USD] [--model NAME]'); process.exit(2); }

const dbPath = process.env.PLAN_LEDGER_DB || join(homedir(), 'Documents', 'plan-ledger', 'data', 'plan-ledger.db');
const store = new Store(dbPath);

// Orphan sweep: steps THIS RUN marked in_progress whose agent never recorded an
// attempt get reset to pending on pause/stop, so a dead agent doesn't leave the
// step wedged "running" on the board. Only ids we marked are touched — other
// concurrent runs' in_progress steps are left alone.
const markedInProgress = new Map(); // step_id -> attempts count at mark time (this run only)
function markInProgress(step) {
  markedInProgress.set(step.id, step.attempts?.length ?? 0);
  store.setStepStatus(step.id, 'in_progress');
}
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
process.on('SIGINT', () => { try { sweepOrphans(); } catch {} store.close(); process.exit(130); });

// Role-tagged steps: the role's full charter lives in ~/.claude/agents/<role>.md. A headless
// -p agent can't be spawned AS a subagent type, so the prompt tells it to read + inhabit the file.
function roleLines(step) {
  return step.role
    ? [`Adopt the "${step.role}" role: read ~/.claude/agents/${step.role}.md FIRST and follow its operating ` +
       `principles, evidence rules, and Definition of done as your own. Your report must use its Report format.`]
    : [];
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
function fileRefLines(step) {
  const refs = step.file_refs || [];
  return refs.length
    ? ['\nCited files (read only what this step needs):',
       ...refs.map((f) => `- [${f.role}] ${f.path}${f.note ? ` — ${oneLine(f.note, 120)}` : ''}`)]
    : [];
}

function buildPrompt(step) {
  return [
    `You are executing exactly ONE step of a plan, using the plan-ledger MCP tools. Do only this step, then stop.`,
    `Plan #${step.plan_id}, step #${step.id} (position ${step.idx}): "${step.title}".`,
    ...roleLines(step),
    ``,
    ...lessonLines(step),
    ...fileRefLines(step),
    ``,
    `1. Call get_step(${step.id}) for its full context, acceptance_criteria, carry_forward, attempts, and any lessons.`,
    `2. Read the attempts and lessons FIRST — do NOT repeat an approach already marked failed.`,
    `3. Do the work to satisfy the acceptance criteria, using only this step's context and tools.`,
    `4. Call record_attempt(${step.id}, …): verdict "pass" on success, "fail"/"partial" otherwise, with a specific what_tried.`,
    `   Always include executor: "runner-mcp"${step.role ? ` and role: "${step.role}"` : ''} in the record_attempt arguments.`,
    `5. If anything must reach the next step, call write_carry_forward.`,
    `Keep your context small — do not load other plans or steps.`,
  ].join('\n');
}

// MCP mode also captures the agent's JSON result — NOT to judge pass/fail (that
// stays DB-driven via record_attempt), but so usage-limit stops are visible here
// too. Before this, only --inject mode could detect a 429/limit, so the default
// mode burned max-attempts on limit errors and "paused for a human" instead of
// sleeping and retrying.
function runAgent(step) {
  const args = ['-p', buildPrompt(step), '--output-format', 'json', '--permission-mode', permissionMode];
  if (lean) args.push('--strict-mcp-config'); // note: non-inject mode needs plan-ledger MCP, so --lean suits --inject
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (budgetUsd) args.push('--max-budget-usd', budgetUsd);
  if (model) args.push('--model', model);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(claudeBin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      try {
        const r = JSON.parse(out), u = r.usage || {};
        resolve({ isError: !!r.is_error, apiErrorStatus: r.api_error_status || null, stopReason: r.stop_reason || '', result: r.result || '', cost: r.total_cost_usd || 0, turns: r.num_turns || 0,
          tin: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), tout: u.output_tokens || 0 });
      } catch { resolve(null); } // unparseable/empty → judge by DB state only, as before
    });
    child.on('error', (e) => { console.error('  spawn error:', e.message); resolve(null); });
  });
}

// INJECTION MODE — give the agent its task DIRECTLY (no MCP, no get_step/record_attempt
// plumbing) and let the RUNNER record the outcome from the agent's JSON. Removes the
// per-agent MCP tool-schema overhead and the indirection that makes cold agents fumble.
function buildDirectPrompt(step) {
  return [
    step.title, '',
    ...roleLines(step),
    step.context,
    step.acceptance_criteria ? `\nAcceptance: ${step.acceptance_criteria}` : '',
    step.carry_forward ? `\nCarried context: ${step.carry_forward}` : '',
    ...lessonLines(step),
    ...fileRefLines(step),
    // B2: state the REAL permission set — inject agents get whatever --allowed-tools
    // the runner was passed (default Write,Read); never contradict it in the prompt.
    `\nWork in the current directory. Available tools: ${allowedTools || 'Write, Read'}. When done, state briefly what you did.`,
    `The FINAL LINE of your output MUST be exactly:`,
    `VERDICT: pass|fail|partial — <one-line summary of what you tried>`,
    `(pick ONE verdict; e.g. "VERDICT: pass — wrote the parser and verified the sample round-trips").`,
  ].filter(Boolean).join('\n');
}

// The inject-mode result contract: the agent's final line must be
// "VERDICT: pass|fail|partial — <what_tried>". No marker → FAIL (an agent that
// didn't follow the contract can't be trusted to have finished the step).
function parseVerdict(text) {
  const lines = String(text || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*VERDICT:\s*(pass|fail|partial)\s*(?:[—–-]+\s*(.*))?$/i.exec(lines[i]);
    if (m) return { verdict: m[1].toLowerCase(), what_tried: (m[2] || '').trim() || null };
  }
  return { verdict: 'fail', what_tried: null };
}
function runInjected(step) {
  const args = ['-p', buildDirectPrompt(step), '--output-format', 'json',
    '--permission-mode', permissionMode, '--allowedTools', allowedTools || 'Write,Read'];
  if (lean) args.push('--strict-mcp-config'); // inject mode needs no MCP → truly lean per-step agent
  if (budgetUsd) args.push('--max-budget-usd', budgetUsd);
  if (model) args.push('--model', model);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(claudeBin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      try {
        const r = JSON.parse(out), u = r.usage || {};
        resolve({ isError: !!r.is_error, apiErrorStatus: r.api_error_status || null, stopReason: r.stop_reason || '', result: r.result || '', cost: r.total_cost_usd || 0, turns: r.num_turns || 0,
          tin: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), tout: u.output_tokens || 0 });
      } catch { resolve({ isError: true, apiErrorStatus: null, stopReason: '', result: '', cost: 0, turns: 0, tin: 0, tout: 0 }); }
    });
    child.on('error', (e) => { console.error('  spawn error:', e.message); resolve({ isError: true, apiErrorStatus: null, stopReason: '', result: '', cost: 0, turns: 0, tin: 0, tout: 0 }); });
  });
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
// reset / "/clear"). Returns 'complete' (all steps done) or 'paused' (needs a human).
let ran = 0;
async function workPlan(pid) {
  if (stopAll) return 'paused';
  const spawns = new Map();
  while (ran < maxSteps) {
    const step = store.nextStep(pid); // lowest WORKABLE step (blocked skipped), with lessons embedded
    if (!step) return 'complete';
    if (step.all_blocked) {
      console.log(`  ⏸ every remaining step is blocked (${step.blocked_steps.map((b) => `#${b.id}`).join(', ')}) — needs a human.`);
      return 'paused';
    }
    const n = (spawns.get(step.id) || 0) + 1;
    spawns.set(step.id, n);
    if (n > maxAttempts) { console.log(`  ⏸ step #${step.id} unresolved after ${maxAttempts} attempt(s) — pausing for a human.`); return 'paused'; }
    console.log(`\n  ▶ step ${step.idx} (#${step.id}) attempt ${n}: ${step.title}`);
    markInProgress(step); // so the board's Live mode focuses it while it runs (tracked for the orphan sweep)
    if (inject) {
      const res = await runInjected(step);
      usage.cost += res.cost; usage.in += res.tin; usage.out += res.tout; usage.turns += res.turns; usage.agents++;
      // gate: the agent must end with a VERDICT line; missing marker or an errored run → fail → retry
      const v = res.isError ? { verdict: 'fail', what_tried: null } : parseVerdict(res.result);
      store.recordAttempt(step.id, {
        what_tried: `[orchestrator:inject] ${(v.what_tried || res.result || '(no output)').replace(/\s+/g, ' ').slice(0, 200)}`,
        result: v.what_tried ? `agent verdict: ${v.verdict}` : (res.isError ? 'agent errored' : 'agent output had no VERDICT line'),
        verdict: v.verdict,
        role: step.role || '',
        executor: 'runner-inject',
      });
      if (budgetOrLimitStop(res)) return 'paused';
    } else {
      const res = await runAgent(step);
      if (res) {
        usage.cost += res.cost; usage.in += res.tin; usage.out += res.tout; usage.turns += res.turns; usage.agents++;
        if (res.result) console.log(`  ⎿ ${res.result.replace(/\s+/g, ' ').slice(0, 300)}`);
        if (budgetOrLimitStop(res)) return 'paused';
      }
    }
    const after = store.getStep(step.id);
    console.log(`  → status: ${after.status}`);
    ran++;
    if (after.status === 'failed' && n >= maxAttempts) { console.log(`  ⏸ step #${step.id} failed ${n}× — pausing for a human.`); return 'paused'; }
  }
  console.log(`  reached --max-steps (${maxSteps}) cap.`);
  return 'paused';
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
        console.log(`\n  --- ${inject ? 'LEAN (inject)' : 'MCP'} prompt for the next workable step (#${first.id})${lean ? ' [--strict-mcp-config]' : ''} ---\n`);
        console.log(mk(first).split('\n').map((l) => '  | ' + l).join('\n'));
      }
    }
    console.log(`\n  DRY RUN — nothing spawned. Re-run with --live to execute (this costs money).`);
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
    const outcome = await workPlan(planId);
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
store.close();
