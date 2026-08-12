#!/usr/bin/env node
// fake-pid-hold.mjs — stub that holds the process open briefly for PID lease tests.
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(1500);
process.stdout.write(JSON.stringify({
  is_error: false,
  result: 'held open for pid test',
  total_cost_usd: 0,
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}));
