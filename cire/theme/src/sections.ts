/**
 * The invite sections an organiser can switch off, and the state such a section
 * is in. One copy for the API (storage and the write body), the organiser
 * builder (badge, tab state, preview) and the guest site (what renders), so the
 * three cannot disagree about which sections have a switch or what a switch
 * means.
 *
 * `footer` is the data-layer name of the closing section, as on the image slot
 * and the `footer_*` columns; the builder calls it "Closing".
 *
 * Adding a section here is a schema change: a `<section>_visible` column on
 * `wedding_invite_customisations` in all three DDL surfaces, and an entry in the
 * API's column map. Every `Record<VisibilitySection, …>` then fails to compile
 * until it covers the new section.
 */

/** The switchable sections, in the order a guest scrolls them. */
export const VISIBILITY_SECTIONS = ["hero", "story", "footer"] as const;
export type VisibilitySection = (typeof VISIBILITY_SECTIONS)[number];

export function isVisibilitySection(value: string): value is VisibilitySection {
  return (VISIBILITY_SECTIONS as readonly string[]).includes(value);
}

/**
 * Where a switchable section stands:
 *
 *  - `shown` — switched on and it has content; guests see it.
 *  - `empty` — switched on but it has nothing in it, so guests see nothing.
 *  - `off`   — switched off; guests see nothing, and the content is kept.
 */
export type SectionState = "shown" | "empty" | "off";

/**
 * The state of a switchable section, from its switch and its emptiness check.
 *
 * An absent switch (`undefined` or `null`) reads as on. It only arrives in a
 * payload from an API older than the switches, and such a payload has to render
 * as it did then: every section with content showed.
 */
export function sectionState(visible: boolean | null | undefined, empty: boolean): SectionState {
  if (visible === false) return "off";
  return empty ? "empty" : "shown";
}
