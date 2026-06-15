// test/integration.test.mjs — end-to-end sync test. Spawns a real server against a temp data
// file (seeded with the OLD whole-doc shape, so migration is exercised), drives the actual client
// sync flow (the same sync.js reducers app.js uses) from two simulated devices, then tears down.
//
// Run: `npm run test:integration`  (not part of `npm test`, which stays pure/offline).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyEnt, recompose, applyChanges, diffOps, SINGLE } from '../public/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8421;
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ok  ', m); else { console.error('  FAIL', m); fails++; } };
const get = p => fetch(BASE + p).then(r => r.json());
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const OLD_DOC = {
  rev: 4,
  people: [{ id: 'me', name: 'Me', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true }],
  chores: [
    { id: 'c1', name: 'Dishes', minutes: 10, priority: 5, intervalCount: 1, intervalUnit: 'days', adultOnly: false, assignee: null, lastDone: null, holder: null, assignedOn: '2026-06-12', escalated: false, enabled: true, matrixKey: null },
    { id: 'c2', name: 'Trash', minutes: 5, priority: 4, intervalCount: 3, intervalUnit: 'days', adultOnly: false, assignee: null, lastDone: null, holder: 'me', assignedOn: '2026-06-13', escalated: false, enabled: true, matrixKey: null },
  ],
  rooms: [{ id: 'r1', name: 'Kitchen', size: 'medium' }],
  matrixTypes: [{ id: 't1', name: 'Tidy', minutes: 5, priority: 3, intervalCount: 1, intervalUnit: 'days', adultOnly: false, assignee: null }],
  matrixExclude: ['t1:r1'],
  settings: { graceDays: 3, escalateAfter: 2, weekStartISO: '2026-06-15' },
  week: { weekStartISO: '2026-06-15', assignments: [{ uid: 'c1#0' }], unassigned: [], load: [], completion: { 'c1#0': { date: '2026-06-15', snap: null } } },
};

/* --- a tiny faithful mirror of app.js's client sync (using the same pure reducers) --- */
const setSeq = (ent, a) => { if (SINGLE.includes(a.collection)) { if (ent[a.collection]) ent[a.collection]._seq = a._seq; } else if (ent[a.collection][a.id]) ent[a.collection][a.id]._seq = a._seq; };
const Client = () => ({ S: null, ent: emptyEnt(), localSeq: 0, outbox: [] });
async function boot(c) { const r = await get('/api/changes?since=0'); c.ent = applyChanges(emptyEnt(), r.changes).ent; c.localSeq = r.serverSeq; c.S = recompose(c.ent, c.localSeq); }
async function save(c, now) {
  const { ops, next } = diffOps(c.ent, c.S, now); c.ent = next; if (ops.length) c.outbox.push(...ops);
  const sent = c.outbox.slice(); if (!sent.length) return { applied: [], conflicts: [] };
  const resp = await post('/api/changes', { ops: sent });
  for (const a of resp.applied) setSeq(c.ent, a);
  const ss = new Set(sent); c.outbox = c.outbox.filter(o => !ss.has(o)); // localSeq advanced only by pull()
  return resp;
}
async function pull(c) {
  const r = await get('/api/changes?since=' + c.localSeq);
  const pending = new Set(c.outbox.map(o => o.collection + ':' + o.id));
  c.ent = applyChanges(c.ent, r.changes, { skip: pending }).ent; c.localSeq = r.serverSeq; c.S = recompose(c.ent, c.localSeq);
}

/* --- spawn server against a temp data file seeded with the old shape --- */
const dir = mkdtempSync(path.join(tmpdir(), 'choreboard-it-'));
const dataFile = path.join(dir, 'state.json');
writeFileSync(dataFile, JSON.stringify(OLD_DOC));
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile }, stdio: 'ignore' });

