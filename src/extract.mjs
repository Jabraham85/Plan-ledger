// extract.mjs — native, zero-dependency code extractor for plan-ledger.
// Produces the SAME node-link schema that Store.importGraph consumes, so a
// repo can be turned into a code graph with NO external tool (graphify stays an
// optional richer producer). Regex-lite, deterministic — covers Python + JS/TS.
//
// Emits: file nodes, class/function/method nodes (contains edges, EXTRACTED),
// import edges file→file (EXTRACTED), inherits edges class→base (EXTRACTED),
// and call edges def→def (INFERRED).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'data', 'webview',
  'EBWebView', '__pycache__', '.venv', 'venv', 'coverage', '.next', 'out', 'vendor']);
const LANG = { '.py': 'py', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'ts', '.tsx': 'ts' };
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class',
  'super', 'print', 'len', 'range', 'str', 'int', 'list', 'dict', 'set', 'tuple', 'await', 'and', 'or', 'not', 'in']);

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p); }
      else if (LANG[extname(e.name)]) out.push(p);
    }
  };
  if (statSync(root).isDirectory()) walk(root); else out.push(root);
  return out;
}

const rel = (root, f) => relative(root, f).split('\\').join('/');

// --- per-file parse: defs (with start line + indent) + raw imports ----------
function parseFile(text, lang) {
  const lines = text.split(/\r?\n/);
  const defs = []; // { name, label, line, indent, isClass, bases[] }
  const imports = []; // raw module strings

  lines.forEach((raw, i) => {
    const ln = i + 1;
    const indent = raw.length - raw.trimStart().length;
    if (lang === 'py') {
      let m;
      if ((m = raw.match(/^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?/)))
        defs.push({ name: m[1], label: m[1], line: ln, indent, isClass: true, bases: (m[2] || '').split(',').map((s) => s.trim().split('[')[0]).filter(Boolean) });
      else if ((m = raw.match(/^\s*(?:async\s+)?def\s+(\w+)/)))
        defs.push({ name: m[1], label: indent > 0 ? `.${m[1]}()` : m[1], line: ln, indent, isClass: false, bases: [] });
      else if ((m = raw.match(/^\s*from\s+([\w.]+)\s+import\b/))) imports.push(m[1]);
      else if ((m = raw.match(/^\s*import\s+([\w.]+)/))) imports.push(m[1]);
    } else { // js / ts
      let m;
      if ((m = raw.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/)))
        defs.push({ name: m[1], label: m[1], line: ln, indent, isClass: true, bases: m[2] ? [m[2]] : [] });
      else if ((m = raw.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/)))
        defs.push({ name: m[1], label: m[1], line: ln, indent, isClass: false, bases: [] });
      else if ((m = raw.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w]+)\s*=>/)))
        defs.push({ name: m[1], label: m[1], line: ln, indent, isClass: false, bases: [] });
      else if (indent >= 2 && (m = raw.match(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/)) && !KEYWORDS.has(m[1]))
        defs.push({ name: m[1], label: `.${m[1]}()`, line: ln, indent, isClass: false, bases: [] });
      const im = raw.match(/(?:from|require\()\s*['"]([^'"]+)['"]/);
      if (im) imports.push(im[1]);
    }
  });
  return { lines, defs, imports };
}

// resolve an import string to a file relpath in the repo, or null
function resolveImport(raw, fromRel, lang, fileSet) {
  const cands = [];
  if (lang === 'py') {
    const base = raw.replace(/^\.+/, '').split('.').join('/');
    cands.push(`${base}.py`, `${base}/__init__.py`);
    // also relative to the importing file's dir
    const dir = fromRel.split('/').slice(0, -1).join('/');
    if (dir) cands.push(`${dir}/${base}.py`, `${dir}/${base}/__init__.py`);
  } else {
    if (!raw.startsWith('.')) return null; // skip bare npm packages
    const dir = fromRel.split('/').slice(0, -1);
    const parts = raw.split('/');
    const stack = [...dir];
    for (const p of parts) { if (p === '..') stack.pop(); else if (p !== '.') stack.push(p); }
    const b = stack.join('/');
    for (const ext of ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']) cands.push(b + ext);
    for (const ext of ['.js', '.mjs', '.ts']) cands.push(`${b}/index${ext}`);
  }
  return cands.find((c) => fileSet.has(c)) || null;
}

export function extractRepo(root) {
  const files = listFiles(root);
  const nodes = [], links = [];
  const seen = new Set();
  const addNode = (n) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };
  const fileSet = new Set(files.map((f) => rel(root, f)));
  const parsed = []; // { relpath, lang, lines, defs, imports }
  const defById = new Map(); // defId -> node
  const defsByName = new Map(); // name -> [defId]

  // pass 1: nodes (files + defs)
  for (const f of files) {
    const relpath = rel(root, f);
    const lang = LANG[extname(f)];
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.length > 600_000) continue; // skip giant/minified files
    const { lines, defs, imports } = parseFile(text, lang);
    addNode({ id: relpath, label: basename(relpath), file_type: 'code', source_file: relpath, source_location: 'L1' });
    for (const d of defs) {
      d.id = `${relpath}::${d.name}@${d.line}`;
      addNode({ id: d.id, label: d.label, file_type: 'code', source_file: relpath, source_location: `L${d.line}`, kind: d.isClass ? 'class' : 'function' });
      links.push({ source: relpath, target: d.id, relation: 'contains', confidence: 'EXTRACTED' });
      defById.set(d.id, d);
      if (!defsByName.has(d.name)) defsByName.set(d.name, []);
      defsByName.get(d.name).push(d.id);
    }
    parsed.push({ relpath, lang, lines, defs, imports });
  }

  // pass 2: edges (imports, inherits, calls)
  for (const pf of parsed) {
    // imports file→file
    for (const imp of pf.imports) {
      const tgt = resolveImport(imp, pf.relpath, pf.lang, fileSet);
      if (tgt && tgt !== pf.relpath) links.push({ source: pf.relpath, target: tgt, relation: 'imports_from', confidence: 'EXTRACTED' });
    }
    // inherits class→base (resolve base by name)
    for (const d of pf.defs) {
      if (!d.isClass) continue;
      for (const base of d.bases) {
        const bn = base.split('.').pop();
        const cand = (defsByName.get(bn) || []).find((id) => defById.get(id)?.isClass);
        if (cand && cand !== d.id) links.push({ source: d.id, target: cand, relation: 'inherits', confidence: 'EXTRACTED' });
      }
    }
    // calls def→def (INFERRED): assign each line to its owning def, scan for known names
    const ordered = [...pf.defs].sort((a, b) => a.line - b.line);
    const ownerAt = (lineNo) => { let o = null; for (const d of ordered) { if (d.line <= lineNo) o = d; else break; } return o; };
    const made = new Set();
    pf.lines.forEach((line, i) => {
      const owner = ownerAt(i + 1);
      if (!owner) return;
      let m; const re = /(\w+)\s*\(/g;
      while ((m = re.exec(line))) {
        const name = m[1];
        if (KEYWORDS.has(name) || name === owner.name) continue;
        const targets = defsByName.get(name);
        if (!targets) continue;
        const tgt = targets[0];
        const key = owner.id + '>' + tgt;
        if (tgt !== owner.id && !made.has(key)) { made.add(key); links.push({ source: owner.id, target: tgt, relation: 'calls', confidence: 'INFERRED' }); }
      }
    });
  }

  return { nodes, links };
}
