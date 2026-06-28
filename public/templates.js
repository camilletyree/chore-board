// templates.js — PURE, side-effect-free home-template engine. No DOM, no I/O, no Date.now/Math.random.
// Imported by the browser app (app.js) and the test suite. Turns a "home profile" (how many
// bedrooms/bathrooms/floors, who lives there, pets, yard…) into a ready-to-use ChoreBoard:
// people, sized rooms, matrix chore-types, the incompatibility set, and a tailored chore list.
//
// It leans on the existing matrix engine: a curated MATRIX_TYPES list crosses every room, and the
// builder computes `matrixExclude` from each type's `appliesTo` room-kinds vs. each room's kind
// (e.g. "Scrub toilet" only in bathrooms, "Vacuum" only in carpeted rooms). MANUAL_CHORES are the
// non-room jobs (dishes, laundry, pets, yard, admin…), each gated by `requires` tags so a home only
// gets the chores it actually has a reason for. Everything is deterministic: same profile in, same
// board out — which is what lets the wizard show a live preview and lets this be unit-tested.

import { applyMatrix, UNITS } from './scheduler.js';

/* ===================== ROOM KINDS ===================== */
export const ROOM_KINDS = ['kitchen', 'bathroom', 'half_bath', 'bedroom', 'living', 'dining', 'laundry', 'office', 'hallway', 'entryway', 'stairs', 'garage', 'basement', 'outdoor'];

/* ===================== THE LIBRARY ===================== */
// mt: a matrix (per-room) chore TYPE. minutes are for a MEDIUM room; the engine scales by room size.
//   mt(key, name, minutes, priority, intervalCount, intervalUnit, adultOnly, appliesTo[], minAge)
const mt = (key, name, minutes, priority, intervalCount, intervalUnit, adultOnly, appliesTo, minAge) =>
  ({ key, name, minutes, priority, intervalCount, intervalUnit, adultOnly, appliesTo, minAge });
// mc: a MANUAL (non-room) chore. `requires` is an AND-list of tags the home must satisfy.
//   mc(key, name, minutes, priority, intervalCount, intervalUnit, adultOnly, minAge, requires[])
const mc = (key, name, minutes, priority, intervalCount, intervalUnit, adultOnly, minAge, requires) =>
  ({ key, name, minutes, priority, intervalCount, intervalUnit, adultOnly, minAge, requires });

export const MATRIX_TYPES = [
  mt("wipe-counters", "Wipe counters & sink", 6, 5, 1, "days", false, ["kitchen"], 6),
  mt("clean-stovetop", "Clean stovetop", 10, 4, 3, "days", false, ["kitchen"], 10),
  mt("scrub-toilet", "Scrub toilet", 8, 4, 1, "weeks", false, ["bathroom", "half_bath"], 10),
  mt("clean-bath-sink", "Clean sink, counter & mirror", 8, 3, 1, "weeks", false, ["bathroom", "half_bath"], 8),
  mt("scrub-shower-tub", "Scrub shower & tub", 15, 4, 1, "weeks", false, ["bathroom"], 12),
  mt("tidy-declutter", "Tidy & declutter", 10, 3, 3, "days", false, ["bedroom", "living", "dining", "office", "basement", "entryway", "hallway"], 6),
  mt("make-beds", "Make the beds", 5, 3, 1, "days", false, ["bedroom"], 6),
  mt("tidy-toys", "Tidy toys", 7, 3, 1, "days", false, ["bedroom", "living", "basement"], 4),
  mt("dust-surfaces", "Dust surfaces & electronics", 12, 3, 1, "weeks", false, ["bedroom", "living", "dining", "office", "hallway", "entryway"], 8),
  mt("vacuum-carpet", "Vacuum carpet & rugs", 10, 4, 1, "weeks", false, ["bedroom", "living", "office", "stairs", "hallway", "basement"], 8),
  mt("sweep-floor", "Sweep floor", 8, 3, 1, "weeks", false, ["kitchen", "living", "dining", "entryway", "hallway", "laundry", "stairs", "garage", "basement", "outdoor"], 8),
  mt("mop-floor", "Mop floor", 12, 3, 2, "weeks", false, ["kitchen", "bathroom", "half_bath", "living", "dining", "entryway", "hallway", "laundry"], 8),
  mt("strip-remake-bed", "Strip & remake bed", 12, 2, 2, "weeks", false, ["bedroom"], 8),
  mt("gather-laundry", "Gather laundry & empty hamper", 5, 3, 3, "days", false, ["bedroom", "bathroom", "laundry"], 6),
  mt("empty-wastebasket", "Empty wastebasket", 3, 4, 3, "days", false, ["kitchen", "bathroom", "half_bath", "bedroom", "living", "dining", "office", "laundry", "garage", "basement"], 6),
  mt("restock-room-supplies", "Restock supplies", 3, 3, 1, "weeks", false, ["kitchen", "bathroom", "half_bath", "laundry"], 6),
  mt("dust-fans-blinds-vents", "Dust fans, blinds & vents", 10, 2, 1, "months", false, ["bedroom", "living", "dining", "office", "kitchen"], 10),
  mt("wash-windows-inside", "Wash windows inside", 12, 2, 3, "months", false, ["kitchen", "bathroom", "bedroom", "living", "dining", "office", "entryway", "hallway"], 8),
];

