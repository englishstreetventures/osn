import { describe, expect, it } from "vitest";

import { Z_CLASS, Z_LAYER } from "./z-index";

describe("z-index layer scale", () => {
  it("orders the layers low → high (BASE < EVENT_CARD < MODAL < MODAL_POPOVER)", () => {
    expect(Z_LAYER.BASE).toBeLessThan(Z_LAYER.EVENT_CARD);
    expect(Z_LAYER.EVENT_CARD).toBeLessThan(Z_LAYER.MODAL);
    expect(Z_LAYER.MODAL).toBeLessThan(Z_LAYER.MODAL_POPOVER);
  });

  it("keeps a modal-launched popover ABOVE the modal (the #203 invariant)", () => {
    // Regression guard: AddToCalendar is opened from inside the details modal
    // and portalled to <body>, so its z-index competes directly with the
    // modal's. At z-90 (< modal z-100) it rendered behind the modal backdrop.
    expect(Z_LAYER.MODAL_POPOVER).toBeGreaterThan(Z_LAYER.MODAL);
  });

  it("pins the current visual values (modal=100, popover=110) — refactor, not re-layer", () => {
    expect(Z_LAYER.MODAL).toBe(100);
    expect(Z_LAYER.MODAL_POPOVER).toBe(110);
  });

  it("maps each layer to its matching Tailwind class literal", () => {
    expect(Z_CLASS.BASE).toBe("z-0");
    expect(Z_CLASS.EVENT_CARD).toBe("z-10");
    expect(Z_CLASS.MODAL).toBe("z-100");
    expect(Z_CLASS.MODAL_POPOVER).toBe("z-110");
  });

  it("derives each class string from its numeric layer value", () => {
    for (const layer of Object.keys(Z_LAYER) as (keyof typeof Z_LAYER)[]) {
      expect(Z_CLASS[layer]).toBe(`z-${Z_LAYER[layer]}`);
    }
  });
});
