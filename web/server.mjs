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
import { Store } from '../src/db.mjs';
import { createBoardServer } from './board.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.PLAN_LEDGER_DB || join(__dirname, '..', 'data', 'plan-ledger.db');
const port = Number(process.env.PLAN_LEDGER_WEB_PORT) || 4319;

const store = new Store(dbPath);
process.on('SIGINT', () => { store.close(); process.exit(0); });
process.on('exit', () => store.close());
const html = await readFile(join(__dirname, 'index.html'), 'utf8');

createBoardServer({ store, html }).listen(port, '127.0.0.1', () => {
  console.log(`[plan-ledger board] http://localhost:${port}  (db: ${dbPath})`);
});
