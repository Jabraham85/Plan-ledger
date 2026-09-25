// story.mjs — turn roleplay / story chat logs (gemma-harness conversation JSON:
// { id, title, created, updated, messages: [{ role, content }] }) into ONE clean,
// de-duplicated, canonical transcript for the brain. Zero AI: pure text handling.
//
//   cleaning   drop the harness system prompt, image-generation tool calls and their
//              results, "N images" requests, resume stubs, image file names
//   series     sessions fork and rewind: the same messages re-appear in later files,
//              and a rewound branch is abandoned. All sessions go into one message tree;
//              at each branch the path the story CONTINUED down (latest activity) is
//              kept, and every message is emitted once.
//   recaps     "HANDOFF BRIEF" messages (canon written for the next session) are kept,
//              marked kind 'recap', at their point in the story.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? '').join('\n') : String(c ?? '');

// → { text, kind: 'story'|'recap' } or null when nothing of the story is left
export function cleanMessage(role, content) {
  if (role === 'system' || role === 'tool') return null;
  let t = textOf(content);
  if (role === 'user') {
    if (/^\s*\[tool [a-z ]+\]/i.test(t)) return null; // tool results / errors from the harness
    if (/^\s*continue from the memory i selected/i.test(t)) return null;
    if (t.length < 80 && /^\s*\d+\s+(more\s+)?(separate\s+)?images?\b/i.test(t)) return null; // "8 images of this scene"
    t = t.replace(/[\s,;]*\b\d+\s+images?\s*$/i, ''); // "… 2 images" suffix (an image request)
    // [like this]: the user speaking to the AI, out of the story — never story canon
    t = t.replace(/\[[^\]\n]{1,600}\]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  }
  t = t.replace(/```tool[\s\S]*?```/g, '')                       // image / tool calls
    .replace(/```(?:json)?\s*\{[\s\S]*?"(?:tool|prompts?)"[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                         // markdown images
    .replace(/\b[\w-]+\.(?:png|jpe?g|webp)\b/gi, '')              // generated image file names
    .replace(/\n{3,}/g, '\n\n').trim();
  if (t.length < 2) return null;
  return { text: t, kind: /^\s*#{0,3}\s*HANDOFF BRIEF\b/i.test(t) ? 'recap' : 'story' };
}

// The image prompts in an assistant turn's tool calls. The cleaner drops them from the
// story text, but they are the most exact record of how the characters LOOK.
export function imagePrompts(content) {
  const out = [];
  for (const m of textOf(content).matchAll(/```tool\s*(\{[\s\S]*?\})\s*```/g)) {
    let call; try { call = JSON.parse(m[1]); } catch { continue; }
    for (const p of Array.isArray(call?.prompts) ? call.prompts : [call]) {
      const t = String(p?.prompt ?? '').trim();
      if (t.length > 40) out.push(t);
    }
  }
  return out;
}

export function loadConversation(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const messages = [], visuals = [];
  (j.messages || []).forEach((m, i) => {
    const c = cleanMessage(m.role, m.content);
    if (c) messages.push({ i, role: m.role, ...c });
    if (m.role === 'assistant') for (const prompt of imagePrompts(m.content)) visuals.push({ i, prompt });
  });
  return { file: basename(path), id: j.id ?? basename(path), title: j.title ?? '', created: Number(j.created) || 0,
    updated: Number(j.updated) || Number(j.created) || 0, messages, visuals,
    // a chat that already feeds a story brain as its own source (gemma-harness brain chat)
    brain: !!(j.settings && j.settings.brain) };
}

// The most recent image prompts across the conversations: from the most recently active
// one, newest last. They describe how the characters look NOW.
export function latestVisuals(convs, k = 6) {
  const withImages = convs.filter((c) => c.visuals?.length).sort((a, b) => a.updated - b.updated || a.created - b.created);
  const last = withImages[withImages.length - 1];
  return last ? last.visuals.slice(-k).map((v) => ({ ...v, file: last.file })) : [];
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const hashOf = (role, text) => createHash('sha1').update(`${role}\u0000${norm(text)}`).digest('hex');

// convs: loadConversation() results. → { items: [{ n, file, i, role, kind, text }], dropped: {messages, chars}, sessions }
export function assembleSeries(convs) {
  const order = [...convs].sort((a, b) => a.created - b.created || a.file.localeCompare(b.file));
  // message tree: a node is a message at a position in a conversation path
  const nodes = new Map(); // key → { key, parent, msg, file, latest, children: [] }
  const roots = [];
  for (const c of order) {
    let parent = null;
    for (const m of c.messages) {
      const key = createHash('sha1').update(`${parent ?? ''}\u0000${hashOf(m.role, m.text)}`).digest('hex');
      let node = nodes.get(key);
      if (!node) {
        node = { key, parent, msg: m, file: c.file, latest: c.updated, children: [] };
        nodes.set(key, node);
        if (parent) nodes.get(parent).children.push(node); else roots.push(node);
      }
      parent = key;
    }
    // every node on this conversation's path saw activity as late as c.updated
    for (let k = parent; k; k = nodes.get(k).parent) { const n = nodes.get(k); if (c.updated > n.latest) n.latest = c.updated; }
  }
  const subtreeChars = (n) => n.msg.text.length + n.children.reduce((t, x) => t + subtreeChars(x), 0);
  const subtreeCount = (n) => 1 + n.children.reduce((t, x) => t + subtreeCount(x), 0);
  const items = [], seen = new Set(), dropped = { messages: 0, chars: 0 }, sessions = [];
  // roots are separate session starts, in the order they began
  for (const root of roots) {
    const session = { file: root.file, from: items.length, s: sessions.length };
    for (let n = root; n; ) {
      const h = hashOf(n.msg.role, n.msg.text);
      if (!seen.has(h)) { // a resumed session repeats what an earlier one already said
        seen.add(h);
        items.push({ n: items.length + 1, s: sessions.length, file: n.file, i: n.msg.i, role: n.msg.role, kind: n.msg.kind, text: n.msg.text });
      }
      if (!n.children.length) break;
      // the branch the story continued down: the latest activity (ties: the first taken)
      const next = n.children.reduce((a, b) => (b.latest > a.latest ? b : a));
      for (const c of n.children) if (c !== next) { dropped.messages += subtreeCount(c); dropped.chars += subtreeChars(c); }
      n = next;
    }
    session.to = items.length;
    if (session.to > session.from) sessions.push(session);
  }
  return { items, dropped, sessions };
}

// Chunks of whole messages, each at most ~maxChars; a recap is always its own chunk
// (split on its own headings when it is long). Lines are "[#n] USER: …" / "[#n] STORY: …".
export function chunkTranscript(items, { maxChars = 12000 } = {}) {
  const line = (it) => `[#${it.n}] ${it.role === 'user' ? 'USER' : 'STORY'}: ${it.text}`;
  const chunks = [];
  let cur = null;
  const flush = () => { if (cur && cur.lines.length) chunks.push({ ...cur, text: cur.lines.join('\n\n') }); cur = null; };
  for (const it of items) {
    if (it.kind === 'recap') {
      flush();
      const parts = it.text.split(/\n(?=#{1,3} )/);
      let buf = '';
      for (const p of parts) {
        if (buf && buf.length + p.length > maxChars) { chunks.push({ kind: 'recap', s: it.s, from: it.n, to: it.n, file: it.file, text: `[#${it.n}] RECAP: ${buf}` }); buf = ''; }
        buf += (buf ? '\n' : '') + p;
      }
      if (buf) chunks.push({ kind: 'recap', s: it.s, from: it.n, to: it.n, file: it.file, text: `[#${it.n}] RECAP: ${buf}` });
      continue;
    }
    const l = line(it);
    if (cur && (cur.chars + l.length > maxChars || cur.s !== it.s)) flush();
    if (!cur) cur = { kind: 'story', s: it.s, from: it.n, to: it.n, file: it.file, lines: [], chars: 0 };
    cur.lines.push(l.length > maxChars ? l.slice(0, maxChars) : l); cur.chars += l.length; cur.to = it.n;
  }
  flush();
  return chunks.map(({ lines, chars, ...c }) => c);
}
