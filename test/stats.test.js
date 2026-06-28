// test/stats.test.js — run with `node test/stats.test.js` (no dependencies).
import { summarizeHistory } from '../public/stats.js';

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error('  FAIL', m, '=>', A, '!==', B); fails++; }
  else console.log('  ok  ', m);
};
const ok = (c, m) => { if (c) console.log('  ok  ', m); else { console.error('  FAIL', m); fails++; } };

const people = [
  { id: 'me', name: 'Me', color: '#1', isAdult: true },
  { id: 'kid', name: 'Kid', color: '#2', isAdult: false },
  { id: 'lazy', name: 'Lazy', color: '#3', isAdult: false },
];
const history = [
  { id: 'h1', choreId: 'c1', name: 'Dishes', personId: 'me', minutes: 10, date: '2026-06-20' },
  { id: 'h2', choreId: 'c1', name: 'Dishes', personId: 'kid', minutes: 10, date: '2026-06-21' },
  { id: 'h3', choreId: 'c2', name: 'Trash', personId: 'me', minutes: 5, date: '2026-06-21' },
  { id: 'h4', choreId: 'c1', name: 'Dishes', personId: 'me', minutes: 10, date: '2026-05-01' }, // older
];

console.log('summarizeHistory');
{
  const all = summarizeHistory(history, people);
  eq([all.totalTasks, all.totalMinutes], [4, 35], 'all-time totals');
  eq(all.daysActive, 3, 'distinct active days counted');
  const me = all.perPerson.find(p => p.id === 'me');
  eq([me.tasks, me.minutes], [3, 25], "Me's tally");
  eq(all.perPerson[0].id, 'me', 'busiest person sorts first');
  ok(all.perPerson.some(p => p.id === 'lazy' && p.minutes === 0), 'someone who did nothing still appears at 0 (honest)');
  eq(all.perPerson.find(p => p.id === 'me').share + all.perPerson.find(p => p.id === 'kid').share + all.perPerson.find(p => p.id === 'lazy').share, 71 + 29 + 0, 'shares are percentages of total minutes');
  eq(all.topChores[0].name, 'Dishes', 'most-done chore ranks first');
  eq(all.recent[0].date, '2026-06-21', 'recent log is newest-first');
}
{
  const recent = summarizeHistory(history, people, { sinceISO: '2026-06-01' });
  eq([recent.totalTasks, recent.totalMinutes], [3, 25], 'range filter drops the old record');
}

console.log(fails ? `\n${fails} TEST(S) FAILED` : '\nALL TESTS PASSED');
process.exit(fails ? 1 : 0);
