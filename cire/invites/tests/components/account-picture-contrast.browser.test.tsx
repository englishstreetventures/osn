/**
 * The guest site's account card draws `@cire/ui`'s `PersonAvatar` initial: the
 * readable gold letter inside a hairline, with no fill of its own, so the
 * letter sits straight on whatever ground the card sits on. The guest site
 * maps the contract onto each couple's palette, so the letter is measured in
 * this site's stylesheet, under every palette, on each of those grounds, and
 * held to 4.5:1.
 */

import { PALETTE_PRESET_KEYS, WCAG_TEXT_MIN } from "@cire/theme";
import PersonAvatar from "@cire/ui/person-avatar";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";
import { applyPaletteToRoot } from "../../src/components/invite-theme";
import { wordsRatio } from "../test-support/paint";

const GROUNDS = {
  page: "bg-bg",
  surface: "bg-surface",
  "raised surface": "bg-surface-raised",
} as const;

afterEach(() => {
  cleanup();
  applyPaletteToRoot(null);
});

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
