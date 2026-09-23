#!/usr/bin/env node
// run.mjs — findings write-back on REAL agent output. Design + hypotheses: PREREG.md.
//
//   SNAPSHOT=<frozen code dir> node bench/findings-real/run.mjs <phase>
//   phases: smoke | a | judge | replay | b | report
//
// Every model call is cached to results/<phase>/<tag>.json — a re-run never
// spends twice. A hard spend cap ($BENCH_CAP_USD, default 15) is checked before
// every call, counting in-flight reservations. Agents are read-only, with no MCP
// servers and no user settings/hooks, and run with the snapshot as their cwd.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../../src/db.mjs';
import { parseFindings, formatFindingLines, FINDINGS_INSTRUCTIONS } from '../../scripts/runner-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Provider (PREREG Amendment 1): 'claude' = headless Claude Code CLI; 'deepseek' =
// DeepSeek API through the read-only agent loop below. Results live in separate
// folders so the two can later be compared rather than mixed.
const PROVIDER = process.env.BENCH_PROVIDER || 'claude';
if (!['claude', 'deepseek'].includes(PROVIDER)) throw new Error(`BENCH_PROVIDER must be claude|deepseek, got ${PROVIDER}`);
const RES = process.env.BENCH_RESULTS || join(HERE, `results-${PROVIDER}`); // override for harness dry-runs
mkdirSync(RES, { recursive: true });
const SNAP = process.env.SNAPSHOT ? resolve(process.env.SNAPSHOT) : '';
const CLAUDE = process.env.CLAUDE_BIN ||
  join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const CAP = Number(process.env.BENCH_CAP_USD || 15);
const CONC = Number(process.env.BENCH_CONCURRENCY || 4);
const QS = JSON.parse(readFileSync(join(HERE, 'questions.json'), 'utf8'));
const REPS_A = 3, THRESHOLD = 0.7;
const REPS_B = Number(process.env.BENCH_REPS_B || (PROVIDER === 'deepseek' ? 5 : 2));
const AGENT_MODEL = process.env.BENCH_AGENT_MODEL || (PROVIDER === 'deepseek' ? 'deepseek-v4-pro' : 'sonnet');
// The judge is external (blind Claude subagents) whenever the agents are not Claude
// — a different model family must grade, never the agents' own.
const JUDGE_EXTERNAL = process.env.BENCH_JUDGE === 'external' || PROVIDER !== 'claude';
const ROUTES = ['exact', 'near', 'guarded', 'full', 'strict', 'strict_full'];

