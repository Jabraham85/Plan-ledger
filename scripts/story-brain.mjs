#!/usr/bin/env node
// story-brain.mjs — the story brain as a JSON command-line service, for chat front-ends
// (gemma-harness's "Brain" chats). Every command prints ONE JSON object on stdout;
// progress goes to stderr; failures print {"error": "..."} and exit 1.
//
//   stories   [--category Storytelling]                  the stories filed under the category
//   create    --name NAME [--category Storytelling]      a new story (or the existing one)
//   brief     --story ID --query TEXT [--limit 20]       what the story knows that matters now:
//                                                        the core cast + facts relevant to TEXT,
//                                                        suspect/conflicting ones flagged; + motifs
//   ingest    --story ID --files A.json[,B.json] [--source KEY] [--max-usd 1] [--model M]
//                                                        read new chat messages into the brain
//                                                        (incremental, rewind-aware; see ingest-story)
//   facts     --story ID                                everything it holds + recent changes (viewer)
//   canon     --story ID [--key K --set TEXT]            the user's own words about the story, atop every chat
//   core      --story ID --derive [--name N] [--force]   derive who each character is at heart (and to whom)
//   tells     --story ID --derive [--name N] [--force]   derive how each character's nature shows in a picture
//                                                        from her own facts (or --name N --set TEXT to pin)
//   motifs    --story ID [--set FILE.json]               the story's voice ledger (retired themes,
//                                                        welcome traits) — shared by all its chats
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store, defaultDbPath } from '../src/db.mjs';
import { loadConversation } from '../src/story.mjs';
import { pickBrief } from '../src/brief.mjs';
import { ingestStory, storyPlan, updateLooks, updateScene, deriveTells, deriveCore } from './ingest-story.mjs';
import { makeAgent } from './brain-llm.mjs';

const CORE_SLOTS = /^(name|true_name|species|age|relationship_status)$/;
const APPEARANCE_SLOTS = /^(hair|eyes|height|build|current_body)$/;

export function storyInfo(store, id) {
  const p = store.getProject(Number(id));
  const plan = store.db.prepare('SELECT id FROM plans WHERE project_id = ? AND title = ?').get(p.id, `Story: ${p.name}`);
  const n = (st) => plan ? store.db.prepare(`SELECT COUNT(*) n FROM findings WHERE plan_id = ? AND status IN (${st})`).get(plan.id).n : 0;
  const cks = store.db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`story_ingest:${p.id}:%`)
    .map((r) => { try { return JSON.parse(r.value); } catch { return null; } }).filter(Boolean);
  return { id: p.id, name: p.name, path: store.projectPath(p.id), plan_id: plan?.id ?? null,
    facts: n("'active','suspect'"), suspect: n("'suspect'"),
    updated: cks.map((c) => c.updated).sort().pop() || null };
}

export function listStories(store, category = 'Storytelling') {
  const cat = store.db.prepare('SELECT id FROM projects WHERE name = ? AND parent_id IS NULL').get(category);
  return cat ? store.childProjects(cat.id).map((id) => storyInfo(store, id)) : [];
}

export function getMotifs(store, id) {
  const row = store.db.prepare('SELECT value FROM settings WHERE key = ?').get(`story_motifs:${Number(id)}`);
  try { return row ? JSON.parse(row.value) : []; } catch { return []; }
}

export function setMotifs(store, id, motifs) {
  if (!Array.isArray(motifs)) throw new Error('motifs must be a JSON list');
  for (const [i, m] of motifs.entries()) {
    if (!m || !['retire', 'keep'].includes(m.mode) || !Array.isArray(m.patterns) || !m.patterns.length) throw new Error(`motif ${i}: needs mode retire|keep and patterns`);
  }
  store.getProject(Number(id));
  store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`story_motifs:${Number(id)}`, JSON.stringify(motifs));
  return motifs;
}

