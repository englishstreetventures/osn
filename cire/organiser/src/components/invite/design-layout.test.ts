import { DEFAULT_DESIGN_ID, DESIGNS } from "@cire/invite-designs";
import { describe, expect, it } from "vitest";

import { designLayout, LAYOUTS } from "./design-layout";

/**
 * Drift guard for the preview's design shapes. The catalog is the source of
 * truth for what packs exist; this table is the source of truth for how each
 * one previews. A new catalog entry with no row here would silently preview as
 * Classic — the exact bug the table was added to fix — so that fails a test.
 */
describe("designLayout", () => {
  it("gives every catalog design an entry of its own", () => {
    // A KEY-set assertion, not value-uniqueness. Comparing stringified shapes
    // would fail the first time two packs legitimately share a signature (two
    // centred packs differing only in colour and type is entirely plausible),
    // and a guard that fails for a legitimate reason is a guard that gets
    // deleted. It would also miss a typo'd key whose fallback shape happened
    // to be unique.
    expect(DESIGNS.map((d) => d.id).toSorted()).toEqual(Object.keys(LAYOUTS).toSorted());
  });

  it("distinguishes the two shipped packs where they actually differ", () => {
    const classic = designLayout("classic");
    const gala = designLayout("gala");
    expect(classic.heroAnchor).toBe("center");
    expect(gala.heroAnchor).toBe("bottom-left");
    expect(classic.align).toBe("center");
    expect(gala.align).toBe("left");
    expect(classic.welcome).toBe("band");
    expect(gala.welcome).toBe("panel");
    expect(classic.eventsRule).toBe(false);
    expect(gala.eventsRule).toBe(true);
  });

  it("falls back to the default pack for an unknown or absent id", () => {
    const fallback = designLayout(DEFAULT_DESIGN_ID);
    expect(designLayout("not-a-design")).toEqual(fallback);
    expect(designLayout(null)).toEqual(fallback);
    expect(designLayout(undefined)).toEqual(fallback);
  });

  it("falls back for PROTOTYPE keys too, which a bare lookup would resolve", () => {
    // `LAYOUTS["constructor"]` is truthy via the prototype chain, so a
    // `lookup ?? default` never fires and every field reads `undefined` — a
    // fourth, unintended shape. Not reachable today (the API validates
    // `designId` against the catalog), but the fallback should hold whatever
    // the caller passes (S-L2).
    const fallback = designLayout(DEFAULT_DESIGN_ID);
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(designLayout(key)).toEqual(fallback);
    }
  });
});