// ---------- secrets: bench .env first, then the gemma-harness .env -------------
// Values are read into memory only; they are never printed, logged or written
// to results. A blank line in the bench .env falls through to the harness one.
function envValue(name) {
  if (process.env[name]) return process.env[name];
  for (const file of [join(HERE, '.env'), join(process.env.USERPROFILE || '', 'Documents', 'gemma-harness', '.env')]) {
    if (!existsSync(file)) continue;
    // [ \t]* — NOT \s*: \s also matches newlines, so a blank `KEY=` line used to
    // swallow the following line (a comment) as the key's value.
    const m = readFileSync(file, 'utf8').match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*)$`, 'm'));
    const v = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
    if (v) return v;
  }
  return '';
}

// ---------- spend ledger + the one gateway to the model ----------------------
const SPEND = join(RES, 'spend.json');
const spend = existsSync(SPEND) ? JSON.parse(readFileSync(SPEND, 'utf8')) : { total: 0, calls: 0, errors: 0, byPhase: {} };
const saveSpend = () => writeFileSync(SPEND, JSON.stringify(spend, null, 2));
let reserved = 0;

async function callModel(phase, tag, prompt, { model = AGENT_MODEL, budget = 0.8 } = {}) {
  const file = join(RES, phase, `${tag}.json`);
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    // A failed call that cost nothing (auth/network) is retried; a real, paid
    // result — even an error — is kept, so spend is never duplicated.
    if (!(prev.is_error && !prev.cost)) return { ...prev, cached: true };
  }
  if (!SNAP || !existsSync(SNAP)) throw new Error('SNAPSHOT must point at the frozen code directory');
  if (spend.total + reserved + budget > CAP) {
    throw new Error(`CAP: $${spend.total.toFixed(2)} spent + $${reserved.toFixed(2)} in flight + $${budget} > $${CAP}`);
  }
  reserved += budget;
  const t0 = Date.now();
  let raw;
  try {
    raw = PROVIDER === 'deepseek' ? await deepseekAgent(prompt, { model, budget }) : await claudeCli(prompt, { model, budget });
  } finally {
    // Always release the reservation. Before this, a spawn that threw leaked its
    // budget, and after a few failures the cap guard blocked every later call.
    reserved -= budget;
  }
  const rec = { phase, tag, model, ...raw, duration_ms: raw.duration_ms ?? Date.now() - t0, prompt };
  spend.total += rec.cost; spend.calls++; if (rec.is_error) spend.errors++;
  spend.byPhase[phase] = (spend.byPhase[phase] || 0) + rec.cost;
  saveSpend();
  mkdirSync(join(RES, phase), { recursive: true });
  writeFileSync(file, JSON.stringify(rec, null, 2));
  console.log(`  ${rec.is_error ? '✗' : '✓'} ${tag.padEnd(22)} $${rec.cost.toFixed(3)}  turns=${String(rec.turns).padStart(2)}  ` +
    `${(rec.duration_ms / 1000).toFixed(0)}s   [total $${spend.total.toFixed(2)}]${rec.is_error ? '  ' + (rec.subtype || rec.stderr.slice(0, 80)) : ''}`);
  return rec;
}

// ---------- provider: headless Claude Code CLI ---------------------------------
async function claudeCli(prompt, { model, budget }) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--max-budget-usd', String(budget),
    '--allowedTools', 'Read,Grep,Glob',
    '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task',
    '--strict-mcp-config', '--permission-mode', 'dontAsk', '--setting-sources', 'project'];
  // A .mjs/.js CLAUDE_BIN (the dry-run fake) must be run through node — Windows
  // cannot spawn a script file directly (EFTYPE); same rule as runner.mjs.
  const [cmd, argv] = /\.(mjs|cjs|js)$/i.test(CLAUDE) ? [process.execPath, [CLAUDE, ...args]] : [CLAUDE, args];
  const out = await new Promise((done) => {
    let p;
    try { p = spawn(cmd, argv, { cwd: SNAP, windowsHide: true }); } catch (e) { done({ so: '', se: String(e), code: -1 }); return; }
    let so = '', se = '';
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { se += d; });
    p.on('close', (code) => done({ so, se, code }));
    p.on('error', (e) => done({ so, se: String(e), code: -1 }));
  });
  let j = null;
  try { j = JSON.parse(out.so); } catch { /* recorded as an error */ }
  const u = j?.usage || {};
  return {
    is_error: !j || !!j.is_error, subtype: j?.subtype ?? null, result: j?.result ?? '',
    cost: j?.total_cost_usd ?? 0, turns: j?.num_turns ?? 0,
    tin: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    tout: u.output_tokens || 0, duration_ms: j?.duration_ms, exit: out.code, stderr: out.se.slice(-400),
  };
}

// ---------- provider: DeepSeek API + read-only agent loop ----------------------
// $/1M tokens, off-peak, api-docs.deepseek.com/quick_start/pricing on 2026-09-22.
// Peak (Mon–Fri UTC 01:00–04:00, 06:00–10:00) is double.
const DS_RATES = { 'deepseek-v4-pro': { hit: 0.022, miss: 0.66, out: 1.98 }, 'deepseek-flash': { hit: 0.003, miss: 0.15, out: 0.6 } };
function dsPeak(d = new Date()) {
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}
const AGENT_SYSTEM = 'You are a careful software engineer working in a READ-ONLY repository (the current project). ' +
  'Inspect it with the tools list_files, read_file and grep — never guess what the code says; check it. ' +
  'Paths are relative to the repository root. When you are done, give your final answer in exactly the format the user asks for.';
const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'List every file under a directory of the repository, recursively.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: 'directory relative to the repo root (default: the root)' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file with line numbers. Long files: use offset/limit (at most 400 lines per call).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: '1-based first line' }, limit: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents with a JavaScript regular expression. Returns up to 60 "path:line: text" matches.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'file or directory relative to the repo root (default: the root)' } }, required: ['pattern'] } } },
];

// Every path is resolved inside the snapshot; anything escaping it is refused.
function inSnap(p = '.') {
  const abs = resolve(SNAP, String(p || '.').replace(/^[/\\]+/, ''));
  const rel = relative(SNAP, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path is outside the repository');
  return abs;
}
const relPath = (abs) => relative(SNAP, abs).replace(/\\/g, '/') || '.';
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full)); else out.push(full);
  }
  return out;
}
export function runTool(name, args = {}) {
  if (name === 'list_files') return walk(inSnap(args.dir)).map(relPath).join('\n') || '(empty)';
  if (name === 'read_file') {
    const abs = inSnap(args.path);
    if (!existsSync(abs) || statSync(abs).isDirectory()) return `error: no such file: ${args.path}`;
    const lines = readFileSync(abs, 'utf8').split('\n');
    const from = Math.max(1, Number(args.offset) || 1), n = Math.min(400, Math.max(1, Number(args.limit) || 400));
    const slice = lines.slice(from - 1, from - 1 + n);
    return `[${relPath(abs)} — lines ${from}-${from + slice.length - 1} of ${lines.length}]\n` + slice.map((l, i) => `${from + i}\t${l}`).join('\n');
  }
  if (name === 'grep') {
    let re;
    try { re = new RegExp(String(args.pattern)); } catch { re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
    const target = inSnap(args.path);
    if (!existsSync(target)) return `error: no such path: ${args.path}`;
    const files = statSync(target).isDirectory() ? walk(target) : [target];
    const hits = [];
    for (const f of files) {
      if (statSync(f).size > 1_000_000) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < 60; i++) if (re.test(lines[i])) hits.push(`${relPath(f)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
      if (hits.length >= 60) break;
    }
    return hits.length ? hits.join('\n') : '(no matches)';
  }
  return `error: unknown tool ${name}`;
}

async function deepseekAgent(prompt, { model, budget, maxTurns = 30 }) {
  const key = envValue('DEEPSEEK_API_KEY');
  if (!key) return { is_error: true, subtype: 'no_api_key', result: '', cost: 0, turns: 0, tin: 0, tout: 0, exit: -1, stderr: 'DEEPSEEK_API_KEY not set' };
  const rate = DS_RATES[model] || DS_RATES['deepseek-v4-pro'];
  const messages = [{ role: 'system', content: AGENT_SYSTEM }, { role: 'user', content: prompt }];
  let cost = 0, turns = 0, tin = 0, tout = 0, hit = 0, miss = 0, toolCalls = 0, last = '';
  const finish = (is_error, subtype, detail = '') => ({ is_error, subtype, result: last, cost, turns, tin, tout,
    cache_hit: hit, cache_miss: miss, tool_calls: toolCalls, peak: dsPeak(), exit: is_error ? 1 : 0, stderr: detail.slice(0, 400) });
  while (turns < maxTurns) {
    turns++;
    const body = { model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0, max_tokens: 4096, thinking: { type: 'disabled' } };
    let data = null;
    for (let attempt = 1; attempt <= 3; attempt++) { // bounded: transient 429/5xx/network only
      try {
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
        });
        const txt = await r.text();
        if (r.ok) { data = JSON.parse(txt); break; }
        if ((r.status === 429 || r.status >= 500) && attempt < 3) { await sleep(3000 * attempt); continue; }
        return finish(true, `http_${r.status}`, txt);
      } catch (e) {
        if (attempt < 3) { await sleep(3000 * attempt); continue; }
        return finish(true, 'network', String(e?.message || e));
      }
    }
    const u = data.usage || {};
    const h = u.prompt_cache_hit_tokens ?? 0, m = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens || 0) - h), o = u.completion_tokens || 0;
    const mult = dsPeak() ? 2 : 1;
    cost += mult * (h * rate.hit + m * rate.miss + o * rate.out) / 1e6;
    tin += u.prompt_tokens || 0; tout += o; hit += h; miss += m;
    const msg = data.choices?.[0]?.message || {};
    if (msg.content) last = msg.content;
    const calls = msg.tool_calls || [];
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) return finish(false, 'success');
    if (cost > budget) return finish(true, 'error_max_budget_usd');
    for (const tc of calls) {
      toolCalls++;
      let out;
      try { out = runTool(tc.function?.name, JSON.parse(tc.function?.arguments || '{}')); } catch (e) { out = `error: ${e.message}`; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 20_000) });
    }
  }
  return finish(true, 'error_max_turns');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; console.log(`  ! ${e.message}`); }
    }
  }));
  return out;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// The judge. With Claude agents it is Opus through the CLI. Otherwise it is
