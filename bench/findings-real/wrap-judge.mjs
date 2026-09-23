#!/usr/bin/env node
// wrap-judge.mjs — turn an external (in-session, blind) judge's reply file
// judge/<topic>.reply.json into the harness record judge/<topic>.json, after
// validating it covers every finding of that topic exactly once. Never edits
// the judge's content; a reply that fails validation is reported, not repaired.
//   node bench/findings-real/wrap-judge.mjs [results-dir]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = process.argv[2] || join(HERE, 'results-deepseek');
const agents = JSON.parse(readFileSync(join(RES, 'a', 'findings.json'), 'utf8'));
for (const t of ['t1', 't2', 't3', 't4', 't5', 't6']) {
  const reply = join(RES, 'judge', `${t}.reply.json`);
  if (!existsSync(reply)) { console.log(`${t}: no reply yet`); continue; }
  const text = readFileSync(reply, 'utf8');
  let j;
  try { j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) { console.log(`${t}: INVALID JSON — ${e.message}`); continue; }
  const ids = agents.filter((a) => a.topic === t).flatMap((a) => a.findings.map((f) => f.id));
  const labelled = ids.filter((id) => j.truth?.[id]?.label);
  const inClusters = (j.clusters || []).flat();
  const dupes = inClusters.filter((id, i) => inClusters.indexOf(id) !== i);
  const missing = ids.filter((id) => !inClusters.includes(id));
  const extra = inClusters.filter((id) => !ids.includes(id));
  const badLabels = labelled.filter((id) => !['true', 'false', 'unverifiable'].includes(j.truth[id].label));
  const okAll = labelled.length === ids.length && !dupes.length && !missing.length && !extra.length && !badLabels.length;
  console.log(`${t}: ${labelled.length}/${ids.length} labelled, ${(j.clusters || []).length} clusters` +
    `${missing.length ? `, MISSING ${missing.join(',')}` : ''}${dupes.length ? `, DUPES ${dupes.join(',')}` : ''}` +
    `${extra.length ? `, UNKNOWN ${extra.join(',')}` : ''}${badLabels.length ? `, BAD LABELS ${badLabels.join(',')}` : ''} → ${okAll ? 'OK' : 'NEEDS ATTENTION'}`);
  writeFileSync(join(RES, 'judge', `${t}.json`), JSON.stringify({
    phase: 'judge', tag: t, model: 'claude-opus (blind in-session subagent, external judge)', is_error: false,
    subtype: okAll ? 'success' : 'incomplete', result: text, cost: 0, turns: 0, tin: 0, tout: 0,
  }, null, 2));
}