export const MANUAL_CHORES = [
  mc("load-run-dishwasher", "Load & run dishwasher", 10, 5, 1, "days", false, 10, ["dishwasher"]),
  mc("unload-dishwasher", "Unload dishwasher", 8, 4, 1, "days", false, 8, ["dishwasher"]),
  mc("hand-wash-dishes", "Hand-wash dishes & pots", 15, 5, 1, "days", false, 10, ["always"]),
  mc("take-out-kitchen-trash", "Take out kitchen trash & recycling", 5, 5, 2, "days", false, 10, ["always"]),
  mc("clean-microwave", "Clean microwave inside & out", 8, 3, 1, "weeks", false, 10, ["always"]),
  mc("clean-fridge-interior", "Clean out & wipe fridge interior", 25, 3, 1, "months", false, 10, ["always"]),
  mc("deep-clean-oven", "Deep-clean the oven", 45, 2, 3, "months", true, 18, ["always"]),
  mc("clear-drain-hair", "Clear hair from drains", 10, 3, 1, "months", false, 10, ["always"]),
  mc("wash-bath-mats", "Wash bath mats", 5, 3, 2, "weeks", false, 10, ["always"]),
  mc("deep-scrub-grout", "Deep scrub tile & grout", 30, 2, 3, "months", true, 18, ["always"]),
  mc("vacuum-under-furniture", "Vacuum under furniture", 30, 2, 1, "months", false, 10, ["always"]),
  mc("spot-clean-walls-baseboards", "Spot-clean walls & baseboards", 20, 2, 3, "months", false, 8, ["always"]),
  mc("declutter-donate", "Declutter & bag donations", 40, 1, 3, "months", false, 10, ["always"]),
  mc("sort-laundry", "Sort laundry into lights, darks & delicates", 5, 2, 3, "days", false, 8, ["always"]),
  mc("wash-load", "Load washer & run a load", 10, 4, 2, "days", false, 10, ["always"]),
  mc("dry-load", "Move wash to dryer & run", 5, 4, 2, "days", false, 10, ["always"]),
  mc("fold-put-away", "Fold & put away a load", 20, 3, 2, "days", false, 8, ["always"]),
  mc("wash-towels", "Wash & dry bath and kitchen towels", 10, 3, 1, "weeks", false, 10, ["always"]),
  mc("wash-sheets", "Wash & dry sheets and bedding", 10, 3, 2, "weeks", false, 10, ["always"]),
  mc("clean-lint-trap", "Clean dryer lint trap", 3, 4, 3, "days", false, 8, ["laundry_room"]),
  mc("clean-dryer-vent", "Clear dryer vent & exhaust duct", 30, 4, 6, "months", true, 14, ["laundry_room"]),
  mc("take-trash-to-curb", "Take trash to the curb", 5, 5, 1, "weeks", false, 10, ["always"]),
  mc("take-recycling-to-curb", "Take recycling to the curb", 5, 3, 2, "weeks", false, 10, ["always"]),
  mc("empty-compost-bin", "Empty kitchen compost", 5, 4, 3, "days", false, 8, ["garden"]),
  mc("replenish-supply-closet", "Replenish the supply closet", 10, 3, 1, "weeks", false, 8, ["always"]),
  mc("water-indoor-plants", "Water the indoor plants", 8, 3, 3, "days", false, 6, ["always"]),
  mc("mow-lawn", "Mow the lawn", 40, 3, 1, "weeks", true, 14, ["yard"]),
  mc("weed-garden-beds", "Weed the garden beds", 25, 2, 1, "weeks", false, 8, ["garden"]),
  mc("water-plants", "Water garden & outdoor plants", 10, 3, 2, "days", false, 6, ["garden"]),
  mc("rake-leaves", "Rake & bag leaves", 40, 2, 2, "weeks", false, 8, ["yard"]),
  mc("shovel-snow", "Shovel or snow-blow snow", 30, 4, 1, "weeks", true, 14, ["yard"]),
  mc("clean-gutters", "Clean out the gutters", 60, 3, 6, "months", true, 14, ["yard"]),
  mc("clean-grill", "Clean the grill", 20, 2, 1, "months", false, 12, ["patio"]),
  mc("wash-car-exterior", "Wash car exterior", 35, 2, 2, "weeks", false, 12, ["car"]),
  mc("vacuum-car-interior", "Vacuum car interior", 20, 2, 2, "weeks", false, 10, ["car"]),
  mc("check-tire-pressure", "Check tire pressure", 10, 3, 1, "months", false, 14, ["car"]),
  mc("declutter-garage", "Declutter the garage", 45, 2, 3, "months", false, 12, ["garage"]),
  mc("lube-garage-door", "Lubricate the garage door", 15, 1, 6, "months", false, 14, ["garage"]),
  mc("feed-dog", "Feed the dog & refill water", 5, 5, 1, "days", false, 6, ["pet_dog"]),
  mc("walk-dog", "Walk the dog", 20, 5, 1, "days", false, 10, ["pet_dog"]),
  mc("scoop-yard-waste", "Scoop dog waste from the yard", 10, 3, 3, "days", false, 8, ["pet_dog", "yard"]),
  mc("brush-groom-pet", "Brush & groom the pet", 10, 2, 3, "days", false, 6, ["pet_dog"]),
  mc("wash-pet-bowls", "Wash the food & water bowls", 5, 3, 3, "days", false, 6, ["pet_dog"]),
  mc("feed-cat", "Feed the cat & refill water", 5, 5, 1, "days", false, 6, ["pet_cat"]),
  mc("scoop-litter", "Scoop the litter box", 5, 5, 1, "days", false, 8, ["pet_cat"]),
  mc("change-litter-box", "Empty & refill the litter box", 15, 3, 1, "weeks", false, 10, ["pet_cat"]),
  mc("clean-small-cage", "Clean the cage or hutch", 25, 4, 1, "weeks", false, 8, ["pet_small"]),
  mc("clean-fish-tank", "Change tank water & clean the glass", 30, 4, 2, "weeks", false, 10, ["pet_fish"]),
  mc("pay-bills", "Pay bills & check budget", 20, 4, 1, "weeks", true, 18, ["always"]),
  mc("plan-meals", "Plan weekly meals", 20, 3, 1, "weeks", false, 12, ["always"]),
  mc("write-grocery-list", "Write the grocery list", 10, 3, 1, "weeks", false, 10, ["always"]),
  mc("grocery-shopping", "Do the grocery shopping", 60, 4, 1, "weeks", true, 18, ["always"]),
  mc("collect-sort-mail", "Collect & sort the mail", 5, 3, 3, "days", false, 8, ["always"]),
  mc("wash-baby-bottles", "Wash baby bottles", 10, 5, 1, "days", false, 10, ["baby"]),
  mc("sterilize-bottles-pump", "Sterilize bottles & pump parts", 15, 4, 3, "days", true, 18, ["baby"]),
  mc("empty-diaper-pail", "Empty & sanitize the diaper pail", 4, 5, 2, "days", false, 8, ["baby"]),
  mc("restock-diapers-wipes", "Restock diapers & wipes", 5, 4, 3, "days", false, 8, ["baby"]),
  mc("pack-school-lunches", "Pack school lunches", 10, 4, 1, "days", false, 10, ["kids"]),
  mc("reset-homework-station", "Reset the homework station", 5, 3, 1, "days", false, 8, ["kids"]),
  mc("pack-school-backpack", "Pack the school backpack", 5, 3, 1, "days", false, 6, ["kids"]),
  mc("sign-school-forms", "Sign school forms & reading logs", 10, 4, 1, "weeks", true, 18, ["kids"]),
  mc("bathe-young-kids", "Bathe the young kids", 20, 4, 2, "days", true, 18, ["kids"]),
  mc("replace-hvac-filter", "Replace HVAC filter", 10, 3, 3, "months", false, 12, ["always"]),
  mc("test-smoke-co-alarms", "Test smoke & CO alarms", 10, 5, 1, "months", false, 12, ["always"]),
  mc("replace-detector-batteries", "Replace smoke & CO alarm batteries", 15, 5, 1, "years", true, 18, ["always"]),
  mc("clean-garbage-disposal", "Clean garbage disposal", 10, 2, 2, "weeks", false, 12, ["always"]),
  mc("clear-wipe-table", "Clear & wipe the table", 6, 4, 1, "days", false, 6, ["always"]),
  mc("empty-clean-dehumidifier", "Empty & clean the dehumidifier", 8, 3, 3, "days", false, 10, ["basement"]),
  mc("test-sump-pump", "Test the sump pump", 10, 3, 3, "months", false, 14, ["basement"]),
  mc("check-fire-extinguisher", "Check the fire extinguisher", 10, 4, 6, "months", false, 12, ["always"]),
  mc("winterize-outdoor-faucets", "Winterize outdoor faucets", 15, 3, 1, "years", false, 12, ["yard"]),
  mc("shred-sort-documents", "Shred & file paperwork", 20, 2, 1, "months", false, 14, ["office"]),
];

