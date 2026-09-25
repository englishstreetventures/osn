/**
 * The dietary-requirement vocabulary: one closed list, shared by everything that
 * reads or writes `rsvps.dietary_presets`.
 *
 * ## Why this is a package and not a file
 *
 * Four consumers, and they cannot reach each other. `@cire/api` validates and
 * serialises; `@cire/ui` renders the picker for the guest sheet, the host editor
 * and the marketing demo. An API that imported the UI package would pull Solid
 * into a Worker, and a UI package cannot be imported by a Worker's schema layer,
 * so the vocabulary is the thing they share and nothing else. That is also why
 * this package has no dependencies at all: adding one puts it in four bundles.
 *
 * ## The data is special-category, including the keys
 *
 * A preset is no less protected than the free text beside it — `halal` and
 * `kosher` reveal religious belief, `nuts` and `shellfish` reveal health. Every
 * gate that covers `rsvps.dietary` covers this too: the Art. 9(2)(a) consent
 * record, the erasure sweep, and the log-redaction deny-list. See
 * `wiki/compliance/dpia/cire-guest-data.md`.
 */

/**
 * Every preset, in canonical order.
 *
 * This order is load-bearing twice: {@link serialisePresets} emits in it, so one
 * selection has exactly one stored string and two rows can be compared; and the
 * picker renders in it, so the bands arrive in a deliberate sequence rather than
 * whatever order a guest happened to tick.
 *
 * Adding a key is free. **Removing one strands saved rows** — a stored
 * `"jain"` whose key no longer exists is dropped by {@link parsePresets} and the
 * guest's answer silently changes — so a removal needs a migration, not an edit.
 */
export const DIETARY_PRESETS = [
  // Diet — what the kitchen is asked to cook.
  "vegetarian",
  "vegan",
  "pescatarian",
  "halal",
  "kosher",
  "no_pork",
  "no_beef",
  "jain",
  "no_alcohol",
  // Allergies — what the kitchen is asked to keep away from a plate.
  "nuts",
  "gluten",
  "dairy",
  "shellfish",
  "egg",
  "sesame",
  // The escape hatch, which reveals the free-text box.
  "other",
] as const;

export type DietaryPreset = (typeof DIETARY_PRESETS)[number];

/**
 * The two kinds of statement a guest can make, plus the escape hatch.
 *
 * A caterer acts on them differently — an allergy is a contamination risk the
 * kitchen isolates for, a diet is a choice about what goes on the plate — so the
 * picker groups them and the CSV keeps them in this order.
 */
export type DietaryBand = "diet" | "allergy" | "other";

export const DIETARY_PRESET_BAND = {
  vegetarian: "diet",
  vegan: "diet",
  pescatarian: "diet",
  halal: "diet",
  kosher: "diet",
  no_pork: "diet",
  no_beef: "diet",
  jain: "diet",
  no_alcohol: "diet",
  nuts: "allergy",
  gluten: "allergy",
  dairy: "allergy",
  shellfish: "allergy",
  egg: "allergy",
  sesame: "allergy",
  other: "other",
} satisfies Readonly<Record<DietaryPreset, DietaryBand>>;

/**
 * What a guest reads, and what a caterer reads in the exported sheet.
 *
 * `no_pork` and `no_beef` are separate from `halal` and `kosher` on purpose: a
 * guest who does not eat pork but does not need a certified kitchen will not tick
 * a pill that claims they do, and would otherwise fall through to free text —
 * which is the failure this whole feature exists to remove.
 *
 * The labels carry no reasons, only requirements, per the minimisation note in
 * `wiki/compliance/dpia/cire-guest-data.md`.
 */
export const DIETARY_PRESET_LABEL = {
  vegetarian: "Vegetarian",
  vegan: "Vegan",
  pescatarian: "Pescatarian",
  halal: "Halal",
  kosher: "Kosher",
  no_pork: "No pork",
  no_beef: "No beef",
  jain: "Jain",
  no_alcohol: "No alcohol",
  nuts: "Nuts",
  gluten: "Gluten / coeliac",
  dairy: "Dairy",
  shellfish: "Shellfish",
  egg: "Egg",
  sesame: "Sesame",
  other: "Other",
} satisfies Readonly<Record<DietaryPreset, string>>;

/**
 * Narrow an arbitrary string to a preset key.
 *
 * `Object.hasOwn`, never `key in MAP`: `in` walks the prototype chain, so
 * `"constructor"`, `"toString"` and `"__proto__"` would all pass and the
 * predicate would then assert an inherited `Object.prototype` member is a real
 * entry. `house/no-in-operator-key-guard` is an error in this repository and
 * matches the narrowed parameter, so an aliased predicate is caught too.
 */
export function isDietaryPreset(key: string): key is DietaryPreset {
  return Object.hasOwn(DIETARY_PRESET_LABEL, key);
}

