// web/app.mjs — entry point for the packaged "Plan Ledger" .exe (Node SEA).
// Double-click → starts the board server and opens it in the default browser.
// If the board is already running, just opens the browser and exits.
//
// index.html is INLINED at bundle time (esbuild --loader:.html=text), so the
// exe is fully self-contained. DB defaults to the same file the MCP server uses.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../src/db.mjs';
import { createBoardServer } from './board.mjs';
import html from './index.html';

const port = Number(process.env.PLAN_LEDGER_WEB_PORT) || 4319;
const url = `http://localhost:${port}`;
const dbPath = process.env.PLAN_LEDGER_DB
  || join(homedir(), 'Documents', 'plan-ledger', 'data', 'plan-ledger.db');

// Open the default browser robustly: try several Windows methods in turn, fall
// back to printing the URL. `start` is a cmd builtin (no error event on bad
// quoting); rundll32 FileProtocolHandler is the most reliable, so try it first.
function openBrowser() {
  if (process.env.PLAN_LEDGER_NO_OPEN) { console.log('  (browser auto-open suppressed)'); return; }
  const methods = [
    ['rundll32', ['url.dll,FileProtocolHandler', url]],
    ['cmd', ['/c', 'start', '', url]],
    ['explorer', [url]],
  ];
  let i = 0;
  const tryNext = () => {
    if (i >= methods.length) { console.log(`  >> open this in your browser: ${url}`); return; }
    const [cmd, args] = methods[i++];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', tryNext);   // spawn failed (binary missing) → next method
      child.unref();
    } catch { tryNext(); }
  };
  console.log('  opening your browser…');
  tryNext();
}

function banner(extra) {
  console.log('========================================');
  console.log('  Plan Ledger — board');
  console.log(`  ${url}`);
  if (extra) console.log(`  ${extra}`);
  console.log('  (close this window to stop)');
  console.log('========================================');
}

const server = createBoardServer({ store: new Store(dbPath), html });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Board already running in another instance — just surface it.
    banner('already running — reopening browser');
    openBrowser();
    setTimeout(() => process.exit(0), 1500); // give the detached opener time to launch
  } else {
    console.error('Failed to start board:', err.message);
    setTimeout(() => process.exit(1), 3000);
  }
});

server.listen(port, '127.0.0.1', () => {
  banner(`db: ${dbPath}`);
  openBrowser();
});