// What the story knows that matters for this turn. Core cast first (who everyone is),
// then what the message and recent turns touch. Suspect / conflicting facts are flagged,
// never passed off as settled.
export function storyBrief(store, id, query = '', { limit = 20 } = {}) {
  const info = storyInfo(store, id);
  if (!info.plan_id) return { story: info, facts: [], looks: [], main: null, motifs: getMotifs(store, id) };
  const live = (q, k) => store.queryFindings({ plan_id: info.plan_id, query: q, status: 'live', limit: k });
  const all = store.queryFindings({ plan_id: info.plan_id, status: 'live', limit: 200 });
  // each character's derived core (who she is at heart, and to whom) leads "who is who" every turn
  const hearts = store.db.prepare("SELECT id FROM findings WHERE plan_id = ? AND slot = 'core' AND status IN ('active','suspect') ORDER BY id")
    .all(info.plan_id).map((r) => store.getFinding(r.id))
    .sort((a, b) => (b.subject === `character:${mainCharacter(store, info.plan_id)}#core`) - (a.subject === `character:${mainCharacter(store, info.plan_id)}#core`));
  const core = [...hearts, ...all.filter((f) => f.slot !== 'core' && /^character:/.test(f.subject) && (CORE_SLOTS.test(f.slot || '') || /#(identity|who)$/.test(f.subject)))
    .sort((a, b) => b.seen_count - a.seen_count).slice(0, 12 - Math.min(4, hearts.length))];
  const picked = new Map(core.map((f) => [f.id, f]));
  // (a core fact the message also matches stays core: replacing it with the query's copy moved it
  // out of "who is who" on some turns, which changed the cached part of the prompt every turn)
  if (String(query).trim()) for (const f of pickBrief(live, String(query).slice(0, 4000), { limit })) if (!picked.has(f.id)) picked.set(f.id, f);
  const looks = storyLooks(store, info.plan_id);
  const lookIds = new Set(looks.map((l) => l.id)), lookNames = new Set(looks.map((l) => l.name.toLowerCase()));
  // once a character has a current look, older appearance facts would only contradict it
  const staleLook = (f) => { const m = /^character:([^#]+)#(.*)$/i.exec(f.subject);
    return m && lookNames.has(m[1].toLowerCase()) && (APPEARANCE_SLOTS.test(f.slot || '') || /appearance|body|look|hair|eyes?|face|build|height/i.test(m[2])); };
  const facts = [...picked.values()].filter((f) => !lookIds.has(f.id) && !staleLook(f) && f.slot !== 'scene' && f.slot !== 'tells' && f.slot !== 'avoid' && f.slot !== 'canon').map((f) => ({ id: f.id, subject: f.subject, slot: f.slot || undefined, claim: f.claim,
    status: f.status, core: core.includes(f) || undefined, conflict: f.conflicts_with?.length ? f.conflicts_with : undefined }));
  return { story: info, canon: storyCanon(store, info.plan_id), scene: storyScene(store, info.plan_id), facts, looks, main: mainCharacter(store, info.plan_id),
    characters: storyCharacters(store, info.plan_id), motifs: getMotifs(store, id) };
}

// STORY CANON: what the user says about their story in their own words ("Mira is madly in love with
// the keeper", "this is a dark story") — always true, at full strength, at the top of
// every chat of the story, so it never has to be explained again. Slot `canon`, one per key: a new
// statement for the same key replaces the old. Only the user writes it (the reading pass cannot).
export function storyCanon(store, planId) {
  return store.db.prepare("SELECT id, subject, claim FROM findings WHERE plan_id = ? AND slot = 'canon' AND status IN ('active','suspect') ORDER BY id")
    .all(planId).map((r) => ({ id: r.id, key: r.subject.replace(/^canon:/, ''), claim: r.claim }));
}

export function setCanon(store, id, key, text) {
  const info = storyInfo(store, id);
  if (!info.plan_id) throw new Error('story has no plan yet');
  const k = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!k) throw new Error('canon needs --key');
  const live = store.db.prepare("SELECT id FROM findings WHERE plan_id = ? AND subject = ? AND slot = 'canon' AND status IN ('active','suspect')").all(info.plan_id, `canon:${k}`);
  if (text == null || !String(text).trim()) {
    for (const r of live) store.retractFinding(r.id, 'removed by the user');
  } else {
    const step = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? ORDER BY idx DESC, id DESC LIMIT 1').get(info.plan_id).id;
    store.absorbFindings([{ kind: 'fact', subject: `canon:${k}`, slot: 'canon', claim: String(text).trim().slice(0, 1500), evidence: ['the user, in their own words'] }],
      { step_id: step, source: 'user:canon', sweep: false });
  }
  return storyCanon(store, info.plan_id);
}

// The cast: characters with at least `min` live facts (a front-end needs every name, e.g. to
// know that a creature-word name is a being wearing a body, not an animal to draw).
export function storyCharacters(store, planId, min = 3) {
  return store.db.prepare(`SELECT lower(substr(subject, 11, instr(subject || '#', '#') - 11)) name, COUNT(*) n FROM findings
      WHERE plan_id = ? AND status IN ('active','suspect') AND subject LIKE 'character:%' GROUP BY name HAVING n >= ? ORDER BY n DESC`)
    .all(planId, min).map((r) => r.name).filter(Boolean);
}

// Where the story is right now (slot "scene": the newest session's last beats).
export function storyScene(store, planId) {
  return store.db.prepare("SELECT claim FROM findings WHERE plan_id = ? AND slot = 'scene' AND status IN ('active','suspect') ORDER BY id DESC LIMIT 1").get(planId)?.claim || null;
}

// Pin a character's look (the user's choice): the automatic look step never replaces it.
export function pinLook(store, id, name, look) {
  const info = storyInfo(store, id);
  if (!info.plan_id) throw new Error('story has no plan yet');
  const step = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? ORDER BY idx DESC, id DESC LIMIT 1').get(info.plan_id)?.id
    ?? store.addStep(info.plan_id, { title: 'Looks', context: 'Pinned looks.' }).id;
  const subject = `character:${String(name).trim().toLowerCase()}#look`;
  store.absorbFindings([{ kind: 'fact', subject, slot: 'look', claim: String(look).trim().slice(0, 900), evidence: ['pinned by the user'] }],
    { step_id: step, source: 'user:pinned', sweep: false });
  return storyLooks(store, info.plan_id);
}

// Each character's current look (slot "look", from the newest image prompts): always part of
// a brief, and what a chat front-end locks into image prompts.
export function storyLooks(store, planId) {
  // tells: how a possessed body visibly moves wrong — part of every image of that character
  const bySlot = (slot) => new Map(store.db.prepare("SELECT subject, claim FROM findings WHERE plan_id = ? AND slot = ? AND status IN ('active','suspect') ORDER BY id")
    .all(planId, slot).map((r) => [r.subject.replace(/^character:/i, '').split('#')[0].toLowerCase(), r.claim]));
  const tells = bySlot('tells');
  // avoid: what her pictures must never look like (derived with her tells) — her negative prompt
  const avoid = bySlot('avoid');
  // wardrobe: what the story last recorded her wearing (the newest "#wardrobe" fact) — an
  // image's starting outfit, until the chat itself changes her clothes
  const wardrobe = new Map(store.db.prepare(`SELECT subject, claim FROM findings WHERE plan_id = ? AND status IN ('active','suspect')
      AND (slot = 'wardrobe' OR subject LIKE 'character:%#wardrobe') ORDER BY id`)
    .all(planId).map((r) => [r.subject.replace(/^character:/i, '').split('#')[0].toLowerCase(), r.claim]));
  return store.db.prepare("SELECT id, subject, claim FROM findings WHERE plan_id = ? AND slot = 'look' AND status IN ('active','suspect') ORDER BY id")
    .all(planId).map((r) => { const name = r.subject.replace(/^character:/i, '').split('#')[0];
      const key = name.toLowerCase();
      return { id: r.id, name, look: r.claim, ...(tells.has(key) ? { tells: tells.get(key) } : {}),
        ...(avoid.has(key) ? { avoid: avoid.get(key) } : {}),
        ...(wardrobe.has(name.toLowerCase()) ? { wardrobe: wardrobe.get(name.toLowerCase()) } : {}) }; });
}

// Pin how a possessed character's body visibly moves wrong (drawn in every image of her).
export function pinTells(store, id, name, tells) {
  const info = storyInfo(store, id);
  if (!info.plan_id) throw new Error('story has no plan yet');
  const step = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? ORDER BY idx DESC, id DESC LIMIT 1').get(info.plan_id).id;
  store.absorbFindings([{ kind: 'fact', subject: `character:${String(name).trim().toLowerCase()}#tells`, slot: 'tells',
    claim: String(tells).trim().slice(0, 700), evidence: ['pinned by the user'] }], { step_id: step, source: 'user:pinned', sweep: false });
  return storyLooks(store, info.plan_id);
}

// The character the story is about: the one with the most live facts.
export function mainCharacter(store, planId) {
  const row = store.db.prepare(`SELECT lower(substr(subject, 11, instr(subject || '#', '#') - 11)) name, COUNT(*) n FROM findings
      WHERE plan_id = ? AND status IN ('active','suspect') AND subject LIKE 'character:%' GROUP BY name ORDER BY n DESC LIMIT 1`).get(planId);
  return row?.name || null;
}

// Everything the story holds, for a viewer: live facts (with what they are built on), and
// the latest changes — what was replaced by what, and what was retracted and why.
export function storyFacts(store, id, { changes = 30 } = {}) {
  const info = storyInfo(store, id);
  if (!info.plan_id) return { story: info, facts: [], changes: [] };
  const rows = store.db.prepare("SELECT id FROM findings WHERE plan_id = ? AND status IN ('active','suspect') ORDER BY id").all(info.plan_id);
  const facts = rows.map(({ id: fid }) => {
    const f = store.getFinding(fid);
    return { id: f.id, subject: f.subject, slot: f.slot || undefined, claim: f.claim, status: f.status, seen: f.seen_count,
      impact: f.impact === 'high' || undefined, conflict: f.conflicts_with?.length ? f.conflicts_with : undefined,
      built_on: f.depends_on.filter((d) => d.type === 'finding').map((d) => Number(d.ref)), evidence: (f.evidence || []).slice(0, 3) };
  });
  const changed = store.db.prepare(`SELECT e.finding_id id, e.event, e.detail, e.created_at, f.claim, f.subject FROM finding_events e
      JOIN findings f ON f.id = e.finding_id WHERE f.plan_id = ? AND e.event IN ('revised','retracted','reinstated','suspect','confirmed')
      ORDER BY e.id DESC LIMIT ?`).all(info.plan_id, changes)
    .map((e) => ({ id: e.id, event: e.event, subject: e.subject, claim: e.claim, detail: e.detail, at: e.created_at }));
  const superseded = store.db.prepare(`SELECT o.id, o.subject, o.claim old, n.claim new, n.id new_id, o.updated_at at FROM findings o
      JOIN findings n ON n.id = o.superseded_by WHERE o.plan_id = ? AND o.status = 'superseded' ORDER BY o.updated_at DESC LIMIT ?`).all(info.plan_id, changes);
  return { story: info, facts, changes: changed, superseded };
}

// ---- CLI -----------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...argv] = process.argv.slice(2);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const flag = (n) => argv.includes(n);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const store = new Store(defaultDbPath());
  try {
    if (cmd === 'stories') out({ stories: listStories(store, val('--category', 'Storytelling')) });
    else if (cmd === 'create') {
      const name = String(val('--name', '')).trim();
      if (!name) throw new Error('--name is required');
      const cat = store.ensureProject(val('--category', 'Storytelling'), { description: 'Stories: one child project per story.' });
      const p = store.ensureProject(name, { parent_id: cat.id, description: `Story memory for ${name}.` });
      storyPlan(store, p, p.name);
      out({ story: storyInfo(store, p.id) });
    } else if (cmd === 'brief') out(storyBrief(store, val('--story'), val('--query', ''), { limit: Number(val('--limit', 20)) }));
    else if (cmd === 'facts') out(storyFacts(store, val('--story')));
    else if (cmd === 'motifs') {
      const file = val('--set');
      out({ motifs: file ? setMotifs(store, val('--story'), JSON.parse(readFileSync(file, 'utf8'))) : getMotifs(store, val('--story')) });
    } else if (cmd === 'ingest') {
      // merging a chat into a story is the user's deliberate act: the caller must say so
      if (!argv.includes('--confirm')) throw new Error('merging into the story brain needs --confirm (the user must ask for it)');
      const p = store.getProject(Number(val('--story')));
      const parent = p.parent_id != null ? store.getProject(p.parent_id).name : 'Storytelling';
      const convs = String(val('--files', '')).split(',').filter(Boolean).map((f) => loadConversation(f));
      if (!convs.length) throw new Error('--files is required');
      const r = await ingestStory(store, { convs, story: p.name, category: parent, source: val('--source', null),
        call: makeAgent({ root: null, model: val('--model', 'deepseek-v4-pro') }), maxUsd: Number(val('--max-usd', 1)),
        maxChunks: Number(val('--chunks', Infinity)), log: (s) => process.stderr.write(s + '\n') });
      out({ story: storyInfo(store, p.id), chunks: r.chunks, cost: Math.round(r.cost * 10000) / 10000, absorbed: r.absorbed,
        rewound: r.rewound.length, stopped: r.stopped, ingested_to: r.ingested_to, total: r.total, refused: r.refused });
    } else if (cmd === 'canon') {
      // the user's own words about their story, at the top of every chat: --key love --set "…"
      // (--set "" removes it); no --key lists them
      out({ canon: val('--key') ? setCanon(store, val('--story'), val('--key'), val('--set', '')) : storyCanon(store, storyInfo(store, val('--story')).plan_id) });
    } else if (cmd === 'core') {
      // --derive [--name Mira] [--force]: who each character is at heart (and to whom), from her facts
      const info = storyInfo(store, val('--story'));
      if (!info.plan_id) throw new Error('story has no plan yet');
      const step = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? ORDER BY idx DESC, id DESC LIMIT 1').get(info.plan_id).id;
      const r = await deriveCore(store, { plan: { id: info.plan_id }, stepId: step, force: flag('--force'),
        names: val('--name') ? [val('--name')] : null, call: makeAgent({ root: null, model: val('--model', 'deepseek-v4-pro') }),
        log: (s) => process.stderr.write(s + '\n') });
      out({ derived: r.derived, cost: Math.round(r.cost * 10000) / 10000 });
    } else if (cmd === 'tells') {
      // --derive [--name Mira] [--force]: the brain works out how each character's nature shows in
      //   a picture, from her own facts (built on them; re-derived when they change)
      // --name Mira --set "…": pin the user's own wording instead (never replaced by --derive)
      if (flag('--derive')) {
        const info = storyInfo(store, val('--story'));
        if (!info.plan_id) throw new Error('story has no plan yet');
        const step = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? ORDER BY idx DESC, id DESC LIMIT 1').get(info.plan_id).id;
        const r = await deriveTells(store, { plan: { id: info.plan_id }, stepId: step, force: flag('--force'),
          names: val('--name') ? [val('--name')] : null, call: makeAgent({ root: null, model: val('--model', 'deepseek-v4-pro') }),
          log: (s) => process.stderr.write(s + '\n') });
        out({ derived: r.derived, cost: Math.round(r.cost * 10000) / 10000, looks: storyLooks(store, info.plan_id) });
      } else {
        if (!val('--name') || val('--set') == null) throw new Error('tells needs --name and --set (or --derive)');
        out({ looks: pinTells(store, val('--story'), val('--name'), val('--set')) });
      }
    } else if (cmd === 'look' && val('--set') != null) {
      // pin a look the user chose: --name Mira --set "tall woman, white braid…"
      if (!val('--name')) throw new Error('--name is required with --set');
      out({ looks: pinLook(store, val('--story'), val('--name'), val('--set')) });
    } else if (cmd === 'scene') {
      // where the story is right now, from the end of the most recently active of these chats
      const p = store.getProject(Number(val('--story')));
      const convs = String(val('--files', '')).split(',').filter(Boolean).map((f) => loadConversation(f));
      if (!convs.length) throw new Error('--files is required');
      const plan = storyPlan(store, p, p.name);
      const step = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? ORDER BY idx DESC, id DESC LIMIT 1').get(plan.id)?.id
        ?? store.addStep(plan.id, { title: 'Scene', context: 'Where the story is now.' }).id;
      const src = val('--source', null) || convs.map((c) => c.file).sort().join('|');
      const r = await updateScene(store, { convs, plan, stepId: step, call: makeAgent({ root: null, model: val('--model', 'deepseek-v4-pro') }),
        key: `story_scene:${p.id}:${src}`, log: (s) => process.stderr.write(s + '\n') });
      out({ scene: storyScene(store, plan.id), updated: r.scene, truths: r.truths || 0, cost: r.cost });
    } else if (cmd === 'look') {
      // the characters' current look from the newest image prompts of these chats (no text ingest)
      const p = store.getProject(Number(val('--story')));
      const convs = String(val('--files', '')).split(',').filter(Boolean).map((f) => loadConversation(f));
      if (!convs.length) throw new Error('--files is required');
      const plan = storyPlan(store, p, p.name);
      const step = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? ORDER BY idx DESC, id DESC LIMIT 1').get(plan.id)?.id
        ?? store.addStep(plan.id, { title: 'Looks', context: 'Current looks from the newest image prompts.' }).id;
      const src = val('--source', null) || convs.map((c) => c.file).sort().join('|');
      const r = await updateLooks(store, { convs, plan, stepId: step, call: makeAgent({ root: null, model: val('--model', 'deepseek-v4-pro') }),
        key: `story_look:${p.id}:${src}`, log: (s) => process.stderr.write(s + '\n') });
      out({ looks: storyLooks(store, plan.id), updated: r.looks, cost: r.cost });
    } else throw new Error(`unknown command "${cmd ?? ''}" (stories | create | brief | facts | look | tells | scene | ingest | motifs)`);
  } catch (e) {
    out({ error: e.message });
    process.exitCode = 1;
  } finally { store.close(); }
}
