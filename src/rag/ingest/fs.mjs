// ingest/fs.mjs — the file/folder ingester (§6 fs matrix).
//
// Deterministic, offline, read-only. Returns already-read documents for RagStore
// to chunk; per-item problems are skip-and-recorded, a missing root aborts.
// (Step 512 hardens the full edge matrix — NUL/oversized/symlink-dir/encoding —
// as exhaustive tests; the load-bearing rows are implemented here so file+folder
// ingest works end to end for step 511.)

import { readdirSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, extname, basename, sep } from 'node:path';

const DEFAULT_EXCLUDES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.venv', '__pycache__',
]);
const EXCLUDE_FILE_RE = /(\.min\.[^.]+$|\.lock$|^package-lock\.json$)/;

const CODE_EXT = new Set([
  '.mjs', '.cjs', '.js', '.ts', '.jsx', '.tsx', '.py', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.cs', '.go', '.rs', '.rb', '.php', '.java', '.kt', '.swift', '.sh', '.ps1', '.sql',
  '.json', '.yaml', '.yml', '.toml',
]);

export function kindForPath(p) {
  const e = extname(p).toLowerCase();
  if (e === '.md' || e === '.markdown') return 'markdown';
  if (e === '.html' || e === '.htm') return 'html';
  if (CODE_EXT.has(e)) return 'code';
  return 'text';
}

const toPosix = (p) => p.split(sep).join('/');

// Decode a file, deciding skip reasons per the fs matrix. Returns {text} or {skip}.
function readDoc(absPath, maxFileKb) {
  let st;
  try { st = statSync(absPath); } catch (e) { return { skip: `unreadable: ${e.code || e.message}` }; }
  if (st.size > maxFileKb * 1024) return { skip: 'too-large' };
  let buf;
  try { buf = readFileSync(absPath); } catch (e) { return { skip: `unreadable: ${e.code || e.message}` }; }
  // Binary sniff: any NUL byte in the first 8 KB.
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { skip: 'binary' };
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  // Undecodable: U+FFFD replacement ratio > 5%.
  const bad = (text.match(/�/g) || []).length;
  if (text.length > 0 && bad / text.length > 0.05) return { skip: 'undecodable' };
  if (text.trim() === '') return { skip: 'empty' };
  return { text };
}

/**
 * ingestFs(root, options) -> { type:'file'|'folder', docs:[{doc_path,text,kind}], skipLog, root }
 * Throws (abort-source) only when the root itself does not exist.
 */
export function ingestFs(root, options = {}) {
  const maxFileKb = options.max_file_kb ?? 512;
  const maxFiles = options.max_files ?? 5000;
  const userExclude = new Set(options.exclude || []);
  const excludes = new Set([...DEFAULT_EXCLUDES, ...userExclude]);

  let rootStat;
  try { rootStat = statSync(root); } catch { throw new Error(`root does not exist: ${root}`); }

  const docs = [];
  const skipLog = [];
  const seenReal = new Set();

  const addFile = (absPath, docPath) => {
    let real;
    try { real = realpathSync(absPath); } catch { real = absPath; }
    if (seenReal.has(real)) return; // realpath dedup (aliases/symlinked files)
    seenReal.add(real);
    if (EXCLUDE_FILE_RE.test(basename(absPath))) { skipLog.push({ path: docPath, reason: 'excluded' }); return; }
    const r = readDoc(absPath, maxFileKb);
    if (r.skip) { skipLog.push({ path: docPath, reason: r.skip }); return; }
    docs.push({ doc_path: docPath, text: r.text, kind: kindForPath(absPath) });
  };

  if (rootStat.isFile()) {
    addFile(root, basename(root));
    return { type: 'file', root, docs, skipLog };
  }

  // Folder: deterministic sorted BFS; symlinked DIRECTORIES are not followed
  // (cycle-proof by construction). Realpath dedup catches remaining file aliases.
  const stack = [root];
  let capHit = false;
  while (stack.length) {
    const dir = stack.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (e) { skipLog.push({ path: toPosix(relative(root, dir)) || '.', reason: `unreadable: ${e.code || e.message}` }); continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (excludes.has(ent.name)) continue;
      let isSymlink = false;
      try { isSymlink = lstatSync(abs).isSymbolicLink(); } catch {}
      if (ent.isDirectory()) {
        if (isSymlink) continue; // do not follow directory symlinks
        stack.push(abs);
      } else if (ent.isFile() || (isSymlink)) {
        if (docs.length >= maxFiles) { capHit = true; continue; }
        addFile(abs, toPosix(relative(root, abs)));
      }
    }
  }
  if (capHit) skipLog.push({ path: '', reason: 'file-cap-hit' });
  return { type: 'folder', root, docs, skipLog };
}
