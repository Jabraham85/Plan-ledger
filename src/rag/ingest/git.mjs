// ingest/git.mjs — the git ingester (§6 git matrix).
//
// Deterministic, offline-capable. A LOCAL path with a working tree is used in place
// (no clone, no network); a URL is shallow-cloned to an OS temp dir and removed in a
// finally. File selection is `git ls-files` at HEAD (tracked text only) — the full fs
// text/binary/size/encoding matrix then applies per file (reused from ingest/fs.mjs).
// Every locator bakes in the short HEAD sha so citations survive later commits:
//   <rel path>@<short-sha>#L<start>-L<end>   (§1 locator grammar).
//
// spawnSync is always called with an ARG ARRAY (never a shell string) — the URL is
// untrusted input and must never be interpolated into a shell.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDoc, kindForPath, EXCLUDE_FILE_RE } from './fs.mjs';

// A source string is a remote URL (clone) vs a local path (use in place) when it
// carries a transport scheme git understands. Everything else is a local path.
const URL_RE = /^(https?:\/\/|git:\/\/|ssh:\/\/|file:\/\/|git@[^:]+:)/i;
export const isGitUrl = (s) => URL_RE.test(String(s ?? ''));

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', timeout: 120000, ...opts });
}

/**
 * ingestGit(source, options, deps) ->
 *   { type:'git', root, sha, docs:[{doc_path,text,kind}], skipLog, makeLocator }
 *
 * Abort-source (throws) on: git missing, clone failure (auth/network/404),
 * non-git local path, empty repo (no HEAD). Per-file problems are skip-and-recorded.
 * deps.spawn is injectable for tests; defaults to the real git.
 */
export function ingestGit(source, options = {}, deps = {}) {
  const run = deps.spawn || git;
  const maxFileKb = options.max_file_kb ?? 512;

  // git must exist — clear abort rather than a cryptic ENOENT downstream.
  const ver = run(['--version']);
  if (ver.error || ver.status !== 0) throw new Error(`git not available: ${ver.error?.message || ver.stderr || 'unknown'}`);

  const isUrl = isGitUrl(source);
  let workDir = source;
  let tempDir = null;

  try {
    if (isUrl) {
      tempDir = mkdtempSync(join(tmpdir(), 'rag-git-'));
      // --single-branch --depth 1: minimal history; arg array => no shell interpolation.
      const clone = run(['clone', '--depth', '1', '--single-branch', String(source), tempDir]);
      if (clone.status !== 0) throw new Error(`git clone failed: ${(clone.stderr || clone.error?.message || '').trim()}`);
      workDir = tempDir;
    }

    // Structural validation: must be a work tree with at least one commit.
    const head = run(['-C', workDir, 'rev-parse', '--short', 'HEAD']);
    if (head.status !== 0) {
      const err = (head.stderr || '').trim();
      if (/not a git repository/i.test(err)) throw new Error(`not a git repository: ${workDir}`);
      // rev-parse HEAD fails on a repo with no commits.
      throw new Error(`repository has no commits (empty repo): ${workDir}`);
    }
    const sha = head.stdout.trim();

    // Tracked files at HEAD only (never untracked/ignored). -z would be safer for
    // exotic names, but ls-files newline output is deterministic for text repos.
    const ls = run(['-C', workDir, 'ls-files']);
    if (ls.status !== 0) throw new Error(`git ls-files failed: ${(ls.stderr || '').trim()}`);
    const tracked = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();

    const docs = [];
    const skipLog = [];
    for (const rel of tracked) {
      const base = rel.split('/').pop();
      if (EXCLUDE_FILE_RE.test(base)) { skipLog.push({ path: rel, reason: 'excluded' }); continue; }
      const r = readDoc(join(workDir, rel), maxFileKb);
      if (r.skip) { skipLog.push({ path: rel, reason: r.skip }); continue; }
      docs.push({ doc_path: rel, text: r.text, kind: kindForPath(rel) });
    }

    // options.include_log: last 200 commit subjects as one synthetic markdown doc,
    // so "what changed and why" is queryable alongside the tree (§6 git).
    if (options.include_log) {
      const log = run(['-C', workDir, 'log', '--format=%h %s', '-n', '200']);
      if (log.status === 0 && log.stdout.trim()) {
        docs.push({ doc_path: '_commits', kind: 'markdown', text: `# Recent commits\n\n${log.stdout.trim()}` });
      }
    }

    // Locator: <rel path>@<sha>#Lstart-Lend. _commits has no file line meaning but
    // stays consistent so rag_cite always resolves.
    const makeLocator = (doc, c) => `${doc.doc_path}@${sha}#L${c.startLine}-L${c.endLine}`;
    return { type: 'git', root: source, sha, docs, skipLog, makeLocator };
  } finally {
    if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  }
}
