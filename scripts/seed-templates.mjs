// seed-templates.mjs — install a few default plan templates (idempotent).
// Usage: node scripts/seed-templates.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.mjs';

const dbPath = process.env.PLAN_LEDGER_DB || join(homedir(), 'Documents', 'plan-ledger', 'data', 'plan-ledger.db');
const s = new Store(dbPath);

const TEMPLATES = [
  { name: 'Code feature', description: 'Standard flow for shipping a code feature.', keywords: ['feature', 'code'], steps: [
    { title: 'Design the approach', context: 'Sketch the design: data shapes, the key functions/modules, and how it fits the existing code. Note trade-offs.', acceptance_criteria: 'A short written approach the user agrees with.' },
    { title: 'Implement', context: 'Write the code to the design. Match surrounding conventions. Keep the change focused.', tools: ['editor'], acceptance_criteria: 'Code compiles/builds with no errors.' },
    { title: 'Add tests', context: 'Add unit/integration tests covering the new behavior and edge cases.', acceptance_criteria: 'Tests exist and pass.' },
    { title: 'Verify in the app', context: 'Run the app and confirm the feature works end to end; capture proof (output/screenshot).', acceptance_criteria: 'Observed working in the real app.' },
  ]},
  { name: 'Bug fix', description: 'Reproduce → diagnose → fix → guard.', keywords: ['bug', 'fix'], steps: [
    { title: 'Reproduce', context: 'Find the smallest reliable repro. Record exact steps and the observed vs expected behavior.', acceptance_criteria: 'A deterministic repro.' },
    { title: 'Diagnose root cause', context: 'Trace to the actual cause (not the symptom). Read the relevant code path.', acceptance_criteria: 'Root cause identified and explained.' },
    { title: 'Fix', context: 'Apply the minimal correct fix at the root cause.', tools: ['editor'], acceptance_criteria: 'Repro no longer triggers the bug.' },
    { title: 'Add a regression test', context: 'Add a test that would have caught this bug.', acceptance_criteria: 'Test fails without the fix, passes with it.' },
  ]},
  { name: 'Unreal feature', description: 'Common Unreal gameplay-feature flow.', keywords: ['unreal', 'gameplay'], steps: [
    { title: 'Create data/asset', context: 'Create the DataAsset/DataTable/Blueprint asset the feature needs.', tools: ['unreal-mcp'], acceptance_criteria: 'Asset exists at the expected path.' },
    { title: 'Implement logic', context: 'Implement the gameplay logic (C++/Blueprint).', tools: ['unreal-mcp'], acceptance_criteria: 'Logic compiles.' },
    { title: 'Bind to actor/UI', context: 'Wire the logic into the relevant actor/component/UMG widget.', tools: ['unreal-mcp'], acceptance_criteria: 'Binding in place.' },
    { title: 'Test in PIE', context: 'Play-In-Editor and confirm the feature behaves as intended.', acceptance_criteria: 'Works in PIE.' },
  ]},
];

let added = 0, skipped = 0;
for (const t of TEMPLATES) {
  const exists = s.listTemplates().some((x) => x.name === t.name);
  if (exists) { skipped++; continue; }
  s.createTemplate(t);
  added++;
}
console.log(`templates: ${added} added, ${skipped} already present → ${s.listTemplates().map((t) => `${t.name}(${t.steps})`).join(', ')}`);
s.close();
