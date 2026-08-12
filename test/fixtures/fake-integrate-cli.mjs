#!/usr/bin/env node
// fake-integrate-cli.mjs — inject stub that writes an owned artifact and claims pass.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const rel = 'out/proof.txt';
mkdirSync(join(cwd, 'out'), { recursive: true });
writeFileSync(join(cwd, rel), 'proof-content', 'utf8');
process.stdout.write(JSON.stringify({
  is_error: false,
  result: [
    'integrated proof written',
    'COMPLETION_JSON: {"contract_version":1,"verdict":"pass","summary":"proof written","outputs":["proof"],"artifacts":[{"path":"out/proof.txt","kind":"file"}],"commands":[{"command":"echo proof","exit_code":0}],"unresolved_gaps":[]}',
  ].join('\n'),
  total_cost_usd: 0.001,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}));
