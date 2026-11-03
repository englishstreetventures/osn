/**
 * The guest site's account card draws `@cire/ui`'s `PersonAvatar` initial: the
 * readable gold letter on the surface at 40% inside a hairline. The guest site
 * maps the contract onto each couple's palette, so the letter is measured in
 * this site's stylesheet, under every palette, on each ground the card sits
 * on, and held to 4.5:1.
 */

import { contrastRatio, PALETTE_PRESET_KEYS, WCAG_TEXT_MIN } from "@cire/theme";
import PersonAvatar from "@cire/ui/person-avatar";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";
import { applyPaletteToRoot } from "../../src/components/invite-theme";

const GROUNDS = {
  page: "bg-bg",
  surface: "bg-surface",
  "raised surface": "bg-surface-raised",
} as const;

afterEach(() => {
  cleanup();
  applyPaletteToRoot(null);
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

/** `el`'s words against everything painted under them, the page first. */
function wordsRatio(el: Element): number {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  const page = getComputedStyle(document.documentElement).getPropertyValue("--color-bg");
  const under = composite([page, ...layers]);
  return contrastRatio(composite([under, getComputedStyle(el).color]), under)!;
}

describe.each(PALETTE_PRESET_KEYS)("the %s scheme", (palettePreset) => {
  it("holds the account card's initial at 4.5:1 on every ground", () => {
    applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });
    render(() => (
      <>
        {Object.entries(GROUNDS).map(([name, ground]) => (
          <div class={`${ground} p-4`} data-ground={name}>
            <PersonAvatar fallback="initial" name={name} class="size-10" />
          </div>
        ))}
      </>
    ));
    const short = Object.keys(GROUNDS)
      .map((name) => {
        const letter = screen.getByText(name.charAt(0).toUpperCase(), {
          selector: `[data-ground="${name}"] span`,
        });
        return [name, wordsRatio(letter)] as const;
      })
      .filter(([, ratio]) => ratio < WCAG_TEXT_MIN)
      .map(([name, ratio]) => `${name}: ${ratio.toFixed(2)}`);
    expect(short).toEqual([]);
  });
});
