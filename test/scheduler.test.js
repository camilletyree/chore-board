// test/scheduler.test.js — run with `node test/scheduler.test.js` (no dependencies).
import {
  addCadence, toISO, rollForward, buildInstances, assignInstances, applyMatrix, sizeFactor
} from '../public/scheduler.js';

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error('  FAIL', m, '=>', A, '!==', B); fails++; }
  else console.log('  ok  ', m);
};

const people = [
  { id: 'me', name: 'Me', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true },
  { id: 'gabby', name: 'Gabby', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true },
  { id: 'kid10', name: 'Son', isAdult: false, weekdayBudget: 20, weekendBudget: 40, maxTaskMinutes: 20, active: true },
  { id: 'kid6', name: 'Daughter', isAdult: false, weekdayBudget: 10, weekendBudget: 20, maxTaskMinutes: 10, active: true },
];
const WS = '2026-06-15';        // Monday
const TODAY = '2026-06-18';     // Thursday
const horizon = '2026-06-21';

function chore(over) { return Object.assign({ id: 'c', name: 'C', minutes: 10, priority: 3, intervalCount: 1, intervalUnit: 'weeks', adultOnly: false, assignee: null, lastDone: null, holder: null, assignedOn: null, escalated: false, enabled: true, matrixKey: null }, over); }

console.log('cadence units');
eq(toISO(addCadence('2026-01-31', 1, 'months')), '2026-03-03', 'Jan 31 + 1 month (JS overflow)');
eq(toISO(addCadence('2026-06-15', 2, 'weeks')), '2026-06-29', '2 weeks');
eq(toISO(addCadence('2024-02-29', 1, 'years')), '2025-03-01', '1 year from leap day');
eq(toISO(addCadence('2026-06-15', 1, 'days')), '2026-06-16', '1 day');

console.log('obligation lifecycle');
{
  const c = [chore({ intervalCount: 1, intervalUnit: 'days' })];
  rollForward(c, { todayISO: TODAY, horizonISO: horizon, grace: 3, escalateAfter: 2, people });
  eq(!!c[0].assignedOn, true, 'never-done chore opens an obligation');
}
{
  const c = [chore({ holder: 'me', assignedOn: '2026-06-14' })]; // 4 days before today
  const inst = buildInstances(c, WS, TODAY, 3);
  eq(inst[0].delinquent, true, 'past grace window -> delinquent');
  eq(buildInstances([chore({ holder: 'me', assignedOn: TODAY })], WS, TODAY, 3)[0].delinquent, false, 'same-day not delinquent');
}

console.log('escalation to an adult after 2 delinquency cycles');
{
  // auto-held by a child, assigned 6 days ago, grace 3 => late = 2 => escalate
  const c = [chore({ holder: 'kid6', assignedOn: '2026-06-12' })];
  rollForward(c, { todayISO: TODAY, horizonISO: horizon, grace: 3, escalateAfter: 2, people });
  eq(c[0].escalated, true, 'stale child obligation is flagged escalated');
  eq(c[0].holder, null, 'holder released for adult reassignment');
  const inst = buildInstances(c, WS, TODAY, 3);
  eq(inst[0].adultOnly, true, 'escalated instance is forced adult-only');
  const r = assignInstances(inst, people);
  eq(people.find(p => p.id === r.assignments[0].personId).isAdult, true, 'escalated task lands on an adult');
}
{
  // only 1 cycle late => NOT escalated yet
  const c = [chore({ holder: 'kid6', assignedOn: '2026-06-15' })]; // 3 days => late 1
  rollForward(c, { todayISO: TODAY, horizonISO: horizon, grace: 3, escalateAfter: 2, people });
  eq(c[0].escalated, false, 'one cycle late does not escalate');
  eq(c[0].holder, 'kid6', 'still held by the child after one cycle');
}
{
  // explicit assignee to a child is NOT auto-escalated (deliberate choice)
  const c = [chore({ assignee: 'kid6', holder: 'kid6', assignedOn: '2026-06-10' })];
  rollForward(c, { todayISO: TODAY, horizonISO: horizon, grace: 3, escalateAfter: 2, people });
  eq(c[0].holder, 'kid6', 'forced child assignee overrides escalation');
  eq(c[0].escalated, false, 'forced assignee never escalates');
}

console.log('assignment constraints');
{
  // locked child holder keeps an over-budget task (force-placed, not dropped)
  const inst = buildInstances([chore({ holder: 'kid6', minutes: 30, assignedOn: '2026-06-14' })], WS, TODAY, 3);
  const r = assignInstances(inst, people);
  eq(r.assignments[0].personId, 'kid6', 'locked holder kept even over budget/cap');
  eq(r.unassigned.length, 0, 'force-placed, not unassigned');
}
{
  // unlocked adult-only never goes to a child
  const inst = buildInstances([chore({ adultOnly: true, assignedOn: TODAY })], WS, TODAY, 3);
  const r = assignInstances(inst, people);
  eq(people.find(p => p.id === r.assignments[0].personId).isAdult, true, 'adult-only stays with an adult');
}
{
  // explicit assignee overrides adult-only
  const inst = buildInstances([chore({ adultOnly: true, assignee: 'kid6', holder: 'kid6', assignedOn: TODAY })], WS, TODAY, 3);
  eq(assignInstances(inst, people).assignments[0].personId, 'kid6', 'explicit assignee overrides adult-only');
}

