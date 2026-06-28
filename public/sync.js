// sync.js — pure, side-effect-free sync core. No DOM, no I/O, no Node APIs.
// Shared by server.js (Node), app.js (browser), and test/sync.test.js.
//
// The board has two shapes:
//   - WHOLE-DOC `S`  : the familiar { rev, people[], chores[], rooms[], matrixTypes[],
//                      matrixExclude[], settings{}, week{ ...,completion{} } } the engine + UI use.
//   - ENTITIES `ent` : addressable records carrying sync metadata, the unit of delta sync.
//
// Keyed collections hold { id: rec }; singletons hold one rec (or null). Every rec gains
// underscore-prefixed metadata the engine ignores:
//   _seq        server-assigned monotonic sequence; higher wins (server resolves LWW first).
//   _updatedAt  client edit time (ms); the server uses it for last-write-wins on POST.
//   _deleted    tombstone, so deletes propagate.
//
// Mapping whole-doc <-> entities:
//   people/chores/rooms/matrixTypes  <-> same-named keyed collections (by id)
//   week.completion                  <-> `completion` keyed collection (by assignment uid)
//   history (durable completion log)  <-> `history` keyed collection (by its own id)
//   settings + matrixExclude         <-> `settings` singleton (matrixExclude folded in)
//   week minus completion            <-> `week` singleton
//
// `completion` is the CURRENT week's check-offs (cleared/rebuilt every generate). `history` is the
// PERMANENT log of completed tasks (one record per check-off, never cleared) that the stats view reads.

export const KEYED = ['people', 'chores', 'rooms', 'matrixTypes', 'completion', 'history'];
export const SINGLE = ['settings', 'week'];
export const COLLECTIONS = [...KEYED, ...SINGLE];

const META = new Set(['_seq', '_updatedAt', '_deleted']);

/* ---------- small pure helpers ---------- */
export function emptyEnt() {
  return { people: {}, chores: {}, rooms: {}, matrixTypes: {}, completion: {}, history: {}, settings: null, week: null };
}
export function domainOf(rec) {
  const out = {};
  for (const k of Object.keys(rec || {})) if (!META.has(k)) out[k] = rec[k];
  return out;
}
function cloneEnt(ent) { return JSON.parse(JSON.stringify(ent)); }
// Order-insensitive structural compare, so a server round-trip (which may reorder keys)
// doesn't read as a local edit.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function eq(a, b) { return stable(a) === stable(b); }
const isLive = rec => rec && !rec._deleted;

/* ---------- whole-doc  ->  entities (domain-only; no metadata) ---------- */
export function decompose(S) {
  const ent = emptyEnt();
  for (const coll of ['people', 'chores', 'rooms', 'matrixTypes', 'history'])
    for (const rec of (S[coll] || [])) if (rec && rec.id != null) ent[coll][rec.id] = domainOf(rec);
  const comp = (S.week && S.week.completion) || {};
  for (const uid of Object.keys(comp)) ent.completion[uid] = domainOf(comp[uid]);
  const st = S.settings || {};
  ent.settings = {
    graceDays: st.graceDays ?? 3, escalateAfter: st.escalateAfter ?? 2,
    weekStartISO: st.weekStartISO ?? null, fairness: st.fairness ?? 'balanced', matrixExclude: S.matrixExclude || [],
  };
  if (S.week) { const { completion, ...wk } = S.week; ent.week = domainOf(wk); }
  return ent;
}

