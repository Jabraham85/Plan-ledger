// board.mjs — the board HTTP server as a factory, shared by the CLI server
// (web/server.mjs, reads index.html from disk) and the packaged exe
// (web/app.mjs, passes inlined HTML). Read endpoints + ref writes + context.
// Bind callers to 127.0.0.1 — this now mutates (ref toggles).

import { createServer } from 'node:http';
import { buildPlanContext, buildProjectContext, buildRefsBlock, groundSlice, stepTerms } from '../src/context.mjs';

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

export function createBoardServer({ store, html }) {
  const json = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const text = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  // [method, regex, handler(match, body, query)] — handler returns {text} | data
  const routes = [
    ['GET', /^\/api\/plans$/,               () => store.listPlans()],
    ['GET', /^\/api\/plans\/(\d+)\/context$/, (m) => ({ text: buildPlanContext(store, Number(m[1])) })],
    ['GET', /^\/api\/plans\/(\d+)$/,         (m) => store.openPlan(Number(m[1]))],
    ['GET', /^\/api\/steps\/(\d+)\/ground$/, (m) => {
      const s = store.getStep(Number(m[1]));
      const terms = stepTerms(s);
      return { terms, markdown: groundSlice(store, s.plan_id, terms, 10), subgraph: store.queryGraph(s.plan_id, terms, 10) };
    }],
    ['GET', /^\/api\/steps\/(\d+)\/lessons$/, (m) => store.getLessons({ step_id: Number(m[1]), limit: 5 })],
    ['GET', /^\/api\/steps\/(\d+)$/,         (m) => store.getStep(Number(m[1]))],
    ['GET', /^\/api\/plans\/(\d+)\/graph$/,  (m) => ({ ...store.graphStats(Number(m[1])), god_nodes: store.godNodes(Number(m[1]), 10) })],
    ['GET', /^\/api\/context$/,              () => ({ text: buildRefsBlock(store, {}) || '(no rules or tools enabled)' })],
    ['GET', /^\/api\/refs$/, (m, b, q) => store.listRefs({
      kind: q.get('kind') || undefined,
      enabled: q.has('enabled') ? q.get('enabled') === 'true' : undefined,
      plan_id: q.get('plan_id') ? Number(q.get('plan_id')) : undefined,
    })],
    ['POST',   /^\/api\/refs$/,        (m, b) => store.createRef(b)],
    ['PATCH',  /^\/api\/refs\/(\d+)$/, (m, b) => store.updateRef(Number(m[1]), b)],
    ['DELETE', /^\/api\/refs\/(\d+)$/, (m) => store.deleteRef(Number(m[1]))],
    // --- write-capability (step 7): create/edit plans & steps from the board ---
    ['GET',    /^\/api\/templates$/,                  () => store.listTemplates()],
    ['GET',    /^\/api\/projects\/current\/context$/,  () => ({ text: buildProjectContext(store, store.currentProjectId()) })],
    ['GET',    /^\/api\/projects\/(\d+)\/context$/,     (m) => ({ text: buildProjectContext(store, Number(m[1])) })],
    ['GET',    /^\/api\/projects$/,                    () => store.listProjects()],
    ['POST',   /^\/api\/projects$/,                    (m, b) => store.createProject(b)],
    ['PATCH',  /^\/api\/projects\/current$/,           (m, b) => store.setCurrentProject(b.project_id)],
    ['GET',    /^\/api\/brief$/,                       () => store.projectBrief()],
    ['GET',    /^\/api\/activity$/,                    () => store.activity()],
    ['GET',    /^\/api\/recall$/,  (m, b, q) => store.recall(q.get('q') || '', Number(q.get('limit')) || 10)],
    ['POST',   /^\/api\/plans$/,                      (m, b) => store.createPlan(b)],
    ['PATCH',  /^\/api\/plans\/(\d+)\/status$/,       (m, b) => store.setPlanStatus(Number(m[1]), b.status)],
    ['POST',   /^\/api\/plans\/(\d+)\/instantiate$/,  (m, b) => store.instantiateTemplate(b.template, Number(m[1]))],
    ['POST',   /^\/api\/plans\/(\d+)\/steps$/,        (m, b) => store.addStep(Number(m[1]), b)],
    ['PATCH',  /^\/api\/steps\/(\d+)\/status$/,       (m, b) => store.setStepStatus(Number(m[1]), b.status)],
    ['POST',   /^\/api\/steps\/(\d+)\/attempts$/,     (m, b) => store.recordAttempt(Number(m[1]), b)],
    ['POST',   /^\/api\/steps\/(\d+)\/file-refs$/,    (m, b) => store.addFileRef({ step_id: Number(m[1]), ...b })],
    ['DELETE', /^\/api\/file-refs\/(\d+)$/,           (m) => store.removeFileRef(Number(m[1]))],
    ['GET',    /^\/api\/file-refs\/(\d+)\/content$/,  (m) => store.readFileRef(Number(m[1]))],
    ['GET',    /^\/api\/steps\/(\d+)\/suggest-files$/, (m, b, q) => store.suggestFileRefs(store.getStep(Number(m[1])).plan_id, q.get('path') || '')],
    ['PATCH',  /^\/api\/steps\/(\d+)$/,               (m, b) => store.updateStep(Number(m[1]), b)],
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      const body = (req.method === 'POST' || req.method === 'PATCH') ? await readBody(req) : {};
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(re);
        if (m) {
          try {
            const out = handler(m, body, url.searchParams);
            if (out && typeof out.text === 'string') return text(res, 200, out.text);
            return json(res, 200, out);
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
}