console.log('matrix: size scaling + exclusions');
{
  eq([sizeFactor('small'), sizeFactor('medium'), sizeFactor('large'), sizeFactor('huge')], [0.5, 1, 1.3, 2], 'size factors');
  const rooms = [
    { id: 'r1', name: 'Living room', size: 'large' },
    { id: 'r2', name: 'Kitchen', size: 'medium' },
    { id: 'r3', name: 'Game room', size: 'small' },
  ];
  const types = [
    { id: 't1', name: 'Tidy', minutes: 10, priority: 3, intervalCount: 1, intervalUnit: 'days', adultOnly: false, assignee: null },
    { id: 't2', name: 'Vacuum', minutes: 20, priority: 3, intervalCount: 1, intervalUnit: 'weeks', adultOnly: false, assignee: null },
    { id: 't3', name: 'Mop', minutes: 20, priority: 3, intervalCount: 2, intervalUnit: 'weeks', adultOnly: true, assignee: null },
  ];
  // exclude Mop in the (carpeted) game room
  const exclude = ['t3:r3'];
  let ch = applyMatrix([], rooms, types, exclude);
  eq(ch.length, 3 * 3 - 1, '9 cells minus 1 exclusion = 8 chores');
  eq(ch.some(c => c.matrixKey === 't3:r3'), false, 'excluded cell not generated');
  eq(ch.find(c => c.matrixKey === 't2:r1').minutes, 26, 'Vacuum large room = 20 * 1.3 = 26 min');
  eq(ch.find(c => c.matrixKey === 't1:r3').minutes, 5, 'Tidy small room = 10 * 0.5 = 5 min');
  eq(ch.find(c => c.matrixKey === 't1:r2').minutes, 10, 'Tidy medium room = 10 min unchanged');

  // state preserved across re-apply; per-room assignee override survives; re-enabling the cell regenerates it
  ch.find(c => c.matrixKey === 't1:r1').lastDone = '2026-06-10';
  ch.find(c => c.matrixKey === 't1:r1').assignee = 'kid10';
  const ch2 = applyMatrix(ch, rooms, types, []); // un-exclude mop/game room
  eq(ch2.length, 9, 're-including the cell regenerates it');
  eq(ch2.find(c => c.matrixKey === 't1:r1').lastDone, '2026-06-10', 'lastDone preserved on re-apply');
  eq(ch2.find(c => c.matrixKey === 't1:r1').assignee, 'kid10', 'per-room assignee override preserved');
}

console.log('fairness modes');
{
  // two equally-free adults; the chore was last held by "me"
  const adults = [
    { id: 'me', name: 'Me', isAdult: true, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'gabby', name: 'Gabby', isAdult: true, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true },
  ];
  const inst = buildInstances([chore({ adultOnly: true, assignedOn: TODAY, lastHolder: 'me' })], WS, TODAY, 3);
  eq(assignInstances(inst, adults).assignments[0].personId, 'me', 'balanced keeps the most-free (stable) pick');
  eq(assignInstances(inst, adults, { fairness: 'rotate', seed: WS }).assignments[0].personId, 'gabby', 'rotate steers away from the last holder');

  // rotate still balances among the non-last-holders by capacity
  const three = [
    { id: 'me', isAdult: true, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'gabby', isAdult: true, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'pat', isAdult: true, weekdayBudget: 5, weekendBudget: 5, maxTaskMinutes: 0, active: true },
  ];
  const r = assignInstances(buildInstances([chore({ adultOnly: true, assignedOn: TODAY, lastHolder: 'me' })], WS, TODAY, 3), three, { fairness: 'rotate', seed: WS });
  eq(r.assignments[0].personId, 'gabby', 'rotate picks the freest among the non-last-holders, not the last holder');

  // deterministic for a given seed (reproducible shuffle, no Math.random)
  const a = assignInstances(inst, adults, { fairness: 'rotate', seed: '2026-06-15' }).assignments[0].personId;
  const b = assignInstances(inst, adults, { fairness: 'rotate', seed: '2026-06-15' }).assignments[0].personId;
  eq(a, b, 'rotate is deterministic for a given seed');
}

console.log('age-appropriateness (minAge)');
{
  const ages = [
    { id: 'mom', isAdult: true, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'kid8', isAdult: false, age: 8, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'kid14', isAdult: false, age: 14, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true },
  ];
  const mk = () => buildInstances([chore({ minAge: 12, assignedOn: TODAY })], WS, TODAY, 3);
  eq(assignInstances(mk(), ages).assignments[0].personId !== 'kid8', true, 'a minAge-12 chore never lands on the 8-year-old');
  eq(assignInstances(mk(), [ages[1], ages[2]]).assignments[0].personId, 'kid14', 'among kids, only the old-enough one (14) takes a minAge-12 chore');
  const legacy = [{ id: 'x', isAdult: false, weekdayBudget: 60, weekendBudget: 60, maxTaskMinutes: 0, active: true }];
  eq(assignInstances(mk(), legacy).assignments[0].personId, 'x', 'a person with no age set is unconstrained by minAge (back-compat)');
}

console.log(fails ? `\n${fails} TEST(S) FAILED` : '\nALL TESTS PASSED');
process.exit(fails ? 1 : 0);
