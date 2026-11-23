// Safe startup diagnostics. No configuration, environment or credential values.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './db.mjs';

const names = ['db.mjs','server.mjs','ledger-cli.mjs','planner-handoff.mjs','cloud-dispatch.mjs','result-evidence.mjs'];
const moduleHashes = Object.fromEntries(names.map(name => [name, createHash('sha256').update(readFileSync(fileURLToPath(new URL(name, import.meta.url)))).digest('hex')]));
const startup = {
  build_id: 'nova-ledger-supported-results-v1',
  process_id: process.pid, startup_id: randomUUID(),
  started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  loaded_code_schema_version: Store.USER_VERSION,
  startup_source_fingerprint: createHash('sha256').update(JSON.stringify(moduleHashes)).digest('hex'),
  startup_module_sha256: moduleHashes,
  capabilities: ['acceptance_generation','parent_owned_cloud_dispatch','supported_task_result_evidence','independent_acceptance_required'],
  fingerprint_limit: 'Startup disk fingerprints identify source observed during startup; they are not a security attestation.',
};
export function ledgerRuntimeInfo(store) {
  return { ...startup, database_schema_version: store.db.prepare('PRAGMA user_version').get().user_version };
}
