import Button from "@cire/ui/button";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/*
 * This portal sets the two tokens `@cire/ui`'s `Button` reads for the one pill
 * language (DESIGN.md §4): `--pill-sm-height`, so a small pill stands at the
 * strips' and filters' 28px, and `--pill-ground`, the glass track's ground
 * every non-primary pill sits on. Measured under this portal's own
 * stylesheet, so a token dropped, misspelt or set to another value here goes
 * red, which `@cire/ui`'s own tests, setting their own copies, cannot see.
 * And `--elev-2`, what floats over the page, carries the inner lip in each
 * scheme, so every menu and popover is lit the same way (DESIGN.md §4).
 */

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

/** A colour as one comparable paint, over black. */
function paint(color: string): string {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data.slice(0, 3).join(",");
}

describe("the portal's floating depth", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`carries the inner lip in what floats, ${theme}`, () => {
      document.documentElement.dataset.theme = theme;
      render(() => <div data-float style={{ "box-shadow": "var(--elev-2)" }} />);
      const shadows = getComputedStyle(document.querySelector("[data-float]")!)
        .boxShadow.split(/,(?![^(]*\))/)
        .map((s) => s.trim());
      expect(shadows.some((s) => s.includes("inset") && s.includes("0px 1px 0px"))).toBe(true);
      expect(shadows.some((s) => s.includes("12px 32px -8px"))).toBe(true);
    });
  }
});

describe("the portal's pill tokens", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`draw a small pill at 28px and a quiet one on the track's ground, ${theme}`, () => {
      document.documentElement.dataset.theme = theme;
      render(() => (
        <div class="bg-bg p-4">
          <Button variant="outline" size="sm">
            Download
          </Button>
          <Button variant="quiet">Record</Button>
        </div>
      ));
      expect(screen.getByRole("button", { name: "Download" }).getBoundingClientRect().height).toBe(
        28,
      );
      const surface = getComputedStyle(document.documentElement)
        .getPropertyValue("--surface")
        .trim();
      expect(
        paint(getComputedStyle(screen.getByRole("button", { name: "Record" })).backgroundColor),
      ).toBe(paint(`color-mix(in oklab, ${surface} 30%, transparent)`));
    });
  }
});
