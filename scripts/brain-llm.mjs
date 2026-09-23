// brain-llm.mjs — a small, provider-level model client for the brain's own
// model work (re-evaluating suspect findings). Not a Claude Code spawn: the
// agent is a few-line system prompt + (optionally) three READ-ONLY tools
// rooted at one directory, so a call costs what the task costs.
//
//   const call = makeAgent({ root, model });   // root: null → no tools (pure judgment)
//   const r = await call(prompt);               // { is_error, result, cost, turns, tin, tout, ... }
//
// Provider: DeepSeek (OpenAI-compatible). Key: $DEEPSEEK_API_KEY, else the first
// DEEPSEEK_API_KEY= line in plan-ledger/.env, bench/findings-real/.env, or
// gemma-harness/.env. The key is read into memory only — never printed or logged.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOME = process.env.PLAN_LEDGER_HOME || join(homedir(), 'Documents', 'plan-ledger');

export function envValue(name) {
  if (process.env[name]) return process.env[name];
  for (const file of [join(HOME, '.env'), join(HOME, 'bench', 'findings-real', '.env'), join(homedir(), 'Documents', 'gemma-harness', '.env')]) {
    if (!existsSync(file)) continue;
    // [ \t]* — never \s*, which would run across a line break into the next line.
    const m = readFileSync(file, 'utf8').match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*)$`, 'm'));
    const v = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
    if (v) return v;
  }
  return '';
}

// $/1M tokens, off-peak (api-docs.deepseek.com pricing, 2026-09-22). Peak
// (Mon–Fri UTC 01:00–04:00 and 06:00–10:00) is double.
export const DS_RATES = { 'deepseek-v4-pro': { hit: 0.022, miss: 0.66, out: 1.98 }, 'deepseek-flash': { hit: 0.003, miss: 0.15, out: 0.6 } };
export function dsPeak(d = new Date()) {
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'List every file under a directory of the repository, recursively.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: 'directory relative to the repo root (default: the root)' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file with line numbers. Long files: use offset/limit (at most 400 lines per call).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: '1-based first line' }, limit: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents with a JavaScript regular expression. Returns up to 60 "path:line: text" matches.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'file or directory relative to the repo root (default: the root)' } }, required: ['pattern'] } } },
];

// Read-only tools confined to `root`; any path escaping it is refused.
export function makeTools(root) {
  const R = resolve(root);
  const inRoot = (p = '.') => {
    const abs = resolve(R, String(p || '.').replace(/^[/\\]+/, ''));
    const rel = relative(R, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path is outside the repository');
    return abs;
  };
  const relPath = (abs) => relative(R, abs).replace(/\\/g, '/') || '.';
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return [];
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
  return function runTool(name, args = {}) {
    if (name === 'list_files') return walk(inRoot(args.dir)).map(relPath).join('\n') || '(empty)';
    if (name === 'read_file') {
      const abs = inRoot(args.path);
      if (!existsSync(abs) || statSync(abs).isDirectory()) return `error: no such file: ${args.path}`;
      const lines = readFileSync(abs, 'utf8').split('\n');
      const from = Math.max(1, Number(args.offset) || 1), n = Math.min(400, Math.max(1, Number(args.limit) || 400));
      const slice = lines.slice(from - 1, from - 1 + n);
      return `[${relPath(abs)} — lines ${from}-${from + slice.length - 1} of ${lines.length}]\n` + slice.map((l, i) => `${from + i}\t${l}`).join('\n');
    }
    if (name === 'grep') {
      let re;
      try { re = new RegExp(String(args.pattern)); } catch { re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
      const target = inRoot(args.path);
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
  };
}

const SYSTEM_TOOLS = 'You are a careful software engineer checking recorded facts against a READ-ONLY repository. ' +
  'Inspect it with the tools list_files, read_file and grep — never guess what the code says; check it. ' +
  'Paths are relative to the repository root. Give your final answer in exactly the format the user asks for.';
const SYSTEM_PLAIN = 'You maintain a knowledge base of recorded facts. Judge carefully and literally from what you are given; ' +
  'do not invent details. Give your final answer in exactly the format the user asks for.';

// Returns async (prompt) => result. root = null → no tools (pure judgment).
export function makeAgent({ root = null, model = 'deepseek-v4-pro', maxTurns = 20, budget = 0.25, key = envValue('DEEPSEEK_API_KEY') } = {}) {
  const runTool = root ? makeTools(root) : null;
  const rate = DS_RATES[model] || DS_RATES['deepseek-v4-pro'];
  return async function call(prompt) {
    if (!key) return { is_error: true, subtype: 'no_api_key', result: '', cost: 0, turns: 0, tin: 0, tout: 0 };
    const messages = [{ role: 'system', content: root ? SYSTEM_TOOLS : SYSTEM_PLAIN }, { role: 'user', content: prompt }];
    let cost = 0, turns = 0, tin = 0, tout = 0, toolCalls = 0, last = '';
    const t0 = Date.now(), peak = dsPeak();
    const finish = (is_error, subtype, detail = '') => ({ is_error, subtype, result: last, cost, turns, tin, tout,
      tool_calls: toolCalls, peak, duration_ms: Date.now() - t0, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
    // Out of turns (or budget) mid-investigation: one last call WITHOUT tools asking
    // for the answer now — otherwise everything the agent read is lost (a real
    // learner hit 30 turns and returned nothing, real-project study).
    let wrapping = false;
    for (;;) {
      if (!wrapping && runTool && (turns >= maxTurns || cost > budget)) {
        wrapping = true;
        messages.push({ role: 'user', content: 'You are out of tool calls. Stop investigating and give your final answer NOW, ' +
          'in exactly the required format, from what you have already verified.' });
      } else if (turns >= maxTurns + (wrapping ? 1 : 0)) return finish(true, 'error_max_turns');
      turns++;
      const body = { model, messages, temperature: 0, max_tokens: 4096, thinking: { type: 'disabled' },
        ...(runTool && !wrapping ? { tools: TOOLS, tool_choice: 'auto' } : {}) };
      let data = null;
      for (let attempt = 1; attempt <= 3; attempt++) { // transient 429/5xx/network only
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
          return finish(true, 'network', e?.message || e);
        }
      }
      const u = data.usage || {};
      const h = u.prompt_cache_hit_tokens ?? 0, m = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens || 0) - h), o = u.completion_tokens || 0;
      cost += (peak ? 2 : 1) * (h * rate.hit + m * rate.miss + o * rate.out) / 1e6;
      tin += u.prompt_tokens || 0; tout += o;
      const msg = data.choices?.[0]?.message || {};
      if (msg.content) last = msg.content;
      const calls = msg.tool_calls || [];
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length || !runTool) return finish(false, wrapping ? 'wrapped_up' : 'success');
      if (wrapping) return finish(true, 'error_max_turns'); // asked to stop, still calling tools
      for (const tc of calls) {
        toolCalls++;
        let out;
        try { out = runTool(tc.function?.name, JSON.parse(tc.function?.arguments || '{}')); } catch (e) { out = `error: ${e.message}`; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 20_000) });
      }
    }
  };
}
