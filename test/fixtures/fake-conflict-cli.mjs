#!/usr/bin/env node
// fake-conflict-cli.mjs — writes a conflicting shared/conflict.txt in the worktree cwd.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const rel = 'shared/conflict.txt';
mkdirSync(join(cwd, 'shared'), { recursive: true });
writeFileSync(join(cwd, rel), 'worker-line\n', 'utf8');
process.stdout.write(JSON.stringify({
  is_error: false,
  result: [
    'conflict worker edit',
    'COMPLETION_JSON: {"contract_version":1,"verdict":"pass","summary":"conflict worker","artifacts":[{"path":"shared/conflict.txt","kind":"file"}],"commands":[{"command":"echo worker","exit_code":0}],"unresolved_gaps":[]}',
  ].join('\n'),
  total_cost_usd: 0,
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}));
