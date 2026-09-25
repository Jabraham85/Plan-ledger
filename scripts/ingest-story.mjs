#!/usr/bin/env node
// ingest-story.mjs — build the brain for an ongoing story from its chat logs.
//
//   node scripts/ingest-story.mjs --dir <conversations dir> --match "mira" --story "Mira"
//        [--category Storytelling] [--dry-run] [--transcript out.txt] [--max-usd 8] [--chunks N]
//   --dry-run      clean + assemble + chunk, print the plan (and write --transcript); no model, no writes
//   --chunks N     stop after N chunks this run (the checkpoint resumes from there)
//
// 1. src/story.mjs cleans and assembles the sessions into one canonical transcript
//    (image prompts, tool calls, repeats and rewound branches removed).
// 2. The story is filed as a project under its category ("Storytelling" → "Mira"),
//    with a plan whose steps are the sessions — facts are "learned in" their session.
// 3. Chunks are read IN ORDER by a text-only model that sees what the brain already
//    knows (#ids) and records durable story truths: characters, relationships, events,
//    places, world rules. A changed trait reuses subject+slot (the old value is
//    superseded); a revelation is impact "high" (what it changes is re-checked); a fact
//    that rests on a known one says depends_on. Recaps restate canon: a match confirms.
// 4. Every few chunks, and at the end, suspect facts are settled (reevaluate, no tools).
// Checkpoint: settings `story_ingest:<project>:<source>` = last message done + a hash per
// message, so a re-run resumes, later messages are ingested incrementally, and a rewound /
// regenerated chat retracts what it learned only from the discarded messages.
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, defaultDbPath } from '../src/db.mjs';
import { loadConversation, assembleSeries, chunkTranscript, latestVisuals } from '../src/story.mjs';
import { pickBrief } from '../src/brief.mjs';
import { parseFindings } from './runner-lib.mjs';
import { makeAgent } from './brain-llm.mjs';
import { reevaluate } from './reevaluate.mjs';

// Attributes that hold ONE value at a time: a new value replaces the old (superseded).
// Anything else a model calls a "slot" (history, personality…) holds many facts, and a slot
// there would make each new fact overwrite the last — so the slot is dropped.
export const SINGLE_SLOTS = new Set(['name', 'true_name', 'age', 'species', 'pronouns', 'hair', 'eyes', 'height', 'build', 'current_body',
  'job', 'current_home', 'current_location', 'relationship_status', 'alive', 'allegiance', 'look', 'scene', 'tells', 'avoid', 'core', 'canon']);
// `look` and `scene` are written ONLY by their own steps (updateLooks / updateScene / a user
// pin): a recap that describes her appearance must not replace the look the user pinned.
const RESERVED_SLOTS = new Set(['look', 'scene', 'tells', 'avoid', 'core', 'canon']);   // tells/avoid: derived from her facts (deriveTells) or pinned
export function storySlot(slot) {
  const s = String(slot || '').trim().toLowerCase();
  return SINGLE_SLOTS.has(s) && !RESERVED_SLOTS.has(s) ? s : undefined;
}
// Not the story: the narrator/assistant talking about itself, and the app's own conventions.
export const NOT_STORY = /^(?:character:(?:story|narrator|assistant|ai|the narrator|model)\b|world:(?:format|formatting|image|images|tone contract|tooling|app)\b)/i;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const briefLine = (f) => `#${f.id} ${f.subject}${f.slot ? ` [slot ${f.slot}]` : ''}: ${clip(f.claim, 220)}` +
  (f.status === 'suspect' ? '  (SUSPECT — being re-checked)' : '');

export function storyPrompt(chunk, brief) {
  return [
    `You are keeping the long-term memory of an ongoing interactive story: a roleplay between USER (the player) and`,
    `STORY (the narrator, who voices the characters). Read this part of the transcript and record the DURABLE truths it`,
    `establishes or changes — what someone continuing the story weeks from now must know.`,
    ``,
    `Record: characters (names, aliases, who/what they really are, age, appearance, personality, history, abilities, goals,`,
    `secrets), relationships (status, feelings, promises, boundaries, conflicts), events that matter later (what happened,`,
    `consequences), places, objects, world rules, recurring rituals and running jokes.`,
    `Skip: image-generation requests and prompts, formatting, transient poses/clothing/positions, moment-to-moment action,`,
    `and repetition. A scene matters through its OUTCOME (a milestone, a change, a promise) — record that, plainly.`,
    `Something a character claims but the story has not confirmed is recorded as a claim ("Mira claims …").`,
    `STORY is the narrator voice, not a character: record nothing about the narrator/AI/assistant itself, the app, image`,
    `generation or formatting conventions — only the story world and the people in it (including the user's character).`,
    ``,
    ...(brief.length ? [`What the story already knows (#ids):`, ...brief.map(briefLine), ``,
      `Do not repeat these. If this part CHANGES one, report the new value with the SAME subject and slot (the old one is`,
      `then replaced). If a finding rests on known ones (would be wrong if they were), add "depends_on":[ids].`, ``] : []),
    chunk.kind === 'recap'
      ? `This part is a HANDOFF RECAP: canon written to carry the story into the next session. Record the canon it states.`
      : `Transcript (each message starts with its [#n] number):`,
    ``,
    chunk.text,
    ``,
    `Report up to 20 findings, most important first, on ONE line:`,
    `FINDINGS: [{"key":"k1","kind":"fact","subject":"character:Mira#identity","slot":"identity","claim":"one atomic truth","evidence":"#12"},`,
    `  {"key":"k2","subject":"event:…","claim":"…","evidence":"#14","depends_on":["k1", 57]}]`,
    `Give each finding a short "key". "depends_on" may list known #ids AND keys of other findings in this same list — use it`,
    `whenever a finding only makes sense (or would be wrong) if another one is true: an event that happened BECAUSE of a fact,`,
    `a relationship built on an identity, a consequence of an earlier event.`,
    `Subjects: "character:<Name>#<aspect>", "relationship:<A>~<B>", "event:<short name>", "place:<Name>", "object:<Name>",`,
    `"world:<topic>". Use one name per character consistently (the one in the known facts if there is one).`,
    `"slot" marks a SINGLE-VALUED attribute so a later change replaces the old value. Allowed slots ONLY: ${[...SINGLE_SLOTS].filter((x) => !RESERVED_SLOTS.has(x)).join(', ')}.`,
    `Never give a slot to things that hold many facts (history, personality, abilities, preferences, boundaries, motives,`,
    `events): those are separate findings without a slot, each its own subject aspect.`,
    `evidence: the [#n] numbers it comes from. Add "impact":"high" for a REVELATION that changes what earlier facts mean`,
    `(someone is not who they seemed, a secret is exposed, a death, a transformation). kind: fact | decision | warning.`,
    `Then a final line: VERDICT: pass — <one-line summary of this part>`,
  ].join('\n');
}

