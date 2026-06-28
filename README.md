# ChoreBoard

A self-hosted household chore scheduler. You describe each chore (priority, duration,
cadence, who's allowed to do it) and your family's daily time budgets, and it generates a
balanced weekly assignment grid — packing each person's day up to their time budget,
respecting adult-only rules, and tracking what's overdue.

Built to run on a home server (e.g. a Synology NAS) and be opened from any family device on
the same network. State is shared: everyone sees and edits the same board.

![ChoreBoard — the weekly assignment grid, with per-person time-budget meters and color-coded chore cards](docs/screenshot.png)

## What it does

- **Guided setup.** A first-run wizard builds a board tailored to your home — describe the
  bedrooms/bathrooms/floors, who lives there (with kids' ages), pets, and yard, and ChoreBoard
  generates sized rooms, a matrix of cleaning types, and a realistic chore list. Pick a ready-made
  preset (studio → large multigenerational house) or build your own; re-run it anytime from **Set up**.
- **Smart weekly schedule.** Each person-day is a time bin (default 30 min weekdays / 60 min
  weekends, per-person). The engine packs due chores into bins, balancing load by *fraction of
  capacity* so kids aren't starved and adults aren't buried, and surfaces anything that won't fit.
- **Fairness modes.** Balance by free time, or *rotate & share* so the same person isn't perpetually
  stuck with the toilets and the trash.
- **History & stats.** A durable completion log shows who pulled their weight, the most-done chores,
  recent activity, and what's slipping right now.
- **Installable & printable.** Install it to a phone/tablet home screen (PWA, offline shell), and
  print a clean per-person weekly "fridge sheet."
- **Obligation + delinquency lifecycle.** A chore comes due on its cadence and is assigned to a
  *holder*. They have a grace window (default 3 days) to check it off. Miss it and it goes
  **delinquent** — pinned to the same person at the top of their day. After a configurable number
  of delinquency cycles, an auto-assigned chore **escalates to an adult**.
- **Flexible cadence.** Every *N* days / weeks / months / years, with real calendar math.
- **Per-chore assignment.** Lock a chore to one person, or let the scheduler auto-balance it.
- **Room × chore matrix.** Declare rooms (with sizes) and matrix chore types (Tidy, Vacuum, Mop…);
  generate one chore per compatible room×type cell. Duration scales with room size, and a
  compatibility grid lets you exclude combinations (e.g. don't mop a carpeted room).

## Quick start (local)

Requires **Node 18+**. No dependencies, no build step.

```bash
node server.js
# open http://localhost:8080
```

Run the tests:

```bash
npm test                 # all pure logic: engine, sync, home builder, stats (offline, fast)
npm run test:integration # spins up a real server, two simulated clients end-to-end
```

You can also open `public/index.html` directly as a file — it falls back to per-device
`localStorage` (the top-right badge shows **Local only** instead of **Shared**). Running the
server is what makes the board shared across devices.

## Project layout

```
chore-board/
├── server.js              # zero-dependency static server + /api/state JSON store
├── package.json           # ES modules; "start" and "test" scripts; no runtime deps
├── public/
│   ├── index.html         # markup + tab shell + setup-wizard modal
│   ├── styles.css         # all styling (incl. wizard, history, print "fridge sheet")
│   ├── scheduler.js       # PURE engine: cadence, obligations, assignment, fairness, matrix (no DOM/IO)
│   ├── sync.js            # PURE sync core: whole-doc <-> entities, delta merge (no DOM/IO)
│   ├── templates.js       # PURE home builder + chore library + presets (no DOM/IO)
│   ├── stats.js           # PURE completion-history aggregation for the History view (no DOM/IO)
│   ├── app.js             # state, storage, rendering, sync client, setup wizard (imports the pure modules)
│   ├── manifest.webmanifest, icon.svg, sw.js   # PWA: install + offline shell
├── test/
│   ├── scheduler.test.js  # pure engine (incl. fairness)
│   ├── sync.test.js       # pure sync reducers (incl. the history collection)
│   ├── templates.test.js  # the pure home builder
│   ├── stats.test.js      # the pure history aggregation
│   └── integration.test.mjs # end-to-end: spawns a server, two simulated clients, migration + SSE
├── data/                  # runtime state.json (gitignored) — the shared source of truth
├── Dockerfile
└── docker-compose.yml
```

All scheduling logic lives in `public/scheduler.js` as pure functions and is covered by
`test/scheduler.test.js`. See `CLAUDE.md` for the architecture contract and `VISION.md` for the
roadmap and open design decisions.

## Deploy on a Synology NAS (StratoSaturn)

The recommended path is **Container Manager** (Docker), because it's self-contained and survives
DSM updates.

1. Copy this folder to a share, e.g. `/volume1/docker/chore-board/`.
2. In DSM open **Container Manager → Project → Create**.
   - Project name: `chore-board`
   - Path: the folder you copied
   - Source: **Use existing docker-compose.yml**
3. Build and run. The board is then at `http://<NAS-IP>:8080` from any device on the LAN.
4. (Optional) Give the NAS a reserved IP/hostname in your router so the URL is stable, and bookmark
   it on each family device's home screen.

Shared state persists to `./data/state.json` on the NAS (mounted into the container at `/data`),
so it survives container rebuilds. Back it up by copying that file, or just include the share in
your normal NAS backup.

### Without Docker

Container Manager isn't installed, or you'd rather not use it:

- **Node directly.** Install the Node.js package from Package Center, then run `node server.js`
  from the project folder (set `PORT`/`DATA_FILE` as needed). Use **Task Scheduler → triggered task
  (boot-up)** to start it automatically.
- **Web Station (static only).** Web Station can serve `public/` as a static site, but *static
  hosting can't share state* — every device would get its own private copy via `localStorage`.
  Only use this if you don't need a shared board.

## Configuration

| Env var     | Default            | Purpose                                  |
|-------------|--------------------|------------------------------------------|
| `PORT`      | `8080`             | Port the server listens on               |
| `DATA_FILE` | `./data/state.json`| Where shared state is persisted          |

## Notes & limits

- **Per-entity live sync.** The board is stored as addressable records (people, chores, rooms,
  matrix types, settings, the week, and each completed box) and devices exchange small **deltas**, so
  independent edits never clobber each other — two kids checking different boxes, or a parent renaming
  a chore while another edits a different one, all stick. Same-record edits resolve last-write-wins.
  Changes push to other devices in about a second over Server-Sent Events (with a short poll as a
  fallback), and edits made while offline queue in an outbox and flush on reconnect.
- **State migrates automatically.** An older `data/state.json` (one whole-document blob) is converted
  to the entity store in place on first start; no manual step. `GET/PUT /api/state` still works as a
  whole-board snapshot/restore endpoint.
- **Install & offline.** ChoreBoard ships a web app manifest and a service worker, so it can be
  installed to a phone/tablet home screen and the app shell loads offline. Service workers require a
  *secure context*, so install/offline activates on `localhost` or behind HTTPS — over a plain-http
  LAN IP it simply doesn't register (the app still works; the offline edit outbox is the real
  resilience either way).
- **No authentication.** Intended for a trusted LAN. Don't expose it directly to the internet
  without putting auth/a reverse proxy in front.
