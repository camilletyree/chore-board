// app.js — UI, state, storage, rendering. Imports the pure engine from scheduler.js
// and the pure sync core from sync.js. This file owns all side effects.
import {
  UNITS, DOW, SIZE_FACTORS, parseISO, toISO, addDays, isWeekend, mondayOf,
  addCadence, nextDue, rollForward, buildInstances, assignInstances, applyMatrix, diffDays, hashStr,
} from './scheduler.js';
import { emptyEnt, decompose, recompose, applyChanges, diffOps, SINGLE } from './sync.js';
import { PRESETS, presetByKey, DEFAULT_PRESET_KEY, buildHome, summarize } from './templates.js';
import { summarizeHistory } from './stats.js';

/* ===================== STORAGE + SYNC (per-entity deltas; local fallback) =====================
 * The synced source of truth is `ent` (entities with _seq/_updatedAt metadata). The UI renders
 * the recomposed whole-doc `S`. Local edits go: mutate S -> save() diffs S vs ent into ops ->
 * outbox -> POST /api/changes. Remote edits arrive via SSE-triggered (or polled) pull() and are
 * merged by _seq, skipping any record still pending in the outbox so an in-flight edit survives.
 */
const LS = { ent: 'choreboard.ent', outbox: 'choreboard.outbox', seq: 'choreboard.seq', old: 'choreboard.state' };
let ent = emptyEnt();      // canonical entities (with sync metadata)
let localSeq = 0;          // highest server _seq we've seen
let outbox = [];           // ops awaiting POST (persisted, so offline edits survive a reload)
let syncMode = 'shared';   // 'shared' | 'local' | 'error'
let es = null, pollTimer = null, flushing = false, flushQueued = false;

function setSync(mode, label) {
  syncMode = mode; const el = document.getElementById('syncState');
  el.className = 'sync ' + mode;
  el.textContent = label || (mode === 'shared' ? 'Shared' : mode === 'local' ? 'Local only' : 'Offline');
}
async function api(path, opts) {
  const r = await fetch(path, Object.assign({ cache: 'no-store', headers: { 'Content-Type': 'application/json' } }, opts));
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}
const keyOf = o => o.collection + ':' + o.id;
const hasContent = e => Object.values(e.people || {}).some(r => r && !r._deleted);
function setSeq(coll, id, seq) {
  if (SINGLE.includes(coll)) { if (ent[coll]) ent[coll]._seq = seq; }
  else if (ent[coll] && ent[coll][id]) ent[coll][id]._seq = seq;
}
function saveLocal() {
  try {
    localStorage.setItem(LS.ent, JSON.stringify(ent));
    localStorage.setItem(LS.outbox, JSON.stringify(outbox));
    localStorage.setItem(LS.seq, String(localSeq));
  } catch (e) { console.warn('local save failed', e); }
}
function loadLocal() {
  try {
    const e = localStorage.getItem(LS.ent);
    if (e) return { ent: JSON.parse(e), outbox: JSON.parse(localStorage.getItem(LS.outbox) || '[]'), localSeq: Number(localStorage.getItem(LS.seq)) || 0 };
    const old = localStorage.getItem(LS.old);              // migrate a pre-sync whole-doc cache
    if (old) return { ent: decompose(JSON.parse(old)), outbox: [], localSeq: 0 };
  } catch { /* corrupt cache -> start fresh */ }
  return null;
}

// Every mutation handler calls save(). It diffs the freshly-edited S against ent, queues the
// changed records, and (when shared) flushes them. No handler needs to know about sync.
async function save() {
  const { ops, next } = diffOps(ent, S, Date.now());
  ent = next;
  if (ops.length) outbox.push(...ops);
  saveLocal();
  if (syncMode !== 'local') await flush();
}

async function flush() {
  if (syncMode === 'local' || !outbox.length) return;
  if (flushing) { flushQueued = true; return; }
  flushing = true;
  try {
    const sent = outbox.slice();
    let resp;
    try { resp = await api('/api/changes', { method: 'POST', body: JSON.stringify({ ops: sent }) }); setSync('shared'); }
    catch { setSync('error', 'Saved locally'); return; }   // keep outbox; retried on next sync tick
    for (const a of resp.applied) setSeq(a.collection, a.id, a._seq);
    const sentSet = new Set(sent);
    outbox = outbox.filter(o => !sentSet.has(o));           // drop exactly what we sent (newer edits stay queued)
    // NB: do NOT advance localSeq here — the response's serverSeq may include other clients'
    // interleaved writes we haven't fetched. Only pull() (which actually fetches them) advances it;
    // the server's broadcast triggers that pull right after this. setSeq above keeps our own echoes idempotent.
    saveLocal();
    if (resp.conflicts && resp.conflicts.length) await rebootstrap(); // rare same-record race: re-sync truth
  } finally {
    flushing = false;
    // Re-flush only if more edits queued during this flush AND the server is still healthy — never
    // on an error path (that would busy-loop while offline; poll/focus retries those instead).
    if (flushQueued && syncMode === 'shared') { flushQueued = false; await flush(); }
  }
}

async function pull() {
  if (syncMode === 'local') return;
  let resp;
  try { resp = await api('/api/changes?since=' + localSeq); setSync('shared'); }
  catch { setSync('error', 'Saved locally'); return; }
  if (!resp.changes.length) { localSeq = Math.max(localSeq, resp.serverSeq); return; }
  const pending = new Set(outbox.map(keyOf));
  const { ent: nextEnt, applied } = applyChanges(ent, resp.changes, { skip: pending });
  ent = nextEnt; localSeq = resp.serverSeq; saveLocal();
  if (applied.length) reconcile();
}

async function sync() { await flush(); await pull(); }

// Re-derive S from ent and re-render — but never clobber an in-progress edit. While a field is
// focused we skip the disruptive full re-render (the data is already merged into S); on the week
// grid we still freshen the checkboxes so a sibling's check-off shows up without stealing focus.
function reconcile() {
  S = recompose(ent, localSeq); normalize();
  const ae = document.activeElement;
  const editing = ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
  if (!editing) { syncBudgetInputs(); renderActive(); }
  else if (activeView === 'week') applyCompletionDom();
}
function applyCompletionDom() {
  const comp = (S.week && S.week.completion) || {};
  for (const cb of $$('#weekBody .check')) {
    const done = !!comp[cb.dataset.uid];
    if (cb.checked !== done) cb.checked = done;
    cb.closest('.task')?.classList.toggle('done', done);
  }
}

// Conflict fallback: a same-record concurrent edit lost LWW. Re-pull the full truth (keeping our
// still-pending edits) so we converge on the winner. Rare at family scale.
async function rebootstrap() {
  try {
    const r = await api('/api/changes?since=0');
    const pending = new Set(outbox.map(keyOf));
    ent = applyChanges(emptyEnt(), r.changes, { skip: pending }).ent;
    localSeq = r.serverSeq; saveLocal(); reconcile();
  } catch { /* transient; next tick retries */ }
}

