# ChoreBoard Beta — manual test pass

Run through these in order. **Check the box if it passes.** If it fails, write what happened on the
`❌ If it failed:` line under that test — be specific (what you did, what you expected, what you saw).
We'll triage the failures together and fix or defer each one.

> Scope: this is the human/UI pass. The automated logic is covered by `npm test` (engine, sync,
> templates, stats) and `npm run test:integration` — run those first as a baseline (§1).

---

## 1. Baseline (automated)

- [ ] `npm test` prints **ALL TESTS PASSED** four times (scheduler, sync, templates, stats).
  - ❌ If it failed: 
- [ ] `npm run test:integration` prints **ALL INTEGRATION CHECKS PASSED**.
  - ❌ If it failed: 

---

## 2. Start the app (fresh)

```powershell
# from C:\dev\chore-board — use a throwaway data file so you get the first-run experience
$env:DATA_FILE = ".\data\beta-test.json"
node server.js
# open http://localhost:8080  (localhost is a secure context, so PWA/install works here)
```

- [ ] Server prints `ChoreBoard running at http://0.0.0.0:8080`.
  - ❌ If it failed: 
- [ ] The page loads and the top-right badge reads **Shared** (green dot).
  - ❌ If it failed: 

---

## 3. First-run setup wizard

- [ ] On first load the **Set up your board** dialog opens by itself, on **Step 1 of 4 · Pick a starting point**.
  - ❌ If it failed: 
- [ ] The preset gallery shows ~10 cards (Studio · solo … Large house · multigenerational); the **Family of 4 · 3 bed / 3 bath** card is pre-selected (highlighted) and **Next** is enabled.
  - ❌ If it failed: 
- [ ] Clicking a different card highlights it; clicking **Build from scratch** also selects.
  - ❌ If it failed: 
- [ ] **Next** → Step 2 (Describe your home): home size, bedrooms, bathrooms, floors, yard, and toggles (Dining/Laundry/Office/Garage/Basement/Dishwasher) reflect the chosen preset.
  - ❌ If it failed: 
- [ ] **Next** → Step 3 (Who lives here): adults, children (with ages), and pets are listed; **+ Add** / ✕ remove work for each.
  - ❌ If it failed: 
- [ ] **Next** → Step 4 (Preview): the People / Rooms / Chores counts, the team, the room chips, and a sample of chores look sensible for the chosen home.
  - ❌ If it failed: 
- [ ] **Apply this setup** closes the wizard, lands on **This week**, and a populated weekly grid appears within a moment.
  - ❌ If it failed: 
- [ ] **Back** returns to the prior step with your edits intact.
  - ❌ If it failed: 

---

## 4. Templates are parametric

- [ ] Click **Set up** (top bar) → on Step 2 increase **Bathrooms** and toggle **Office** on → Step 4 preview's room/chore counts go up accordingly.
  - ❌ If it failed: 
- [ ] On Step 3, remove all pets → Step 4 no longer mentions pet chores (no dog/cat tasks).
  - ❌ If it failed: 
- [ ] Add a child aged **3** (or younger) → they do **not** appear as a team member, but baby/kid chores still appear.
  - ❌ If it failed: 
- [ ] Remove every adult and have no child aged 4+ → **Apply** is disabled and the preview warns you to add someone.
  - ❌ If it failed: 
- [ ] Apply a clearly different preset (e.g. **Studio · solo**) → the board (team, rooms, chores) is replaced to match.
  - ❌ If it failed: 

---

## 5. This week — generation & balancing

> Re-apply the **Family of 4** preset for the rest of the pass (Set up → Family of 4 → Apply).

- [ ] The grid shows each active person as a row and Mon–Sun as columns; today's column is marked.
  - ❌ If it failed: 
- [ ] The per-person capacity meters (top) and per-day meters are filled proportionally; nobody is wildly over while others sit empty.
  - ❌ If it failed: 
