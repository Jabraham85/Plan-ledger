// brain-llm.mjs — the brain's model client, against a mocked API (no network, no spend).
// Run: node test/brain-llm.mjs
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAgent, makeTools } from '../scripts/brain-llm.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };
const root = join(tmpdir(), `pl-brainllm-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'src', 'a.js'), 'const x = 48;\n');

// ---- tools are confined to the root ----------------------------------------------------
const tool = makeTools(root);
check('read_file returns numbered lines', tool('read_file', { path: 'src/a.js' }).includes('1\tconst x = 48;'));
check('grep finds matches with path:line', tool('grep', { pattern: 'x = 48' }) === 'src/a.js:1: const x = 48;');
check('paths escaping the root are refused', (() => { try { tool('read_file', { path: '../../etc/passwd' }); return false; } catch { return true; } })());

// ---- the loop, against a scripted fake API --------------------------------------------
const reqs = [];
function mockApi(script) {
  let i = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    reqs.push(body);
    const msg = script(body, i++);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) };
  };
}
const toolCall = (n) => ({ content: '', tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }] });

// an agent that never stops exploring: after maxTurns it must be asked to wrap up, WITHOUT tools
reqs.length = 0;
mockApi((body, i) => (body.tools ? toolCall(i) : { content: 'FINDINGS: [{"claim":"x is 48"}]\nVERDICT: pass — done' }));
let r = await makeAgent({ root, key: 'test', maxTurns: 3 })('investigate');
check('out of turns → one wrap-up call without tools, answer kept', !r.is_error && r.subtype === 'wrapped_up' && r.result.includes('FINDINGS') && r.turns === 4);
check('the wrap-up request carries no tools and says so', !reqs.at(-1).tools && reqs.at(-1).messages.at(-1).content.includes('out of tool calls'));
check('tool results were fed back each turn', reqs[1].messages.some((m) => m.role === 'tool' && m.content.includes('const x = 48')));

// budget exhaustion also wraps up instead of losing the work
reqs.length = 0;
mockApi((body, i) => (body.tools ? toolCall(i) : { content: 'ANSWER: 48' }));
r = await makeAgent({ root, key: 'test', maxTurns: 30, budget: 0 })('investigate');
check('over budget → wrap-up answer, not an error', !r.is_error && r.result === 'ANSWER: 48');

// a model that keeps calling tools even after being told to stop → error, bounded
reqs.length = 0;
mockApi((_b, i) => toolCall(i));
r = await makeAgent({ root, key: 'test', maxTurns: 2 })('investigate');
check('ignores the wrap-up → error_max_turns, bounded to maxTurns + 1 calls', r.is_error && r.subtype === 'error_max_turns' && reqs.length === 3);

// a normal answer is untouched; no-tools agents never send tools
reqs.length = 0;
mockApi(() => ({ content: 'RESOLVE: {"verdict":"confirmed"}' }));
r = await makeAgent({ root: null, key: 'test' })('judge this');
check('no-tools agent: one call, no tools field, success', !r.is_error && r.subtype === 'success' && reqs.length === 1 && !reqs[0].tools);
r = await makeAgent({ root, key: '' })('x');
check('no API key → an error result, no call', r.is_error && r.subtype === 'no_api_key');

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} brain-llm checks passed.`);