/**
 * What a guest or organiser reads for one key, including a key this build does
 * not know.
 *
 * The vocabulary grows on the server first, and an open page keeps the build it
 * loaded with, so a saved answer can carry a key missing from
 * {@link DIETARY_PRESET_LABEL}. It is still the guest's answer — possibly an
 * allergy — so it reads as its own words rather than vanishing: underscores
 * become spaces and the first letter is capitalised, so `no_pork` reads "No
 * pork". That is right for most keys and close for the rest (`gluten` would read
 * "Gluten", not "Gluten / coeliac") until the page reloads onto a build that
 * knows the key.
 *
 * Keys are `[a-z_]+` by construction (see {@link serialisePresets}). A key that
 * is only underscores comes back as itself; a key that is empty or only
 * whitespace comes back as `""`, which every caller skips.
 */
export function presetLabel(key: string): string {
  if (isDietaryPreset(key)) return DIETARY_PRESET_LABEL[key];
  const words = key.replaceAll("_", " ").replace(/\s+/g, " ").trim();
  if (words === "") return key.trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Pack a selection into the single `rsvps.dietary_presets` column.
 *
 * Comma-separated keys rather than JSON. Every key matches `[a-z_]+` and comes
 * from a closed set, so there is no value that could ever need escaping, the
 * parse cannot throw, and the column stays legible in the D1 console. The JSON
 * precedent in this schema (`weddings.gift_summary_json`) is JSON because it
 * holds a nested object; a flat set of enum keys does not need it.
 *
 * Output is deduplicated and in {@link DIETARY_PRESETS} order, so the same
 * selection always produces the same string however it was clicked. The server
 * re-serialises whatever it is sent, which is what makes a duplicate in a request
 * body a normalisation rather than a rejection.
 */
export function serialisePresets(keys: readonly DietaryPreset[]): string {
  const chosen = new Set<DietaryPreset>(keys);
  return DIETARY_PRESETS.filter((key) => chosen.has(key)).join(",");
}

/**
 * Read the column back.
 *
 * Total: any input produces an array, because this parses data that may predate
 * the current vocabulary or have been written by hand in a console. Unknown keys
 * are dropped rather than thrown on — a guest opening their invite should see the
 * presets that still exist, not an error — and the result is re-canonicalised, so
 * a hand-edited `"nuts,vegetarian"` round-trips to `"vegetarian,nuts"`.
 *
 * A legacy row predating this column is the empty string, which yields `[]`. Such
 * a row renders as an "Other"-only answer on the strength of its free text; see
 * the reveal rule in the picker.
 */
export function parsePresets(stored: string): DietaryPreset[] {
  if (stored === "") return [];
  const found = new Set<DietaryPreset>();
  for (const part of stored.split(",")) {
    const key = part.trim();
    if (isDietaryPreset(key)) found.add(key);
  }
  return DIETARY_PRESETS.filter((key) => found.has(key));
}

/**
 * The presets a guest picked, as a caterer should read them.
 *
 * Shared by the CSV export, the organiser's table and search, and the picker's
 * collapsed summary, so the sheet and the screen never disagree about what a
 * row says or the order it says it in.
 *
 * Same canonicalisation {@link serialisePresets} performs — one `Set`, one pass
 * in declaration order, duplicates collapsed — rather than calling it and
 * splitting the string back apart. This runs once per guest × event while the
 * CSV is built, on a Worker with a 10 ms CPU budget per invocation.
 *
 * Keys this build does not know trail the canonical ones, once each, in the
 * order they arrived, labelled by {@link presetLabel}; a key with an empty label
 * is skipped.
 * The server parses with {@link parsePresets} first, so the CSV never has one and
 * never pays for the second pass.
 */
export function presetLabels(keys: readonly string[]): string[] {
  // The empty case first, and it is the common one: a guest with prose and no
  // presets, and every non-responder row on the organiser's dashboard. Without
  // the guard an empty selection still walks all sixteen keys.
  if (keys.length === 0) return [];
  const chosen = new Set(keys);
  const labels: string[] = [];
  for (const key of DIETARY_PRESETS) if (chosen.has(key)) labels.push(DIETARY_PRESET_LABEL[key]);
  // Every known key pushed one label, so fewer labels than distinct keys means
  // at least one key is outside the vocabulary.
  if (labels.length < chosen.size) {
    for (const key of chosen) {
      if (isDietaryPreset(key)) continue;
      const label = presetLabel(key);
      if (label !== "") labels.push(label);
    }
  }
  return labels;
}

/**
 * One guest's whole dietary answer as a single human-readable cell.
 *
 * The caterer's spreadsheet keeps its existing per-event `"<Event> Dietary"`
 * column rather than gaining one column per preset, so an organiser's saved
 * formulas survive this change.
 *
 * `filter(Boolean)` is load-bearing at both ends: presets with no free text must
 * not emit a trailing `"Vegetarian; "`, and a legacy prose-only row must not
 * gain a leading `"; "`. Both would break existing assertions about rows this
 * feature never touched.
 */
export function formatDietaryCell(keys: readonly string[], freeText: string): string {
  return [...presetLabels(keys), freeText.trim()].filter(Boolean).join("; ");
}