export const LIBRARY = { matrixTypes: MATRIX_TYPES, manualChores: MANUAL_CHORES };

/* ===================== PRESETS (home profiles) ===================== */
// A preset is just a profile the wizard can one-click apply or use as a starting point.
const flags = (diningRoom, laundryRoom, office, garage, basement, yard, dishwasher) =>
  ({ diningRoom, laundryRoom, office, garage, basement, yard, dishwasher });

export const PRESETS = [
  { key: "studio-solo", label: "Studio · solo", blurb: "A solo renter keeping a compact studio tidy with a light, low-cadence routine.",
    homeSize: "studio", beds: 0, baths: 1, floors: 1, flags: flags(false, false, false, false, false, "none", false),
    adults: [{ name: "Sam" }], kids: [], pets: [] },
  { key: "apartment-couple", label: "Apartment · couple", blurb: "Two partners sharing a one-bedroom apartment and looking after a cat.",
    homeSize: "apartment", beds: 1, baths: 1, floors: 1, flags: flags(false, true, false, false, false, "none", true),
    adults: [{ name: "Morgan" }, { name: "Avery" }], kids: [], pets: [{ type: "cat", name: "Pepper" }] },
  { key: "apartment-roommates-3", label: "Apartment · 3 roommates", blurb: "Three roommates splitting the chores in a shared apartment, fish included.",
    homeSize: "apartment", beds: 3, baths: 2, floors: 1, flags: flags(false, false, false, false, false, "none", true),
    adults: [{ name: "Jordan" }, { name: "Riley" }, { name: "Quinn" }], kids: [], pets: [{ type: "fish", name: "Goldie" }] },
  { key: "small-single-parent", label: "Small house · single parent + 2", blurb: "A single parent and two little ones, with age-appropriate jobs for tiny helpers.",
    homeSize: "small", beds: 2, baths: 1, floors: 1, flags: flags(false, true, false, false, false, "small", true),
    adults: [{ name: "Dana" }], kids: [{ name: "Mia", age: 5 }, { name: "Leo", age: 3 }], pets: [{ type: "cat", name: "Mittens" }] },
  { key: "family4-3b3b", label: "Family of 4 · 3 bed / 3 bath", blurb: "A busy two-parent household with a 10- and 6-year-old, a dog, and a yard to keep up.",
    homeSize: "medium", beds: 3, baths: 3, floors: 2, flags: flags(true, true, false, true, false, "large", true),
    adults: [{ name: "Alex" }, { name: "Jamie" }], kids: [{ name: "Noah", age: 10 }, { name: "Ella", age: 6 }], pets: [{ type: "dog", name: "Biscuit" }] },
  { key: "medium-family-teens", label: "Medium house · family with teens", blurb: "Two parents and two teenagers who can shoulder real chores, plus a dog and a cat.",
    homeSize: "medium", beds: 3, baths: 2, floors: 2, flags: flags(true, true, true, true, true, "large", true),
    adults: [{ name: "Pat" }, { name: "Chris" }], kids: [{ name: "Sofia", age: 15 }, { name: "Max", age: 13 }], pets: [{ type: "dog", name: "Rex" }, { type: "cat", name: "Luna" }] },
  { key: "large-multigen", label: "Large house · multigenerational", blurb: "Three generations under one roof sharing a big house, a yard, and the family dog.",
    homeSize: "large", beds: 5, baths: 4, floors: 2, flags: flags(true, true, true, true, true, "large", true),
    adults: [{ name: "Maria" }, { name: "David" }, { name: "Rose" }], kids: [{ name: "Lucas", age: 12 }, { name: "Emma", age: 8 }], pets: [{ type: "dog", name: "Cooper" }] },
  { key: "large-family-five", label: "Large house · big family", blurb: "A full house of five with three kids of every age, a dog, and a hamster to feed.",
    homeSize: "large", beds: 4, baths: 3, floors: 2, flags: flags(true, true, true, true, true, "large", true),
    adults: [{ name: "Nicole" }, { name: "Brian" }], kids: [{ name: "Aiden", age: 14 }, { name: "Zoe", age: 9 }, { name: "Lily", age: 4 }], pets: [{ type: "dog", name: "Buddy" }, { type: "small", name: "Nibbles" }] },
  { key: "small-new-baby", label: "Small house · new baby", blurb: "Two first-time parents with an infant, buried in bottles, diapers, and never-ending laundry.",
    homeSize: "small", beds: 2, baths: 1, floors: 1, flags: flags(false, true, false, false, false, "small", true),
    adults: [{ name: "Priya" }, { name: "Daniel" }], kids: [{ name: "Aria", age: 1 }], pets: [] },
  { key: "apartment-family-young-kids", label: "Apartment · family with kids", blurb: "Two parents and two grade-schoolers in a no-yard apartment, splitting the indoor chores.",
    homeSize: "apartment", beds: 2, baths: 1, floors: 1, flags: flags(false, false, false, false, false, "none", true),
    adults: [{ name: "Marcus" }, { name: "Tara" }], kids: [{ name: "Iris", age: 8 }, { name: "Theo", age: 5 }], pets: [] },
];

