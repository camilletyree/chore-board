# VISION.md

## The problem

Running a household is a recurring scheduling problem that families solve badly: chores have
different urgencies, durations, and cadences; some are kid-appropriate and some aren't; and the
labor should be shared fairly without anyone having to re-derive "who does what this week" by hand
every week. Sticky notes and shared docs don't enforce time budgets, don't track what's overdue,
and don't rebalance.

ChoreBoard turns that into a small, honest optimization: given the chores, the people, and how much
time each person realistically has per day, produce a fair weekly slate — and keep it honest over
time by tracking who's actually doing their part.

## Who it's for

One household, running on its own hardware, opened from family devices on the LAN. Not a SaaS, not
multi-tenant, no accounts. The whole thing should remain something a technically-comfortable parent
can read end-to-end, host on a NAS, and modify.

## Principles

- **The engine is the product.** The scheduling logic is pure, tested, and lives in one file. The UI
  and server are replaceable shells around it.
- **Honest over magical.** When the week can't fit, say so and why, rather than silently dropping
  tasks. When a kid ignores a chore, surface it (delinquent → escalate) rather than letting it vanish.
- **Fair by construction.** Balance by proportion of capacity, not raw minutes, so the youngest pull
  a real but age-appropriate share. Time budgets and task-length caps encode "what's realistic for
  this person" once, instead of being re-litigated each week.
- **Tunable, because households differ.** Grace period, escalation threshold, budgets, cadences,
  room sizes, and compatibilities are all data, edited in the app, not constants in code.
- **Self-hostable and dependency-light.** Runs anywhere Node runs; no build, no cloud.

## Current capabilities (v2)

- Weekly time-budgeted assignment grid with per-person capacity meters and an overflow report.
- Obligation lifecycle: cadence-opened obligations, a grace window, delinquency, and escalation to an
  adult after N delinquency cycles.
- Cadence in days/weeks/months/years with calendar-correct math.
- Per-chore lock-to-a-person, or auto-balance.
- Room × chore matrix with size-scaled durations and a compatibility grid for incompatible cells.
- Real-time shared state across devices: per-entity delta sync over a small JSON API (independent
  edits never clobber; ~1s propagation via Server-Sent Events), with an offline outbox fallback.

## Open design decisions & roadmap

Roughly in priority order. None are committed; this is the thinking, not a backlog promise.

### Incompatibility: grid today, attributes later
Today incompatibility is a per-cell exclusion grid (`matrixExclude`) — the right call at household
scale. If rooms/types ever multiply, the upgrade is **room attributes + type requirements**: tag
rooms (`flooring: carpet | hardwood | tile`, `has_toilet`, …) and give types predicates
(`mop requires hard floor`), so generation derives compatibility and a new room auto-applies the
rules. The current exclusion set is forward-compatible: attribute-derived exclusions can populate the
same `matrixExclude`, so this is additive, not a rewrite.

### Per-room duration overrides
Size scaling (small/medium/large/huge) covers most of "rooms aren't the same effort." If a specific
cell still needs a bespoke duration (a galley kitchen that mops faster than its size implies), add an
optional per-cell `minutesOverride` on the derived chore that survives re-apply, shown in the matrix.

### Fairness modes
Beyond proportional load: an **even-rotation** mode for the unpleasant chores (toilets, trash) so the
same person doesn't always draw them, and a **shuffle** so a given chore isn't perpetually the same
kid's job. Both are scheduler-layer changes with clear test cases.

### Escalation policy
Currently: same holder through delinquency, then escalate auto-assigned child chores to an adult.
Possible extensions: configurable escalation *targets* (to a specific parent, or round-robin among
adults), notifications when something escalates, and a "stuck" report of chronically delinquent chores.

### Sync & history
- ✅ Finer-grained sync — **done**: per-entity deltas with last-write-wins per record, SSE push, and
  an offline outbox (see `TODO.md` and `public/sync.js`). Remaining stretch: field-level LWW, only if
  same-record/different-field concurrent edits ever become a real problem.
- A completion **history/stats** view: who did how much, streaks, which chores are chronically late —
  the data (`lastDone`, completion records) is already being captured.

### Quality-of-life
- PWA install + a print-optimized "fridge sheet" (print stylesheet exists; could be richer).
- Light auth / reverse-proxy guidance for households that want it reachable beyond the LAN.
- Optional reminders (the obligation model already knows what's due and to whom).

## Non-goals

- Multi-household / SaaS / accounts.
- A heavy frontend framework or a build pipeline.
- Turning the server into a smart backend. Domain logic stays in the pure engine; the server stays a
  store.