/* ---------- entities  ->  whole-doc (skips tombstones; rebuilds folded fields) ---------- */
export function recompose(ent, serverSeq = 0) {
  const S = { rev: serverSeq };
  for (const coll of ['people', 'chores', 'rooms', 'matrixTypes', 'history'])
    S[coll] = Object.values(ent[coll] || {}).filter(isLive).map(domainOf);
  const st = isLive(ent.settings) ? ent.settings : {};
  S.settings = { graceDays: st.graceDays ?? 3, escalateAfter: st.escalateAfter ?? 2, weekStartISO: st.weekStartISO ?? null, fairness: st.fairness ?? 'balanced' };
  S.matrixExclude = st.matrixExclude || [];
  if (isLive(ent.week)) {
    S.week = { ...domainOf(ent.week), completion: {} };
    for (const [uid, rec] of Object.entries(ent.completion || {})) if (isLive(rec)) S.week.completion[uid] = domainOf(rec);
  } else S.week = null;
  return S;
}

/* ---------- apply a batch of remote changes to a local ent (pure) ----------
 * A change is { collection, id, rec }; rec carries _seq (and maybe _deleted). Higher _seq wins
 * (the server already resolved LWW by _updatedAt before assigning _seq). Records whose
 * `${collection}:${id}` is in `skip` are left untouched — that's how an unsynced local edit in
 * the outbox survives a pull that would otherwise overwrite it with an older server value.
 */
export function applyChanges(ent, changes, opts = {}) {
  const skip = opts.skip || new Set();
  const next = cloneEnt(ent);
  const applied = [];
  for (const { collection, id, rec } of changes) {
    if (!COLLECTIONS.includes(collection)) continue;
    if (skip.has(collection + ':' + id)) continue;
    const cur = SINGLE.includes(collection) ? next[collection] : next[collection][id];
    if (cur && (cur._seq || 0) >= (rec._seq || 0)) continue; // already have this or newer
    if (SINGLE.includes(collection)) next[collection] = rec; else next[collection][id] = rec;
    applied.push({ collection, id, seq: rec._seq });
  }
  return { ent: next, applied };
}

/* ---------- diff a freshly-edited whole-doc against the synced ent (pure) ----------
 * Returns the ops to POST plus the new ent reflecting those edits optimistically (real _seq is
 * filled in once the server echoes the write). `now` is injected so this stays pure/testable.
 * Op shape: { collection, id, rec, baseSeq } — rec is domain + _updatedAt (+ _deleted for a delete).
 */
export function diffOps(prevEnt, S, now) {
  const target = decompose(S);
  const next = cloneEnt(prevEnt);
  const ops = [];
  const upsert = (coll, id, domain, prevRec) => {
    const baseSeq = prevRec ? (prevRec._seq || 0) : 0;
    ops.push({ collection: coll, id, rec: { ...domain, _updatedAt: now }, baseSeq });
    if (SINGLE.includes(coll)) next[coll] = { ...domain, _updatedAt: now, _seq: baseSeq };
    else next[coll][id] = { ...domain, _updatedAt: now, _seq: baseSeq };
  };
  const tombstone = (coll, id, prevRec) => {
    ops.push({ collection: coll, id, rec: { _deleted: true, _updatedAt: now }, baseSeq: prevRec._seq || 0 });
    const dead = { _deleted: true, _updatedAt: now, _seq: prevRec._seq || 0 };
    if (SINGLE.includes(coll)) next[coll] = dead; else next[coll][id] = dead;
  };

  for (const coll of KEYED) {
    const tgt = target[coll] || {}, prev = prevEnt[coll] || {};
    for (const id of Object.keys(tgt)) {
      const prevRec = prev[id];
      if (!isLive(prevRec) || !eq(domainOf(prevRec), tgt[id])) upsert(coll, id, tgt[id], prevRec);
    }
    for (const id of Object.keys(prev)) if (!tgt[id] && isLive(prev[id])) tombstone(coll, id, prev[id]);
  }
  for (const coll of SINGLE) {
    const tgt = target[coll], prevRec = prevEnt[coll];
    if (tgt) { if (!isLive(prevRec) || !eq(domainOf(prevRec), tgt)) upsert(coll, coll, tgt, prevRec); }
    else if (isLive(prevRec)) tombstone(coll, coll, prevRec);
  }
  return { ops, next };
}
