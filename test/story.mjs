// story.mjs — ingesting a story from chat logs: cleaning, fork/rewind assembly,
// chunking, and the ingester (category hierarchy, sessions as steps, slot changes,
// recaps confirming, checkpoint resume). Synthetic fixture only. Run: node test/story.mjs
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.mjs';
import { cleanMessage, loadConversation, assembleSeries, chunkTranscript } from '../src/story.mjs';
import { ingestStory, storyPrompt } from '../scripts/ingest-story.mjs';

let pass = 0;
const check = (label, cond) => { assert.ok(cond, label); console.log('  ok  ' + label); pass++; };

// ---- cleaning
check('system prompt dropped', cleanMessage('system', 'You are…') === null);
check('tool results / errors and resume stubs dropped',
  cleanMessage('user', '[tool result]\n2 of 2 images') === null && cleanMessage('user', '[tool error] wrong count') === null &&
  cleanMessage('user', 'Continue from the memory I selected as the resume point.') === null);
check('a bare image request is dropped; a "… 2 images" suffix is stripped from real input',
  cleanMessage('user', '8 images of this scene') === null && cleanMessage('user', 'Mira, you look tired. Sit with me. 2 images').text === 'Mira, you look tired. Sit with me.');
check('image tool calls and file names are removed from the narration',
  cleanMessage('assistant', 'She laughs.\n```tool\n{"tool":"comfy","prompts":[{"prompt":"x"}]}\n```\nsaved as mira-001.png').text === 'She laughs.\n\nsaved as');
check('an assistant turn that was only a tool call leaves nothing', cleanMessage('assistant', '```tool\n{"tool":"comfy"}\n```') === null);
check('[bracketed] words are the user speaking to the AI, out of the story: never read as story',
  cleanMessage('user', 'She kisses him. [make her angrier next time]').text === 'She kisses him.' && cleanMessage('user', '[fix the image please]') === null);
check('a handoff brief is kept and marked as a recap', cleanMessage('user', '# HANDOFF BRIEF — MIRA\nMira is a lighthouse keeper.').kind === 'recap');

// ---- series assembly: a fork that was abandoned, a resumed session that repeats
const dir = join(tmpdir(), `pl-story-${process.pid}`);
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const conv = (name, created, updated, msgs) => writeFileSync(join(dir, name), JSON.stringify({ id: name, title: name, created, updated,
  messages: [{ role: 'system', content: 'harness prompt' }, ...msgs.map(([role, content]) => ({ role, content }))] }));
const U = (c) => ['user', c], A = (c) => ['assistant', c];
const base = [U('Hello Mira.'), A('Mira is the lighthouse keeper of Gull Rock. Her hair is red.'), U('What is in the tower?'), A('A brass lamp that never goes out.')];
conv('s1.json', 100, 150, [...base, U('Light it.'), A('The lamp flares green — a bad omen in this town.')]); // abandoned tail
conv('s1-fork.json', 200, 300, [...base, U('Leave it dark tonight.'), A('Mira leaves it dark; a ship runs aground on the rocks.'),
  A('```tool\n{"tool":"comfy","prompts":[{"prompt":"storm"}]}\n```'), U('[tool result]\n1 image')]);
conv('s2.json', 400, 500, [U('# HANDOFF BRIEF — MIRA\nMira keeps the Gull Rock light. Her hair is red. A ship ran aground when she left the lamp dark.'),
  U('Mira dyes her hair black to hide from the harbor master.'), A('Mira dyes her hair black. The harbor master no longer recognizes her.')]);
conv('s2-resume.json', 600, 650, [U('Continue from the memory I selected as the resume point.'), A('Mira dyes her hair black. The harbor master no longer recognizes her.')]);
conv('other.json', 50, 60, [U('Unrelated chat about apples.'), A('Apples are red.')]);
const convs = ['s1.json', 's1-fork.json', 's2.json', 's2-resume.json'].map((f) => loadConversation(join(dir, f)));
const series = assembleSeries(convs);
const texts = series.items.map((x) => x.text);
check('the continued branch is kept and the rewound one dropped',
  texts.some((t) => /runs aground/.test(t)) && !texts.some((t) => /flares green/.test(t)) && series.dropped.messages === 2);