const itemHash = (x) => createHash('sha1').update(`${x.role}\u0000${x.text}`).digest('hex').slice(0, 16);
const evidenceN = (e) => { const m = /^#(\d+) (\S+)#m\d+/.exec(String(e)); return m ? { n: Number(m[1]), file: m[2] } : null; };

// The story's plan (one step per session); created on first use.
export function storyPlan(store, proj, story) {
  const row = store.db.prepare('SELECT id FROM plans WHERE project_id = ? AND title = ?').get(proj.id, `Story: ${story}`);
  return row || store.createPlan({ title: `Story: ${story}`, summary: 'Story memory, built from the session logs.', project_id: proj.id });
}

// A chat was rewound / regenerated: messages after #d are gone. Facts that rest ONLY on
// those messages (of this source) are retracted — which re-opens what was built on them —
// and a fact one of them had replaced comes back. Returns the retracted ids.
export function retractAfter(store, planId, files, d, log = () => {}) {
  const fileSet = new Set(files), out = [];
  for (const { id } of store.db.prepare("SELECT id FROM findings WHERE plan_id = ? AND status IN ('active','suspect') ORDER BY id").all(planId)) {
    const f = store.getFinding(id);
    const ev = (f.evidence || []).map(evidenceN).filter(Boolean);
    const mine = ev.filter((e) => fileSet.has(e.file));
    if (!mine.length || mine.length < ev.length || mine.some((e) => e.n <= d)) continue; // survives on other evidence
    const replaced = store.db.prepare("SELECT id FROM findings WHERE superseded_by = ? AND status = 'superseded'").all(f.id).map((r) => r.id);
    store.resolveFinding(f.id, { verdict: 'retracted', reason: `the chat was rewound past message #${d}` });
    for (const old of replaced) store.reinstateFinding(old, `#${f.id} that replaced it was rewound away`);
    out.push(f.id);
  }
  if (out.length) log(`  ↺ rewound past #${d}: retracted ${out.length} fact(s) learned only from the discarded messages`);
  return out;
}

// How the characters LOOK now, from the newest image prompts (the most exact visual canon
// the story has; the text cleaner drops them). One `look` fact per named character; a newer
// look replaces the older (slot). Reads the latest prompts only, so an older session can
// never overwrite a newer look; skipped when those prompts were already read.
export function lookPrompt(visuals) {
  return [
    `These are the most recent image prompts from an ongoing illustrated story, oldest first, newest last. They are the`,
    `canonical record of how the characters look NOW.`,
    ``,
    ...visuals.map((v, i) => `[image ${i + 1}] ${v.prompt}`),
    ``,
    `For EACH character the story names who appears in them, write ONE compact description of their stable physical`,
    `appearance, ready to paste into an image prompt: apparent age, height and build, skin, hair (colour, length, cut),`,
    `eyes, face, distinguishing features and marks. NOT clothing, pose, expression, setting, lighting or camera. Where the`,
    `prompts differ, the newest wins. Skip unnamed extras ("a 21-year-old girl") unless the prompts give their name.`,
    `One line: FINDINGS: [{"subject":"character:<Name>#look","slot":"look","claim":"<40-90 words>"}]`,
    `Then a final line: VERDICT: pass — <who you described>`,
  ].join('\n');
}

// A look is the body, not the outfit: a clause about clothing would pin every future image
// to one outfit, so it is dropped even when the model includes it.
const CLOTHING = /\b(nude|naked|topless|undressed|wearing|wears|dressed|clothes|clothing|outfit|boots?|heels?|shoes?|dress|shirt|t-shirt|top|skirt|shorts|jeans|pants|trousers|jacket|coat|hoodie|robe|lingerie|bra|panties|underwear|stockings|socks|gloves|hat|uniform|costume|two-piece)\b/i;
export function withoutClothing(text) {
  const parts = String(text || '').trim().replace(/\.$/, '').split(/,\s*|;\s*|\.\s+/);
  return parts.filter((p) => p.trim() && !CLOTHING.test(p)).join(', ').trim() + '.';
}

// Only a character the story actually knows gets a look: a prompt that calls Mira "the keeper"
// (her costume) must not create a second character whose look is glued onto costume prompts.
function knownCharacter(store, planId, lookSubject, min = 3) {
  const name = lookSubject.replace(/^character:/i, '').split('#')[0].toLowerCase();
  return store.db.prepare("SELECT count(*) n FROM findings WHERE plan_id = ? AND status IN ('active','suspect') AND lower(subject) LIKE ? AND slot IS NOT 'look'")
    .get(planId, `character:${name}#%`).n >= min;
}

// HOW WHAT SHE IS SHOWS IN A PICTURE, derived from what the story knows about her — not
// written by hand. The reader model gets her own facts (with ids) and only general truths
// about image models; it answers with her `tells` (what a camera sees: expression, eyes,
// posture, hands) and `avoid` (what her pictures must never look like). Both are findings
// BUILT ON the facts cited, so when those facts change, truth maintenance marks them suspect
// and the next merge derives them again. A tell the user pinned is never replaced.
const OWN_SLOTS_SKIP = /^(look|tells|avoid|wardrobe)$/;
export function tellsPrompt(name, look, facts) {
  return [
    `You are the art director of an illustrated story. Below is everything the story's memory holds about ${name}, and her current body.`,
    ``,
    `BODY: ${look}`,
    `FACTS (id: claim):`,
    ...facts.map((f) => `#${f.id}: ${f.claim}`),
    ``,
    `Decide how ${name} must LOOK IN A PHOTOGRAPH so a viewer feels exactly what she is. Derive it from these facts, specific`,
    `to her, from her own nature, habits and history; not a generic "creepy" or "sexy". What image models do (use this):`,
    `- They draw every word literally. Her body is human: if something inhabits or possesses it, that thing is invisible and shows`,
    `  ONLY through what the body does. No creature or animal words, no similes, nothing non-human (claws, fangs, horns, glowing eyes).`,
    `- Left alone they give every face a pleasant, friendly, composed prettiness and ignore mild words. Name her expression`,
    `  strongly and exactly (the kind of smile or stare, the mouth, the eyes) so it overrides that default.`,
    `- They read TONE from tone words, not from anatomy: "a grin showing every tooth, held too long" is drawn as a big happy`,
    `  smile. Say what her expression MEANS in words an image model knows as a mood (for example: menacing, predatory,`,
    `  sinister, mocking, malicious, smug, unhinged, feral, deranged, hungry, greedy, vacant, haunted, sly, cold, gleeful,`,
    `  tender, sultry) — only the ones that are true of HER — and put the tone word first ("a predatory grin", not "a grin`,
    `  held too long"). Anatomy after it is fine ("a predatory grin showing every tooth").`,
    `  A smile of any kind is drawn HAPPY unless its tone word is unmistakable: "gleeful", "delighted", "playful", "knowing",`,
    `  "fond" all come out as a pretty, cheerful smile. If her smile is meant to disturb, its tone word must be one no happy face`,
    `  has (menacing, psychotic, deranged, predatory, sinister, feral), with what shows it (teeth bared, pupils tiny, eyes that do`,
    `  not smile), and "happy, cheerful, joyful" belong in AVOID. If her smile is warm, say so plainly.`,
    `  Pick ONE dominant tone (two at most), the truest of her: one face, not a list of alternatives. Every phrase must be`,
    `  true at the same moment; too many tone words blur into nothing.`,
    `- A face only reads when it is described; poses of whole limbs at odd angles come out as broken anatomy. Carry it in the`,
    `  face, eyes, head, posture, and what her hands do.`,
    `- Only what a camera sees: every phrase must be something a photograph shows. No feelings, thoughts, motives or backstory`,
    `  ("the pleasure of being chosen" cannot be photographed; "a slow, delighted, not-nice smile" can).`,
    `- It must hold in EVERY picture of her, whatever the scene: who she is, not what is happening now. No clothing or nudity,`,
    `  props, makeup or hair state, setting, lighting, or a moment from the story. Do not repeat the BODY (it is added separately).`,
    `- Only HER: the facts about other characters are context; never give her their habits.`,
    `Write TELLS: 20-45 words (never more), comma-separated visual phrases, strongest first. And AVOID: 6-12 comma-separated negative-prompt`,
    `terms for what her pictures must never look like, given who she is (the wrong mood or manner for her) — short plain terms an`,
    `image model knows ("friendly smile", "cheerful", "shy", "serene"), not descriptions.`,
    `Cite the fact ids each is built on.`,
    `One line: FINDINGS: [{"subject":"character:${name}#tells","slot":"tells","claim":"...","built_on":[ids]},`,
    `{"subject":"character:${name}#avoid","slot":"avoid","claim":"...","built_on":[ids]}]`,
    `Then a final line: VERDICT: pass — <one line: what she is, in picture terms>`,
  ].join('\n');
}

// WHO SHE IS AT HEART, derived from what the story knows — the one statement a chat must never
// lose. A story's truths arrive as many small facts ("said I love you back", "has a key",
// "blushes at 'my love'"), under more than one name for the same person ("the user", "the
// captain"); no single fact says "she is madly in love with him", so a brief built from the
// most-seen facts missed it. The reader writes her core from her own facts and her relationship
// facts, at its true strength; it is built on the facts cited (re-derived when they change) and
// always leads the brief.
export function corePrompt(name, facts) {
  return [
    `You keep the long-term memory of an ongoing story. Below is what it holds about ${name} (#id: claim), her own facts and her`,
    `relationships, most established first.`,
    ``,
    ...facts.map((f) => `#${f.id} ${f.subject}: ${f.claim}`),
    ``,
    `Write ${name}'s CORE: who she is at heart and what drives her NOW, in 3-5 plain sentences someone continuing this story must`,
    `never forget: what she really is, how she carries herself, what she wants, and who she is bound to and HOW STRONGLY. State`,
    `every feeling at its true strength as the facts show it; never soften, hedge or tidy it. Where the facts use different names`,
    `for the same person (for example "the user" and a title or nickname the story gives him, when the facts show they are the`,
    `same man), treat them as one person and call him "the user". Only what the facts support; where they changed, the newest wins.`,
    `Facts whose subject starts with "canon:" are the USER'S OWN WORDS about their story: authoritative. Carry them into her`,
    `core at their full strength, in their own terms; never weaken, qualify or contradict them.`,
    `Cite the fact ids it is built on.`,
    `One line: FINDINGS: [{"subject":"character:${name}#core","slot":"core","claim":"...","built_on":[ids]}]`,
    `Then a final line: VERDICT: pass — <one line>`,
  ].join('\n');
}

export async function deriveCore(store, { plan, stepId, call, names = null, force = false, log = () => {}, own = 45, ties = 40 }) {
  if (!call) return { derived: [], cost: 0 };
  const looks = store.db.prepare("SELECT subject FROM findings WHERE plan_id = ? AND slot = 'look' AND status IN ('active','suspect')").all(plan.id);
  let cost = 0;
  const derived = [];
  for (const lk of looks) {
    const name = lk.subject.replace(/^character:/i, '').split('#')[0].toLowerCase();
    if (names && !names.map((n) => n.toLowerCase()).includes(name)) continue;
    if (!force && store.db.prepare("SELECT 1 FROM findings WHERE plan_id = ? AND lower(subject) = ? AND status IN ('active','suspect') AND source = 'user:pinned'")
      .get(plan.id, `character:${name}#core`)) continue;
    const mine = store.db.prepare(`SELECT id, subject, claim FROM findings WHERE plan_id = ? AND status IN ('active','suspect') AND lower(subject) LIKE ?
        ORDER BY (subject LIKE '%#identity' OR slot IN ('species','true_name','name','age')) DESC, seen_count DESC, id DESC`).all(plan.id, `character:${name}#%`)
      .filter((f) => !/^(look|tells|avoid|wardrobe|core)$/.test(f.subject.split('#')[1] || '')).slice(0, own);
    const bonds = store.db.prepare(`SELECT id, subject, claim FROM findings WHERE plan_id = ? AND status IN ('active','suspect')
        AND lower(subject) LIKE 'relationship:%' AND lower(subject) LIKE ? ORDER BY seen_count DESC, id DESC LIMIT ?`).all(plan.id, `%${name}%`, ties);
    const canon = store.db.prepare("SELECT id, subject, claim FROM findings WHERE plan_id = ? AND slot = 'canon' AND status IN ('active','suspect') ORDER BY id").all(plan.id);
    const facts = [...canon, ...mine, ...bonds];
    if (facts.length < 3) continue;
    const sigKey = `story_core:${plan.id}:${name}`;
    const sig = createHash('sha1').update(facts.map((f) => `${f.id}:${f.claim}`).join('\u0001')).digest('hex').slice(0, 16);
    const current = store.db.prepare("SELECT status FROM findings WHERE plan_id = ? AND lower(subject) = ? AND status IN ('active','suspect') ORDER BY id DESC LIMIT 1")
      .get(plan.id, `character:${name}#core`);
    if (!force && current?.status === 'active' && store.db.prepare('SELECT value FROM settings WHERE key = ?').get(sigKey)?.value === sig) continue;
    const r = await call(corePrompt(name, facts));
    cost += r.cost || 0;
    if (r.is_error) { log(`  ✗ core ${name}: model call failed (${r.subtype})`); continue; }
    const ids = new Set(facts.map((f) => f.id));
    const f = parseFindings(r.result).findings.find((x) => new RegExp(`^character:${name}#core$`, 'i').test(String(x.subject || '').trim()) && String(x.claim || '').trim());
    if (!f) { log(`  ✗ core ${name}: no usable answer`); continue; }
    const on = (Array.isArray(f.built_on) ? f.built_on : []).map(Number).filter((id) => ids.has(id));
    store.absorbFindings([{ kind: 'fact', subject: `character:${name}#core`, slot: 'core', claim: String(f.claim).trim().slice(0, 1200),
      depends_on: on, evidence: on.slice(0, 6).map((id) => `derived from #${id}`) }], { step_id: stepId, source: 'story:derived', sweep: false });
    store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(sigKey, sig);
    derived.push({ name, core: String(f.claim).trim(), built_on: on });
    log(`  ♥ ${name}: core derived from ${facts.length} facts`);
  }
  return { derived, cost };
}

export async function deriveTells(store, { plan, stepId, call, names = null, key = null, force = false, log = () => {}, maxFacts = 60 }) {
  if (!call) return { derived: [], cost: 0 };
  const looks = store.db.prepare("SELECT subject, claim FROM findings WHERE plan_id = ? AND slot = 'look' AND status IN ('active','suspect')").all(plan.id);
  let cost = 0;
  const derived = [];
  for (const lk of looks) {
    const name = lk.subject.replace(/^character:/i, '').split('#')[0].toLowerCase();
    if (names && !names.map((n) => n.toLowerCase()).includes(name)) continue;
    const pinned = store.db.prepare("SELECT 1 FROM findings WHERE plan_id = ? AND lower(subject) = ? AND status IN ('active','suspect') AND source = 'user:pinned'")
      .get(plan.id, `character:${name}#tells`);
    if (pinned && !force) continue;
    // her own facts first (who/what she is, how she acts); then events/relationships that involve her
    const own = store.db.prepare(`SELECT id, subject, claim FROM findings WHERE plan_id = ? AND status IN ('active','suspect')
        AND lower(subject) LIKE ? ORDER BY (subject LIKE '%#identity' OR subject LIKE '%#who' OR slot IN ('species','true_name','name','age')) DESC,
        (subject LIKE '%#personality' OR subject LIKE '%#habit%' OR subject LIKE '%#nature') DESC, seen_count DESC, id DESC`).all(plan.id, `character:${name}#%`)
      .filter((f) => !OWN_SLOTS_SKIP.test(f.subject.split('#')[1] || ''));
    const about = store.db.prepare(`SELECT id, subject, claim FROM findings WHERE plan_id = ? AND status IN ('active','suspect')
        AND lower(subject) NOT LIKE 'character:%' AND lower(claim) LIKE ? ORDER BY id DESC LIMIT 15`).all(plan.id, `%${name}%`);
    // (another character's own facts are never shown: one character was given another's signature habit)
    const facts = [...own.slice(0, maxFacts - Math.min(15, about.length)), ...about].slice(0, maxFacts);
    if (facts.length < 3) continue;
    const sigKey = `${key || `story_tells:${plan.id}`}:${name}`;
    const sig = createHash('sha1').update(lk.claim + facts.map((f) => `${f.id}:${f.claim}`).join('\u0001')).digest('hex').slice(0, 16);
    const current = store.db.prepare("SELECT status FROM findings WHERE plan_id = ? AND lower(subject) = ? AND status IN ('active','suspect') ORDER BY id DESC LIMIT 1")
      .get(plan.id, `character:${name}#tells`);
    if (!force && current?.status === 'active' && store.db.prepare('SELECT value FROM settings WHERE key = ?').get(sigKey)?.value === sig) continue;
    const r = await call(tellsPrompt(name, lk.claim, facts));
    cost += r.cost || 0;
    if (r.is_error) { log(`  ✗ tells ${name}: model call failed (${r.subtype})`); continue; }
    const ids = new Set(facts.map((f) => f.id));
    const found = parseFindings(r.result).findings
      .filter((f) => new RegExp(`^character:${name}#(tells|avoid)$`, 'i').test(String(f.subject || '').trim()) && String(f.claim || '').trim())
      .map((f) => {
        const slot = String(f.subject).trim().split('#')[1].toLowerCase();
        const on = (Array.isArray(f.built_on) ? f.built_on : []).map(Number).filter((id) => ids.has(id));
        return { kind: 'fact', subject: `character:${name}#${slot}`, slot, claim: String(f.claim).trim().length > 420 ? String(f.claim).trim().slice(0, 420).replace(/,[^,]*$/, '') : String(f.claim).trim(),
          depends_on: on, evidence: on.slice(0, 6).map((id) => `derived from #${id}`) };
      });
    if (!found.length) { log(`  ✗ tells ${name}: no usable answer`); continue; }
    store.absorbFindings(found, { step_id: stepId, source: 'story:derived', sweep: false });
    store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(sigKey, sig);
    derived.push({ name, tells: found.find((f) => f.slot === 'tells')?.claim, avoid: found.find((f) => f.slot === 'avoid')?.claim,
      built_on: found.find((f) => f.slot === 'tells')?.depends_on || [] });
    log(`  🎭 ${name}: tells derived from ${facts.length} facts`);
  }
  return { derived, cost };
}

export async function updateLooks(store, { convs, plan, stepId, call, key, log = () => {}, k = 6 }) {
  const visuals = latestVisuals(convs, k);
  if (!visuals.length || !call) return { looks: 0, cost: 0 };
  const sig = createHash('sha1').update(visuals.map((v) => v.prompt).join('\u0001')).digest('hex').slice(0, 16);
  if (store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value === sig) return { looks: 0, cost: 0, unchanged: true };
  // a look the user pinned is never replaced by this automatic step
  const pinned = new Set(store.db.prepare("SELECT lower(subject) s FROM findings WHERE plan_id = ? AND slot = 'look' AND status IN ('active','suspect') AND source = 'user:pinned'")
    .all(plan.id).map((x) => x.s));
  const r = await call(lookPrompt(visuals));
  if (r.is_error) { log(`  ✗ looks: model call failed (${r.subtype})`); return { looks: 0, cost: r.cost || 0 }; }
  const found = parseFindings(r.result).findings
    .filter((f) => /^character:[^#]+#look$/i.test(String(f.subject || '').trim()) && !NOT_STORY.test(String(f.subject)) && String(f.claim || '').trim()
      && !pinned.has(String(f.subject).trim().toLowerCase()) && knownCharacter(store, plan.id, String(f.subject).trim()))
    .map((f) => ({ kind: 'fact', subject: String(f.subject).trim(), slot: 'look', claim: withoutClothing(f.claim).slice(0, 900),
      evidence: visuals.slice(-2).map((v) => `image ${v.file}#m${v.i}`) }));
  if (found.length) store.absorbFindings(found, { step_id: stepId, source: 'story:look', sweep: false });
  store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, sig);
  log(`  👁 looks from the latest ${visuals.length} image prompt(s): ${found.map((f) => f.subject.split(':')[1].split('#')[0]).join(', ') || 'none named'}`);
  return { looks: found.length, cost: r.cost || 0 };
}

// WHERE THE STORY IS RIGHT NOW, from the end of the most recently active session: one
// `scene:now` fact (slot scene — a newer scene replaces the older), plus the durable truths
// of that stretch, so a chat can pick up where the story left off before the in-order read
// reaches it. A scene from an older session never replaces one from a newer session.
export function scenePrompt(text) {
  return [
    `You are keeping the long-term memory of an ongoing interactive story (USER = the player, STORY = the narrator voicing`,
    `the characters). Below is the END of the most recent session, oldest first.`,
    ``, text, ``,
    `1. Record WHERE THE STORY IS RIGHT NOW as one finding: subject "scene:now", slot "scene" — where they are, when, who is`,
    `   present and in what state, what just happened in the last beats, and what is unresolved or about to happen.`,
    `   60-140 words, concrete, present tense.`,
    `2. Record up to 12 durable truths from this stretch that someone continuing the story must know: new characters and who`,
    `   they are, what happened, promises, changes. Subjects: "character:<Name>#<aspect>", "relationship:<A>~<B>",`,
    `   "event:<short name>", "place:<Name>", "object:<Name>", "world:<topic>". Nothing about image generation or the narrator.`,
    `One line: FINDINGS: [{"subject":"scene:now","slot":"scene","claim":"..."}, {"subject":"character:...","claim":"..."}]`,
    `Then a final line: VERDICT: pass — <one line>`,
  ].join('\n');
}

export async function updateScene(store, { convs, plan, stepId, call, key, log = () => {}, maxChars = 14000 }) {
  const latest = [...convs].filter((c) => c.messages.length).sort((a, b) => a.updated - b.updated || a.created - b.created).pop();
  if (!latest || !call) return { scene: false, cost: 0 };
  const atKey = key.replace(/^story_scene:/, 'story_scene_at:').split(':').slice(0, 2).join(':'); // per story, not per source
  const newestSeen = Number(store.db.prepare('SELECT value FROM settings WHERE key = ?').get(atKey)?.value || 0);
  if (latest.updated < newestSeen) return { scene: false, cost: 0, older: true };
  const lines = [];
  let chars = 0;
  for (const m of [...latest.messages].reverse()) {
    if (m.kind === 'recap') continue;
    const l = `${m.role === 'user' ? 'USER' : 'STORY'}: ${m.text}`;
    if (chars + l.length > maxChars && lines.length) break;
    lines.unshift(l.slice(0, maxChars)); chars += l.length;
  }
  const sig = createHash('sha1').update(lines.join('\u0001')).digest('hex').slice(0, 16);
  if (store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value === sig) return { scene: false, cost: 0, unchanged: true };
  const r = await call(scenePrompt(lines.join('\n\n')));
  if (r.is_error) { log(`  ✗ scene: model call failed (${r.subtype})`); return { scene: false, cost: r.cost || 0 }; }
  const ev = [`scene ${latest.file}#m${latest.messages[latest.messages.length - 1].i}`];
  const found = parseFindings(r.result).findings.filter((f) => String(f.claim || '').trim() && !NOT_STORY.test(String(f.subject || '').trim()))
    .map((f) => {
      const scene = /^scene:/i.test(String(f.subject || '').trim());
      const slot = scene ? 'scene' : storySlot(f.slot);
      return { kind: 'fact', subject: scene ? 'scene:now' : String(f.subject).trim(), slot, claim: String(f.claim).trim().slice(0, 1500), evidence: ev };
    });
  if (found.length) store.absorbFindings(found, { step_id: stepId, source: 'story:scene', sweep: false });
  for (const [k, v] of [[key, sig], [atKey, String(latest.updated)]])
    store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  log(`  📍 scene from the end of ${latest.file}: ${found.some((f) => f.slot === 'scene') ? 'updated' : 'none'}, +${found.filter((f) => f.slot !== 'scene').length} recent truths`);
  return { scene: found.some((f) => f.slot === 'scene'), truths: found.length, cost: r.cost || 0 };
}

export async function ingestStory(store, { convs, story, category = 'Storytelling', call, dryRun = false, maxUsd = 8,
  maxChunks = Infinity, settleEvery = 8, retryMs = 5000, log = () => {}, transcriptOut = null, source = null } = {}) {
  const { items, dropped, sessions } = assembleSeries(convs);
  const cat = dryRun ? null : store.ensureProject(category, { description: 'Stories: one child project per story.' });
  const proj = dryRun ? null : store.ensureProject(story, { parent_id: cat.id, description: `Story memory for ${story}.` });
  const plan = dryRun ? null : storyPlan(store, proj, story);
  // Resume per SOURCE (the series, or one chat): the checkpoint keeps a hash per message,
  // so an edited / rewound history is detected at the exact message where it diverged.
  const src = source || createHash('sha1').update(convs.map((c) => c.file).sort().join('|')).digest('hex').slice(0, 12);
  const key = proj ? `story_ingest:${proj.id}:${src}` : null;
  const ck = key ? JSON.parse(store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || 'null') : null;
  const hashes = items.map(itemHash);
  let lastN = 0, rewound = [];
  if (ck?.last_n) {
    const old = ck.hashes || [];
    let d = 0;
    while (d < Math.min(ck.last_n, old.length, hashes.length) && old[d] === hashes[d]) d++;
    lastN = d;
    if (d < ck.last_n && !dryRun) rewound = retractAfter(store, plan.id, convs.map((c) => c.file), d, log);
  }
  const todo = chunkTranscript(items.filter((x) => x.n > lastN));
  log(`${convs.length} file(s) → ${items.length} messages (${items.reduce((t, x) => t + x.text.length, 0)} chars) in ${sessions.length} session(s); ` +
    `rewound branches dropped: ${dropped.messages} msg / ${dropped.chars} chars; ${todo.length} chunk(s) to read${lastN ? ` (resuming after #${lastN})` : ''}`);
  if (transcriptOut) writeFileSync(transcriptOut, todo.map((c) => `==== session ${c.s} #${c.from}-${c.to} ${c.kind}\n${c.text}`).join('\n\n'));
  if (dryRun) return { chunks: todo.length, items: items.length, sessions: sessions.length, dropped };
  const saveCheckpoint = (n) => store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify({ last_n: n, hashes: hashes.slice(0, n), updated: new Date().toISOString() }));
  if (rewound.length || (ck?.last_n && lastN < ck.last_n)) saveCheckpoint(lastN);
  const stepFor = new Map();
  for (const s of sessions) {
    const title = `Session ${s.s + 1}: ${s.file.replace(/\.json$/, '')}`;
    const row = store.db.prepare('SELECT id FROM steps WHERE plan_id = ? AND title = ?').get(plan.id, title);
    stepFor.set(s.s, row ? row.id : store.addStep(plan.id, { title, context: `Messages #${s.from + 1}–#${s.to} of the canonical transcript.` }).id);
  }
  // No `briefed` auto-links: in a story every fact names its characters, so a shared-word
  // link would tie everything to everything — only the links the reader states are kept.
  const byN = new Map(items.map((x) => [x.n, x]));
  const evidenceOf = (e) => String(e).match(/#?\d+/g)?.map((m) => byN.get(Number(m.replace('#', '')))).filter(Boolean)
    .map((x) => `#${x.n} ${x.file}#m${x.i}`) ?? [];
  const core = () => store.queryFindings({ plan_id: plan.id, status: 'live', limit: 200 })
    .filter((f) => /^character:/.test(f.subject) && (/^(name|true_name|species|age|relationship_status)$/.test(f.slot || '') || /#(identity|who)$/.test(f.subject)))
    .sort((a, b) => b.seen_count - a.seen_count).slice(0, 12);

  let stopped = null, cost = 0, done = 0, absorbed = { added: 0, merged: 0, superseded: 0, conflict: 0, other: 0 }, refused = 0, settled = [];
  const settle = async () => {
    const r = await reevaluate(store, { call, tools: false, plan_id: plan.id, maxRounds: 4, log: (s) => log('   ' + s) });
    cost += r.cost; settled.push(...r.results);
  };
  for (const c of todo) {
    if (done >= maxChunks) { log(`stopped after ${done} chunk(s) (--chunks)`); break; }
    if (cost > maxUsd) { log(`⛔ spend cap $${maxUsd} reached — resume later`); break; }
    const known = new Map(core().map((f) => [f.id, f]));
    for (const f of pickBrief((q, k) => store.queryFindings({ plan_id: plan.id, query: q, status: 'live', limit: k }), c.text.slice(0, 6000), { limit: 20 })) known.set(f.id, f);
    const brief = [...known.values()];
    // a failed call (network, API) is retried, then the run STOPS without moving the
    // checkpoint — a chunk is only ever skipped because it was read and held nothing
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await call(storyPrompt(c, brief));
      cost += r.cost || 0;
      if (!r.is_error) break;
      log(`  … #${c.from}-${c.to}: call failed (${r.subtype}), attempt ${attempt + 1}/3`);
      if (attempt < 2) await new Promise((ok) => setTimeout(ok, retryMs * (attempt + 1)));
    }
    if (r.is_error) { log(`⛔ #${c.from}-${c.to}: the model call keeps failing (${r.subtype}) — stopped; re-run to resume here`); stopped = r.subtype; break; }
    const pf0 = parseFindings(r.result);
    const pf = { ...pf0, findings: pf0.findings.filter((f) => !NOT_STORY.test(String(f.subject || '').trim())) };
    if (!pf.findings.length) { refused++; log(`  ✗ #${c.from}-${c.to} (${c.kind}): nothing recorded (${pf.error || 'no FINDINGS line'})`); }
    // depends_on: known #ids (only ones it was shown) and keys of findings in this same batch
    const keyed = new Map(pf.findings.map((f, i) => [String(f.key ?? '').trim(), i]).filter(([k]) => k));
    const refs = (f) => (Array.isArray(f.depends_on) ? f.depends_on : f.depends_on == null ? [] : [f.depends_on]).map((v) => String(v).trim());
    const fs = pf.findings.map(({ key: _k, ...f }) => ({ ...f, slot: storySlot(f.slot), kind: ['fact', 'decision', 'warning'].includes(f.kind) ? f.kind : 'fact',
      evidence: (Array.isArray(f.evidence) ? f.evidence : [f.evidence]).flatMap(evidenceOf),
      depends_on: refs(f).filter((v) => !keyed.has(v)).map((v) => Number(v.replace(/^#/, ''))).filter((v) => known.has(v)) }));
    const res = fs.length ? store.absorbFindings(fs, { step_id: stepFor.get(c.s), source: `story:${c.kind}`, sweep: false }) : { results: [] };
    const idAt = new Map(res.results.filter((x) => x.id).map((x) => [x.index, x.id]));
    let inBatch = 0;
    pf.findings.forEach((f, i) => {
      const me = idAt.get(i); if (!me) return;
      const ids = refs(f).filter((v) => keyed.has(v)).map((v) => idAt.get(keyed.get(v))).filter((d) => d && d !== me);
      if (ids.length) { inBatch += store.linkFinding(me, ids).length; fs[i].depends_on.push(...ids); }
    });
    const o = { added: 0, merged: 0, superseded: 0, conflict: 0, other: 0 };
    for (const x of res.results) { const k = { created: 'added', duplicate: 'merged', near_duplicate: 'merged', confirmed: 'merged', superseded: 'superseded', conflict: 'conflict' }[x.outcome] || 'other'; o[k]++; absorbed[k]++; }
    const high = fs.filter((f) => f.impact === 'high').length, linked = fs.filter((f) => f.depends_on.length).length;
    log(`  ✓ #${c.from}-${c.to} ${c.kind === 'recap' ? 'RECAP ' : ''}s${c.s + 1}: ${fs.length} found → ${o.added} new, ${o.merged} confirmed, ${o.superseded} replaced` +
      `${o.conflict ? `, ${o.conflict} conflicting` : ''}${o.other ? `, ${o.other} rejected` : ''}${high ? `, ${high} revelation(s)` : ''}${linked ? `, ${linked} built on known` : ''} — $${cost.toFixed(3)}`);
    saveCheckpoint(c.to);
    done++;
    if (done % settleEvery === 0 && store.suspectQueue({ plan_id: plan.id, limit: 1 }).length) await settle();
  }
  if (store.suspectQueue({ plan_id: plan.id, limit: 1 }).length) await settle();
  // the characters' current look, from the newest image prompts (once the text is caught up)
  let looks = 0;
  if (!stopped && done === todo.length && call) {
    const lastStep = stepFor.get(Math.max(...stepFor.keys()));
    const l = await updateLooks(store, { convs, plan, stepId: lastStep, call, key: `story_look:${proj.id}:${src}`, log });
    cost += l.cost; looks = l.looks;
    const sc = await updateScene(store, { convs, plan, stepId: lastStep, call, key: `story_scene:${proj.id}:${src}`, log });
    cost += sc.cost;
    // how each character's nature shows in a picture — re-derived when the facts under it changed
    const t = await deriveTells(store, { plan, stepId: lastStep, call, log });
    cost += t.cost;
    // who each character is at heart (and to whom), re-derived when the facts under it changed
    const c = await deriveCore(store, { plan, stepId: lastStep, call, log });
    cost += c.cost;
  }
  return { looks, project: proj, plan_id: plan.id, chunks: done, cost, absorbed, refused, settled, stopped, rewound, source: src,
    ingested_to: done ? todo[done - 1].to : lastN, total: items.length };
}

// ---- CLI -----------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const dir = val('--dir'), story = val('--story'), files = val('--files');
  if ((!dir && !files) || !story) { console.error('usage: ingest-story.mjs (--dir DIR [--match REGEX] | --files A.json,B.json) --story NAME [--source KEY] [--category Storytelling] [--dry-run] [--transcript FILE] [--max-usd 8] [--chunks N]'); process.exit(2); }
  const match = new RegExp(val('--match', '.'), 'i');
  const convs = files ? files.split(',').filter(Boolean).map((p) => loadConversation(p)) : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return loadConversation(join(dir, f)); } catch { return null; } })
    // (a chat that feeds the brain as its own source is never re-read as part of the series)
    .filter((c) => c && (files || !c.brain) && c.messages.some((m) => match.test(m.text)));
  const store = new Store(defaultDbPath());
  const r = await ingestStory(store, { convs, story, category: val('--category', 'Storytelling'), dryRun: flag('--dry-run'),
    call: flag('--dry-run') ? null : makeAgent({ root: null, model: val('--model', 'deepseek-v4-pro') }),
    maxUsd: Number(val('--max-usd', 8)), maxChunks: Number(val('--chunks', Infinity)), transcriptOut: val('--transcript', null), source: val('--source', null),
    log: (s) => console.log(s) });
  if (!flag('--dry-run')) {
    const n = (v) => r.settled.filter((x) => x.verdict === v).length;
    console.log(`\n${store.projectPath(r.project.id)} (project ${r.project.id}, plan ${r.plan_id}): ${r.chunks} chunk(s), ` +
      `${JSON.stringify(r.absorbed)}, ${r.refused} chunk(s) with nothing recorded; settled ${r.settled.length} ` +
      `(${n('confirmed')} confirmed, ${n('revised')} revised, ${n('retracted')} retracted, ${n('unsure')} unsure) — $${r.cost.toFixed(3)}`);
  }
  store.close();
}