function startStream() {
  stopPolling();
  if (typeof EventSource === 'undefined') { startPolling(); return; }
  try {
    es = new EventSource('/api/stream');
    es.onopen = () => { stopPolling(); sync(); };
    es.onmessage = e => { try { if ((JSON.parse(e.data).serverSeq || 0) > localSeq) pull(); } catch { /* ignore */ } };
    es.onerror = () => { startPolling(); };                 // EventSource auto-retries; poll meanwhile
  } catch { startPolling(); }
}
function startPolling() { if (!pollTimer && syncMode !== 'local') pollTimer = setInterval(sync, 4000); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// Initial load: build ent from the full change log (or local cache when offline) and start syncing.
async function bootstrap() {
  outbox = loadLocal()?.outbox || [];                       // recover edits queued while offline
  try {
    const r = await api('/api/changes?since=0');
    setSync('shared');
    ent = applyChanges(emptyEnt(), r.changes).ent;
    localSeq = r.serverSeq;
    S = hasContent(ent) ? recompose(ent, localSeq) : null;
    saveLocal();
    await flush();                                          // push any recovered offline edits
    startStream();
  } catch {
    setSync('local', 'Local only');                         // opened as a file, or server unreachable
    const c = loadLocal();
    if (c && c.ent) { ent = c.ent; localSeq = c.localSeq || 0; S = hasContent(ent) ? recompose(ent, localSeq) : null; }
    else { ent = emptyEnt(); S = null; }
  }
}

/* ===================== DEFAULT DATA ===================== */
function uid(p) { return p + Math.random().toString(36).slice(2, 8); }
const PCOLORS = ['var(--p-me)', 'var(--p-gabby)', 'var(--p-kid10)', 'var(--p-kid6)', '#7a5cc0', '#3f9e8f', '#b5852a', '#5b6b7a'];
function defaultPeople() {
  return [
    { id: 'me', name: 'Me', color: 'var(--p-me)', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'gabby', name: 'Gabby', color: 'var(--p-gabby)', isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true },
    { id: 'kid10', name: 'Son (10)', color: 'var(--p-kid10)', isAdult: false, age: 10, weekdayBudget: 20, weekendBudget: 40, maxTaskMinutes: 20, active: true },
    { id: 'kid6', name: 'Daughter (6)', color: 'var(--p-kid6)', isAdult: false, age: 6, weekdayBudget: 10, weekendBudget: 20, maxTaskMinutes: 10, active: true },
  ];
}
function mkChore(name, minutes, priority, intervalCount, intervalUnit, adultOnly) {
  return { id: uid('c'), name, minutes, priority, intervalCount, intervalUnit, adultOnly, assignee: null, lastDone: null, holder: null, assignedOn: null, escalated: false, enabled: true, matrixKey: null };
}
function defaultChores() {
  return [
    mkChore('Load / run dishwasher', 10, 5, 1, 'days', false),
    mkChore('Wipe kitchen counters', 5, 3, 1, 'days', false),
    mkChore('Make beds', 5, 2, 1, 'days', false),
    mkChore('Feed pet & refill water', 5, 4, 1, 'days', false),
    mkChore('Take out trash', 5, 4, 3, 'days', false),
    mkChore('Water the garden', 10, 2, 2, 'days', false),
    mkChore('Laundry: wash, dry, fold', 30, 4, 3, 'days', true),
    mkChore('Take out recycling', 5, 3, 1, 'weeks', false),
    mkChore('Clean a bathroom', 25, 4, 1, 'weeks', true),
    mkChore('Clean toilets', 10, 4, 1, 'weeks', true),
    mkChore('Change bed sheets', 15, 2, 1, 'weeks', true),
    mkChore('Wipe down fridge shelves', 30, 2, 1, 'months', true),
    mkChore('Clean oven', 30, 2, 1, 'months', true),
  ];
}
function defaultRooms() {
  return [
    { id: 'r_living', name: 'Living room', size: 'large' },
    { id: 'r_kitchen', name: 'Kitchen', size: 'medium' },
    { id: 'r_game', name: 'Game room', size: 'medium' },
  ];
}
function defaultTypes() {
  return [
    { id: 't_tidy', name: 'Tidy', minutes: 5, priority: 3, intervalCount: 1, intervalUnit: 'days', adultOnly: false, assignee: null },
    { id: 't_vac', name: 'Vacuum', minutes: 15, priority: 3, intervalCount: 1, intervalUnit: 'weeks', adultOnly: false, assignee: null },
    { id: 't_mop', name: 'Mop', minutes: 20, priority: 3, intervalCount: 2, intervalUnit: 'weeks', adultOnly: true, assignee: null },
  ];
}
// Spread a fresh template's first due-dates across each chore's cadence so the very first "Refresh
// week" isn't a wall of everything-at-once. Deterministic per chore id (no Math.random), and it
// reads as honest ("you've already been keeping up with some of these"). Lives here, not in the
// pure builder, because it needs today's date.
const CADENCE_DAYS = { days: 1, weeks: 7, months: 30, years: 365 };
function staggerChores(st) {
  const today = new Date();
  for (const c of st.chores) {
    if (!c.enabled || c.lastDone) continue;
    const span = Math.max(1, (c.intervalCount || 1) * (CADENCE_DAYS[c.intervalUnit] || 1));
    c.lastDone = toISO(addDays(today, -(hashStr(c.id) % (span + 1)))); // next due lands in [today, today+span]
  }
}

// The "sample home" used by Reset and as the safe fallback: the curated family-of-4 showcase
// template, built by the same pure builder the wizard uses (templates.js), with first due-dates
// staggered. First run opens the wizard so a household can tailor this instead of inheriting
// someone else's home.
function seedState() { const st = buildHome(presetByKey(DEFAULT_PRESET_KEY)); staggerChores(st); return st; }

/* ===================== STATE ===================== */
let S = null;            // the whole persisted blob
let activeView = 'week';
const get = { people: () => S.people, chores: () => S.chores, rooms: () => S.rooms, types: () => S.matrixTypes };

function normalize() {
  S.rev = S.rev || 0;
  if (!S.people || !S.people.length) S.people = defaultPeople(); // never persist a zero-person team ([] is truthy, so ||= won't catch it)
  S.rooms ||= defaultRooms(); S.matrixTypes ||= defaultTypes(); S.matrixExclude ||= [];
  S.history ||= [];
  S.settings = Object.assign({ graceDays: 3, escalateAfter: 2, weekStartISO: null, fairness: 'balanced' }, S.settings || {});
  if (S.settings.fairness !== 'rotate') S.settings.fairness = 'balanced';
  for (const r of S.rooms) if (!r.size) r.size = 'medium';
  for (const c of (S.chores ||= [])) {
    if (c.intervalCount === undefined) { c.intervalCount = c.intervalDays || 1; c.intervalUnit = 'days'; delete c.intervalDays; }
    c.intervalUnit ??= 'days'; c.assignee ??= null; c.holder ??= null; c.assignedOn ??= null; c.lastHolder ??= null;
    c.escalated = !!c.escalated; c.matrixKey ??= null; c.minAge ??= 0;
  }
}

/* ===================== HELPERS ===================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const personById = id => S.people.find(p => p.id === id);
const choreById = id => S.chores.find(c => c.id === id);
function priColor(p) { return p >= 5 ? '#bf3b2e' : p >= 4 ? '#d98324' : p >= 3 ? '#2f6f5e' : '#9aa6a0'; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function assigneeOptions(sel) { return `<option value="">Auto</option>` + S.people.map(p => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join(''); }
function unitOptions(sel, count) { return UNITS.map(u => `<option value="${u}" ${sel === u ? 'selected' : ''}>${u.slice(0, -1)}${(count || 1) > 1 ? 's' : ''}</option>`).join(''); }
function sizeOptions(sel) { return Object.keys(SIZE_FACTORS).map(s => `<option value="${s}" ${sel === s ? 'selected' : ''}>${s} ×${SIZE_FACTORS[s]}</option>`).join(''); }
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1900); }

/* ===================== WEEK ===================== */
function renderWeek() {
  const body = $('#weekBody'), week = S.week;
  if (!week || !week.assignments) {
    body.innerHTML = `<div class="gridwrap"><div class="loading">No slate yet for this week.<br><br><button class="btn primary" id="emptyGen">Refresh week</button></div></div>`;
    $('#emptyGen')?.addEventListener('click', generate); return;
  }
  const ws = parseISO(week.weekStartISO), we = addDays(ws, 6), fmt = dt => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const delinq = week.assignments.filter(a => a.delinquent).length, escal = week.assignments.filter(a => a.escalated).length;
  $('#weekTitle').textContent = `Week of ${fmt(ws)}`;
  $('#weekMeta').textContent = `${fmt(ws)} – ${fmt(we)} · ${week.assignments.length} tasks`
    + (delinq ? ` · ${delinq} delinquent` : '') + (escal ? ` · ${escal} escalated` : '');
  const todayISO = toISO(new Date());
  const active = S.people.filter(p => p.active);
  const loadById = Object.fromEntries((week.load || []).map(l => [l.id, l]));

  let bal = '<div class="balance">';
  for (const p of active) {
    const l = loadById[p.id] || { used: 0, cap: 1 }; const pct = l.cap ? Math.round(l.used / l.cap * 100) : 0; const over = l.used > l.cap;
    bal += `<div class="bcard"><div class="who"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</div>
      <div class="nums">${l.used} / ${l.cap} min · ${pct}%</div>
      <div class="meter ${over ? 'over' : ''}"><span style="width:${Math.min(100, pct)}%;background:${p.color}"></span></div></div>`;
  }
  bal += '</div>';

  let g = '<div class="gridwrap"><div class="grid"><div class="gcell ghead"></div>';
  for (let d = 0; d < 7; d++) { const date = addDays(ws, d); g += `<div class="gcell ghead ${isWeekend(d) ? 'weekend' : ''} ${toISO(date) === todayISO ? 'today' : ''}"><div class="dow">${DOW[d]}</div><div class="dnum">${date.getDate()}</div></div>`; }
  for (const p of active) {
    g += `<div class="gcell rowlabel"><div class="who"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</div><div class="role">${p.isAdult ? 'Adult' : 'Child'}</div></div>`;
    for (let d = 0; d < 7; d++) {
      const cap = isWeekend(d) ? p.weekendBudget : p.weekdayBudget;
      const items = week.assignments.filter(a => a.personId === p.id && a.dayIndex === d).sort((a, b) => (b.delinquent - a.delinquent) || (b.priority - a.priority));
      const used = items.reduce((s, a) => s + a.minutes, 0); const pct = cap ? Math.round(used / cap * 100) : 0; const over = used > cap;
      let cell = `<div class="gcell daycell ${isWeekend(d) ? 'weekend' : ''}">`;
      if (items.length) cell += `<div class="cellmeter ${over ? 'over' : ''}"><span style="width:${Math.min(100, pct)}%;background:${p.color}"></span></div>`;
      if (!items.length) cell += '<div class="empty-cell">—</div>';
      else for (const a of items) {
        const done = week.completion && week.completion[a.uid];
        let flags = '';
        if (a.delinquent && !done) flags += `<span class="flag del">DELINQUENT${a.lateCycles > 1 ? ' ×' + a.lateCycles : ''}</span>`;
        if (a.escalated && !done) flags += `<span class="flag esc">ESCALATED</span>`;
        cell += `<div class="task ${done ? 'done' : ''} ${a.delinquent && !done ? 'delinquent' : ''}" style="--c:${p.color}">
          <label class="tname"><input type="checkbox" class="check" data-uid="${a.uid}" ${done ? 'checked' : ''} aria-label="Mark “${esc(a.name)}” done"><span>${esc(a.name)}</span></label>
          <div class="tmin"><span class="pri" style="background:${priColor(a.priority)}"></span>${a.minutes} min ${flags}</div></div>`;
      }
      cell += '</div>'; g += cell;
    }
  }
  g += '</div></div>';

  let of = '';
  if (week.unassigned && week.unassigned.length) {
    of = '<div class="overflow no-print"><h3>Couldn’t fit ' + week.unassigned.length + ' task' + (week.unassigned.length > 1 ? 's' : '') + '</h3><p>Raise a time budget, lower a chore’s priority, or relax an adult-only flag.</p><ul>'
      + week.unassigned.map(u => `<li><b>${esc(u.inst.name)}</b> (${u.inst.minutes} min) — ${esc(u.reason)}</li>`).join('') + '</ul></div>';
  }

  // print-only "fridge sheet": a clean per-person checklist for the week
  let ps = `<div class="print-sheet"><div class="ps-head"><h2>ChoreBoard — week of ${fmt(ws)}</h2><div class="ps-sub">${fmt(ws)} – ${fmt(we)}</div></div><div class="ps-people">`;
  for (const p of active) {
    const mine = week.assignments.filter(a => a.personId === p.id).sort((a, b) => (a.dayIndex - b.dayIndex) || (b.delinquent - a.delinquent) || (b.priority - a.priority));
    ps += `<div class="ps-person"><div class="ps-name"><span class="dot" style="background:${p.color}"></span>${esc(p.name)} <span class="ps-role">${p.isAdult ? 'Adult' : 'Child'}</span></div>`;
    if (!mine.length) ps += `<div class="ps-empty">No tasks this week.</div>`;
    else {
      ps += '<ul class="ps-list">'; let curDay = -1;
      for (const a of mine) {
        if (a.dayIndex !== curDay) { curDay = a.dayIndex; ps += `<li class="ps-day">${DOW[curDay]} ${addDays(ws, curDay).getDate()}</li>`; }
        ps += `<li class="ps-task"><span class="ps-box"></span><span class="ps-tname">${esc(a.name)}</span><span class="ps-min">${a.minutes}m${a.delinquent ? ' · late' : ''}</span></li>`;
      }
      ps += '</ul>';
    }
    ps += '</div>';
  }
  ps += '</div></div>';

  body.innerHTML = bal + g + of + ps;
  $$('#weekBody .check').forEach(cb => cb.addEventListener('change', onCheck));
}
async function onCheck(e) {
  const uid = e.target.dataset.uid, a = S.week.assignments.find(x => x.uid === uid); if (!a) return;
  const ch = choreById(a.choreId); S.week.completion ||= {}; S.history ||= [];
  const today = toISO(new Date());
  // History is keyed by the OBLIGATION (week + chore + date), not the volatile build-order uid
  // (`choreId#seq`, whose seq shifts when earlier chores drop out between same-week regenerations).
  // One record per chore per day; the chosen id is stashed on the completion record so uncheck removes
  // exactly it even after the uid has changed.
  const histId = `${S.week.weekStartISO}#${a.choreId}#${today}`;
  if (e.target.checked) {
    S.week.completion[uid] = { date: today, histId, snap: ch ? { lastDone: ch.lastDone, holder: ch.holder, lastHolder: ch.lastHolder, assignedOn: ch.assignedOn, escalated: ch.escalated } : null };
    if (ch) { ch.lastDone = today; ch.lastHolder = a.personId; ch.holder = null; ch.assignedOn = null; ch.escalated = false; } // clear obligation, remember who did it
    // durable log entry for the History view (kept even after the week is regenerated)
    if (!S.history.some(h => h.id === histId))
      S.history.push({ id: histId, choreId: a.choreId, name: a.name, personId: a.personId, minutes: a.minutes, date: today, weekStartISO: S.week.weekStartISO, priority: a.priority, late: !!a.delinquent });
  } else {
    const rec = S.week.completion[uid]; if (ch && rec && rec.snap) Object.assign(ch, rec.snap);
    const hid = (rec && rec.histId) || histId;
    delete S.week.completion[uid];
    S.history = S.history.filter(h => h.id !== hid);
  }
  e.target.closest('.task').classList.toggle('done', e.target.checked);
  await save();
}
async function generate() {
  S.settings.weekStartISO = $('#weekStart').value || toISO(mondayOf(new Date()));
  S.settings.graceDays = Math.max(1, Number($('#graceDays').value) || 3);
  S.settings.escalateAfter = Math.max(1, Number($('#escalateAfter').value) || 2);
  S.settings.fairness = $('#fairness').value === 'rotate' ? 'rotate' : 'balanced';
  const todayISO = toISO(new Date());
  const ws = parseISO(S.settings.weekStartISO), we = addDays(ws, 6);
  const horizonISO = toISO(we > parseISO(todayISO) ? we : parseISO(todayISO));
  rollForward(S.chores, { todayISO, horizonISO, grace: S.settings.graceDays, escalateAfter: S.settings.escalateAfter, people: S.people });
  const inst = buildInstances(S.chores, S.settings.weekStartISO, todayISO, S.settings.graceDays);
  const res = assignInstances(inst, S.people, { fairness: S.settings.fairness, seed: S.settings.weekStartISO });
  // lock holder so delinquency/escalation track the person, and remember it so 'rotate' shares the
  // chore with someone else next cycle.
  for (const c of S.chores) if (res.holderOf[c.id]) { c.holder = res.holderOf[c.id]; c.lastHolder = res.holderOf[c.id]; }
  S.week = { weekStartISO: S.settings.weekStartISO, assignments: res.assignments, unassigned: res.unassigned, load: res.load, completion: {} };
  await save(); renderWeek();
  toast(`Built ${res.assignments.length} tasks` + (res.unassigned.length ? ` · ${res.unassigned.length} didn’t fit` : ''));
}

/* ===================== CHORES ===================== */
function renderChores() {
  const tb = $('#choreRows'); tb.innerHTML = '';
  if (!S.chores.length) {
    tb.innerHTML = `<tr><td colspan="9"><div class="emptyrow">No chores yet. <button class="btn sm primary" id="emptySetup">Set up from a template</button> or use “+ Add chore”.</div></td></tr>`;
    $('#emptySetup')?.addEventListener('click', () => openWizard());
    return;
  }
  for (const c of S.chores) {
    const m = !!c.matrixKey;
    const tr = document.createElement('tr'); if (!c.enabled) tr.classList.add('disabled-row');
    tr.innerHTML = `
      <td>${m ? `<span class="pill" title="Managed in Rooms">matrix</span> ` : ''}<input type="text" data-f="name" value="${esc(c.name)}" ${m ? 'disabled' : ''}></td>
      <td class="col-c"><select data-f="priority" ${m ? 'disabled' : ''}>${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${c.priority === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td class="col-c"><input type="number" min="1" data-f="minutes" value="${c.minutes}" ${m ? 'disabled' : ''}></td>
      <td class="col-c"><div class="cadence"><input type="number" min="1" data-f="intervalCount" value="${c.intervalCount}" ${m ? 'disabled' : ''}><select data-f="intervalUnit" ${m ? 'disabled' : ''}>${unitOptions(c.intervalUnit, c.intervalCount)}</select></div></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="adultOnly" ${c.adultOnly ? 'checked' : ''} ${m ? 'disabled' : ''}><span class="track"></span></label></td>
      <td class="col-c"><select data-f="assignee">${assigneeOptions(c.assignee)}</select></td>
      <td class="col-c"><input type="date" data-f="lastDone" value="${c.lastDone || ''}"></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="enabled" ${c.enabled ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c">${m ? '' : '<button class="btn ghost sm danger" data-del aria-label="Remove chore">✕</button>'}</td>`;
    tr.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', async () => {
      const f = el.dataset.f;
      if (f === 'adultOnly' || f === 'enabled') c[f] = el.checked;
      else if (f === 'priority' || f === 'minutes' || f === 'intervalCount') c[f] = Math.max(1, Number(el.value) || 1);
      else if (f === 'assignee') c[f] = el.value || null;
      else if (f === 'lastDone') c[f] = el.value || null;
      else c[f] = el.value;
      await save(); renderChores();
    }));
    tr.querySelector('[data-del]')?.addEventListener('click', async () => { S.chores = S.chores.filter(x => x.id !== c.id); await save(); renderChores(); });
    tb.appendChild(tr);
  }
}

