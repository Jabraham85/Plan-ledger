#!/usr/bin/env node
// fake-claude-findings.mjs — CLAUDE_BIN stub for the findings write-back e2e in
// test/runner-unit.mjs (plan #134). Like fake-claude-cli.mjs it mimics
// `claude -p ... --output-format json`, but it also (a) appends the prompt it
// received to $FAKE_PROMPT_LOG, so the test can prove what the NEXT agent was
// briefed with, and (b) ends with a FINDINGS line before the VERDICT line.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, prompt + '\n=====PROMPT-END=====\n');
const findings = [{ kind: 'fact', subject: 'fixture/zebra.cfg', slot: 'capacity',
  claim: 'the zebra cache holds 42 entries', evidence: 'fixture/zebra.cfg:3' }];
process.stdout.write(JSON.stringify({
  is_error: false,
  result: `did the step (stub agent)\nFINDINGS: ${JSON.stringify(findings)}\nVERDICT: pass — stub reports one finding`,
  total_cost_usd: 0.001,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}));
