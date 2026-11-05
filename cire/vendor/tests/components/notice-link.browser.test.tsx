/**
 * A link inside a warning, measured with the vendor portal's own stylesheet.
 *
 * The claim page warns that an organisation already has a listing and links
 * to it inside the warning (`ClaimApp.tsx`). The link takes the readable gold,
 * not the warning's own ink, so its words sit on the warning's tint in a
 * colour the tint was not chosen for. This holds them at 4.5:1 in both themes.
 */

import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { proseLinkClass } from "@cire/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** The page's ground, then every background from the outermost ancestor in. */
function backdropOf(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  return composite([ground, ...layers]);
}

describe("a link inside a warning", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`holds its words at ${WCAG_TEXT_MIN}:1 on the warning's tint, ${theme}`, () => {
      document.documentElement.dataset.theme = theme;
      render(() => (
        <Notice tone="warn">
          Bloom &amp; Co already has a directory listing. Pick another organisation, or{" "}
          <a class={proseLinkClass()} href="#/orgs/bloom">
            edit Bloom &amp; Co's listing
          </a>
          .
        </Notice>
      ));
      const link = screen.getByRole("link");
      const under = backdropOf(link);
      const ink = composite([under, getComputedStyle(link).color]);
      expect(contrastRatio(ink, under)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    });
  }
});
