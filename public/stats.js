// stats.js — PURE, side-effect-free aggregation over the durable completion `history`.
// No DOM, no I/O, no Date.now (the caller passes `sinceISO`). Feeds the History view; unit-tested.
// A history record is { id, choreId, name, personId, minutes, date(ISO), weekStartISO, priority, late }.

export function summarizeHistory(history, people, opts = {}) {
  const since = opts.sinceISO || null;
  const recs = (history || []).filter(h => h && h.date && (!since || h.date >= since));
  const byId = Object.fromEntries((people || []).map(p => [p.id, p]));

  // Seed a row for every active-ish person so someone who did nothing still shows as 0 (honest).
  const rows = {};
  for (const p of (people || [])) rows[p.id] = { id: p.id, name: p.name, color: p.color, tasks: 0, minutes: 0 };

  let totalMinutes = 0, totalTasks = 0;
  const chores = {};
  for (const h of recs) {
    const pid = h.personId;
    if (!rows[pid]) rows[pid] = { id: pid, name: (byId[pid] && byId[pid].name) || 'Former member', color: (byId[pid] && byId[pid].color) || '#9aa6a0', tasks: 0, minutes: 0 };
    rows[pid].tasks++; rows[pid].minutes += (h.minutes || 0);
    totalTasks++; totalMinutes += (h.minutes || 0);
    const k = h.choreId || h.name;
    chores[k] = chores[k] || { name: h.name || k, count: 0, minutes: 0 };
    chores[k].count++; chores[k].minutes += (h.minutes || 0);
  }

  const perPerson = Object.values(rows)
    .map(r => ({ ...r, share: totalMinutes ? Math.round(r.minutes / totalMinutes * 100) : 0 }))
    .sort((a, b) => b.minutes - a.minutes || b.tasks - a.tasks);
  const topChores = Object.values(chores).sort((a, b) => b.count - a.count || b.minutes - a.minutes).slice(0, 8);
  const recent = recs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 15);
  const daysActive = new Set(recs.map(h => h.date)).size;

  return { totalMinutes, totalTasks, count: recs.length, daysActive, perPerson, topChores, recent };
}