export const DEFAULT_PRESET_KEY = 'family4-3b3b';
export const presetByKey = key => PRESETS.find(p => p.key === key) || null;

/* ===================== PROFILE -> BOARD ===================== */
const PALETTE = ['var(--p-me)', 'var(--p-gabby)', 'var(--p-kid10)', 'var(--p-kid6)', '#7a5cc0', '#3f9e8f', '#b5852a', '#5b6b7a'];
const SHARED_SIZE = { studio: 'small', apartment: 'small', small: 'medium', medium: 'medium', large: 'large' };
const LIVING_SIZE = { studio: 'medium', apartment: 'medium', small: 'medium', medium: 'large', large: 'large' };

export function flagsOf(p) {
  const f = p.flags || {};
  return {
    diningRoom: !!f.diningRoom, laundryRoom: !!f.laundryRoom, office: !!f.office,
    garage: !!f.garage, basement: !!f.basement, yard: f.yard || 'none',
    dishwasher: f.dishwasher !== undefined ? !!f.dishwasher : (p.homeSize !== 'studio'),
  };
}

// The set of `requires` tags a profile satisfies. Manual chores whose `requires` are all present apply.
export function tagsFor(profile) {
  const f = flagsOf(profile), pets = profile.pets || [], kids = profile.kids || [];
  const t = new Set(['always']);
  if (pets.length) t.add('pet');
  if (pets.some(p => p.type === 'dog')) t.add('pet_dog');
  if (pets.some(p => p.type === 'cat')) t.add('pet_cat');
  if (pets.some(p => p.type === 'small')) t.add('pet_small');
  if (pets.some(p => p.type === 'fish')) t.add('pet_fish');
  if (f.yard !== 'none') { t.add('yard'); t.add('garden'); t.add('patio'); }
  if (f.garage) { t.add('garage'); t.add('car'); }
  if (f.basement) t.add('basement');
  if (f.office) t.add('office');
  if (f.diningRoom) t.add('dining');
  if (f.laundryRoom) t.add('laundry_room');
  if ((profile.floors || 1) > 1) t.add('multistory');
  t.add(f.dishwasher ? 'dishwasher' : 'no_dishwasher');
  if (kids.some(k => (k.age || 0) <= 2)) t.add('baby');
  if (kids.some(k => (k.age || 0) >= 3 && (k.age || 0) <= 17)) t.add('kids');
  return t;
}