check('shared messages appear once; a resumed session adds nothing already said',
  texts.filter((t) => /brass lamp/.test(t)).length === 1 && texts.filter((t) => /dyes her hair black\. The harbor/.test(t)).length === 1);
check('sessions in the order they began; the recap is kept in place, marked', series.sessions.length === 2 &&
  series.items.find((x) => x.kind === 'recap')?.n > series.items.find((x) => /runs aground/.test(x.text)).n);
check('message numbers are sequential and each carries its source file + original index',
  series.items.every((x, i) => x.n === i + 1 && x.file && Number.isInteger(x.i)));
const chunks = chunkTranscript(series.items, { maxChars: 120 });
check('chunks: whole [#n] messages, split by size and session; a recap is its own chunk',
  chunks.every((c) => c.kind === 'recap' ? /^\[#\d+\] RECAP:/.test(c.text) : /^\[#\d+\] (USER|STORY):/.test(c.text)) &&
  chunks.some((c) => c.kind === 'recap') && new Set(chunks.map((c) => c.s)).size === 2);

// ---- the ingester (fake model reading the chunks)
const s = new Store(':memory:');
const dry = await ingestStory(s, { convs, story: 'Mira', dryRun: true });
check('dry run plans the chunks and writes nothing', dry.chunks > 0 && !s.listProjects().some((p) => p.name === 'Storytelling'));
const prompts = [];
const call = async (p) => {
  prompts.push(p);
  const f = [];
  const at = Math.max(p.indexOf("Transcript (each"), p.indexOf("HANDOFF RECAP:")), body = at >= 0 ? p.slice(at) : ""; // the chunk, not the brief
  if (/lighthouse keeper/.test(body) && !/RECAP/.test(body)) f.push({ key: 'k1', subject: 'character:Mira#identity', slot: 'identity', claim: 'Mira is the lighthouse keeper of Gull Rock', evidence: '#2' },
    { subject: 'character:Mira#hair', slot: 'hair', claim: 'Mira has red hair', evidence: '#2' });
  if (/runs aground/.test(body) && !/RECAP/.test(body)) { const lamp = /#(\d+) character:mira#identity/i.exec(p)?.[1];
    f.push({ subject: 'event:the wreck', claim: 'A ship ran aground on Gull Rock the night Mira left the lamp dark', evidence: '#6', depends_on: lamp ? [Number(lamp), 999] : ['k1', 999] }); } // same chunk → by key
  if (/RECAP/.test(body)) f.push({ subject: 'character:Mira#identity', slot: 'identity', claim: 'Mira is the lighthouse keeper of Gull Rock', evidence: '#7' });
  if (/dyes her hair black/.test(body) && !/RECAP/.test(body)) f.push({ subject: 'character:Mira#hair', slot: 'hair', claim: 'Mira has dyed her hair black', evidence: '#9' });
  return { is_error: false, cost: 0.01, result: `FINDINGS: ${JSON.stringify(f)}\nVERDICT: pass — read` };
};
const small = { convs, story: 'Mira', call, maxChunks: 2, settleEvery: 100 };
const r1 = await ingestStory(s, small);
const cat = s.listProjects().find((p) => p.name === 'Storytelling'), mira = s.listProjects().find((p) => p.name === 'Mira');
check('filed under the category: Storytelling › Mira', cat && mira && mira.parent_id === cat.id && mira.path === 'Storytelling › Mira');
check('--chunks stops early and the checkpoint remembers where', r1.chunks === 2 && JSON.parse(s.db.prepare('SELECT value FROM settings WHERE key LIKE ?').get(`story_ingest:${mira.id}:%`).value).last_n > 0);
const r2 = await ingestStory(s, { ...small, maxChunks: Infinity });
if (process.env.DEBUG_STORY) console.log(prompts.map((p) => p.split('\n').filter((l) => /^\[#\d+\]/.test(l)).map((l) => l.slice(0, 40))));
const reads = prompts.filter((p) => /\n\[#\d+\] (?:USER|STORY|RECAP):/.test(p)); // (not the re-check prompts)
const firstN = reads.map((p) => /\n\[#(\d+)\] (?:USER|STORY|RECAP):/.exec(p)[1]);
check('a re-run resumes after the checkpoint (no chunk read twice)', firstN.every(Boolean) && new Set(firstN).size === reads.length && reads.length === 3 && r2.chunks > 0);
const live = s.queryFindings({ plan_id: r2.plan_id, status: 'live', limit: 50 });
const hair = live.filter((f) => f.subject === 'character:mira#hair');
check('a changed trait (same subject + slot) replaces the old value', hair.length === 1 && /black/.test(hair[0].claim));
const ident = live.find((f) => f.subject === 'character:mira#identity');
check('the recap restating canon confirms it (seen twice), not a duplicate', ident && ident.seen_count === 2 && live.filter((f) => f.subject === 'character:mira#identity').length === 1);
const wreck = live.find((f) => f.subject === 'event:the wreck');
check('a fact built on another keeps depends_on — by key within one chunk, by #id across chunks (an id it was not shown is dropped)',
  s.getFinding(wreck.id).depends_on.some((d) => d.type === 'finding' && Number(d.ref) === ident.id) && !s.getFinding(wreck.id).depends_on.some((d) => d.ref === '999'));
check('no shared-word links: the wreck is NOT tied to her hair, so dyeing it re-checks nothing',
  !s.getFinding(wreck.id).depends_on.some((d) => d.type === 'finding' && Number(d.ref) !== ident.id) && s.getFinding(wreck.id).status === 'active' &&
  prompts.filter((p) => !/WHERE THE STORY IS RIGHT NOW/.test(p)).length === reads.length);  // (no re-check prompts; the end-of-run scene step is expected)
check('facts are learned in their session (a step per session) with evidence back to the raw log',
  s.getFinding(wreck.id).step_id && /s1-fork\.json#m\d+/.test(s.getFinding(wreck.id).evidence.join(' ')));
check('the model saw known facts by #id in later chunks', prompts.slice(1).some((p) => /What the story already knows/.test(p) && /#\d+ character:mira#identity/.test(p)));
check('the story prompt asks for durable truths, slots, revelations and skips image prompts',
  /DURABLE/.test(storyPrompt({ kind: 'story', text: '' }, [])) && /impact":"high"|"impact":"high"/.test(storyPrompt({ kind: 'story', text: '' }, [])) &&
  /image-generation/.test(storyPrompt({ kind: 'story', text: '' }, [])));
// a chat REWOUND and regenerated: the hair-dye exchange is replaced. What was learned only
// from the discarded messages is retracted, and the fact it had replaced comes back.
{
  conv('s2.json', 400, 700, [U('# HANDOFF BRIEF — MIRA\nMira keeps the Gull Rock light. Her hair is red. A ship ran aground when she left the lamp dark.'),
    U('Mira decides to keep her red hair after all.'), A('She keeps it red and faces the harbor master.')]);
  conv('s2-resume.json', 600, 650, [U('Continue from the memory I selected as the resume point.'), A('She keeps it red and faces the harbor master.')]);
  const again = ['s1.json', 's1-fork.json', 's2.json', 's2-resume.json'].map((f) => loadConversation(join(dir, f)));
  const r3 = await ingestStory(s, { convs: again, story: 'Mira', call, settleEvery: 100 });
  const hairNow = s.queryFindings({ plan_id: r3.plan_id, status: 'live', limit: 50 }).filter((f) => f.subject === 'character:mira#hair');
  const black = s.queryFindings({ plan_id: r3.plan_id, status: 'any', limit: 50 }).find((f) => /black/.test(f.claim));
  check('rewind: the fact learned only from the discarded messages is retracted', r3.rewound.length === 1 && black.status === 'retracted');
  check('rewind: the value it had replaced is current again ("red hair" reinstated)', hairNow.length === 1 && /red/.test(hairNow[0].claim) &&
    s.getFinding(hairNow[0].id).history.some((h) => h.event === 'reinstated'));
  check('rewind: facts from before the divergence are untouched', s.queryFindings({ plan_id: r3.plan_id, status: 'live', limit: 50 }).some((f) => f.subject === 'event:the wreck'));
}

// a revelation in a story does NOT blanket-reopen every fact naming the character (the
// real story run flagged 127 of 179); reach lets a model pick what it actually changes
{
  const t = new Store(':memory:');
  const p = t.createPlan({ title: 'x' });
  const add = (f, o = {}) => t.absorbFindings([f], { plan_id: p.id, ...o }).results[0].id;
  const a = add({ subject: 'character:ada#appearance', claim: 'Ada has freckles' });
  const b = add({ subject: 'character:ada#history', claim: 'Ada was a court jester' });
  add({ subject: 'character:ada#identity', claim: 'Ada is secretly two spirits sharing one body', impact: 'high' }, { sweep: false });
  check('story revelation (sweep:false): no blanket re-open of every fact naming her',
    t.getFinding(a).status === 'active' && t.getFinding(b).status === 'active');
  check('...it waits for reach instead (a model picks the facts it really changes)', t.pendingReach({ plan_id: p.id }).length === 1);
  add({ subject: 'character:ada#identity', claim: 'Ada is actually an angel in disguise', impact: 'high' });
  check('the default (code facts) still sweeps', t.getFinding(a).status === 'suspect');
  t.close();
}

// looks: the newest image prompts give each named character's CURRENT look (not the outfit);
// a newer look replaces the older, and the brief then drops older appearance facts
{
  const { updateLooks, withoutClothing, storyPlan } = await import('../scripts/ingest-story.mjs');
  const { storyBrief } = await import('../scripts/story-brain.mjs');
  check('a look keeps the body, drops the outfit', withoutClothing('Petite demon, black hair, flat black eyes, nude but for black heeled boots, pointed canines.') ===
    'Petite demon, black hair, flat black eyes, pointed canines.');
  const t = new Store(':memory:');
  const cat = t.ensureProject('Storytelling'), proj = t.ensureProject('Mira', { parent_id: cat.id });
  const plan = storyPlan(t, proj, 'Mira'), step = t.addStep(plan.id, { title: 's1' }).id;
  t.absorbFindings([{ subject: 'character:mira#hair', slot: 'hair', claim: 'Mira has red hair' }, { subject: 'character:mira#identity', claim: 'Mira keeps the light' },
    { subject: 'character:mira#history', claim: 'Mira grew up on the pier' }], { step_id: step });
  const img = (p) => ['```tool\n' + JSON.stringify({ tool: 'comfy', prompt: p }) + '\n```'];
  const mk = (prompt, updated) => {
    const f = join(dir, `look-${updated}.json`);
    writeFileSync(f, JSON.stringify({ id: 'x', created: updated, updated, messages: [{ role: 'user', content: 'show me' }, { role: 'assistant', content: img(prompt)[0] }] }));
    return loadConversation(f);
  };
  let asked = '';
  const call = async (p) => { asked = p; const hair = /silver/.test(p) ? 'silver' : 'black';
    return { is_error: false, cost: 0.001, result: `FINDINGS: [{"subject":"character:Mira#look","slot":"look","claim":"Tall woman, ${hair} hair cropped short, grey eyes, wearing a yellow raincoat"}]\nVERDICT: pass` }; };
  await updateLooks(t, { convs: [mk('Mira, a tall woman with black cropped hair and grey eyes, in a yellow raincoat on the pier at dusk', 1)], plan, stepId: step, call, key: 'k' });
  check('the look prompt shows the newest image prompts and asks for the body only', /image 1\] Mira, a tall woman/.test(asked) && /NOT clothing/.test(asked));
  let b = storyBrief(t, proj.id, 'hello');
  check('one look per character, clothing removed, main character known', b.looks.length === 1 && /black hair/.test(b.looks[0].look) && !/raincoat/.test(b.looks[0].look) && b.main === 'mira');
  check('with a current look, the older appearance fact ("red hair") leaves the brief', !b.facts.some((f) => /red hair/.test(f.claim)) && b.facts.some((f) => /keeps the light/.test(f.claim)));
  const n = asked; await updateLooks(t, { convs: [mk('Mira, a tall woman with black cropped hair and grey eyes, in a yellow raincoat on the pier at dusk', 1)], plan, stepId: step, call, key: 'k' });
  check('the same prompts are not read twice', asked === n);
  await updateLooks(t, { convs: [mk('Mira, a tall woman with silver cropped hair now, grey eyes, on the pier', 2)], plan, stepId: step, call, key: 'k' });
  b = storyBrief(t, proj.id, 'hello');
  check('a newer look replaces the older one', b.looks.length === 1 && /silver/.test(b.looks[0].look));
  // an alias (her costume, "the jester") is not a character the story knows: no second look
  const alias = async () => ({ is_error: false, cost: 0, result: 'FINDINGS: [{"subject":"character:jester#look","slot":"look","claim":"Petite, black hair"}]\nVERDICT: pass' });
  await updateLooks(t, { convs: [mk('the jester in a harlequin two-piece, laughing', 3)], plan, stepId: step, call: alias, key: 'k' });
  check('an unknown name (an alias) gets no look', storyBrief(t, proj.id, '').looks.length === 1);
  // a look the user pinned is never replaced by the automatic step
  const { pinLook } = await import('../scripts/story-brain.mjs');
  pinLook(t, proj.id, 'Mira', 'Tall woman, white braid to the waist, one blue eye and one brown');
  await updateLooks(t, { convs: [mk('Mira, a tall woman with a green bob, on the pier', 4)], plan, stepId: step, call, key: 'k' });
  b = storyBrief(t, proj.id, '');
  check('a pinned look survives the automatic look step', b.looks.length === 1 && /white braid/.test(b.looks[0].look));
  const { storySlot } = await import('../scripts/ingest-story.mjs');
  check('look/scene are reserved: the reading pass can never write them (a recap overwrote a pinned look)',
    storySlot('look') === undefined && storySlot('scene') === undefined && storySlot('hair') === 'hair');
  // how her nature shows in a picture is DERIVED from her own facts, built on them, never hand-written
  {
    const { deriveTells } = await import('../scripts/ingest-story.mjs');
    t.absorbFindings([{ kind: 'fact', subject: 'character:mira#identity', claim: 'Mira is a drowned sailor wearing the keeper\'s body' },
      { kind: 'fact', subject: 'character:mira#personality', claim: 'Mira counts everything twice and hums sea shanties under her breath' },
      { kind: 'fact', subject: 'character:mira#habit', claim: 'Mira never blinks when the lamp is lit' }], { step_id: step, source: 'test', sweep: false });
    const ids = t.db.prepare("SELECT id FROM findings WHERE plan_id = ? AND subject LIKE 'character:mira#%' AND slot IS NOT 'look'").all(plan.id).map((r) => r.id);
    let seen = '', calls = 0;
    const director = async (p) => { seen = p; calls++;
      return { is_error: false, cost: 0.002, result: `FINDINGS: [{"subject":"character:mira#tells","slot":"tells","claim":"unblinking salt-glazed stare, lips moving as if counting","built_on":[${ids.slice(0, 2)}]},{"subject":"character:mira#avoid","slot":"avoid","claim":"cheerful, carefree","built_on":[${ids[0]}]}]\nVERDICT: pass` }; };
    const { pinTells } = await import('../scripts/story-brain.mjs');
    t.db.prepare("UPDATE findings SET status = 'retracted' WHERE plan_id = ? AND slot = 'tells'").run(plan.id);
    let r = await deriveTells(t, { plan, stepId: step, call: director });
    const tellsF = t.db.prepare("SELECT id FROM findings WHERE subject = 'character:mira#tells' AND status = 'active'").get();
    const deps = t.getFinding(tellsF.id).depends_on.filter((d) => d.type === 'finding').map((d) => Number(d.ref));
    check('tells are derived from her own facts (ids shown) with only general image-model truths — no character wording supplied',
      /#\d+: Mira counts everything twice/.test(seen) && /invisible/.test(seen) && /ONE dominant tone/.test(seen) && !/jester|goblin|\bbell\b/i.test(seen));
    check('the derived tells are built on the facts cited', r.derived.length === 1 && deps.length === 2 && deps.every((d) => ids.includes(d)));
    b = storyBrief(t, proj.id, '');
    check('the brief carries her derived tells and what to avoid', /salt-glazed/.test(b.looks[0].tells) && b.looks[0].avoid === 'cheerful, carefree');
    await deriveTells(t, { plan, stepId: step, call: director });
    check('nothing changed under them: not derived again', calls === 1);
    t.absorbFindings([{ kind: 'fact', subject: 'character:mira#habit2', claim: 'Mira licks salt from her fingers' }], { step_id: step, source: 'test', sweep: false });
    await deriveTells(t, { plan, stepId: step, call: director });
    check('a new fact about her: derived again', calls === 2);
    pinTells(t, proj.id, 'Mira', 'the user\'s own words');
    await deriveTells(t, { plan, stepId: step, call: director, force: false });
    check('a tell the user pinned is never replaced by the derivation', calls === 2 && /user's own words/.test(storyBrief(t, proj.id, '').looks[0].tells));
    // who she is at heart — derived from her facts AND her relationships, and always first in "who is who"
    const { deriveCore } = await import('../scripts/ingest-story.mjs');
    t.absorbFindings([{ kind: 'fact', subject: 'relationship:mira~keeper', claim: 'Mira told the keeper she loves him and gave him her key' }],
      { step_id: step, source: 'test', sweep: false });
    const bond = t.db.prepare("SELECT id FROM findings WHERE subject = 'relationship:mira~keeper'").get().id;
    let asked2 = '', n2 = 0;
    const reader = async (p) => { asked2 = p; n2++;
      return { is_error: false, cost: 0.002, result: `FINDINGS: [{"subject":"character:mira#core","slot":"core","claim":"A drowned sailor wearing the keeper's body, desperately in love with him.","built_on":[${ids[0]},${bond}]}]\nVERDICT: pass` }; };
    await deriveCore(t, { plan, stepId: step, call: reader });
    check('the core is derived from her own facts and her relationships, at full strength', /relationship:mira~keeper: Mira told the keeper she loves him/.test(asked2)
      && /never soften/.test(asked2) && /one person/.test(asked2));
    const heart = t.db.prepare("SELECT id FROM findings WHERE subject = 'character:mira#core' AND status = 'active'").get();
    check('the core is built on the facts cited', t.getFinding(heart.id).depends_on.filter((d) => d.type === 'finding').map((d) => Number(d.ref)).includes(bond));
    b = storyBrief(t, proj.id, 'anything');
    check('the core leads "who is who" in every brief', b.facts[0].subject === 'character:mira#core' && b.facts[0].core);
    await deriveCore(t, { plan, stepId: step, call: reader });
    t.absorbFindings([{ kind: 'fact', subject: 'relationship:mira~keeper#vow', claim: 'Mira swore to stay with the keeper until the lamp dies' }], { step_id: step, source: 'test', sweep: false });
    await deriveCore(t, { plan, stepId: step, call: reader });
    check('unchanged facts: not derived again; a new bond: derived again', n2 === 2);
    // the user's own words about the story: at the top of every brief, authoritative for her core
    const { setCanon } = await import('../scripts/story-brain.mjs');
    setCanon(t, proj.id, 'love', 'Mira is madly in love with the keeper.');
    setCanon(t, proj.id, 'tone', 'This is a dark adult story.');
    b = storyBrief(t, proj.id, 'anything');
    check('canon is in every brief, not among the facts', b.canon.map((c) => c.key).join() === 'love,tone' && !b.facts.some((f) => /^canon:/.test(f.subject)));
    setCanon(t, proj.id, 'love', 'Mira is unhingedly, madly in love with the keeper.');
    check('the same key replaces its old words', storyBrief(t, proj.id, '').canon.find((c) => c.key === 'love').claim.startsWith('Mira is unhingedly'));
    await deriveCore(t, { plan, stepId: step, call: reader, force: true });
    check('the core is written with the canon as authority', /canon:love: Mira is unhingedly/.test(asked2) && /USER'S OWN WORDS/.test(asked2));
    setCanon(t, proj.id, 'tone', '');
    check('--set "" removes a canon entry', storyBrief(t, proj.id, '').canon.length === 1);
  }
  // where the story is right now: a newer session's scene replaces an older one; an older session never does
  const { updateScene } = await import('../scripts/ingest-story.mjs');
  const sc = (t2) => async () => ({ is_error: false, cost: 0, result: `FINDINGS: [{"subject":"scene:now","slot":"scene","claim":"${t2}"},{"subject":"character:gull#identity","claim":"Gull is the harbor goblin"}]\nVERDICT: pass` });
  await updateScene(t, { convs: [mk('x', 10)], plan, stepId: step, call: sc('On the pier at dusk, Mira waits for the ferry.'), key: 'story_scene:1:a' });
  check('scene: where the story is now + the recent truths of that stretch', /ferry/.test(storyBrief(t, proj.id, '').scene) &&
    t.queryFindings({ plan_id: plan.id, status: 'live', limit: 50 }).some((f) => /goblin/.test(f.claim)));
  await updateScene(t, { convs: [mk('y', 5)], plan, stepId: step, call: sc('An older scene.'), key: 'story_scene:1:b' });
  check('scene: an older session never replaces a newer scene', /ferry/.test(storyBrief(t, proj.id, '').scene));
  await updateScene(t, { convs: [mk('z', 20)], plan, stepId: step, call: sc('In the lighthouse at midnight, the lamp dark.'), key: 'story_scene:1:c' });
  check('scene: a newer session replaces it', /midnight/.test(storyBrief(t, proj.id, '').scene) && !storyBrief(t, proj.id, '').facts.some((f) => f.slot === 'scene'));
  t.close();
}

// the story-brain service a chat front-end calls (scripts/story-brain.mjs)
{
  const { listStories, storyBrief, setMotifs, getMotifs } = await import('../scripts/story-brain.mjs');
  const mira = s.listProjects().find((p) => p.name === 'Mira');
  const st = listStories(s);
  check('stories: the category lists Mira with its live fact count', st.length === 1 && st[0].name === 'Mira' && st[0].facts >= 3 && st[0].path === 'Storytelling › Mira');
  const b = storyBrief(s, mira.id, 'tell me about the wreck on the rocks');
  check('brief: the core cast always comes first (identity), then what the message touches (the wreck)',
    b.facts[0].subject === 'character:mira#identity' && b.facts[0].core && b.facts.some((f) => f.subject === 'event:the wreck'));
  check('brief: nothing retracted or superseded is offered', b.facts.every((f) => f.status === 'active' || f.status === 'suspect'));
  setMotifs(s, mira.id, [{ id: 'age', mode: 'retire', patterns: ['\\bcenturies\\b'] }]);
  check('motifs are stored per story and returned with the brief', getMotifs(s, mira.id)[0].id === 'age' && storyBrief(s, mira.id, '').motifs.length === 1);
  let bad = false; try { setMotifs(s, mira.id, [{ mode: 'nope' }]); } catch { bad = true; }
  check('a malformed motif list is refused', bad);
}

// a model that cannot be reached: retried, then the run stops and the checkpoint does NOT move
{
  const t = new Store(':memory:');
  let calls = 0;
  const down = async () => { calls++; return { is_error: true, subtype: 'network', result: '', cost: 0 }; };
  const r = await ingestStory(t, { convs, story: 'Mira', call: down, retryMs: 1 });
  const proj = t.listProjects().find((p) => p.name === 'Mira');
  const ck = t.db.prepare('SELECT value FROM settings WHERE key LIKE ?').get(`story_ingest:${proj.id}:%`);
  check('an unreachable model: 3 attempts, run stopped, nothing skipped (no checkpoint)', calls === 3 && r.stopped === 'network' && r.chunks === 0 && !ck);
  t.close();
}
s.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} story checks passed.`);
