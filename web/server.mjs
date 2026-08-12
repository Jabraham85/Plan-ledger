#!/usr/bin/env node
// web/server.mjs — standalone visual board for plan-ledger (option B1), CLI form.
// Reads index.html from disk and serves it via the shared board factory.
// Reads the SAME plan-ledger.db the MCP server writes (WAL → safe concurrent reads).
//
//   node web/server.mjs            → http://localhost:4319
//   PLAN_LEDGER_WEB_PORT=5000 ...  → custom port
//   PLAN_LEDGER_DB=... node ...    → custom db

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store, defaultDbPath } from '../src/db.mjs';
import { createBoardServer } from './board.mjs';
import { reapLoop } from '../src/supervisor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = defaultDbPath();
const port = Number(process.env.PLAN_LEDGER_WEB_PORT) || 4319;

const store = new Store(dbPath);
// Bounded reaper: any lease left orphaned by a runner/agent crash is closed
// as `cancelled` within one interval so a dead executor cannot silently
// wedge a plan's completion invariants. Env overrides keep it configurable
// per deployment; the defaults match the 60-120s reliability contract.
const reapInterval = Math.max(5_000, Number(process.env.PLAN_LEDGER_REAP_INTERVAL_MS) || 60_000);
const reapStale = Math.max(5_000, Number(process.env.PLAN_LEDGER_REAP_STALE_MS) || 120_000);
const reaper = reapLoop(store, {
  interval_ms: reapInterval,
  stale_after_ms: reapStale,
  logger: (msg) => console.log(`[plan-ledger board] ${msg}`),
});
process.on('SIGINT', () => { reaper.stop(); store.close(); process.exit(0); });
process.on('exit', () => { reaper.stop(); store.close(); });
const html = await readFile(join(__dirname, 'index.html'), 'utf8');

createBoardServer({ store, html, dbPath }).listen(port, '127.0.0.1', () => {
  console.log(`[plan-ledger board] http://localhost:${port}  (db: ${dbPath})`);
  console.log(`[plan-ledger board] reap loop: every ${reaper.interval_ms}ms, stale=${reaper.stale_after_ms}ms`);
});
