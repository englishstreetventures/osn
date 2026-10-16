import { describe, expect, it } from "vitest";

import { Z_CLASS, Z_LAYER } from "../../src/lib/z-index";

describe("z-index layer scale", () => {
  it("orders the layers low → high (BASE < EVENT_CARD < STICKY_RAIL < MODAL_POPOVER < TOAST < CONSENT)", () => {
    expect(Z_LAYER.BASE).toBeLessThan(Z_LAYER.EVENT_CARD);
    expect(Z_LAYER.EVENT_CARD).toBeLessThan(Z_LAYER.STICKY_RAIL);
    expect(Z_LAYER.STICKY_RAIL).toBeLessThan(Z_LAYER.MODAL_POPOVER);
    expect(Z_LAYER.MODAL_POPOVER).toBeLessThan(Z_LAYER.TOAST);
    expect(Z_LAYER.TOAST).toBeLessThan(Z_LAYER.CONSENT);
  });

  it("has no modal layer at all, because a modal is not in this ordering", () => {
    // The sheets are `showModal()` dialogs, which paint in the top layer —
    // above every stacking context in the document, whatever number anything
    // here carries. A `MODAL` entry would read as a promise this scale cannot
    // keep, and anything written to sit "above the modal" by out-numbering it
    // would be wrong in a way no arithmetic here could catch.
    expect(Object.keys(Z_LAYER)).not.toContain("MODAL");
    expect(Object.keys(Z_CLASS)).not.toContain("MODAL");
  });

  it("derives each class string from its numeric layer value", () => {
    for (const layer of Object.keys(Z_LAYER) as (keyof typeof Z_LAYER)[]) {
      expect(Z_CLASS[layer]).toBe(`z-${Z_LAYER[layer]}`);
    }
  });
});
