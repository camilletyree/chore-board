// scheduler.js — pure, side-effect-free scheduling logic.
// Imported by the browser app (app.js) and by the test suite. No DOM, no I/O.

export const UNITS = ['days', 'weeks', 'months', 'years'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const SIZE_FACTORS = { small: 0.5, medium: 1.0, large: 1.3, huge: 2.0 };

/* ---------- date helpers (date-only, local, midnight-anchored) ---------- */
export function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function toISO(dt) { const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, '0'), d = String(dt.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
export function addDays(dt, n) { const c = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); c.setDate(c.getDate() + n); return c; }
export function diffDays(a, b) { return Math.round((a - b) / 86400000); }
export function isWeekend(i) { return i === 5 || i === 6; }
export function mondayOf(dt) { const c = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); const off = (c.getDay() + 6) % 7; return addDays(c, -off); }
export function daysByCloseness(t) { const o = [t]; for (let k = 1; k < 7; k++) { if (t - k >= 0) o.push(t - k); if (t + k <= 6) o.push(t + k); } return o; }
export function addCadence(iso, count, unit) {
  const d = parseISO(iso); count = Math.max(1, Math.round(count || 1));
  if (unit === 'weeks') d.setDate(d.getDate() + 7 * count);
  else if (unit === 'months') d.setMonth(d.getMonth() + count);
  else if (unit === 'years') d.setFullYear(d.getFullYear() + count);
  else d.setDate(d.getDate() + count);
  return d;
}

/* ---------- obligation lifecycle ----------
 * Each chore carries at most one open obligation:
 *   assignedOn : ISO date the obligation became due (null = resting)
 *   holder     : personId currently responsible (null = needs auto-assignment)
 *   escalated  : true once an auto-held child obligation has been bumped to an adult
 * Cadence opens obligations; the grace window + escalation drive what happens when ignored.
 */
export function nextDue(c, todayISO) {
  return c.lastDone ? addCadence(c.lastDone, c.intervalCount, c.intervalUnit) : parseISO(todayISO);
}

// Mutates chores in place: opens due obligations and escalates stale child-held ones.
export function rollForward(chores, { todayISO, horizonISO, grace = 3, escalateAfter = 2, people = [] }) {
  const horizon = parseISO(horizonISO);
  const today = parseISO(todayISO);
  const isAdult = Object.fromEntries(people.map(p => [p.id, !!p.isAdult]));
  const active = new Set(people.filter(p => p.active).map(p => p.id));
  for (const c of chores) {
    if (!c.enabled) continue;
    if (c.holder === undefined) c.holder = null;
    if (c.escalated === undefined) c.escalated = false;
    // holder left the team -> release
    if (c.holder && !active.has(c.holder)) c.holder = c.assignee || null;

    if (!c.assignedOn) {
      const nd = nextDue(c, todayISO);
      if (nd <= horizon) { c.assignedOn = toISO(nd); c.holder = c.assignee || null; c.escalated = false; }
      continue;
    }
    // open obligation exists
    if (c.assignee) { c.holder = c.assignee; continue; } // explicit assignment always wins, no auto-escalation
    const late = Math.floor(diffDays(today, parseISO(c.assignedOn)) / grace); // 0 = on time, 1 = 1st delinquency, ...
    if (late >= escalateAfter && c.holder && isAdult[c.holder] === false) {
      c.escalated = true;   // release a child's stale obligation; buildInstances forces it adult-only,
      c.holder = null;      // assignInstances then balances it across the adults.
    }
  }
}

// Builds the schedulable instances for the displayed week (relative to today). Pure.
export function buildInstances(chores, weekStartISO, todayISO, grace = 3) {
  const ws = parseISO(weekStartISO), we = addDays(ws, 6), today = parseISO(todayISO);
  const out = []; let seq = 0;
  for (const c of chores) {
    if (!c.enabled || !c.assignedOn) continue;
    const ao = parseISO(c.assignedOn);
    const late = Math.floor(diffDays(today, ao) / grace);
    const delinquent = late >= 1;
    let day;
    if (delinquent) { const p = today < ws ? ws : (today > we ? we : today); day = diffDays(p, ws); }
    else { if (ao > we) continue; day = ao < ws ? 0 : diffDays(ao, ws); }
    day = Math.min(6, Math.max(0, day));
    out.push({
      uid: `${c.id}#${seq++}`, choreId: c.id, name: c.name, minutes: c.minutes, priority: c.priority,
      adultOnly: !!c.adultOnly || !!c.escalated,   // escalated obligations are adult-only for this cycle
      minAge: c.minAge || 0,                       // youngest age allowed to do it solo (0 = any)
      assignee: c.assignee || null, holder: c.holder || null, lastHolder: c.lastHolder || null,
      day, delinquent, lateCycles: Math.max(0, late), escalated: !!c.escalated,
    });
  }
  return out;
}

// Tiny deterministic string hash (FNV-1a). Pure — no Math.random, so a "shuffle" is reproducible
// from a seed (we seed it with the week start), which keeps the engine testable.
export function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }

// Candidate comparator for auto-assignment. `balanced` (default) packs onto the person with the
// highest remaining fraction of weekly capacity. `rotate` first steers a chore AWAY from whoever
// last held it (so the same kid isn't perpetually stuck with the toilets), then balances by
// capacity, then breaks remaining ties with a per-week deterministic shuffle so equally-free
// people take turns week to week. Capacity is still the tiebreak, so load stays fair within rotation.
function candCmp(inst, d, fairness, seed) {
  const frac = t => t.weekRem / t.weekCap;
  if (fairness === 'rotate') {
    return (a, b) =>
      ((a.ref.id === inst.lastHolder ? 1 : 0) - (b.ref.id === inst.lastHolder ? 1 : 0))
      || (frac(b) - frac(a))
      || (hashStr(seed + ':' + inst.choreId + ':' + a.ref.id) - hashStr(seed + ':' + inst.choreId + ':' + b.ref.id))
      || (b.dayRem[d] - a.dayRem[d]);
  }
  return (a, b) => (frac(b) - frac(a)) || (b.dayRem[d] - a.dayRem[d]);
}

// Assigns instances to (person, day) bins. Pure; returns assignments + who ended up holding each chore.
// opts.fairness: 'balanced' (default) | 'rotate'. opts.seed: stable string (the week start) for shuffle.
export function assignInstances(instances, people, opts = {}) {
  const { fairness = 'balanced', seed = '' } = opts;
  const team = people.filter(p => p.active).map(p => {
    const dayRem = []; let weekly = 0;
    for (let d = 0; d < 7; d++) { const cap = isWeekend(d) ? p.weekendBudget : p.weekdayBudget; dayRem.push(cap); weekly += cap; }
    return { ref: p, dayRem, weekRem: weekly, weekCap: weekly };
  });
  const tById = Object.fromEntries(team.map(t => [t.ref.id, t]));
  const sorted = [...instances].sort((a, b) => (b.delinquent - a.delinquent) || (b.priority - a.priority) || (b.minutes - a.minutes));
  const assignments = [], unassigned = [], holderOf = {};
  for (const inst of sorted) {
    const locked = inst.holder || inst.assignee;
    if (locked) {
      const t = tById[locked];
      if (!t) { unassigned.push({ inst, reason: 'Assigned person is inactive — reassign in Chores' }); continue; }
      const d = inst.day; t.dayRem[d] -= inst.minutes; t.weekRem -= inst.minutes; // force-place, may exceed budget
      assignments.push({ ...inst, personId: t.ref.id, dayIndex: d }); holderOf[inst.choreId] = t.ref.id; continue;
    }
    const eligible = team.filter(t =>
      (!inst.adultOnly || t.ref.isAdult)
      && (!t.ref.maxTaskMinutes || inst.minutes <= t.ref.maxTaskMinutes)
      && (!inst.minAge || t.ref.isAdult || t.ref.age == null || t.ref.age >= inst.minAge)); // age-appropriate: adults always qualify; people with no age set are unconstrained
    if (!eligible.length) { unassigned.push({ inst, reason: inst.adultOnly ? 'No adult is free for this task' : inst.minAge ? 'No one old enough for this task' : 'No one can take a task this long' }); continue; }
    let placed = false;
    for (const d of daysByCloseness(inst.day)) {
      const cands = eligible.filter(t => t.dayRem[d] >= inst.minutes);
      if (!cands.length) continue;
      cands.sort(candCmp(inst, d, fairness, seed));
      const pick = cands[0]; pick.dayRem[d] -= inst.minutes; pick.weekRem -= inst.minutes;
      assignments.push({ ...inst, personId: pick.ref.id, dayIndex: d }); holderOf[inst.choreId] = pick.ref.id; placed = true; break;
    }
    if (!placed) unassigned.push({ inst, reason: 'No room left in the week — raise a budget or lower priority' });
  }
  return { assignments, unassigned, load: team.map(t => ({ id: t.ref.id, used: t.weekCap - t.weekRem, cap: t.weekCap })), holderOf };
}

/* ---------- matrix expansion ----------
 * chores = manual chores + derived (room × type) chores.
 * exclude = array of `${typeId}:${roomId}` keys that should NOT generate a chore (incompatibilities).
 * Duration scales by room size. Re-applying preserves per-cell completion state + assignee overrides.
 */
export function sizeFactor(size) { return SIZE_FACTORS[size] ?? 1.0; }

export function applyMatrix(chores, rooms, types, exclude = []) {
  const excluded = new Set(exclude);
  const existing = Object.fromEntries(chores.filter(c => c.matrixKey).map(c => [c.matrixKey, c]));
  const derived = [];
  for (const t of types) for (const r of rooms) {
    const key = `${t.id}:${r.id}`;
    if (excluded.has(key)) continue;
    const minutes = Math.max(1, Math.round(t.minutes * sizeFactor(r.size)));
    const prev = existing[key];
    derived.push({
      id: prev ? prev.id : ('m_' + key.replace(/[^a-z0-9]/gi, '')), matrixKey: key,
      name: `${t.name} — ${r.name}`,
      minutes, priority: t.priority, intervalCount: t.intervalCount, intervalUnit: t.intervalUnit, adultOnly: !!t.adultOnly, minAge: t.minAge || 0,
      assignee: prev ? prev.assignee : (t.assignee || null),
      lastDone: prev ? prev.lastDone : null, holder: prev ? prev.holder : null,
      lastHolder: prev ? (prev.lastHolder || null) : null,
      assignedOn: prev ? prev.assignedOn : null, escalated: prev ? !!prev.escalated : false,
      enabled: prev ? prev.enabled : true,
    });
  }
  return chores.filter(c => !c.matrixKey).concat(derived);
}
