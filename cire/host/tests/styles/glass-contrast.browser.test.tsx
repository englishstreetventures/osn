import { contrastRatio } from "@cire/theme";
import Button from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import SegmentedTabs from "@cire/ui/segmented-tabs";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/*
 * The chosen glass stands apart from what it sits on by 3:1 in the light
 * theme (WCAG 1.4.11, englishstreetventures/osn#2356): a strip's glass against
 * its track, and a chosen `glass` pill against the ground beside it, on the
 * page and on a card. The fill cannot carry it there — the gold word on the
 * glass needs a pale fill to read at 4.5:1, and the light track is pale too —
 * so the glass's ring does: `--glass-ring`, readable gold at 1px. A ring under
 * 1px paints at part coverage on a 1x screen, so it is held to 1px as well as
 * to its colour.
 */

/** The non-text contrast floor for a component's boundary and state. */
const BOUNDARY_MIN = 3;

const GROUNDS = {
  page: (children: JSX.Element) => <div class="bg-bg flex items-center gap-3 p-4">{children}</div>,
  card: (children: JSX.Element) => (
    <div class={cardClass()}>
      <div class="flex items-center gap-3">{children}</div>
    </div>
  ),
} as const;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

const settle = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The page's ground, then every background from the outermost ancestor in to `element`. */
function backdropOf(element: Element): string[] {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  return [getComputedStyle(document.documentElement).getPropertyValue("--bg"), ...layers];
}

/**
 * The ring in `element`'s computed `box-shadow`: the outer layer with no
 * offset and no blur, only a spread.
 */
function ringOf(element: Element): { color: string; spread: number } {
  const layers = getComputedStyle(element)
    .boxShadow.split(/,(?![^(]*\))/)
    .map((layer) => layer.trim());
  const rings = layers.flatMap((layer) => {
    if (layer.includes("inset")) return [];
    const lengths = [...layer.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    if (lengths.length !== 4) return [];
    const [x, y, blur, spread] = lengths as [number, number, number, number];
    if (x !== 0 || y !== 0 || blur !== 0 || spread <= 0) return [];
    return [{ color: layer.replace(/\s*-?[\d.]+px/g, "").trim(), spread }];
  });
  expect(rings, `one ring in ${getComputedStyle(element).boxShadow}`).toHaveLength(1);
  return rings[0]!;
}

/** `element`'s ring against the ground it is painted over. */
function ringRatio(element: Element, ground: Element): number {
  const under = backdropOf(ground);
  const { color } = ringOf(element);
  return contrastRatio(composite([...under, color]), composite(under))!;
}

describe("the chosen glass in the light theme", () => {
  for (const [groundName, wrap] of Object.entries(GROUNDS)) {
    it(`stands 3:1 apart from its track on the ${groundName}`, async () => {
      document.documentElement.dataset.theme = "light";
      render(() =>
        wrap(
          <SegmentedTabs
            items={[
              { value: "guests", label: "Guests" },
              { value: "households", label: "Households" },
              { value: "seating", label: "Seating" },
            ]}
            value="guests"
            onChange={() => {}}
            label="Views"
            semantics="tabs"
          />,
        ),
      );
      await settle();
      const glass = document.querySelector<HTMLElement>("[data-segmented-glass]")!;
      expect(getComputedStyle(glass).opacity).toBe("1");
      const track = screen.getByRole("tablist", { name: "Views" });
      const { spread } = ringOf(glass);
      expect(spread).toBeGreaterThanOrEqual(1);
      expect(ringRatio(glass, track)).toBeGreaterThanOrEqual(BOUNDARY_MIN);
      // The glass moves in a layer clipped to the track, so the ring paints
      // only while the track's padding leaves it room on every side.
      const ring = glass.getBoundingClientRect();
      const clip = glass.parentElement!.getBoundingClientRect();
      expect(ring.left - spread).toBeGreaterThanOrEqual(clip.left);
      expect(ring.top - spread).toBeGreaterThanOrEqual(clip.top);
      expect(ring.right + spread).toBeLessThanOrEqual(clip.right);
      expect(ring.bottom + spread).toBeLessThanOrEqual(clip.bottom);
    });

    it(`stands 3:1 apart from the ground beside a chosen glass pill on the ${groundName}`, () => {
      document.documentElement.dataset.theme = "light";
      render(() =>
        wrap(
          <Button variant="glass" size="sm" aria-pressed="true">
            Desktop
          </Button>,
        ),
      );
      const pill = screen.getByRole("button", { name: "Desktop" });
      expect(ringOf(pill).spread).toBeGreaterThanOrEqual(1);
      expect(ringRatio(pill, pill.parentElement!)).toBeGreaterThanOrEqual(BOUNDARY_MIN);
    });
  }
});
