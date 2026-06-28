# TODO

> **Beta status.** Beyond the sync work below, the Beta shipped: a first-run **setup wizard** +
> parametric **home templates** with a real chore **library** (`public/templates.js`), **fairness
> modes** (rotate & share, in `scheduler.js`), a durable **history** collection + **stats** view
> (`public/stats.js`), **PWA** install/offline (`manifest.webmanifest`/`sw.js`), and a print
> "fridge sheet." All pure logic is unit-tested (`npm test` runs engine + sync + templates + stats);
> `npm run test:integration` still covers the wire protocol. See `VISION.md` for what's next.
>
> **Status (sync, implemented).** Slices 1–3 below are done: entities on disk with `/api/changes`
> GET/POST (per-entity LWW), `/api/stream` SSE push with a poll fallback, the client outbox, and the
> focused-row re-render guard. `public/sync.js` holds the pure core (`decompose`/`recompose`/
> `applyChanges`/`diffOps`); covered by `test/sync.test.js` and the end-to-end `npm run
> test:integration`. **Still deferred:** field-level LWW (Slice 4) — only do it if same-record,
> different-field concurrent edits become a real problem. The rest of this doc is kept as the design
> record.

## Per-entity sync (replace whole-document last-write-wins)

### Why
Today the whole board is one JSON doc saved via `PUT /api/state`, and clients full-poll
`GET /api/state` every 15s, replacing local `S` when `rev` increases. Two consequences:

- **Clobbering.** Two devices editing *anything* in the same ~15s window: last writer wins the
  entire document, silently discarding the other's change — even if they touched unrelated chores.
- **Latency.** Changes take up to 15s (or a focus event) to appear elsewhere. Painful when several
  kids check boxes at once on a Saturday.

Goal: independent edits to different things never conflict, same-thing edits resolve at entity (not
document) granularity, and changes propagate in ~1s. Keep the constraints: vanilla ES modules, no
build, zero server deps, server stays domain-dumb (no scheduling logic).

### Core idea
Decompose the blob into addressable **entities**, each carrying its own revision metadata, and sync
**deltas** instead of the whole document. Conflict resolution becomes per-entity last-write-wins,
which already eliminates essentially all real family clobbering.

### Data model
Collections keyed by id: `people`, `chores`, `rooms`, `matrixTypes`. Singletons: `settings`,
`week`. `matrixExclude` folds into `settings`. `week.completion` gets promoted to its own collection
(see "The actual win" below).

Every record gains sync metadata (underscore-prefixed, ignored by the engine):
```
{ ...domainFields, _seq: <int>, _updatedAt: <ms>, _deleted?: true }
```
- `_seq` — server-assigned monotonic sequence (Lamport-ish), unique and increasing per applied write.
- `_deleted` — tombstone, so deletes propagate. GC tombstones older than e.g. 30 days on server start.

On-disk shape becomes:
```
{ serverSeq: <int>, entities: { people:{id:rec}, chores:{...}, rooms:{...},
  matrixTypes:{...}, completion:{uid:rec}, settings:{rec}, week:{rec} } }
```

### Server API (additions; keep `/api/state` for snapshot + back-compat)
- `GET /api/changes?since=<seq>` → `{ serverSeq, changes: [{collection, id, rec}] }` for every record
  with `_seq > since`. Cheap no-op when nothing changed (returns empty `changes`, same `serverSeq`).
- `POST /api/changes` body `{ ops: [{collection, id, rec, baseSeq}] }` → server applies each op:
  - assign `_seq = ++serverSeq`, stamp `_updatedAt`;
  - **per-entity LWW:** accept if incoming `_updatedAt` ≥ stored (or always accept and let newest win);
  - return `{ serverSeq, applied:[{collection,id,_seq}], conflicts:[...] }`.
  Server does **no** merging of domain meaning — it just stores records and stamps seqs.
- Optional push: `GET /api/stream` Server-Sent Events. Built-in `EventSource` on the client, plain
  `res.write('data: ...\n\n')` on the Node side — no dependency. Emit `{serverSeq}` pings on each
  applied write; client reacts by pulling `/api/changes?since=localSeq`. This is what kills the 15s lag.

### Conflict policy (proportionate, in order of effort)
1. **Per-entity LWW (baseline, do this).** Different entities → never conflict. Same entity →
   newest `_updatedAt` wins for that record only. Solves the family case.
2. **Field-level LWW (stretch, probably unnecessary).** Per-field timestamps so two people editing
   different fields of the *same* chore both stick. More machinery; defer until it's a real problem.

### The actual win: completion as its own keyed collection
The high-frequency, high-concurrency action is checking boxes. Promote `week.completion` from a map
nested in the `week` singleton to a first-class `completion` collection keyed by assignment `uid`
(`${choreId}#${seq}`, already unique within a generated week). Then two kids checking *different*
tasks are upserts to *different* records → zero conflict, instant propagation. This is the single
change that removes the pain the user described; do it even if the rest is deferred.

