/**
 * `cireStyle()` against the mapping the lab's own `:root` carries.
 *
 * The lab imports Musubi's stylesheet (`src/lab.css`), so every `--ui-*`
 * token Musubi's contract block maps reaches every story. A cire subtree is
 * cire only where `cireStyle()` sets each of those tokens, with cire's value
 * or with `initial` where cire maps none; a token it misses draws Musubi's
 * value inside a column labelled cire, and the story still renders. No flow
 * opens the lab, so this reads the two sources side by side.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cireStyle } from "../src/stories/cire-ui/cire-mapping.ts";

const MUSUBI_CSS = new URL("../../../musubi/social/src/App.css", import.meta.url);

/**
 * Tokens Musubi maps that `cireStyle()` leaves alone on purpose. cire's faces
 * are self-hosted by its Astro pipeline and are not loaded in the lab, so a
 * cire subtree shows the lab's own faces rather than claim cire's
 * (`src/stories/cire-ui/cire-mapping.ts`).
 */
const LEFT_TO_THE_LAB = ["--ui-font-body", "--ui-font-display", "--ui-font-mono"];

/** Every `--ui-*` custom property Musubi's stylesheet declares, comments stripped. */
function musubiTokens(): string[] {
  const css = readFileSync(MUSUBI_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = css.matchAll(/(?:^|[{;\s])(--ui-[a-z0-9-]+)\s*:/g);
  return [...new Set([...declared].map((match) => match[1]!))].toSorted();
}

describe("cireStyle", () => {
  const tokens = musubiTokens();

  it("finds Musubi's contract block", () => {
    expect(tokens).toContain("--ui-ink");
    expect(tokens).toContain("--ui-weight-title");
  });

  for (const theme of ["dark", "light"] as const) {
    it(`sets every token Musubi maps, in ${theme}`, () => {
      const set = Object.keys(cireStyle(theme));
      const missing = tokens.filter(
        (token) => !set.includes(token) && !LEFT_TO_THE_LAB.includes(token),
      );
      expect(missing).toEqual([]);
    });

    it(`leaves the lab's faces alone, in ${theme}`, () => {
      const set = Object.keys(cireStyle(theme));
      expect(LEFT_TO_THE_LAB.filter((token) => set.includes(token))).toEqual([]);
    });
  }

  it("excludes only tokens Musubi declares", () => {
    expect(LEFT_TO_THE_LAB.filter((token) => !tokens.includes(token))).toEqual([]);
  });
});
