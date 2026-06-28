// test/templates.test.js — run with `node test/templates.test.js` (no dependencies).
// Covers the pure home-template engine: tag gating, room derivation, age budgets, the builder,
// matrix-exclusion correctness, minAge/age plumbing, and determinism.
import {
  PRESETS, presetByKey, MATRIX_TYPES,
  tagsFor, deriveRooms, manualFor, ageBudget, peopleFor, buildHome, summarize, validateLibrary,
} from '../public/templates.js';

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error('  FAIL', m, '=>', A, '!==', B); fails++; }
  else console.log('  ok  ', m);
};
const ok = (c, m) => { if (c) console.log('  ok  ', m); else { console.error('  FAIL', m); fails++; } };

const SHOW = presetByKey('family4-3b3b');                 // 2 adults, kids 10 & 6, dog, yard, 3b/3b, 2 floors
const APT = presetByKey('apartment-family-young-kids');   // pet-free, yard-free apartment, kids 8 & 5
const SOLO = presetByKey('studio-solo');                  // studio, no dishwasher
const BABY = presetByKey('small-new-baby');               // 2 adults + a 1-year-old

console.log('library is internally valid');
eq(validateLibrary(), [], 'every library entry has sane minutes/priority/cadence/appliesTo');
ok(PRESETS.length >= 8, 'presets span a range of homes');
ok(!!SHOW && !!APT && !!SOLO && !!BABY, 'the presets the tests rely on all exist');

console.log('age -> budgets');
{
  eq(ageBudget(40).isAdult, true, 'an adult is an adult');
  eq(ageBudget(40).maxTaskMinutes, 0, 'adults have no task cap');
  eq([ageBudget(10).weekdayBudget, ageBudget(10).maxTaskMinutes], [20, 20], '10-year-old budget + cap');
  eq([ageBudget(6).weekdayBudget, ageBudget(6).maxTaskMinutes], [10, 12], '6-year-old budget + cap');
  eq(ageBudget(5).isAdult, false, 'a 5-year-old is a (very light) helper');
}

console.log('tag gating reflects the home');
{
  const ts = tagsFor(SHOW);
  ok(ts.has('pet_dog') && !ts.has('pet_cat'), 'dog home gets pet_dog, not pet_cat');
  ok(ts.has('yard') && ts.has('multistory') && ts.has('kids') && ts.has('dishwasher'), 'yard + multistory + kids + dishwasher');
  const ta = tagsFor(APT);
  ok(!ta.has('pet') && !ta.has('yard') && !ta.has('car'), 'a pet-free, yard-free apartment gets none of those');
  ok(tagsFor(SOLO).has('no_dishwasher'), 'a dishwasher-less studio gets the hand-wash path');
  ok(tagsFor(BABY).has('baby'), 'a home with an infant gets the baby tag');
}

console.log('rooms derive from the home shape');
{
  const rooms = deriveRooms(SHOW);
  eq(rooms.filter(r => r.kind === 'bedroom').length, 3, '3 beds -> 3 bedrooms');
  eq(rooms.filter(r => r.kind === 'bathroom').length, 3, '3 baths -> 3 bathrooms');
  ok(rooms.some(r => r.kind === 'stairs'), '2 floors -> a stairs room');
  ok(rooms.some(r => r.kind === 'garage') && rooms.some(r => r.kind === 'dining') && rooms.some(r => r.kind === 'outdoor'), 'garage + dining + yard present');
  eq(new Set(rooms.map(r => r.id)).size, rooms.length, 'room ids are unique');
  eq(deriveRooms(SOLO).filter(r => r.kind === 'bedroom').length, 0, 'a studio has no separate bedroom');
}

console.log('manual chores are gated by what the home has');
{
  const m = manualFor(SHOW).map(c => c.key);
  ok(m.includes('walk-dog'), 'dog home walks the dog');
  ok(!m.includes('scoop-litter'), 'dog home does not scoop a litter box');
  ok(m.includes('load-run-dishwasher'), 'a dishwasher home runs the dishwasher');
  const ma = manualFor(APT).map(c => c.key);
  ok(!ma.includes('walk-dog') && !ma.includes('mow-lawn'), 'an apartment skips dog + yard chores');
  const ms = manualFor(SOLO).map(c => c.key);
  ok(ms.includes('hand-wash-dishes') && !ms.includes('load-run-dishwasher'), 'a dishwasher-less home hand-washes and never runs a dishwasher');
}

console.log('the builder produces a coherent board');
{
  const board = buildHome(SHOW);
  eq(board.people.length, 4, '2 adults + 2 kids = 4 people');
  eq(board.people.filter(p => p.isAdult).length, 2, 'two adults');
  const ten = board.people.find(p => p.age === 10);
  ok(ten && [ten.weekdayBudget, ten.maxTaskMinutes].join() === '20,20', 'the 10-year-old gets age-appropriate budgets and an age');
  ok(board.people.filter(p => p.isAdult).every(p => p.age === null), 'adults carry no age constraint');
  ok(board.chores.some(c => c.matrixKey), 'matrix-derived chores were generated');
  ok(board.chores.some(c => !c.matrixKey), 'manual chores are present too');
  ok(board.chores.some(c => c.matrixKey && c.minAge >= 10), 'minAge flows onto derived chores (e.g. scrub toilet)');
  ok(board.chores.some(c => !c.matrixKey && c.minAge >= 18), 'minAge flows onto manual chores (e.g. clean the oven)');
  ok(board.settings.fairness === 'balanced', 'fairness defaults to balanced');
  ok(Array.isArray(board.history) && board.history.length === 0, 'a fresh board has an empty history');
  eq(new Set(board.chores.map(c => c.id)).size, board.chores.length, 'chore ids are unique');

  // matrix-exclusion correctness: every derived chore sits in a room whose kind its type allows
  const appliesByKey = Object.fromEntries(MATRIX_TYPES.map(t => [t.key, t.appliesTo]));
  const kindById = Object.fromEntries(deriveRooms(SHOW).map(r => [r.id, r.kind]));
  let bad = 0;
  for (const c of board.chores.filter(c => c.matrixKey)) {
    const [typeId, roomId] = c.matrixKey.split(':');
    const allowed = appliesByKey[typeId.replace(/^t_/, '')] || [];
    if (!allowed.includes(kindById[roomId])) bad++;
  }
  eq(bad, 0, 'no derived chore lands in a room its type does not apply to (e.g. no toilet in the kitchen)');
  ok(!board.chores.some(c => /litter/i.test(c.name)), 'no cat -> no litter-box chore on the board');
}

console.log('toddlers generate chores but are not put on the team');
{
  eq(peopleFor(BABY).length, 2, 'the infant (age 1) is not a team member; the two adults are');
  ok(buildHome(BABY).chores.some(c => c.id === 'c_wash-baby-bottles'), 'but the infant still generates baby-care chores');
}

console.log('the builder is deterministic');
eq(JSON.stringify(buildHome(SHOW)), JSON.stringify(buildHome(SHOW)), 'same profile in -> identical board out');

console.log('summary matches the board');
{
  const s = summarize(SHOW), b = buildHome(SHOW);
  eq([s.people, s.chores], [b.people.length, b.chores.length], 'summary counts agree with the built board');
}

console.log(fails ? `\n${fails} TEST(S) FAILED` : '\nALL TESTS PASSED');
process.exit(fails ? 1 : 0);
