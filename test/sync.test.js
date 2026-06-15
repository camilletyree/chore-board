// test/sync.test.js — run with `node test/sync.test.js` (no dependencies).
// Covers the pure sync core: decompose/recompose round-trips and the applyChanges/diffOps reducers.
import {
  emptyEnt, decompose, recompose, applyChanges, diffOps, KEYED, SINGLE,
} from '../public/sync.js';

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error('  FAIL', m, '=>', A, '!==', B); fails++; }
  else console.log('  ok  ', m);
};
const NOW = 1_700_000_000_000;

function sampleDoc() {
  return {
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
    week: {
      weekStartISO: '2026-06-15', weekId: 'w1', assignments: [{ uid: 'c1#0' }], unassigned: [], load: [],
      completion: { 'c1#0': { date: '2026-06-15', snap: null } },
    },
  };
}

// Stamp an ent's records as if the server applied them all at seq 1 (mirrors migration).
function stamp(ent, seq = 1) {
  for (const c of KEYED) for (const id of Object.keys(ent[c])) ent[c][id] = { ...ent[c][id], _seq: seq, _updatedAt: NOW };
  for (const c of SINGLE) if (ent[c]) ent[c] = { ...ent[c], _seq: seq, _updatedAt: NOW };
  return ent;
}

console.log('decompose / recompose round-trip');
{
  const S = sampleDoc();
  const ent = decompose(S);
  eq(Object.keys(ent.chores).sort(), ['c1', 'c2'], 'chores keyed by id');
  eq(ent.completion['c1#0'].date, '2026-06-15', 'completion lifted out of week into its own collection');
  eq(ent.week.completion, undefined, 'week singleton no longer carries completion');
  eq(ent.settings.matrixExclude, ['t1:r1'], 'matrixExclude folded into settings');

  const S2 = recompose(stamp(decompose(S)), 7);
  eq(S2.rev, 7, 'recompose stamps rev from serverSeq');
  eq(S2.chores.length, 2, 'chores restored');
  eq(S2.matrixExclude, ['t1:r1'], 'matrixExclude split back out of settings');
  eq(S2.settings.matrixExclude, undefined, 'settings no longer carries matrixExclude after recompose');
  eq(S2.week.completion['c1#0'].date, '2026-06-15', 'completion folded back into week');
  eq(S2.people, S.people, 'people survive a full round-trip');
}

console.log('applyChanges: seq-ordered LWW');
{
  const ent = stamp(decompose(sampleDoc()));   // everything at _seq 1
  const r1 = applyChanges(ent, [{ collection: 'chores', id: 'c1', rec: { id: 'c1', name: 'Dishes v2', _seq: 5, _updatedAt: NOW } }]);
  eq(r1.ent.chores.c1.name, 'Dishes v2', 'higher _seq overwrites');
  eq(r1.applied.length, 1, 'one change applied');
  const r2 = applyChanges(r1.ent, [{ collection: 'chores', id: 'c1', rec: { id: 'c1', name: 'stale', _seq: 3, _updatedAt: NOW } }]);
  eq(r2.ent.chores.c1.name, 'Dishes v2', 'lower (out-of-order) _seq is ignored');
  eq(r2.applied.length, 0, 'nothing applied for a stale change');
}

console.log('applyChanges: tombstones + new records');
{
  const ent = stamp(decompose(sampleDoc()));
  const r = applyChanges(ent, [
    { collection: 'chores', id: 'c2', rec: { id: 'c2', _seq: 6, _updatedAt: NOW, _deleted: true } },
    { collection: 'people', id: 'kid', rec: { id: 'kid', name: 'Kid', isAdult: false, active: true, _seq: 7, _updatedAt: NOW } },
  ]);
  const S = recompose(r.ent, 7);
  eq(S.chores.map(c => c.id), ['c1'], 'tombstoned chore drops out of the whole-doc');
  eq(S.people.map(p => p.id), ['me', 'kid'], 'a brand-new remote record appears');
}

console.log('applyChanges: completion records are independent');
{
  const ent = stamp(decompose(sampleDoc()));
  const r = applyChanges(ent, [
    { collection: 'completion', id: 'c2#1', rec: { date: '2026-06-16', snap: null, _seq: 8, _updatedAt: NOW } },
  ]);
  eq(Object.keys(r.ent.completion).sort(), ['c1#0', 'c2#1'], 'checking a different box adds a record without touching the other');
}

console.log('applyChanges: skip protects an unsynced local edit');
{
  const ent = stamp(decompose(sampleDoc()));
  const r = applyChanges(ent, [{ collection: 'chores', id: 'c1', rec: { id: 'c1', name: 'remote', _seq: 9, _updatedAt: NOW } }], { skip: new Set(['chores:c1']) });
  eq(r.ent.chores.c1.name, 'Dishes', 'a pending (skipped) record is not overwritten by a pull');
  eq(r.applied.length, 0, 'skipped change is not counted as applied');
}

console.log('diffOps: only the touched entity becomes an op');
{
  const ent = stamp(decompose(sampleDoc()));
  const S = recompose(ent, 1);
  eq(diffOps(ent, S, NOW).ops.length, 0, 'no edits => no ops (key-order-insensitive compare)');

  // check a box: one completion upsert, nothing else
  S.week.completion['c2#1'] = { date: '2026-06-16', snap: null };
  const d1 = diffOps(ent, S, NOW);
  eq(d1.ops.length, 1, 'checking a box yields exactly one op');
  eq([d1.ops[0].collection, d1.ops[0].id], ['completion', 'c2#1'], 'and it targets only that completion record');
  eq(d1.next.completion['c2#1']._updatedAt, NOW, 'optimistic ent reflects the local edit');
}
{
  // edit a chore name -> single chore op; settings + others untouched
  const ent = stamp(decompose(sampleDoc()));
  const S = recompose(ent, 1);
  S.chores.find(c => c.id === 'c1').name = 'Wash up';
  const d = diffOps(ent, S, NOW);
  eq(d.ops.map(o => o.collection + ':' + o.id), ['chores:c1'], 'editing one chore touches only that chore');
  eq(d.ops[0].baseSeq, 1, 'op carries the prior _seq as baseSeq');
}
{
  // delete a chore -> tombstone op
  const ent = stamp(decompose(sampleDoc()));
  const S = recompose(ent, 1);
  S.chores = S.chores.filter(c => c.id !== 'c2');
  const d = diffOps(ent, S, NOW);
  eq(d.ops.map(o => o.collection + ':' + o.id), ['chores:c2'], 'deleting a chore yields one op');
  eq(d.ops[0].rec._deleted, true, 'the op is a tombstone');
}
{
  // settings + matrixExclude both live in the settings singleton
  const ent = stamp(decompose(sampleDoc()));
  const S = recompose(ent, 1);
  S.settings.graceDays = 5;
  S.matrixExclude = [];
  const d = diffOps(ent, S, NOW);
  eq(d.ops.map(o => o.collection), ['settings'], 'settings + matrixExclude edits collapse into one settings op');
  eq(d.ops[0].rec.matrixExclude, [], 'matrixExclude travels inside the settings record');
}

console.log(fails ? `\n${fails} TEST(S) FAILED` : '\nALL TESTS PASSED');
process.exit(fails ? 1 : 0);
