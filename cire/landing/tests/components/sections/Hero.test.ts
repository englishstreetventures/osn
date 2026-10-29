import { describe, expect, it } from "vitest";

import hero from "../../../src/components/sections/Hero.astro?raw";

// The hero is static Astro markup with no island; its chips are CSS and the
// end-to-end flow (`cire-landing-home`) drives them. This guards what a browser
// run with the stack's env never reaches: the external "See a live invite" link,
// used only when PUBLIC_DEMO_INVITE_URL is set, must carry
// rel="noopener noreferrer" (reverse-tabnabbing). Mirrors the ?raw idiom in
// legal-pages.test.
describe("Hero", () => {
  it('protects the external demo link with rel="noopener noreferrer"', () => {
    expect(hero).toContain("noopener noreferrer");
  });
});