Note: `uid`s are regenerated each `generate()`, so clear/replace the `completion` collection on
refresh (tie completion records to `week._seq` or a `weekId` and drop stale ones).

### Client changes (`app.js`)
- Track `localSeq`. Initial load: `GET /api/state` snapshot → set `localSeq = serverSeq`.
- **Pull (delta):** `GET /api/changes?since=localSeq`; upsert each change into `S` by id honoring
  `_seq`/tombstones; advance `localSeq`; re-render the active view — but **skip re-rendering the row
  containing the focused input** so a remote change to chore Y can't blow away an in-progress edit of
  chore Y's name. (Today's whole-`S` replace can't do this; per-entity apply makes it tractable.)
- **Push (local edit):** on mutation, enqueue the changed record(s) to an **outbox** and POST
  `/api/changes`; on success advance `localSeq` to the returned seqs. Outbox persists to localStorage
  so edits survive a reload/offline gap and flush on reconnect. Keeps the existing offline fallback.
- Replace the 15s `setInterval(pull)` with SSE-triggered pulls (fall back to a short 3–5s poll if the
  `EventSource` connection drops).

### Engine interaction (don't let this leak into the server)
- `generate()` stays a coarse, whole-board read that writes the `week` singleton plus `holder` /
  `assignedOn` / `lastDone` onto many chores. Route those writes through the same per-entity upsert so
  they merge with concurrent completion check-offs rather than replacing the doc.
- Completion vs generation race: completion (a user fact: "I did this") should beat a stale generate.
  Per-entity `_updatedAt` LWW handles it — whichever happened later wins, which is the desired result.
- Server still runs **no** scheduling logic. (See CLAUDE.md architecture contract.)

### Migration / back-compat
- Server start: if the state file is the old `{rev, people, chores, ...}` shape, decompose into the
  `entities` shape, stamp every record `_seq = 1`, set `serverSeq = 1`. Idempotent.
- Keep `GET/PUT /api/state` working (snapshot/restore + clients that predate `/api/changes`). A client
  detects delta support by probing `/api/changes` once; if 404, stay in whole-doc mode.

### Suggested sequencing
1. ✅ **Slice 1:** promote `completion` to a keyed collection + add `/api/changes` GET/POST with
   per-entity LWW. (Shipped together with Slice 2 — the server was built generic from the start, with
   the full entities model on disk and an idempotent migration.)
2. ✅ **Slice 2:** all collections (`people`/`chores`/`rooms`/`matrixTypes`/`settings`/`week`) on the
   delta path; focused-row re-render guard + localStorage outbox.
3. ✅ **Slice 3:** SSE push (`/api/stream`); poll dropped to a 4s fallback when the stream is down.
4. **Later (only if needed):** field-level LWW.

### What shipped vs. the design above (notes for the next reader)
- The client keeps its rendered whole-doc `S` and a canonical entity store `ent`; `save()` diffs `S`
  vs `ent` (`diffOps`) so existing mutation handlers were untouched — they still just call `save()`.
- `matrixExclude` is folded into the `settings` singleton (as designed); `recompose` splits it back
  out so the rest of `app.js` still sees `S.matrixExclude`.
- Stale completion is handled by **tombstoning on `generate()`** (via the diff), not a `weekId` field;
  uid reuse across weeks is safe under `_updatedAt` LWW. (See the design note under "The actual win".)
- **`flush()` does not advance `localSeq`** — only `pull()` does, since only it fetches the changes up
  to that seq. Advancing on POST skips other devices' interleaved writes. (Easy to get wrong; tested.)
- Default transport is **SSE with a 4s poll fallback** (resolves the "SSE vs short-poll" open
  question in favor of SSE, kept cheap because pulls hit the lightweight `/api/changes`).

### Testing
- Engine is unaffected — `scheduler.js` stays pure; `npm test` should remain green throughout.
- Add merge tests for the new (pure) client-side `applyChanges(state, changes)` reducer: tombstones,
  out-of-order seqs, same-entity LWW, completion collection independence. Keep that reducer pure so it
  can live in/near the engine and be unit-tested without a DOM.
- Manual: two browser tabs against one server, edit different chores simultaneously → both persist;
  check two different boxes simultaneously → both stick within ~1s.

### Open questions
- SSE vs short-poll as the default? SSE is nicer but adds a long-lived connection per device; for a
  handful of devices it's fine. Short-poll (3–5s) on the cheap `/api/changes` may be enough and is
  simpler — decide based on how the box-checking feels after Slice 1.
- Tombstone GC window (30 days?) and whether to ever hard-compact the entity log.
