/**
 * How each design pack is SHAPED, as the miniature preview needs to know it.
 *
 * The builder's live preview was design-blind: it rendered one centred stack
 * whatever pack the wedding was on, so switching Classic → Gala changed the
 * radio card and nothing else. Colours, fonts and copy were exact and the
 * LAYOUT — the one thing a design pack actually is — was a fiction.
 *
 * This is the missing half. It is deliberately a SKETCH, not a second
 * implementation: the guest packs own their real markup (`cire/web/src/designs/
 * <id>/`), and duplicating it here would be a copy to drift. What's described
 * is the handful of structural moves that read at miniature size and that an
 * organiser is choosing between:
 *
 * | | `classic` | `gala` |
 * |---|---|---|
 * | Hero copy | centred in the frame | anchored bottom-left (editorial) |
 * | Section copy | centred column | left-aligned |
 * | Code entry | full-bleed band | narrow bordered panel, flush left |
 * | Events header | heading, then cards | heading closed by a hairline rule |
 *
 * Every row is traceable to the pack: gala's hero is `items-start justify-end`
 * against classic's centred block, its story/events columns are `text-left`
 * against classic's `text-center`, its claim panel is a `max-w-[400px]` bordered
 * card (`md:mx-0`) rather than a section band, and its events header closes with
 * a full-width `<hr>`. Adding a pack means adding a row here — {@link
 * designLayout} falls back to the default pack's shape, and the test asserts
 * every catalog id has an entry of its own, so a new design fails loudly rather
 * than silently previewing as Classic.
 */

import { DEFAULT_DESIGN_ID, type DesignId } from "@cire/invite-designs";

export interface DesignPreviewLayout {
  /** Where the hero's title block sits in the frame. */
  readonly heroAnchor: "center" | "bottom-left";
  /** How section copy (eyebrow / heading / body) is aligned. */
  readonly align: "center" | "left";
  /** The code-entry section: a full-bleed band, or an inset bordered panel that
   *  sits on the surface rather than filling it. */
  readonly welcome: "band" | "panel";
  /** Whether the events header is closed by a full-width hairline rule. */
  readonly eventsRule: boolean;
}

export const LAYOUTS: Record<DesignId, DesignPreviewLayout> = {
  classic: { heroAnchor: "center", align: "center", welcome: "band", eventsRule: false },
  gala: { heroAnchor: "bottom-left", align: "left", welcome: "panel", eventsRule: true },
};

/** The layout for a design id. An unknown id (a wedding on a pack this build
 *  doesn't carry, mid-deploy) previews as the default pack — the same fallback
 *  the guest site's registry makes, so the two never disagree about what an
 *  unrecognised id renders as.
 *
 *  `Object.hasOwn`, not a bare lookup with `??`: indexing an object literal
 *  with a caller-supplied string resolves PROTOTYPE keys too, so `constructor`
 *  / `__proto__` / `toString` each return something truthy, the `??` never
 *  fires, and every field reads `undefined` — a fourth, unintended shape
 *  instead of the documented default-pack fallback. Same footgun as S-L6's
 *  `SHEET_LABEL` lookup; closed by construction here. */
export function designLayout(designId: string | null | undefined): DesignPreviewLayout {
  return designId != null && Object.hasOwn(LAYOUTS, designId)
    ? LAYOUTS[designId as DesignId]
    : LAYOUTS[DEFAULT_DESIGN_ID];
}