// EXTERNAL (PREREG Amendment 1): the exact prompt is written to
// judge/<topic>.prompt.md for a blind in-session Claude subagent, whose verbatim
// reply the operator saves as judge/<topic>.json. The judge is never the agents' model.
async function judgeCall(topic, prompt, opts) {
  if (!JUDGE_EXTERNAL) return callModel('judge', topic, prompt, opts);
  const f = join(RES, 'judge', `${topic}.json`);
  if (existsSync(f)) return readJson(f);
  mkdirSync(join(RES, 'judge'), { recursive: true });
  writeFileSync(join(RES, 'judge', `${topic}.prompt.md`), prompt);
  console.log(`  … judge ${topic}: prompt written to judge/${topic}.prompt.md — awaiting the external judge`);
  return null;
}

// ---------- phases ------------------------------------------------------------
const phases = {
  // Offline: the agent tools must never reach outside the snapshot.
  selftest() {
    let pass = 0;
    const ok = (label, cond) => { if (!cond) throw new Error('SELFTEST FAILED: ' + label); console.log('  ok  ' + label); pass++; };
    const refused = (fn) => { try { const r = fn(); return /^error:/.test(r); } catch (e) { return /outside the repository/.test(e.message); } };
    ok('list_files lists the snapshot', runTool('list_files', {}).includes('package.json'));
    ok('read_file reads with line numbers', /^\[package\.json — lines 1-/.test(runTool('read_file', { path: 'package.json', limit: 3 })));
    ok('read_file caps at 400 lines', runTool('read_file', { path: 'src/db.mjs', limit: 5000 }).split('\n').length <= 401);
    ok('grep finds a known symbol with path:line', /src\/db\.mjs:\d+:/.test(runTool('grep', { pattern: 'busy_timeout', path: 'src' })));
    ok('grep tolerates an invalid regex (treated as literal)', !/^error/.test(runTool('grep', { pattern: '(unclosed' })));
    ok('refuses ../ traversal (read)', refused(() => runTool('read_file', { path: '../../../Windows/win.ini' })));
    ok('refuses ../ traversal (list)', refused(() => runTool('list_files', { dir: '..' })));
    ok('refuses ../ traversal (grep)', refused(() => runTool('grep', { pattern: 'x', path: '../' })));
    ok('an absolute path is forced under the snapshot, never followed', refused(() => runTool('read_file', { path: 'C:/Windows/win.ini' })));
    ok('unknown tool rejected', /unknown tool/.test(runTool('rm_rf', {})));
    console.log(`\nselftest: ${pass} checks passed`);
  },

  async smoke() {
    const r = await callModel('smoke', 'smoke', 'Read package.json in the current directory and tell me the value of its "name" field. ' +
      'The FINAL LINE of your output MUST be exactly: ANSWER: <name>', { budget: 0.3 });
    console.log(r.result);
  },

  // Part A: independent agents investigate and report FINDINGS.
  async a() {
    const jobs = [];
    for (let rep = 1; rep <= REPS_A; rep++) for (const t of QS.topics) jobs.push({ t, rep });
    await pool(jobs, CONC, ({ t, rep }) => callModel('a', `${t.id}-r${rep}`, [
      `You are investigating the codebase in the current directory (plan-ledger, a Node.js app).`,
      `Investigate how it ${t.brief}. Read the relevant source. Do not modify anything.`,
      ...FINDINGS_INSTRUCTIONS,
      `Report between 3 and 8 findings. Each must be something you verified in the code, with evidence.`,
      `The FINAL LINE of your output MUST be exactly:`,
      `VERDICT: pass|fail|partial — <one-line summary of what you investigated>`,
    ].join('\n'), { budget: 0.8 }));
    const agents = [];
    for (const { t, rep } of jobs) {
      const f = join(RES, 'a', `${t.id}-r${rep}.json`);
      if (!existsSync(f)) continue;
      const rec = readJson(f), pf = parseFindings(rec.result);
      agents.push({ agent: `${t.id}-r${rep}`, topic: t.id, rep, is_error: rec.is_error, parse_error: pf.error,
        findings: pf.findings.map((x, i) => ({ id: `${t.id}-r${rep}-${i + 1}`, ...x })) });
    }
    writeJson(join(RES, 'a', 'findings.json'), agents);
    const n = agents.reduce((s, x) => s + x.findings.length, 0);
    console.log(`\nPart A: ${agents.length} agents, ${n} findings, ${agents.filter((x) => x.parse_error).length} parse errors, ` +
      `${agents.filter((x) => x.is_error).length} run errors`);
  },

  // Blind judge: truth labels + same-fact clusters, per topic.
  async judge() {
    const agents = readJson(join(RES, 'a', 'findings.json'));
    await pool(QS.topics, CONC, (t) => {
      const fs = agents.filter((a) => a.topic === t.id).flatMap((a) => a.findings)
        .map(({ id, subject, claim, evidence, kind, slot }) => ({ id, kind, subject, slot, claim, evidence }));
      return judgeCall(t.id, [
        `You are a strict, careful judge. Below are FINDINGS reported by several independent agents about the codebase`,
        `in the current directory (plan-ledger). Read the relevant code to check them. Do not modify anything.`,
        ``,
        `Do two things:`,
        `1. TRUTH: label every finding "true" (the code clearly supports it), "false" (the code contradicts it — a wrong`,
        `   name, number, or behaviour makes it false), or "unverifiable" (it cannot be checked from the code).`,
        `2. CLUSTERS: group findings that state the SAME underlying fact (the same piece of information, however it is`,
        `   worded). Findings that state DIFFERENT facts go in different clusters, even when they are about the same`,
        `   function. Every finding id must appear in exactly one cluster.`,
        ``,
        `Findings:`,
        JSON.stringify(fs, null, 1),
        ``,
        `Respond with ONLY a JSON object and nothing else:`,
        `{"truth": {"<id>": {"label": "true|false|unverifiable", "why": "<short reason>"}}, "clusters": [["<id>", "<id>"], ["<id>"]]}`,
      ].join('\n'), { model: 'opus', budget: 1.5 });
    });
    const pending = QS.topics.filter((t) => !existsSync(join(RES, 'judge', `${t.id}.json`)));
    if (pending.length) {
      // Never aggregate a partial judgement: labels.json would silently turn the
      // missing topics into singleton clusters and skew every replay metric.
      console.log(`\njudge: waiting on ${pending.map((t) => t.id).join(', ')} — labels.json NOT written.`);
      return;
    }
    const truth = {}, clusters = [], problems = [];
    for (const t of QS.topics) {
      const f = join(RES, 'judge', `${t.id}.json`);
      const ids = agents.filter((a) => a.topic === t.id).flatMap((a) => a.findings.map((x) => x.id));
      let j = null;
      if (existsSync(f)) {
        const r = readJson(f).result;
        try { j = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)); } catch { problems.push(`${t.id}: unparseable judge output`); }
      } else problems.push(`${t.id}: no judge output`);
      const seen = new Set();
      for (const c of j?.clusters || []) {
        const cc = c.filter((id) => ids.includes(id) && !seen.has(id));
        cc.forEach((id) => seen.add(id));
        if (cc.length) clusters.push({ topic: t.id, ids: cc });
      }
      for (const id of ids) {
        if (!seen.has(id)) { clusters.push({ topic: t.id, ids: [id] }); problems.push(`${id}: missing from judge clusters (singleton)`); }
        truth[id] = j?.truth?.[id] ?? { label: 'unlabelled', why: 'judge omitted it' };
      }
    }
    writeJson(join(RES, 'judge', 'labels.json'), { truth, clusters, problems });
    const labels = Object.values(truth).reduce((m, x) => ((m[x.label] = (m[x.label] || 0) + 1), m), {});
    console.log(`\njudge: ${clusters.length} clusters over ${Object.keys(truth).length} findings; truth ${JSON.stringify(labels)}; ` +
      `${problems.length} problem(s)${problems.length ? ': ' + problems.slice(0, 5).join('; ') : ''}`);
  },

  // Offline replay of the REAL findings through every route, several arrival orders.
  replay() {
    const agents = readJson(join(RES, 'a', 'findings.json')).filter((a) => a.findings.length);
    const { truth, clusters } = readJson(join(RES, 'judge', 'labels.json'));
    const clusterOf = new Map();
    clusters.forEach((c, i) => c.ids.forEach((id) => clusterOf.set(id, i)));
    const orders = [agents.map((_, i) => i)];
    const r = mulberry32(7);
    for (let k = 0; k < 5; k++) {
      const o = agents.map((_, i) => i);
      for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
      orders.push(o);
    }
    const total = agents.reduce((s, a) => s + a.findings.length, 0);
    const out = {};
    // Post-hoc exploration (not a pre-registered test): BENCH_THRESHOLDS=0.3,0.4,…
    // sweeps thresholds into replay-sweep.json, leaving the pre-registered
    // 0.7 result in replay.json untouched.
    const thrs = (process.env.BENCH_THRESHOLDS || String(THRESHOLD)).split(',').map(Number);
    const sweep = thrs.length > 1;
    for (const thr of thrs) for (const route of ROUTES) {
      const agg = { merges: 0, wrongMerge: 0, rejected: 0, activeRows: 0, clusters: 0, fragmented: 0, lostClusters: 0,
        falseActive: 0, conflicts: 0, conflictsCatchingFalse: 0, supersedes: 0, wrongSupersedes: 0, examples: [] };
      for (const order of orders) {
        const s = new Store(':memory:');
        const plan = s.createPlan({ title: 'replay' });
        const creator = new Map(); // row id -> finding id that created it
        for (const ai of order) {
          const a = agents[ai];
          const res = s.absorbFindings(a.findings.map(({ id, ...f }) => f), { plan_id: plan.id, source: a.agent, route, threshold: thr });
          res.results.forEach((x, i) => {
            const fid = a.findings[i].id;
            if (x.outcome === 'rejected') { agg.rejected++; return; }
            if (x.outcome === 'duplicate' || x.outcome === 'near_duplicate') {
              agg.merges++;
              const cfid = creator.get(x.id);
              if (clusterOf.get(cfid) !== clusterOf.get(fid)) {
                agg.wrongMerge++;
                if (agg.examples.length < 6) agg.examples.push(`MERGED ${fid} INTO ${cfid}`);
              }
              return;
            }
            creator.set(x.id, fid);
            if (x.outcome === 'superseded') for (const old of x.superseded || []) {
              agg.supersedes++;
              if (clusterOf.get(creator.get(old)) !== clusterOf.get(fid)) {
                agg.wrongSupersedes++;
                if (agg.examples.length < 6) agg.examples.push(`SUPERSEDED ${creator.get(old)} BY ${fid}`);
              }
            }
            if (x.outcome === 'conflict') {
              agg.conflicts++;
              const others = (x.conflicts_with || []).map((id) => creator.get(id));
              if ([fid, ...others].some((f) => truth[f]?.label === 'false')) agg.conflictsCatchingFalse++;
            }
          });
        }
        const active = s.queryFindings({ plan_id: plan.id, limit: 200 });
        agg.activeRows += active.length;
        const rowsPerCluster = new Map();
        for (const row of active) {
          const c = clusterOf.get(creator.get(row.id));
          rowsPerCluster.set(c, (rowsPerCluster.get(c) || 0) + 1);
          if (truth[creator.get(row.id)]?.label === 'false') agg.falseActive++;
        }
        const absorbedClusters = new Set(agents.flatMap((a) => a.findings.map((f) => clusterOf.get(f.id))));
        agg.clusters += absorbedClusters.size;
        for (const c of absorbedClusters) {
          const n = rowsPerCluster.get(c) || 0;
          if (n === 0) agg.lostClusters++;
          if (n > 1) agg.fragmented++;
        }
        s.close();
      }
      const k = orders.length;
      out[sweep ? `${route}@${thr}` : route] = { ...Object.fromEntries(Object.entries(agg).filter(([key]) => key !== 'examples').map(([key, v]) => [key, v / k])),
        wrongMergePct: agg.merges ? (100 * agg.wrongMerge) / agg.merges : 0, examples: agg.examples };
    }
    writeJson(join(RES, sweep ? 'replay-sweep.json' : 'replay.json'),
      { findings: total, agents: agents.length, orders: orders.length, threshold: sweep ? thrs : THRESHOLD, routes: out });
    console.log(`\nreplay: ${total} real findings from ${agents.length} agents, ${orders.length} arrival orders (means per order)\n`);
    console.log('route        merges  wrong(%)        lost facts  fragmented  excess rows  false kept active  conflicts (catching a false one)');
    for (const [route, m] of Object.entries(out)) {
      console.log(`${route.padEnd(12)} ${m.merges.toFixed(1).padStart(6)}  ${m.wrongMerge.toFixed(1).padStart(5)} (${m.wrongMergePct.toFixed(1)}%)  ` +
        `${m.lostClusters.toFixed(1).padStart(10)}  ${m.fragmented.toFixed(1).padStart(10)}  ${(m.activeRows - m.clusters).toFixed(1).padStart(11)}  ` +
        `${m.falseActive.toFixed(1).padStart(17)}  ${m.conflicts.toFixed(1)} (${m.conflictsCatchingFalse.toFixed(1)})`);
    }
  },

  // H3b (PREREG-H3b.md): harder multi-hop questions, arms NONE / BRAIN / TRUST.
  // The pilot (NONE x1) is calibration only and never enters a verdict.
  async h3bpilot() { await h3bRun('h3b-pilot', ['none'], 1); },
  async h3b() { await h3bRun('h3b', H3B_ARMS, REPS_B); },
  h3breport() { h3bReport(); },

  // Part B: NONE vs BRAIN on questions with hand-verified answers.
  async b() {
    const agents = readJson(join(RES, 'a', 'findings.json'));
    const brain = new Store(':memory:');
    const plan = brain.createPlan({ title: 'brain' });
    for (const a of agents) if (a.findings.length) brain.absorbFindings(a.findings.map(({ id, ...f }) => f), { plan_id: plan.id, source: a.agent });
    const briefs = {};
    for (const q of QS.questions) {
      const hits = brain.queryFindings({ plan_id: plan.id, query: q.q, limit: 5 });
      briefs[q.id] = { lines: formatFindingLines(hits), finding_ids: hits.map((h) => h.id) };
    }
    writeJson(join(RES, 'b', 'briefs.json'), briefs);
    const jobs = [];
    for (let rep = 1; rep <= REPS_B; rep++) QS.questions.forEach((q, i) => {
      const arms = (i + rep) % 2 ? ['none', 'brain'] : ['brain', 'none']; // interleave arm order
      for (const arm of arms) jobs.push({ q, arm, rep });
    });
    await pool(jobs, CONC, ({ q, arm, rep }) => callModel('b', `${q.id}-${arm}-r${rep}`, [
      `Answer this question about the codebase in the current directory (plan-ledger, a Node.js app).`,
      `You may read files. Do not modify anything.`,
      ``,
      `Question: ${q.q}`,
      ...(arm === 'brain' ? briefs[q.id].lines : []),
      ``,
      `Be precise. The FINAL LINE of your output MUST be exactly:`,
      `ANSWER: <your answer>`,
    ].join('\n'), { budget: 0.5 }));
    brain.close();
  },

  report() {
    const out = [];
    const log = (s = '') => { out.push(s); console.log(s); };
    const agents = readJson(join(RES, 'a', 'findings.json'));
    const labels = readJson(join(RES, 'judge', 'labels.json'));
    const replay = readJson(join(RES, 'replay.json'));
    const nF = Object.keys(labels.truth).length;
    const tl = Object.values(labels.truth).reduce((m, x) => ((m[x.label] = (m[x.label] || 0) + 1), m), {});
    const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

    // Part B grading
    const grade = (q, text) => {
      // Amendment 2: the LAST `ANSWER:` anywhere (agents glue markers onto prose
      // lines). [ \t]* — never \s*, which would run across a line break.
      const m = [...String(text).matchAll(/ANSWER:[ \t]*([^\n]+)/g)].pop();
      if (!m) return { ok: false, why: 'no ANSWER marker' };
      const ans = m[1].trim();
      if (q.type === 'number') {
        const n = (ans.match(/-?\d[\d,_]*(?:\.\d+)?/) || [''])[0].replace(/[,_]/g, '');
        return { ok: n === q.expect, ans };
      }
      return { ok: ans.toLowerCase().includes(q.expect.toLowerCase()), ans };
    };
    const rows = [];
    for (const q of QS.questions) for (const arm of ['none', 'brain']) for (let rep = 1; rep <= REPS_B; rep++) {
      const f = join(RES, 'b', `${q.id}-${arm}-r${rep}.json`);
      if (!existsSync(f)) continue;
      const r = readJson(f);
      rows.push({ q: q.id, arm, rep, ...grade(q, r.result), cost: r.cost, turns: r.turns, tin: r.tin, tout: r.tout, ms: r.duration_ms, err: r.is_error });
    }
    const arm = (a) => rows.filter((r) => r.arm === a);
    const mean = (xs, k) => (xs.length ? xs.reduce((s, x) => s + x[k], 0) / xs.length : 0);

    log('# Findings write-back on real agent output — results');
    log(`\nGenerated ${new Date().toISOString()} by bench/findings-real/run.mjs. Hypotheses were fixed beforehand in PREREG.md.`);
    const spendNow = existsSync(SPEND) ? readJson(SPEND) : spend;
    log(`\nSpend: $${spendNow.total.toFixed(2)} over ${spendNow.calls} calls (${spendNow.errors} errored) — ` +
      Object.entries(spendNow.byPhase).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', '));

    log('\n## Part A — real findings');
    log(`\n${agents.length} agent runs → ${nF} findings. Parse errors: ${agents.filter((a) => a.parse_error).length}; run errors: ${agents.filter((a) => a.is_error).length}.`);
    log(`Judge (opus, blind): ${labels.clusters.length} same-fact clusters. Truth: ${Object.entries(tl).map(([k, v]) => `${k} ${v} (${pct(v, nF)})`).join(', ')}.`);
    if (labels.problems.length) log(`Judge problems: ${labels.problems.length} (${labels.problems.slice(0, 4).join('; ')})`);
    log(`\n**H2 (truthfulness ≥ 90%)**: ${pct(tl.true || 0, nF)} judged true → ${(tl.true || 0) / nF >= 0.9 ? 'PASS' : 'FAIL — recommend a verification gate before absorb'}.`);

    log(`\nReplay: ${replay.findings} findings, ${replay.agents} agents, ${replay.orders} arrival orders, threshold ${replay.threshold} (means per order).\n`);
    log('| route | merges | wrong merges | lost facts | fragmented facts | excess rows | false kept active | conflicts (catching a false finding) |');
    log('|---|---|---|---|---|---|---|---|');
    for (const [route, m] of Object.entries(replay.routes)) {
      log(`| ${route} | ${m.merges.toFixed(1)} | ${m.wrongMerge.toFixed(1)} (${m.wrongMergePct.toFixed(1)}%) | ${m.lostClusters.toFixed(1)} | ` +
        `${m.fragmented.toFixed(1)} | ${(m.activeRows - m.clusters).toFixed(1)} | ${m.falseActive.toFixed(1)} | ${m.conflicts.toFixed(1)} (${m.conflictsCatchingFalse.toFixed(1)}) |`);
    }
    const sf = replay.routes.strict_full;
    log(`\n**H1 (strict_full wrong merges ≤ 1%)**: ${sf.wrongMergePct.toFixed(1)}% → ${sf.wrongMergePct <= 1 ? 'PASS' : 'FAIL'}.`);
    for (const [route, m] of Object.entries(replay.routes)) if (m.examples.length) log(`- ${route} examples: ${m.examples.slice(0, 3).join('; ')}`);

    log('\n## Part B — does the brain help?');
    log(`\n${rows.length} runs graded mechanically against hand-verified answers.\n`);
    log('| arm | correct | mean cost | mean turns | mean input tok | mean output tok | mean time |');
    log('|---|---|---|---|---|---|---|');
    for (const a of ['none', 'brain']) {
      const xs = arm(a);
      log(`| ${a.toUpperCase()} | ${xs.filter((x) => x.ok).length}/${xs.length} | $${mean(xs, 'cost').toFixed(4)} | ${mean(xs, 'turns').toFixed(1)} | ` +
        `${Math.round(mean(xs, 'tin'))} | ${Math.round(mean(xs, 'tout'))} | ${(mean(xs, 'ms') / 1000).toFixed(1)}s |`);
    }
    const N = arm('none'), B = arm('brain');
    const accDelta = B.filter((x) => x.ok).length - N.filter((x) => x.ok).length;
    const costCut = mean(N, 'cost') ? 1 - mean(B, 'cost') / mean(N, 'cost') : 0;
    log(`\nPer question (correct/runs, mean cost):\n`);
    log('| q | NONE | BRAIN | brief had the answer? |');
    log('|---|---|---|---|');
    const briefs = readJson(join(RES, 'b', 'briefs.json'));
    for (const q of QS.questions) {
      const n = N.filter((x) => x.q === q.id), b = B.filter((x) => x.q === q.id);
      const inBrief = briefs[q.id].lines.join(' ').toLowerCase().includes(q.expect.toLowerCase());
      log(`| ${q.id} | ${n.filter((x) => x.ok).length}/${n.length} $${mean(n, 'cost').toFixed(3)} | ${b.filter((x) => x.ok).length}/${b.length} $${mean(b, 'cost').toFixed(3)} | ${inBrief ? 'yes' : 'no'} |`);
    }
    const wrong = rows.filter((x) => !x.ok).map((x) => `${x.q}/${x.arm}/r${x.rep}: ${x.why || JSON.stringify(x.ans)}`);
    if (wrong.length) log(`\nWrong answers: ${wrong.join('; ')}`);
    log(`\n**H3 (BRAIN accuracy within 1 of NONE, and ≥ 25% cheaper)**: accuracy Δ ${accDelta >= 0 ? '+' : ''}${accDelta}, ` +
      `cost ${costCut >= 0 ? '−' : '+'}${Math.abs(100 * costCut).toFixed(0)}% → ` +
      `${accDelta >= -1 && costCut >= 0.25 ? 'PASS' : accDelta < -1 ? 'FAIL (accuracy)' : 'FAIL (no material saving)'}.`);
    writeFileSync(join(RES, 'REPORT.md'), out.join('\n') + '\n');
    console.log(`\n→ ${join(RES, 'REPORT.md')}`);
  },
};

