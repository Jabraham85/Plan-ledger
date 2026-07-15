#!/usr/bin/env node
// fake-claude-cli.mjs — stub for CLAUDE_BIN in test/runner-unit.mjs's stubbed
// end-to-end proof. Mimics `claude -p ... --output-format json`'s stdout shape
// (see scripts/runner.mjs spawnClaude) but ALWAYS claims VERDICT: pass,
// regardless of the prompt it was given — the point is to prove the runner's
// VERIFY gate catches a claimed pass that doesn't hold up, not to simulate a
// real agent. Reached via runner.mjs's resolveClaude() testability hook:
// CLAUDE_BIN pointing at a .mjs file is run as `node <this file> <args...>`,
// so `args` below is whatever the runner passed after '-p' etc. — unused here,
// but read defensively in case a future test wants to branch on it.
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  is_error: false,
  result: 'did the step (stub agent)\nVERDICT: pass — stub always claims pass',
  total_cost_usd: 0.0123,
  num_turns: 2,
  usage: { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}));
