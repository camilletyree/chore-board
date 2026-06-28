# CLAUDE.md

Working notes for Claude Code on this repo. Read this before changing scheduling behavior.

## What this is

A self-hosted family chore scheduler. Vanilla ES modules + a zero-dependency Node server. No
framework, no build step, no runtime dependencies. Keep it that way unless there's a strong reason
not to — the value here is that it runs anywhere Node runs and is trivial to host on a NAS.

## Architecture contract (don't break these)

1. **All scheduling logic lives in `public/scheduler.js` and stays pure.** No DOM, no `fetch`, no
   `Date.now()` reaching into globals — dates come in as ISO strings / args. This is what makes the
   engine testable and is the single source of truth shared by the browser and the tests. If you're
   adding scheduling behavior, it goes here, and it gets a test.
2. **All sync logic lives in `public/sync.js` and stays pure.** No DOM, no `fetch`, no `Date.now()`
   (the caller injects `now`). It's the other pure module shared by browser, server, and tests:
   whole-doc ↔ entities (`decompose`/`recompose`), the merge reducer (`applyChanges`), and the
   local-edit differ (`diffOps`). Sync behavior goes here and gets a test in `test/sync.test.js`.
3. **`public/app.js` owns side effects:** state, storage, rendering, events, the network sync client,
   the setup wizard, and the only places `Date`/`Math.random`-ish concerns live (e.g. `staggerChores`).
   It imports the pure modules. No scheduling *or* sync rules — only orchestration and presentation.
   - **Two more pure modules join the family, same rules (pure, tested, no DOM/IO/`Date.now`):**
     `public/templates.js` — the chore **library** + the deterministic **home builder** (`buildHome`
     turns a profile into a board); covered by `test/templates.test.js`. `public/stats.js` —
     `summarizeHistory` aggregates the completion log for the History view; covered by
     `test/stats.test.js`. New home/library/stats logic goes in these and gets a test.
4. **`server.js` is a dumb store.** Serves `public/` statically; persists entities and stamps each
   applied write with a monotonic `_seq`, resolving same-record conflicts by last-write-wins on the
   client `_updatedAt`. That's the *only* logic it has — **no scheduling/domain knowledge**, no deps.
5. **Entities, synced as deltas.** On disk: `{ serverSeq, entities }` (see `sync.js` for the shape).
   The browser holds the canonical `ent` (entities + `_seq`/`_updatedAt` metadata) and renders the
   recomposed whole-doc `S`. Every mutation still goes through `save()`, which now diffs `S` vs `ent`
   into per-record ops, queues them in a localStorage **outbox**, and POSTs `/api/changes`. Remote
   edits arrive via SSE-triggered (or polled) `pull()` and merge by `_seq`. `localStorage` is the
   offline fallback only; the server is the source of truth when present.

## Domain model (glossary)

- **chore** — `{id, name, minutes, priority(1–5), intervalCount, intervalUnit, adultOnly, minAge, assignee,
  lastDone, holder, lastHolder, assignedOn, escalated, enabled, matrixKey}`. `lastHolder` records who
  most recently did/held it; it's only consulted by the `rotate` fairness mode (otherwise inert).
- **age-appropriateness** — a chore's `minAge` (0 = any) and a person's optional `age` gate auto
  eligibility: a kid only gets an auto chore if `age >= minAge`. Adults always qualify; a person with
  **no `age` set is unconstrained** (back-compat for manually-added people). `assignee`/escalation still
  override. `templates.js` sets `age` on kids and `minAge` on chores; the Team tab has an **Age** field
  (blank = no limit), and manually-added chores default `minAge` 0 (no per-chore minAge editor — set
  `adultOnly` or an assignee instead).
- **fairness** — `settings.fairness`: `balanced` (default, proportional-capacity packing) or `rotate`
  (steer a chore away from its `lastHolder`, then balance, then a per-week deterministic shuffle so
  equally-free people take turns). Set in the week controls; passed to `assignInstances`.
- **history** — durable completion log: a `history` keyed collection (its own sync collection),
  one record per check-off `{id, choreId, name, personId, minutes, date, weekStartISO, priority, late}`,
  **never** cleared by `generate()` (unlike `week.completion`). `stats.js` aggregates it for the History tab.