// ---------- H3b ---------------------------------------------------------------
const H3B_ARMS = ['none', 'brain', 'trust'];
// Fixed verbatim in PREREG-H3b.md; the 98% is the measured H2 result.
const TRUST_LINE = 'These findings were recorded by earlier agents that verified them against this code ' +
  '(in a blind audit, 98% were correct). Use them directly as facts: only read the code for what ' +
  'they do not cover, or for anything marked CONFLICT.';
const QS3 = () => JSON.parse(readFileSync(join(HERE, 'questions-h3b.json'), 'utf8'));

async function h3bRun(dir, arms, reps) {
  const agents = readJson(join(RES, 'a', 'findings.json'));
  const brain = new Store(':memory:');
  const plan = brain.createPlan({ title: 'brain' });
  for (const a of agents) if (a.findings.length) brain.absorbFindings(a.findings.map(({ id, ...f }) => f), { plan_id: plan.id, source: a.agent });
  const qs = QS3().questions, briefs = {};
  for (const q of qs) {
    const hits = brain.queryFindings({ plan_id: plan.id, query: q.q, limit: 5 });
    briefs[q.id] = { lines: formatFindingLines(hits), finding_ids: hits.map((h) => h.id) };
  }
  brain.close();
  writeJson(join(RES, dir, 'briefs.json'), briefs);
  const jobs = [];
  for (let rep = 1; rep <= reps; rep++) qs.forEach((q, i) => {
    const k = (i + rep) % arms.length; // rotate arm order per question and rep
    for (const arm of [...arms.slice(k), ...arms.slice(0, k)]) jobs.push({ q, arm, rep });
  });
  await pool(jobs, CONC, ({ q, arm, rep }) => callModel(dir, `${q.id}-${arm}-r${rep}`, [
    `Answer this question about the codebase in the current directory (plan-ledger, a Node.js app).`,
    `You may read files. Do not modify anything.`,
    ``,
    `Question: ${q.q}`,
    ...(arm !== 'none' ? briefs[q.id].lines : []),
    ...(arm === 'trust' && briefs[q.id].lines.length ? [TRUST_LINE] : []),
    ``,
    `Be precise. The FINAL LINE of your output MUST be exactly:`,
    `ANSWER: <your answer>`,
  ].join('\n'), { budget: 0.5 }));
}