// Rooms (with their kind, used to compute matrix exclusions) derived from the home's shape.
export function deriveRooms(profile) {
  const f = flagsOf(profile), hs = profile.homeSize || 'medium', beds = profile.beds || 0, floors = profile.floors || 1;
  const rooms = [];
  const add = (kind, name, size) => rooms.push({ kind, name, size });
  if (beds === 0) {
    add('living', 'Studio / main room', LIVING_SIZE[hs] || 'medium');
  } else {
    add('living', 'Living room', LIVING_SIZE[hs] || 'medium');
    for (let i = 0; i < beds; i++) add('bedroom', i === 0 ? 'Primary bedroom' : `Bedroom ${i + 1}`, i === 0 && hs !== 'apartment' ? 'large' : 'medium');
  }
  add('kitchen', 'Kitchen', SHARED_SIZE[hs] || 'medium');
  if (f.diningRoom) add('dining', 'Dining room', 'medium');
  for (let i = 0; i < Math.max(1, profile.baths || 1); i++) add('bathroom', i === 0 ? 'Primary bathroom' : `Bathroom ${i + 1}`, i === 0 ? 'medium' : 'small');
  if (f.laundryRoom) add('laundry', 'Laundry room', 'small');
  if (f.office) add('office', 'Office', 'small');
  if (f.garage) add('garage', 'Garage', 'large');
  if (f.basement) add('basement', 'Basement', 'large');
  add('entryway', 'Entryway', 'small');
  if (beds >= 2 || floors > 1) add('hallway', 'Hallway', 'small');
  if (floors > 1) add('stairs', 'Stairs', 'small');
  if (f.yard !== 'none') add('outdoor', f.yard === 'large' ? 'Yard' : 'Patio', f.yard === 'large' ? 'large' : 'medium');
  // deterministic, unique ids
  const seen = {};
  for (const r of rooms) { const base = 'r_' + r.kind; seen[base] = (seen[base] || 0) + 1; r.id = base + (seen[base] > 1 ? seen[base] : ''); }
  return rooms;
}

