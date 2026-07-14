// build-exe.mjs — build the standalone "Plan Ledger.exe" via Node SEA.
// Reproducible: bundles, generates the SEA blob, clones node.exe, strips its
// Authenticode signature, AUTO-DETECTS the sentinel fuse from the binary (its
// value is build-specific — do not hardcode the documented one), then injects.
//
//   node scripts/build-exe.mjs     (or: npm run build:exe)
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { inject } from 'postject';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = (...p) => join(root, ...p);
const exe = r('dist', 'Plan Ledger.exe');
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

mkdirSync(r('build'), { recursive: true });
mkdirSync(r('dist'), { recursive: true });

console.log('1/5 bundling web/app.mjs …');
await build({
  entryPoints: [r('web', 'app.mjs')],
  bundle: true, platform: 'node', format: 'cjs',
  loader: { '.html': 'text' },
  outfile: r('build', 'board-bundle.cjs'),
});

console.log('2/5 generating SEA blob …');
sh(process.execPath, ['--experimental-sea-config', r('sea-config.json')]);

console.log('3/5 cloning node.exe …');
// Windows locks a running .exe, so the clone/overwrite fails (EBUSY). Stop any
// running instance first — the board is stateless (all state in the DB).
if (process.platform === 'win32') { try { execFileSync('taskkill', ['/IM', 'Plan Ledger.exe', '/F'], { stdio: 'ignore' }); } catch {} }
// Windows can hold the .exe's file lock for a moment after the kill — retry the overwrite.
for (let i = 0; ; i++) { try { copyFileSync(process.execPath, exe); break; } catch (e) { if (i >= 15) throw e; await sleep(350); } }

console.log('4/5 stripping signature …');
sh(process.execPath, [r('scripts', 'strip-signature.mjs'), exe]);

// detect the build-specific sentinel fuse (NOT the documented constant)
const buf = readFileSync(exe);
const marker = Buffer.from('NODE_SEA_FUSE_');
const at = buf.indexOf(marker);
if (at < 0) throw new Error('no SEA fuse in this node.exe — SEA unsupported?');
let end = at + marker.length;
while (end < buf.length && /[0-9a-f]/.test(String.fromCharCode(buf[end]))) end++;
const fuse = buf.toString('latin1', at, end);
console.log(`    detected fuse: ${fuse}`);

console.log('5/5 injecting blob with postject …');
await inject(exe, 'NODE_SEA_BLOB', readFileSync(r('build', 'sea-prep.blob')), { sentinelFuse: fuse });

// 6/6 BOOT-TEST the real exe (not `node`) — catches SEA-only crashes (import.meta.url,
// .cmd quirks, native modules) before they ship. Fails the build if the exe won't serve.
console.log('6/6 boot-testing the exe …');
const port = 4399;
const child = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, PLAN_LEDGER_WEB_PORT: String(port), PLAN_LEDGER_NO_OPEN: '1' } });
let exited = null;
child.on('exit', (code) => { exited = code; });
let served = false;
for (let i = 0; i < 20 && exited === null && !served; i++) {
  await sleep(300);
  try { const res = await fetch(`http://localhost:${port}/api/plans`); if (res.ok) served = true; } catch {}
}
try { child.kill(); } catch {}
if (!served) {
  console.error(`\n❌ BOOT-TEST FAILED — the exe ${exited !== null ? `exited immediately (code ${exited})` : 'did not serve within timeout'}.`);
  console.error('   The build produced a binary that crashes on launch. Not shipping it.');
  process.exit(1);
}
console.log('   boot-test OK — exe launches and serves.');

console.log(`\n✅ built ${exe}`);
