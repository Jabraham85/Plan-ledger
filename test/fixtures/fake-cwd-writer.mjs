#!/usr/bin/env node
// fake-cwd-writer.mjs — test stub that writes a marker file into process.cwd().
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
writeFileSync(join(cwd, '.plan-ledger-worker-marker'), cwd, 'utf8');
process.stdout.write(JSON.stringify({
  is_error: false,
  result: 'wrote worker marker',
  total_cost_usd: 0,
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}));