// Library subsets the profile actually needs.
export function manualFor(profile, library = LIBRARY) {
  const tags = tagsFor(profile);
  return library.manualChores.filter(c => (c.requires || ['always']).every(r => tags.has(r)));
}
export function typesFor(profile, roomKinds, library = LIBRARY) {
  const kinds = new Set(roomKinds);
  return library.matrixTypes.filter(t => (t.appliesTo || []).some(k => kinds.has(k)));
}
// Exclusion keys for every cell whose room kind isn't in the type's appliesTo.
export function excludesFor(rooms, types) {
  const ex = [];
  for (const t of types) for (const r of rooms) if (!(t.appliesTo || []).includes(r.kind)) ex.push(`${t.id}:${r.id}`);
  return ex;
}

// Age -> time budgets + task-length cap. Adults uncapped; younger kids get shorter days and shorter tasks.
export function ageBudget(age) {
  if (age >= 18) return { isAdult: true, weekdayBudget: 30, weekendBudget: 60, maxTaskMinutes: 0 };
  if (age >= 16) return { isAdult: false, weekdayBudget: 25, weekendBudget: 50, maxTaskMinutes: 45 };
  if (age >= 13) return { isAdult: false, weekdayBudget: 20, weekendBudget: 45, maxTaskMinutes: 30 };
  if (age >= 10) return { isAdult: false, weekdayBudget: 20, weekendBudget: 40, maxTaskMinutes: 20 };
  if (age >= 6) return { isAdult: false, weekdayBudget: 10, weekendBudget: 25, maxTaskMinutes: 12 };
  return { isAdult: false, weekdayBudget: 5, weekendBudget: 10, maxTaskMinutes: 6 }; // ages 4–5
}