- **obligation** — the open instance of a chore. A chore has **at most one** open obligation at a
  time, represented by `assignedOn` (the date it came due) + `holder` (who owns it). `holder === null`
  means "needs auto-assignment". Resting chore: `assignedOn === null`.
- **cadence** — `intervalCount` × `intervalUnit` (days/weeks/months/years). Drives when the next
  obligation opens, measured from `lastDone` (or "now" if never done).
- **grace** — days a holder has to complete an obligation before it's **delinquent**
  (`settings.graceDays`, default 3).
- **delinquency cycle** — `floor((today − assignedOn) / grace)`. 0 = on time, 1 = first delinquency, …
- **escalation** — once an *auto-held* (no explicit `assignee`) obligation owned by a *child* reaches
  `settings.escalateAfter` cycles, it's flagged `escalated`, the holder is released, and
  `buildInstances` forces it adult-only so it reassigns to an adult. Explicit assignees never escalate.
- **holder vs assignee** — `assignee` is a user-set lock ("always this person"). `holder` is the
  current owner, which the scheduler sets for auto chores and persists so delinquency/escalation
  follow the same person across refreshes. `assignee` always wins over `holder`.
- **matrix** — `rooms` × `matrixTypes`, minus `matrixExclude` (an array of `"typeId:roomId"` keys).
  `applyMatrix` regenerates derived chores (those with `matrixKey`), scaling `minutes` by room size
  (`SIZE_FACTORS`) and **preserving per-cell state** (`lastDone`, `holder`, `assignedOn`, `assignee`,
  `enabled`) across re-applies. Manual chores (no `matrixKey`) are untouched.

## Engine entry points (in order of a "Refresh week")

1. `rollForward(chores, {todayISO, horizonISO, grace, escalateAfter, people})` — mutates chores:
   opens due obligations, releases stale child obligations for escalation. The only mutating engine fn.
2. `buildInstances(chores, weekStartISO, todayISO, grace)` — pure → schedulable instances for the week
   (sets `delinquent`, `lateCycles`, `escalated`, and forces `adultOnly` when escalated).
