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

  it("keeps consent above the toast layer", () => {
    expect(Z_LAYER.CONSENT).toBeGreaterThan(Z_LAYER.TOAST);
  });

  it("keeps the consent banner above every numbered layer", () => {
    // Every numbered one, which is no longer every layer: a sheet is a
    // `showModal()` dialog in the top layer, and while one is open the banner
    // is beneath it and inert whatever this says (`xchromo/osn#1061`). What
    // this still decides is the banner against the page — the toaster, the
    // Add-to-Calendar menu, the sticky rail — and if that inverts the banner is
    // buried with nothing to close.
    expect(Z_LAYER.CONSENT).toBeGreaterThan(Z_LAYER.TOAST);
    expect(Z_LAYER.CONSENT).toBeGreaterThan(Z_LAYER.MODAL_POPOVER);
    expect(Z_LAYER.CONSENT).toBeGreaterThan(Z_LAYER.STICKY_RAIL);
  });

  it("keeps the Add-to-Calendar menu above the cards it can be opened from", () => {
    // The half of #203 this scale still owns. Opened from an event card rather
    // than from a sheet, the menu is an ordinary fixed box competing with the
    // page: at z-90 it rendered behind what it was opened over.
    expect(Z_LAYER.MODAL_POPOVER).toBeGreaterThan(Z_LAYER.EVENT_CARD);
    expect(Z_LAYER.MODAL_POPOVER).toBeGreaterThan(Z_LAYER.STICKY_RAIL);
  });

  it("pins the current visual values (popover=110, toast=150, consent=200) — refactor, not re-layer", () => {
    expect(Z_LAYER.MODAL_POPOVER).toBe(110);
    expect(Z_LAYER.TOAST).toBe(150);
    expect(Z_LAYER.CONSENT).toBe(200);
  });

  it("maps each layer to its matching Tailwind class literal", () => {
    expect(Z_CLASS.BASE).toBe("z-0");
    expect(Z_CLASS.EVENT_CARD).toBe("z-10");
    expect(Z_CLASS.STICKY_RAIL).toBe("z-20");
    expect(Z_CLASS.MODAL_POPOVER).toBe("z-110");
    expect(Z_CLASS.TOAST).toBe("z-150");
    expect(Z_CLASS.CONSENT).toBe("z-200");
  });

  it("derives each class string from its numeric layer value", () => {
    for (const layer of Object.keys(Z_LAYER) as (keyof typeof Z_LAYER)[]) {
      expect(Z_CLASS[layer]).toBe(`z-${Z_LAYER[layer]}`);
    }
  });
});

describe("the gift page's sticky rail", () => {
  /**
   * The rail carries the only way back to the invitation and stays put while a
   * long gift list scrolls under it. Every card on that page paints a
   * background of its own and is LATER in the document, so without a layer the
   * rail is painted over by the list it floats above — visible at the top of
   * the page and gone from the moment it matters.
   */
  it("floats above the list it sticks over, and below every overlay", () => {
    expect(Z_LAYER.STICKY_RAIL).toBeGreaterThan(Z_LAYER.EVENT_CARD);
    expect(Z_LAYER.STICKY_RAIL).toBeGreaterThan(Z_LAYER.BASE);
    expect(Z_LAYER.STICKY_RAIL).toBeLessThan(Z_LAYER.MODAL_POPOVER);
    expect(Z_LAYER.STICKY_RAIL).toBeLessThan(Z_LAYER.CONSENT);
  });
});