/* ===================== ROOMS / MATRIX ===================== */
function renderRooms() {
  const rl = $('#roomList'); rl.innerHTML = '';
  S.rooms.forEach(r => {
    const chip = document.createElement('div'); chip.className = 'roomchip';
    chip.innerHTML = `<input type="text" value="${esc(r.name)}"><select>${sizeOptions(r.size)}</select><button title="Remove room">✕</button>`;
    const [name, size, btn] = [chip.querySelector('input'), chip.querySelector('select'), chip.querySelector('button')];
    name.addEventListener('change', async e => { r.name = e.target.value; await save(); updateMatrixCount(); });
    size.addEventListener('change', async e => { r.size = e.target.value; await save(); });
    btn.addEventListener('click', async () => { S.rooms = S.rooms.filter(x => x.id !== r.id); await save(); renderRooms(); });
    rl.appendChild(chip);
  });

  const tb = $('#matrixRows'); tb.innerHTML = '';
  S.matrixTypes.forEach(t => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-f="name" value="${esc(t.name)}"></td>
      <td class="col-c"><input type="number" min="1" data-f="minutes" value="${t.minutes}"></td>
      <td class="col-c"><select data-f="priority">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${t.priority === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td class="col-c"><div class="cadence"><input type="number" min="1" data-f="intervalCount" value="${t.intervalCount}"><select data-f="intervalUnit">${unitOptions(t.intervalUnit, t.intervalCount)}</select></div></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="adultOnly" ${t.adultOnly ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c"><select data-f="assignee">${assigneeOptions(t.assignee)}</select></td>
      <td class="col-c"><button class="btn ghost sm danger" data-del aria-label="Remove chore type">✕</button></td>`;
    tr.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', async () => {
      const f = el.dataset.f;
      if (f === 'adultOnly') t[f] = el.checked;
      else if (f === 'minutes' || f === 'priority' || f === 'intervalCount') t[f] = Math.max(1, Number(el.value) || 1);
      else if (f === 'assignee') t[f] = el.value || null; else t[f] = el.value;
      await save(); renderRooms();
    }));
    tr.querySelector('[data-del]').addEventListener('click', async () => { S.matrixTypes = S.matrixTypes.filter(x => x.id !== t.id); await save(); renderRooms(); });
    tb.appendChild(tr);
  });

  renderCompat(); updateMatrixCount();
}
function renderCompat() {
  const wrap = $('#compatWrap');
  if (!S.rooms.length || !S.matrixTypes.length) { wrap.innerHTML = '<div style="padding:14px" class="tag">Add at least one room and one chore type.</div>'; return; }
  const excl = new Set(S.matrixExclude);
  let h = '<table class="compat"><thead><tr><th></th>' + S.rooms.map(r => `<th>${esc(r.name)}</th>`).join('') + '</tr></thead><tbody>';
  for (const t of S.matrixTypes) {
    h += `<tr><th>${esc(t.name)}</th>`;
    for (const r of S.rooms) { const key = `${t.id}:${r.id}`; h += `<td><input type="checkbox" data-key="${key}" ${excl.has(key) ? '' : 'checked'}></td>`; }
    h += '</tr>';
  }
  h += '</tbody></table>';
  wrap.innerHTML = h;
  wrap.querySelectorAll('input[data-key]').forEach(cb => cb.addEventListener('change', async () => {
    const key = cb.dataset.key, set = new Set(S.matrixExclude);
    if (cb.checked) set.delete(key); else set.add(key);
    S.matrixExclude = [...set]; await save(); updateMatrixCount();
  }));
}
function updateMatrixCount() {
  const total = S.rooms.length * S.matrixTypes.length, excl = S.matrixExclude.filter(k => {
    const [tid, rid] = k.split(':'); return S.matrixTypes.some(t => t.id === tid) && S.rooms.some(r => r.id === rid);
  }).length;
  $('#matrixCount').textContent = `${total - excl} chores (${total} cells − ${excl} excluded)`;
}

/* ===================== TEAM ===================== */
function renderTeam() {
  const tb = $('#teamRows'); tb.innerHTML = '';
  for (const p of S.people) {
    const tr = document.createElement('tr'); if (!p.active) tr.classList.add('disabled-row');
    const colorOpts = PCOLORS.map(c => `<option value="${c}" ${p.color === c ? 'selected' : ''}>●</option>`).join('');
    tr.innerHTML = `
      <td><input type="text" data-f="name" value="${esc(p.name)}"></td>
      <td><span class="dot" style="background:${p.color};margin-right:6px"></span><select data-f="color" style="width:54px">${colorOpts}</select></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="isAdult" ${p.isAdult ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c"><input type="number" min="0" max="120" data-f="age" value="${p.age ?? ''}" placeholder="—" title="A child's age. Sets which chores they're old enough for. Leave blank for adults / no limit."></td>
      <td class="col-c"><input type="number" min="0" data-f="weekdayBudget" value="${p.weekdayBudget}"></td>
      <td class="col-c"><input type="number" min="0" data-f="weekendBudget" value="${p.weekendBudget}"></td>
      <td class="col-c"><input type="number" min="0" data-f="maxTaskMinutes" value="${p.maxTaskMinutes}"></td>
      <td class="col-c"><label class="sw"><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''}><span class="track"></span></label></td>
      <td class="col-c"><button class="btn ghost sm danger" data-del aria-label="Remove person">✕</button></td>`;
    tr.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', async () => {
      const f = el.dataset.f;
      if (f === 'isAdult' || f === 'active') p[f] = el.checked;
      else if (['weekdayBudget', 'weekendBudget', 'maxTaskMinutes'].includes(f)) p[f] = Math.max(0, Number(el.value) || 0);
      else if (f === 'age') p.age = el.value === '' ? null : Math.max(0, Number(el.value) || 0);
      else p[f] = el.value;
      await save(); renderTeam();
    }));
    tr.querySelector('[data-del]').addEventListener('click', async () => { if (S.people.length <= 1) { toast('Keep at least one person'); return; } S.people = S.people.filter(x => x.id !== p.id); await save(); renderTeam(); });
    tb.appendChild(tr);
  }
}

/* ===================== HISTORY ===================== */
function fmtMins(m) { if (!m) return '0 min'; const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h ${mm ? mm + 'm' : ''}`.trim() : `${mm} min`; }
function fmtDate(iso) { try { return parseISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return iso; } }

function renderHistory() {
  const body = $('#historyBody');
  const days = Number($('#histRange')?.value ?? 30);
  const todayISO = toISO(new Date());
  const sinceISO = days ? toISO(addDays(new Date(), -days + 1)) : null;
  const sum = summarizeHistory(S.history || [], S.people, { sinceISO });

  // chores past their grace window right now (from live chore state, not the log)
  const grace = S.settings.graceDays || 3;
  const overdue = (S.chores || []).filter(c => c.enabled && c.assignedOn).map(c => ({ c, late: Math.floor(diffDays(parseISO(todayISO), parseISO(c.assignedOn)) / grace) }))
    .filter(o => o.late >= 1).sort((a, b) => b.late - a.late);

  if (!sum.count && !overdue.length) {
    body.innerHTML = `<div class="panel"><div class="loading">Nothing logged yet.<br><br>Check tasks off on <b>This week</b> and they’ll show up here — who did what, and what keeps slipping.</div></div>`;
    return;
  }

  const range = days ? `last ${days} days` : 'all time';
  let h = `<div class="balance">
    <div class="bcard"><div class="who">Completed</div><div class="nums">${sum.totalTasks} task${sum.totalTasks === 1 ? '' : 's'}</div></div>
    <div class="bcard"><div class="who">Time spent</div><div class="nums">${fmtMins(sum.totalMinutes)}</div></div>
    <div class="bcard"><div class="who">Active days</div><div class="nums">${sum.daysActive} · ${range}</div></div>
  </div>`;

  h += `<div class="panel"><div class="panel-foot" style="border-top:none;border-bottom:1px solid var(--line-2)"><span class="tag" style="color:var(--ink);font-weight:700">Who pulled their weight</span><span class="tag">Share of time spent, ${range}.</span></div><div class="histrows">`;
  if (!sum.totalTasks) h += `<div class="loading" style="padding:22px">Nothing checked off in this range.</div>`;
  for (const p of sum.perPerson) h += `<div class="histrow"><div class="who"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</div>
    <div class="meter"><span style="width:${p.share}%;background:${p.color}"></span></div>
    <div class="nums">${p.tasks} · ${fmtMins(p.minutes)} · ${p.share}%</div></div>`;
  h += `</div></div>`;

  if (overdue.length) {
    h += `<div class="overflow warn no-print"><h3>${overdue.length} chore${overdue.length > 1 ? 's' : ''} slipping right now</h3><p>Past the grace window and still open. Check them off, or they’ll escalate.</p><ul>`
      + overdue.slice(0, 12).map(o => { const who = o.c.holder && personById(o.c.holder); return `<li><b>${esc(o.c.name)}</b> — ${o.late} cycle${o.late > 1 ? 's' : ''} late${who ? ` · ${esc(who.name)}` : ''}</li>`; }).join('')
      + `</ul></div>`;
  }

  h += `<div class="histcols">
    <div class="panel"><div class="panel-foot" style="border-top:none;border-bottom:1px solid var(--line-2)"><span class="tag" style="color:var(--ink);font-weight:700">Most done</span></div><div class="histlist">`
    + (sum.topChores.length ? sum.topChores.map(c => `<div class="hitem"><span>${esc(c.name)}</span><span class="nums">${c.count}× · ${fmtMins(c.minutes)}</span></div>`).join('') : `<div class="loading" style="padding:18px">—</div>`)
    + `</div></div>
    <div class="panel"><div class="panel-foot" style="border-top:none;border-bottom:1px solid var(--line-2)"><span class="tag" style="color:var(--ink);font-weight:700">Recent activity</span></div><div class="histlist">`
    + (sum.recent.length ? sum.recent.map(r => { const who = personById(r.personId); return `<div class="hitem"><span>${esc(r.name)}<span class="nums"> · ${esc(who ? who.name : '—')}</span></span><span class="nums">${fmtDate(r.date)}</span></div>`; }).join('') : `<div class="loading" style="padding:18px">—</div>`)
    + `</div></div>
  </div>`;

  body.innerHTML = h;
}

/* ===================== SETUP WIZARD / TEMPLATES ===================== */
let wiz = null;
const clone = o => JSON.parse(JSON.stringify(o));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const SCRATCH_PROFILE = { homeSize: 'medium', beds: 2, baths: 1, floors: 1, flags: { diningRoom: false, laundryRoom: false, office: false, garage: false, basement: false, yard: 'none', dishwasher: true }, adults: [{ name: 'Me' }], kids: [], pets: [] };
const WIZ_STEPS = ['Pick a starting point', 'Describe your home', 'Who lives here', 'Preview & apply'];

function openWizard(opts = {}) {
  const show = presetByKey(DEFAULT_PRESET_KEY);
  const ae = document.activeElement;
  wiz = { step: 0, firstRun: !!opts.firstRun, chosen: opts.firstRun ? '' : DEFAULT_PRESET_KEY, profile: opts.firstRun ? null : clone(show), opener: (ae && ae !== document.body) ? ae : $('#setupBtn') };
  document.querySelector('.wrap').inert = true;          // background not tabbable / AT-reachable while the dialog is open
  const m = $('#wizard'); m.hidden = false; document.body.classList.add('modal-open');
  renderWizard();
}
function hideWizard() {
  const opener = wiz && wiz.opener;
  document.querySelector('.wrap').inert = false;
  $('#wizard').hidden = true; document.body.classList.remove('modal-open'); wiz = null;
  opener?.focus?.();                                     // return focus to whatever opened the dialog
}
function dismissWizard() { const fr = wiz && wiz.firstRun; hideWizard(); if (fr && !hasContent(ent)) applyProfile(presetByKey(DEFAULT_PRESET_KEY)); }
async function applyProfile(profile) {
  const built = buildHome(clone(profile));
  if (!built.people.length) { toast('Add at least one adult, or a child age 4 or older'); return; } // never apply a zero-person board
  built.history = (S && S.history) || [];               // keep the log when re-running setup on an existing board
  S = built; staggerChores(S);
  normalize(); syncBudgetInputs(); hideWizard();
  switchView('week'); await generate();
  toast('Your board is ready');
}

function renderWizard() {
  $('#wizStep').textContent = `Step ${wiz.step + 1} of ${WIZ_STEPS.length} · ${WIZ_STEPS[wiz.step]}`;
  const body = $('#wizBody'), foot = $('#wizFoot'), p = wiz.profile;
  if (wiz.step === 0) body.innerHTML = wizStart();
  else if (wiz.step === 1) body.innerHTML = wizHome(p);
  else if (wiz.step === 2) body.innerHTML = wizPeople(p);
  else body.innerHTML = wizPreview(p);

  const back = wiz.step > 0 ? `<button class="btn" data-wiz="back">Back</button>` : '<span></span>';
  const noTeam = wiz.profile && summarize(wiz.profile).people === 0;
  const next = wiz.step < 3
    ? `<button class="btn primary" data-wiz="next" ${wiz.step === 0 && !wiz.profile ? 'disabled' : ''}>Next</button>`
    : `<button class="btn primary" data-wiz="apply" ${noTeam ? 'disabled' : ''}>Apply this setup</button>`;
  foot.innerHTML = `${back}<span class="spacer"></span>${next}`;
  wireWizard();
  (body.querySelector('input, select, button.presetcard') || body).focus?.();
}

function wizStart() {
  const card = (key, label, blurb, stats) => `<button class="presetcard ${wiz.chosen === key ? 'sel' : ''}" data-preset="${key}">
    <div class="pname">${esc(label)}</div><div class="pblurb">${esc(blurb)}</div><div class="pstats">${stats}</div></button>`;
  const cards = PRESETS.map(p => { const s = summarize(p); return card(p.key, p.label, p.blurb, `${s.people} ${s.people === 1 ? 'person' : 'people'} · ${s.rooms} rooms · ${s.chores} chores`); }).join('');
  return `<p class="wizlead">Pick a starting point — you can fine-tune the home, the people, and every chore afterward.</p>
    <div class="presetgrid">${cards}${card('scratch', 'Build from scratch', 'Start minimal and describe your home on the next steps.', 'You choose everything')}</div>`;
}
function wizHome(p) {
  const f = p.flags, sel = (k, v, opts) => `<select data-h="${k}">${opts.map(o => `<option value="${o}" ${v === o ? 'selected' : ''}>${cap(o)}</option>`).join('')}</select>`;
  const toggles = [['diningRoom', 'Dining room'], ['laundryRoom', 'Laundry room'], ['office', 'Office'], ['garage', 'Garage'], ['basement', 'Basement'], ['dishwasher', 'Dishwasher']];
  return `<div class="wizgrid">
    <label class="wizfield"><span>Home size</span>${sel('homeSize', p.homeSize, ['studio', 'apartment', 'small', 'medium', 'large'])}</label>
    <label class="wizfield"><span>Bedrooms</span><input type="number" min="0" max="12" data-h="beds" value="${p.beds}"></label>
    <label class="wizfield"><span>Bathrooms</span><input type="number" min="1" max="12" data-h="baths" value="${p.baths}"></label>
    <label class="wizfield"><span>Floors</span><input type="number" min="1" max="4" data-h="floors" value="${p.floors}"></label>
    <label class="wizfield"><span>Yard</span>${sel('yard', f.yard, ['none', 'small', 'large'])}</label>
  </div>
  <div class="wiztoggles">${toggles.map(([k, lbl]) => `<label class="wcheck"><input type="checkbox" data-flag="${k}" ${f[k] ? 'checked' : ''}><span>${lbl}</span></label>`).join('')}</div>`;
}
function wizPeople(p) {
  const adults = p.adults.map((a, i) => `<div class="wizrow"><input data-adult="${i}" value="${esc(a.name || '')}" placeholder="Adult's name" aria-label="Adult name"><button class="btn ghost sm danger" data-deladult="${i}" aria-label="Remove adult">✕</button></div>`).join('');
  const kids = p.kids.map((k, i) => `<div class="wizrow"><input data-kidname="${i}" value="${esc(k.name || '')}" placeholder="Child's name" aria-label="Child name"><input type="number" min="0" max="17" data-kidage="${i}" value="${k.age ?? 8}" aria-label="Age" title="Age"><button class="btn ghost sm danger" data-delkid="${i}" aria-label="Remove child">✕</button></div>`).join('');
  const pets = p.pets.map((pet, i) => `<div class="wizrow"><select data-pettype="${i}" aria-label="Pet type">${['dog', 'cat', 'small', 'fish'].map(t => `<option value="${t}" ${pet.type === t ? 'selected' : ''}>${cap(t === 'small' ? 'small pet' : t)}</option>`).join('')}</select><input data-petname="${i}" value="${esc(pet.name || '')}" placeholder="Pet's name" aria-label="Pet name"><button class="btn ghost sm danger" data-delpet="${i}" aria-label="Remove pet">✕</button></div>`).join('');
  return `<div class="wizpeople">
    <div class="wizsec"><h3>Adults</h3>${adults || '<p class="hint">Add at least one adult.</p>'}<button class="btn sm" data-add="adult">+ Add adult</button></div>
    <div class="wizsec"><h3>Children</h3><p class="hint">Age sets each kid’s time budget and what they can take on. Under 4 just creates the chores, not a team member.</p>${kids}<button class="btn sm" data-add="kid">+ Add child</button></div>
    <div class="wizsec"><h3>Pets</h3>${pets || '<p class="hint">No pets? Skip this.</p>'}<button class="btn sm" data-add="pet">+ Add pet</button></div>
  </div>`;
}
function wizPreview(p) {
  const s = summarize(p), board = buildHome(p);
  const rooms = board.rooms.map(r => `<span class="pill" style="color:var(--ink);background:var(--surface-2)">${esc(r.name)}</span>`).join(' ');
  const people = board.people.map(pp => `<span class="dot" style="background:${pp.color}"></span> ${esc(pp.name)}${pp.isAdult ? '' : ' <span class="nums">(child)</span>'}`).join(' &nbsp; ');
  const manual = board.chores.filter(c => !c.matrixKey).slice(0, 14).map(c => esc(c.name)).join(' · ');
  return `<div class="balance">
      <div class="bcard"><div class="who">People</div><div class="nums">${s.adults} adult${s.adults === 1 ? '' : 's'} · ${s.kids} kid${s.kids === 1 ? '' : 's'}</div></div>
      <div class="bcard"><div class="who">Rooms</div><div class="nums">${s.rooms}</div></div>
      <div class="bcard"><div class="who">Chores</div><div class="nums">${s.chores} · ${s.manual} everyday + ${s.matrix} room jobs</div></div>
    </div>
    <div class="panel" style="padding:13px 15px"><div class="tag" style="color:var(--ink);font-weight:700;margin-bottom:7px">Team</div><div>${people}</div></div>
    <div class="panel" style="padding:13px 15px;margin-top:14px"><div class="tag" style="color:var(--ink);font-weight:700;margin-bottom:7px">Rooms</div><div style="display:flex;flex-wrap:wrap;gap:6px">${rooms}</div></div>
    <div class="panel" style="padding:13px 15px;margin-top:14px"><div class="tag" style="color:var(--ink);font-weight:700;margin-bottom:7px">A taste of the chores</div><div class="hint" style="margin:0">${manual} …</div></div>
    ${s.people === 0 ? '<p class="wizlead" style="margin-top:14px;color:var(--alert);font-weight:600">Add at least one adult, or a child age 4 or older, on the “Who lives here” step before applying.</p>'
      : `<p class="wizlead" style="margin-top:14px">Apply replaces the current board with this setup${wiz.firstRun ? '' : ' (your history is kept)'}, then builds this week. Tune anything afterward in Chores, Rooms, and Team.</p>`}`;
}

function wireWizard() {
  const p = wiz.profile, body = $('#wizBody');
  body.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.preset;
    wiz.chosen = k; wiz.profile = clone(k === 'scratch' ? SCRATCH_PROFILE : presetByKey(k));
    renderWizard();
  }));
  body.querySelectorAll('[data-h]').forEach(el => el.addEventListener('change', () => {
    const k = el.dataset.h;
    if (k === 'yard') p.flags.yard = el.value;
    else if (k === 'homeSize') p.homeSize = el.value;
    else p[k] = Math.max(Number(el.min || 0), Number(el.value) || 0);
  }));
  body.querySelectorAll('[data-flag]').forEach(el => el.addEventListener('change', () => { p.flags[el.dataset.flag] = el.checked; }));
  body.querySelectorAll('[data-adult]').forEach(el => el.addEventListener('input', () => { p.adults[+el.dataset.adult].name = el.value; }));
  body.querySelectorAll('[data-deladult]').forEach(el => el.addEventListener('click', () => { p.adults.splice(+el.dataset.deladult, 1); renderWizard(); }));
  body.querySelectorAll('[data-kidname]').forEach(el => el.addEventListener('input', () => { p.kids[+el.dataset.kidname].name = el.value; }));
  body.querySelectorAll('[data-kidage]').forEach(el => el.addEventListener('change', () => { p.kids[+el.dataset.kidage].age = Math.max(0, Math.min(17, Number(el.value) || 0)); }));
  body.querySelectorAll('[data-delkid]').forEach(el => el.addEventListener('click', () => { p.kids.splice(+el.dataset.delkid, 1); renderWizard(); }));
  body.querySelectorAll('[data-pettype]').forEach(el => el.addEventListener('change', () => { p.pets[+el.dataset.pettype].type = el.value; }));
  body.querySelectorAll('[data-petname]').forEach(el => el.addEventListener('input', () => { p.pets[+el.dataset.petname].name = el.value; }));
  body.querySelectorAll('[data-delpet]').forEach(el => el.addEventListener('click', () => { p.pets.splice(+el.dataset.delpet, 1); renderWizard(); }));
  body.querySelectorAll('[data-add]').forEach(el => el.addEventListener('click', () => {
    const w = el.dataset.add;
    if (w === 'adult') p.adults.push({ name: '' });
    else if (w === 'kid') p.kids.push({ name: '', age: 8 });
    else p.pets.push({ type: 'dog', name: '' });
    renderWizard();
  }));
  $('#wizFoot').querySelectorAll('[data-wiz]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.wiz;
    if (a === 'back') { wiz.step = Math.max(0, wiz.step - 1); renderWizard(); }
    else if (a === 'next') { if (wiz.step === 0 && !wiz.profile) return; wiz.step = Math.min(3, wiz.step + 1); renderWizard(); }
    else if (a === 'apply') applyProfile(wiz.profile);
  }));
}

