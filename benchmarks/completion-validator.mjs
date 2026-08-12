#!/usr/bin/env node
// benchmarks/completion-validator.mjs
// Measures completion_payload_v2 validator latency (pure in-process validation only).

import { performance } from 'node:perf_hooks';
import { validateCompletionPayload } from '../src/completion-validator.mjs';

const argv = process.argv.slice(2);
const val = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
};

const ITERATIONS = Math.max(1000, Number(val('--iterations', 2000)) || 2000);

function percentile(sortedAsc, p) {
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
function round3(n) { return Math.round(n * 1000) / 1000; }

const validPayload = {
  contract_version: 2,
  outcome: 'success',
  artifacts: [{ path: 'docs/audits/evidence.json', kind: 'file' }],
  commands: [{ command: 'node test/execution-governance.mjs', exit_code: 0, output_redacted: true }],
  limitations: ['none'],
};
const invalidPayload = {
  contract_version: 2,
  outcome: 'success',
  artifacts: [],
  commands: [{ command: 'npm test', exit_code: 1, output: '' }],
  limitations: [],
};

const samples = [];
let validChecks = 0;
let invalidChecks = 0;
for (let i = 0; i < ITERATIONS; i++) {
  const claimedPass = i % 2 === 0;
  const payload = claimedPass ? validPayload : invalidPayload;
  const t0 = performance.now();
  const result = validateCompletionPayload(payload, { claimed_pass: true });
  const ms = performance.now() - t0;
  samples.push(ms);
  if (claimedPass) {
    if (!result.ok) throw new Error(`expected valid payload to pass on iteration ${i}`);
    validChecks++;
  } else {
    if (result.ok) throw new Error(`expected invalid payload to fail on iteration ${i}`);
    invalidChecks++;
  }
}

samples.sort((a, b) => a - b);
const p95 = percentile(samples, 95);
const out = {
  benchmark: 'completion_validator',
  iterations: ITERATIONS,
  valid_checks: validChecks,
  invalid_checks: invalidChecks,
  p50_ms: round3(percentile(samples, 50)),
  p95_ms: round3(p95),
  max_ms: round3(samples[samples.length - 1]),
  threshold_ms: 2,
  pass: p95 <= 2,
};

console.log(JSON.stringify(out, null, 2));
if (!out.pass) process.exit(1);