function gradeH3b(q, text) {
  // The LAST `ANSWER:` anywhere, even glued mid-line ("…4399ANSWER: 4, 500…"):
  // split on the marker rather than matching per line, which captured both copies.
  const segs = String(text).split('ANSWER:');
  const m = segs.length > 1 ? [null, segs.pop().split('\n')[0]] : null;
  if (!m) return { ok: false, why: 'no ANSWER marker' };
  const ans = m[1].trim(), low = ans.toLowerCase();
  const word = (w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(low);
  if (q.type === 'number') return { ok: (ans.match(/-?\d[\d,_]*(?:\.\d+)?/) || [''])[0].replace(/[,_]/g, '') === q.expect, ans };
  if (q.type === 'seq') { const ns = (ans.match(/-?\d+(?:\.\d+)?/g) || []); return { ok: ns.length === q.expect.length && ns.every((n, i) => Number(n) === Number(q.expect[i])), ans }; }
  if (q.type === 'first-word') return { ok: (low.match(/[a-z0-9]+/) || [''])[0] === q.expect, ans };
  if (q.type === 'all') return { ok: q.expect.every(word), ans };
  return { ok: low.includes(q.expect.toLowerCase()), ans };
}

function h3bReport() {
  const out = [], log = (s = '') => { out.push(s); console.log(s); };
  const qs = QS3().questions;
  const mean = (xs, k) => (xs.length ? xs.reduce((s, x) => s + x[k], 0) / xs.length : 0);
  const load = (dir, arms, reps) => {
    const rows = [];
    for (const q of qs) for (const arm of arms) for (let rep = 1; rep <= reps; rep++) {
      const f = join(RES, dir, `${q.id}-${arm}-r${rep}.json`);
      if (!existsSync(f)) continue;
      const r = readJson(f);
      rows.push({ q: q.id, arm, rep, ...gradeH3b(q, r.result), cost: r.peak ? r.cost / 2 : r.cost /* off-peak-normalized (PREREG-H3b) */, turns: r.turns, tin: r.tin, tout: r.tout, ms: r.duration_ms, err: r.is_error });
    }
    return rows;
  };
  log('# H3b — does the brain help on hard questions?');
  log(`\nGenerated ${new Date().toISOString()}. Hypotheses fixed beforehand in PREREG-H3b.md.`);
  const sp = existsSync(SPEND) ? readJson(SPEND) : spend;
  log(`\nSpend to date: $${sp.total.toFixed(2)} total — ` + Object.entries(sp.byPhase).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', '));

  const pilot = load('h3b-pilot', ['none'], 1);
  if (pilot.length) {
    log(`\n## Pilot (calibration only; excluded from every verdict)\n`);
    log(`NONE ×1: ${pilot.filter((x) => x.ok).length}/${pilot.length} correct, mean turns **${mean(pilot, 'turns').toFixed(1)}** (hard if ≥ 6), mean cost $${mean(pilot, 'cost').toFixed(4)}.`);
    log('\n| q | ok | turns | cost | answer |\n|---|---|---|---|---|');
    for (const r of pilot) log(`| ${r.q} | ${r.ok ? '✓' : '✗'} | ${r.turns} | $${r.cost.toFixed(4)} | ${String(r.ans || r.why).replace(/\|/g, '/').slice(0, 90)} |`);
  }
  const rows = load('h3b', H3B_ARMS, REPS_B);
  if (!rows.length) { writeFileSync(join(RES, 'REPORT-H3b.md'), out.join('\n') + '\n'); return; }
  const arm = (a) => rows.filter((r) => r.arm === a);
  log(`\n## Confirmatory run\n\n${rows.length} runs, graded mechanically.\n`);
  log('| arm | correct | mean cost | mean turns | mean input tok | mean output tok | mean time |\n|---|---|---|---|---|---|---|');
  for (const a of H3B_ARMS) {
    const xs = arm(a);
    log(`| ${a.toUpperCase()} | ${xs.filter((x) => x.ok).length}/${xs.length} | $${mean(xs, 'cost').toFixed(4)} | ${mean(xs, 'turns').toFixed(1)} | ` +
      `${Math.round(mean(xs, 'tin'))} | ${Math.round(mean(xs, 'tout'))} | ${(mean(xs, 'ms') / 1000).toFixed(1)}s |`);
  }
  // question-level bootstrap, 10k resamples, seeded
  const rnd = mulberry32(20260922);
  const perQ = (a, k) => qs.map((q) => mean(rows.filter((r) => r.arm === a && r.q === q.id), k));
  const boot = (a, k) => {
    const n = perQ('none', k), x = perQ(a, k), I = qs.length, s = [];
    for (let b = 0; b < 10000; b++) {
      let sn = 0, sx = 0;
      for (let i = 0; i < I; i++) { const j = Math.floor(rnd() * I); sn += n[j]; sx += x[j]; }
      s.push(sn ? 1 - sx / sn : 0);
    }
    s.sort((p, q) => p - q);
    const pt = 1 - x.reduce((p, v) => p + v, 0) / n.reduce((p, v) => p + v, 0);
    return { pt, lo: s[249], hi: s[9749], p0: s.filter((v) => v > 0).length / 1e4, p25: s.filter((v) => v >= 0.25).length / 1e4 };
  };
  const pc = (v) => `${(100 * v).toFixed(1)}%`;
  log('\n| comparison | metric | saving | 95% CI | P(>0) | P(≥25%) |\n|---|---|---|---|---|---|');
  const verdict = {};
  for (const a of ['brain', 'trust']) for (const k of ['cost', 'turns', 'tin']) {
    const b = boot(a, k);
    if (k === 'cost') verdict[a] = b;
    log(`| ${a.toUpperCase()} vs NONE | ${k} | ${pc(b.pt)} | [${pc(b.lo)}, ${pc(b.hi)}] | ${b.p0.toFixed(2)} | ${b.p25.toFixed(2)} |`);
  }
  const briefs = readJson(join(RES, 'h3b', 'briefs.json'));
  log('\n| q | NONE | BRAIN | TRUST | answer values present in brief (numbers; may be coincidental) |\n|---|---|---|---|---|');
  for (const q of qs) {
    const c = (a) => { const xs = rows.filter((r) => r.arm === a && r.q === q.id); return `${xs.filter((x) => x.ok).length}/${xs.length} $${mean(xs, 'cost').toFixed(3)} ${mean(xs, 'turns').toFixed(1)}t`; };
    const bl = briefs[q.id].lines.join(' ');
    const nums = new Set(bl.match(/\d+(?:\.\d+)?/g) || []);
    const has = `${[].concat(q.expect).filter((e) => nums.has(String(e))).length}/${[].concat(q.expect).length} values`;
    log(`| ${q.id} | ${c('none')} | ${c('brain')} | ${c('trust')} | ${has} |`);
  }
  const wrong = rows.filter((x) => !x.ok).map((x) => `${x.q}/${x.arm}/r${x.rep}: ${x.why || JSON.stringify(x.ans)}`);
  if (wrong.length) log(`\nWrong answers: ${wrong.join('; ')}`);
  const nOk = arm('none').filter((x) => x.ok).length;
  for (const [a, h] of [['brain', 'H3b-1'], ['trust', 'H3b-2']]) {
    const ok = arm(a).filter((x) => x.ok).length, v = verdict[a];
    const acc = ok >= nOk - 2, big = v.pt >= 0.25, robust = v.lo > 0;
    log(`\n**${h} (${a.toUpperCase()} vs NONE)**: accuracy ${ok} vs ${nOk} ${acc ? '✓' : '✗'}; saving ${pc(v.pt)} ${big ? '✓' : '✗'}; ` +
      `CI lower ${pc(v.lo)} ${robust ? '✓' : '✗'} → **${acc && big && robust ? 'PASS' : 'FAIL'}**.`);
  }
  const tOk = arm('trust').filter((x) => x.ok).length, bOk = arm('brain').filter((x) => x.ok).length;
  log(`\n**H3b-3 (trust safety)**: TRUST ${tOk} vs BRAIN ${bOk} correct → ${tOk >= bOk - 2 ? 'safe' : 'UNSAFE to deploy'}.`);
  writeFileSync(join(RES, 'REPORT-H3b.md'), out.join('\n') + '\n');
  console.log(`\n→ ${join(RES, 'REPORT-H3b.md')}`);
}

const phase = process.argv[2];
if (!phases[phase]) { console.error(`usage: run.mjs <${Object.keys(phases).join('|')}>`); process.exit(2); }
await phases[phase]();
