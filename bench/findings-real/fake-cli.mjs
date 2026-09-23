#!/usr/bin/env node
// fake-cli.mjs — stand-in for `claude -p ... --output-format json`, used ONLY to
// dry-run the harness plumbing end to end (CLAUDE_BIN=... BENCH_RESULTS=<tmp>).
// It produces the right SHAPE of output for each phase; its content is
// meaningless and must never be reported as data.
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
let result;
if (prompt.includes('strict, careful judge')) {
  const body = prompt.slice(prompt.indexOf('Findings:') + 9, prompt.indexOf('Respond with ONLY'));
  const fs = JSON.parse(body);
  const groups = new Map();
  for (const f of fs) { const k = String(f.claim).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); groups.set(k, [...(groups.get(k) || []), f.id]); }
  const truth = Object.fromEntries(fs.map((f, i) => [f.id, { label: i % 7 === 3 ? 'false' : 'true', why: 'fake' }]));
  result = JSON.stringify({ truth, clusters: [...groups.values()] });
} else if (prompt.includes('Investigate how it')) {
  const topic = (prompt.match(/Investigate how it ([^.—]+)/) || [])[1] || 'x';
  const subject = `fake/${topic.split(' ').slice(0, 3).join('-')}`;
  const findings = [
    { kind: 'fact', subject, claim: `the ${topic.split(' ')[0]} path uses a default of 30`, evidence: 'fake.mjs:1' },
    { kind: 'fact', subject, claim: `the ${topic.split(' ')[0]} path is checked before running`, evidence: 'fake.mjs:2' },
    { kind: 'lesson', subject, claim: `never skip the ${topic.split(' ')[1] || 'y'} step`, evidence: 'fake.mjs:3' },
  ];
  result = `looked around\nFINDINGS: ${JSON.stringify(findings)}\nVERDICT: pass — fake investigation`;
} else if (prompt.includes('Question:')) {
  result = `thinking\nANSWER: ${prompt.includes('What project already knows') || prompt.includes('already knows') ? '30' : '8'}`;
} else {
  result = 'ANSWER: plan-ledger';
}
process.stdout.write(JSON.stringify({
  is_error: false, subtype: 'success', result, total_cost_usd: 0.0001, num_turns: 2, duration_ms: 5,
  usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}));