3. `assignInstances(instances, people, opts?)` — pure → `{assignments, unassigned, load, holderOf}`.
   `opts = {fairness:'balanced'|'rotate', seed}` (default balanced; `app.js#generate()` passes the
   week-start as the seed).
   - Locked (holder or assignee) → **force-placed** on that person, *ignoring* budget and task-length
     caps (it's a must-do; the UI shows the over-budget meter in red). Never dropped to `unassigned`.
   - Auto → eligible filtered by `adultOnly` + per-person `maxTaskMinutes` + age (`age >= inst.minAge`,
     adults and no-age people exempt); placed by first-fit on the day nearest its target, choosing the
     person with the **highest remaining fraction** of weekly capacity. This proportional balance is
     deliberate — balancing by raw minutes starves the kids.
   - `rotate` reorders the candidates: avoid `inst.lastHolder` first, then the capacity rule above,
     then a seeded `hashStr` shuffle (reproducible — no `Math.random`). `app.js#generate()` writes the
     chosen holder back to `lastHolder` so next cycle shares it out.

`app.js#generate()` then writes `holderOf` back onto each chore so the holder sticks.

## Invariants worth a test if you touch the engine

- Adult-only (unlocked) never lands on a child; explicit assignee/escalation may override.
- Age-appropriate: an auto chore with `minAge` never lands on a younger kid; adults and no-age people qualify.
- A locked/over-budget task is force-placed, not unassigned.
- Exactly one open obligation per chore; completing clears it and starts the next cadence cycle.
- `applyMatrix` preserves per-cell state (incl. `lastHolder`) and honors `matrixExclude` and size scaling.
- Escalation: child + auto + `cycles ≥ escalateAfter` → adult; forced assignee never escalates.
- Fairness `rotate` steers an auto chore away from its `lastHolder` when someone else has room, and is
  deterministic for a given seed; `balanced` (default) is unchanged.

`test/scheduler.test.js` covers all of the above. `test/templates.test.js` covers the home builder
(gating, room derivation, age budgets, matrix-exclusion correctness, determinism) and
`test/stats.test.js` the history aggregation. **Run `npm test` after any engine/templates/stats change.**

## Sync invariants worth a test if you touch sync

- Independent edits never conflict: different chores/people/boxes edited at once all stick.
- Same-record edits resolve by last-write-wins (newer `_updatedAt`); the loser gets a `conflict`.
- `applyChanges` is monotonic: a higher `_seq` wins, an out-of-order lower `_seq` is a no-op.
- Tombstones (`_deleted`) propagate deletes and drop out of `recompose`.
- `diffOps` emits an op only for records that actually changed (key-order-insensitive compare).
- An unsynced local edit in the outbox survives a `pull()` (the `skip` set protects it).
- Round-trip: `recompose(decompose(S))` preserves the board; `completion`, `history`, and
  `matrixExclude`/`fairness` move to/from their entity homes correctly.
- `history` is its own keyed collection (durable log), independent of the per-week `completion`
  collection; the server stays generic over `KEYED`/`SINGLE`, so it needed no server change.

`test/sync.test.js` covers the pure reducers (in `npm test`). `npm run test:integration` spins up a
real server and drives two simulated clients end-to-end (migration, SSE, LWW). **Run `npm test`
after any sync change**, and `npm run test:integration` if you touch the wire protocol or server.

## Conventions

- ES modules everywhere (`"type": "module"`). Browser loads `app.js` via `<script type="module">`.
- 2-space indent, semicolons, single quotes. Match the existing terse style in `scheduler.js`.
- No new dependencies without updating this file and the Dockerfile, and justifying it in the PR.
- UI copy: plain, active voice, sentence case. Errors say what happened and how to fix it.
- Don't introduce `localStorage`/`sessionStorage` as the *primary* store — it's the offline fallback
  only. The server is the source of truth when present.

## Gotchas

- Dates are date-only and local; always go through the helpers in `scheduler.js` (`parseISO`,
  `toISO`, `addDays`, `addCadence`) — don't hand-roll `Date` math, especially for months/years.
- `pull()` re-renders on remote changes, but **never while a field is focused** (it would clobber an
  in-progress edit): it merges into `S` and, on the week grid, surgically refreshes only the
  checkboxes so a sibling's check-off shows without stealing focus. Keep that guard if you change sync.
- `flush()` must **not** advance `localSeq` — only `pull()` may, because only `pull()` actually
  fetches the changes up to that seq. Advancing it on POST would skip other devices' interleaved
  writes (a subtle clobber). The server's broadcast triggers the reconciling `pull()` right after.
- Completion records are keyed by assignment `uid` (`choreId#seq`), which **repeats across weeks**.
  `generate()` clears `week.completion`, so `diffOps` tombstones the old records; LWW handles the
  uid reuse. Don't assume a completion `uid` is globally unique.
- `history` records use `weekStart#uid` so they're unique across weeks. Checking a box appends one;
  unchecking tombstones it; `generate()` does **not** clear history (that's the whole point). Don't
  re-key history off the bare `uid` or it'll collide week to week.
- A fresh template would otherwise make every chore come due on the first refresh. `app.js#staggerChores`
  seeds `lastDone` in the past, deterministically per chore id, so first due-dates spread across each
  chore's cadence. It lives in `app.js` (needs today's date) — keep `templates.js` pure (it leaves
  `lastDone: null`). `buildHome` ids are deterministic (`c_/t_/r_/p…`), so re-applying a template is stable.
- The showcase template expands to ~150 chores (15 rooms × the matrix), which is intentional breadth;
  the scheduler + staggering keep any one week sane. The Chores tab lists them all (matrix ones are
  read-only there, managed in Rooms).
- PWA: the service worker only registers in a **secure context** (localhost / HTTPS), so it's a no-op
  over a plain-http LAN IP — by design. The offline outbox, not the SW, is the real resilience.
- `data/state.json` is gitignored. Don't commit real family data. The file is `{ serverSeq, entities }`;
  the server migrates an old whole-doc file in place on first start (idempotent), and GCs tombstones >30d.
- `/api/state` (GET recomposed snapshot / PUT wholesale replace) is kept for back-compat and reset;
  normal edits go through `/api/changes`. Don't route per-record edits back through `/api/state`.