/* ===================== WIRING ===================== */
function switchView(v) {
  activeView = v;
  $$('.tab').forEach(t => { const on = t.dataset.view === v; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; });
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  if (v === 'week') renderWeek(); else if (v === 'chores') renderChores(); else if (v === 'rooms') renderRooms(); else if (v === 'team') renderTeam(); else if (v === 'history') renderHistory();
}
function renderActive() { switchView(activeView); }

$('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) switchView(b.dataset.view); });
$('#tabs').addEventListener('keydown', e => {                  // ARIA tablist keyboard pattern: arrows/Home/End move between tabs
  const tabs = $$('.tab'), i = tabs.indexOf(document.activeElement); if (i < 0) return;
  const j = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? (i + 1) % tabs.length
    : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  if (j < 0) return;
  e.preventDefault(); switchView(tabs[j].dataset.view); tabs[j].focus();
});
$('#generateBtn').addEventListener('click', generate);
$('#printBtn').addEventListener('click', () => window.print());
$('#graceDays').addEventListener('change', async () => { S.settings.graceDays = Math.max(1, Number($('#graceDays').value) || 3); await save(); });
$('#escalateAfter').addEventListener('change', async () => { S.settings.escalateAfter = Math.max(1, Number($('#escalateAfter').value) || 2); await save(); });
$('#fairness').addEventListener('change', async () => { S.settings.fairness = $('#fairness').value === 'rotate' ? 'rotate' : 'balanced'; await save(); });
$('#histRange').addEventListener('change', renderHistory);
$('#setupBtn').addEventListener('click', () => openWizard());
$('#wizClose').addEventListener('click', dismissWizard);
$('#wizard').addEventListener('click', e => { if (e.target.id === 'wizard') dismissWizard(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#wizard').hidden) dismissWizard(); });
$('#addChore').addEventListener('click', async () => { S.chores.unshift(mkChore('New chore', 10, 3, 1, 'weeks', false)); await save(); renderChores(); });
$('#addRoom').addEventListener('click', async () => { S.rooms.push({ id: uid('r'), name: 'New room', size: 'medium' }); await save(); renderRooms(); });
$('#addType').addEventListener('click', async () => { S.matrixTypes.push({ id: uid('t'), name: 'New type', minutes: 10, priority: 3, intervalCount: 1, intervalUnit: 'weeks', adultOnly: false, assignee: null }); await save(); renderRooms(); });
$('#addPerson').addEventListener('click', async () => { S.people.push({ id: uid('p'), name: 'New person', color: PCOLORS[S.people.length % PCOLORS.length], isAdult: true, age: null, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0, active: true }); await save(); renderTeam(); });
$('#applyMatrix').addEventListener('click', async () => {
  const before = S.chores.filter(c => c.matrixKey).length;
  S.chores = applyMatrix(S.chores, S.rooms, S.matrixTypes, S.matrixExclude);
  const after = S.chores.filter(c => c.matrixKey).length;
  await save(); renderRooms();
  toast(`Matrix applied · ${after} chore${after === 1 ? '' : 's'}` + (after > before ? ` (+${after - before})` : after < before ? ` (−${before - after})` : ''));
});
$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Erase all chores, rooms, team, history, and the current week, and reload the sample home?')) return;
  S = seedState(); normalize(); syncBudgetInputs();
  await save(); renderActive(); toast('Reset to the sample home');
});

function syncBudgetInputs() {
  $('#weekStart').value = S.settings.weekStartISO || toISO(mondayOf(new Date()));
  $('#graceDays').value = S.settings.graceDays;
  $('#escalateAfter').value = S.settings.escalateAfter;
  $('#fairness').value = S.settings.fairness || 'balanced';
}

/* ===================== LIVE SYNC ===================== */
// pull()/flush()/startStream() live in the STORAGE + SYNC section above. Refresh on tab focus
// in case an SSE ping was missed while the tab was backgrounded.
window.addEventListener('focus', () => { if (syncMode !== 'local') sync(); });

/* ===================== INIT ===================== */
(async function init() {
  await bootstrap();
  if (!S || !S.people || !S.people.length) {                // first run anywhere -> guided setup
    S = seedState(); normalize(); syncBudgetInputs(); renderWeek();
    openWizard({ firstRun: true });                         // dismissing it falls back to the sample home
    return;
  }
  normalize();
  syncBudgetInputs();
  renderWeek();
})();

// Progressive enhancement: install + offline shell. Service workers need a secure context, so this
// is a no-op over a plain-http LAN IP (works on localhost / behind HTTPS). The app is fully usable
// either way — the offline outbox in the sync layer is the real resilience.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