// People from the occupancy. Toddlers under 4 generate chores (baby/kids tags) but aren't on the team.
export function peopleFor(profile) {
  const out = [];
  const push = (name, isAdult, age, fallback) => {
    const b = ageBudget(isAdult ? 99 : age);
    out.push({ id: 'p' + (out.length + 1), name: name || fallback, color: PALETTE[out.length % PALETTE.length], isAdult, age: isAdult ? null : age, weekdayBudget: b.weekdayBudget, weekendBudget: b.weekendBudget, maxTaskMinutes: b.maxTaskMinutes, active: true });
  };
  (profile.adults || []).forEach((a, i) => push(a.name, true, 99, 'Adult ' + (i + 1)));
  (profile.kids || []).forEach(k => { if ((k.age || 0) >= 4) push(k.name, false, k.age || 10, 'Kid'); });
  return out;
}

function choreFrom(c) {
  return {
    id: 'c_' + c.key, name: c.name, minutes: c.minutes, priority: c.priority,
    intervalCount: c.intervalCount, intervalUnit: c.intervalUnit, adultOnly: !!c.adultOnly, minAge: c.minAge || 0,
    assignee: null, lastDone: null, holder: null, lastHolder: null, assignedOn: null, escalated: false, enabled: true, matrixKey: null,
  };
}

// THE builder: a profile -> a whole-doc board ready to drop into the app (S-shaped, week not yet built).
export function buildHome(profile, library = LIBRARY) {
  const roomsK = deriveRooms(profile);
  const typesK = typesFor(profile, roomsK.map(r => r.kind), library).map(t => ({
    id: 't_' + t.key, name: t.name, minutes: t.minutes, priority: t.priority,
    intervalCount: t.intervalCount, intervalUnit: t.intervalUnit, adultOnly: !!t.adultOnly, minAge: t.minAge || 0, assignee: null, appliesTo: t.appliesTo,
  }));
  const rooms = roomsK.map(r => ({ id: r.id, name: r.name, size: r.size }));
  const matrixExclude = excludesFor(roomsK, typesK);
  const matrixTypes = typesK.map(({ appliesTo, ...t }) => t);
  const manual = manualFor(profile, library).map(choreFrom);
  const chores = applyMatrix(manual, rooms, matrixTypes, matrixExclude);
  return {
    rev: 0, people: peopleFor(profile), rooms, matrixTypes, matrixExclude, chores,
    settings: { graceDays: 3, escalateAfter: 2, weekStartISO: null, fairness: 'balanced' },
    week: null, history: [],
  };
}

// A short human summary of what a profile will produce, for the wizard preview.
export function summarize(profile, library = LIBRARY) {
  const rooms = deriveRooms(profile);
  const types = typesFor(profile, rooms.map(r => r.kind), library);
  const built = buildHome(profile, library);
  return {
    people: built.people.length, adults: built.people.filter(p => p.isAdult).length, kids: built.people.filter(p => !p.isAdult).length,
    rooms: rooms.length, types: types.length, chores: built.chores.length,
    manual: built.chores.filter(c => !c.matrixKey).length, matrix: built.chores.filter(c => c.matrixKey).length,
  };
}

// Validate the library against UNITS so a bad cadence can't ship silently (used by the test).
export function validateLibrary(library = LIBRARY) {
  const errs = [];
  const check = (e, where) => {
    if (!e.key) errs.push(`${where}: missing key`);
    if (!(e.minutes >= 1)) errs.push(`${e.key}: minutes must be >= 1`);
    if (!(e.priority >= 1 && e.priority <= 5)) errs.push(`${e.key}: priority out of range`);
    if (!UNITS.includes(e.intervalUnit)) errs.push(`${e.key}: bad intervalUnit ${e.intervalUnit}`);
    if (!(e.intervalCount >= 1)) errs.push(`${e.key}: intervalCount must be >= 1`);
  };
  for (const t of library.matrixTypes) { check(t, 'matrixType'); for (const k of t.appliesTo) if (!ROOM_KINDS.includes(k)) errs.push(`${t.key}: bad appliesTo ${k}`); }
  for (const c of library.manualChores) check(c, 'manualChore');
  return errs;
}