- [ ] **Refresh week** rebuilds the slate; the toast reports how many tasks were built (and how many didn't fit, if any).
  - ❌ If it failed: 
- [ ] Anything that doesn't fit appears in a **"Couldn't fit…"** box below the grid with a reason.
  - ❌ If it failed: 
- [ ] Changing **Grace** / **Escalate** / **Week starts** and refreshing takes effect.
  - ❌ If it failed: 

---

## 6. Fairness — rotate & share

- [ ] Set **Balance → Rotate & share**. Refresh, then bump **Week starts** forward a week and refresh again, a few times.
  - ❌ If it failed: 
- [ ] A recurring unpleasant chore (e.g. **Scrub toilet — …**, **Take out kitchen trash & recycling**) tends to move between people across weeks rather than always landing on the same person.
  - ❌ If it failed: 
- [ ] Switching back to **By free time** still produces a balanced, sensible slate.
  - ❌ If it failed: 

---

## 7. Chores tab

- [ ] The Chores table lists everything; matrix-generated chores show a **matrix** pill and their fields are read-only there.
  - ❌ If it failed: 
- [ ] Edit a manual chore's name / minutes / priority / cadence / Adult-only / Assign-to / Last-done → it saves instantly (no error badge).
  - ❌ If it failed: 
- [ ] **+ Add chore** adds a row you can edit; the ✕ removes a manual chore.
  - ❌ If it failed: 
- [ ] Toggling **enabled** off drops a chore from the next refresh.
  - ❌ If it failed: 

---

## 8. Rooms & matrix

- [ ] Add a room and pick a size; add a chore type; the **Compatibility** grid shows the room×type cells.
  - ❌ If it failed: 
- [ ] Unchecking a compatibility cell, then **Apply matrix**, removes that chore; the count line and toast update.
  - ❌ If it failed: 
- [ ] Changing a room's size rescales its matrix chores' minutes after Apply matrix.
  - ❌ If it failed: 

---

## 9. Team tab (incl. Age)

- [ ] Each person shows Name, Color, Adult, **Age**, Weekday/Weekend min, Max task min, Active.
  - ❌ If it failed: 
- [ ] The two kids show their ages (10 and 6); the adults' Age is blank.
  - ❌ If it failed: 
- [ ] Editing budgets / max-task / age saves instantly; **+ Add person** and ✕ remove work (it won't let you remove the last person).
  - ❌ If it failed: 

---

## 10. Age-appropriateness

- [ ] On a refreshed week, the 6-year-old is **not** assigned age-restricted chores (e.g. Scrub toilet, Scrub shower & tub, Mop) — those go to older kids/adults.
  - ❌ If it failed: 
- [ ] Set the 6-year-old's **Age** to 13 in Team, refresh → they may now pick up more of those chores.
  - ❌ If it failed: 
- [ ] Adult-only chores (e.g. Deep-clean the oven, Pay bills) never land on a child.
  - ❌ If it failed: 

---

## 11. Obligation lifecycle (delinquency / escalation)

- [ ] In Chores, set a chore's **Last done** to ~2 weeks ago and Refresh → it appears flagged **DELINQUENT** pinned near the top of its holder's day.
  - ❌ If it failed: 
- [ ] Push **Last done** further back (past `grace × escalate` days) for an auto chore held by a child → after Refresh it flags **ESCALATED** and moves to an adult.
  - ❌ If it failed: 

---

## 12. Completing tasks + History

- [ ] Check a task's box → it strikes through / dims; unchecking restores it.
  - ❌ If it failed: 
- [ ] Open **History** → totals, a per-person "who pulled their weight" share bar, **Most done**, and **Recent activity** reflect what you checked.
  - ❌ If it failed: 
- [ ] Change the History **Range** (7/30/90/all) → the numbers update.
  - ❌ If it failed: 
- [ ] Check a few boxes, then **Refresh week** → History **keeps** those completions (the log isn't wiped by regenerating).
  - ❌ If it failed: 
- [ ] If anything is past its grace window, History shows a **"slipping right now"** list.
  - ❌ If it failed: 

---

## 13. Live sync (two tabs)

> Open a second tab at http://localhost:8080 (or a private window) — each is a "device".

- [ ] Check a task in tab A and a **different** task in tab B → within ~1s both tabs show **both** checked (neither clobbers the other).
  - ❌ If it failed: 
- [ ] Rename one chore in A and a **different** chore in B → both edits stick in both tabs.
  - ❌ If it failed: 
- [ ] In A, click into a chore-name field and type (don't blur); in B check a box → A does **not** lose what you're typing.
  - ❌ If it failed: 

---

## 14. PWA — install & offline

- [ ] In Chrome on **http://localhost:8080**, an install icon appears in the address bar; installing opens ChoreBoard in its own window.
  - ❌ If it failed: 
- [ ] With the app open, stop the server (Ctrl-C) and reload → the app shell still loads (badge flips to **Saved locally / Offline**); restart the server and edits flush back to **Shared**.
  - ❌ If it failed: 

---

## 15. Print — fridge sheet

- [ ] Click **Print** (or Ctrl-P) → the preview is a clean **per-person weekly checklist** (one block per person, tasks grouped by day with empty checkboxes), not the on-screen grid.
  - ❌ If it failed: 

---

## 16. Accessibility / keyboard

- [ ] Tab to the view tabs, then use **← / →** (and Home/End) to move between This week / Chores / Rooms / Team / History.
  - ❌ If it failed: 
- [ ] Open **Set up**, press **Tab** repeatedly → focus stays inside the dialog (doesn't reach the page behind it); **Esc** closes it and focus returns to the Set up button.
  - ❌ If it failed: 
- [ ] A screen reader (or hovering) announces a meaningful name for the week checkboxes and the ✕ delete buttons (not just "checkbox" / "✕").
  - ❌ If it failed: 

---

## 17. Reset

- [ ] **Reset** (top bar) → after confirming, the board returns to the sample **Family of 4** home and the week is rebuilt.
  - ❌ If it failed: 

---

## Anything else

Notes / surprises / papercuts not covered above:

> 
> 

---

When you've gone through it, send me the failures (the filled-in `❌` lines) and I'll fix or we'll
decide to defer. To wipe the test data afterward: stop the server and delete `data\beta-test.json`.