async function main() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

  console.log('migration: old whole-doc -> entities');
  {
    const st = await get('/api/state');
    ok(st.chores.length === 2 && st.week.completion['c1#0'], 'GET /api/state recomposes the migrated doc');
    ok(JSON.stringify(st.matrixExclude) === JSON.stringify(['t1:r1']), 'matrixExclude restored from settings');
    const ch = await get('/api/changes?since=0');
    ok(ch.serverSeq === 1 && ch.changes.every(c => c.rec._seq === 1), 'all migrated records stamped _seq 1');
    ok(ch.changes.some(c => c.collection === 'completion'), 'completion is its own collection');
  }

  console.log('SSE pushes on each applied write');
  {
    const ctrl = new AbortController();
    const res = await fetch(BASE + '/api/stream', { signal: ctrl.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); const got = [];
    (async () => { try { while (true) { const { value, done } = await reader.read(); if (done) break; for (const l of dec.decode(value).split('\n')) if (l.startsWith('data:')) got.push(l.slice(5).trim()); } } catch {} })();
    await new Promise(r => setTimeout(r, 150));
    const before = got.length;
    await post('/api/changes', { ops: [{ collection: 'people', id: 'me', rec: { id: 'me', name: 'Me!', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true, _updatedAt: Date.now() + 9000 }, baseSeq: 1 }] });
    await new Promise(r => setTimeout(r, 200)); ctrl.abort();
    ok(before >= 1 && got.length > before, 'initial snapshot event + a push after the write');
  }

  const A = Client(), B = Client(); await boot(A); await boot(B);
  console.log('two clients sync'); ok(A.S.chores.length === 2 && B.S.chores.length === 2, 'both boot to the same state');

  console.log('a check on one device shows up on the other');
  { A.S.week.completion['c2#1'] = { date: '2026-06-16', snap: null }; await save(A, Date.now()); await pull(B); ok(!!B.S.week.completion['c2#1'], 'B sees the box A checked'); }

  console.log('different boxes checked at once -> both stick');
  {
    A.S.week.completion['cX'] = { date: '2026-06-17', snap: null };
    B.S.week.completion['cY'] = { date: '2026-06-17', snap: null };
    await save(A, Date.now()); await save(B, Date.now()); await pull(A); await pull(B);
    ok(A.S.week.completion['cX'] && A.S.week.completion['cY'], 'A has both');
    ok(B.S.week.completion['cX'] && B.S.week.completion['cY'], 'B has both (no clobber)');
  }

  console.log('different chores edited at once -> both stick');
  {
    A.S.chores.find(c => c.id === 'c1').name = 'Dishwasher';
    B.S.chores.find(c => c.id === 'c2').name = 'Garbage';
    await save(A, Date.now()); await save(B, Date.now()); await pull(A); await pull(B);
    const both = c => c.S.chores.find(x => x.id === 'c1').name === 'Dishwasher' && c.S.chores.find(x => x.id === 'c2').name === 'Garbage';
    ok(both(A), 'A has both edits'); ok(both(B), 'B has both edits');
  }

  console.log('same chore edited at once -> later write wins, loser gets a conflict + converges');
  {
    const T = Date.now() + 10000;
    B.S.chores.find(c => c.id === 'c1').name = 'B wins';
    const rb = await save(B, T);
    A.S.chores.find(c => c.id === 'c1').name = 'A stale';
    const ra = await save(A, T - 5000);
    ok(rb.applied.length >= 1, "B's newer write applied");
    ok(ra.conflicts.some(c => c.collection === 'chores' && c.id === 'c1'), "A's stale write rejected as conflict");
    await pull(A);
    ok(A.S.chores.find(c => c.id === 'c1').name === 'B wins', 'A converges on the winner after pull');
  }
}

main()
  .catch(e => { console.error(e); fails++; })
  .finally(() => {
    srv.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    console.log(fails ? `\n${fails} INTEGRATION CHECK(S) FAILED` : '\nALL INTEGRATION CHECKS PASSED');
    process.exitCode = fails ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 200).unref();
  });
