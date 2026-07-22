import { describe, expect, it } from "vitest";

import hero from "./Hero.astro?raw";

// The hero is static Astro markup (the interactive island, WaxSeal3D, is purely
// decorative and needs no behavioural test). We guard the two things that would
// be silent regressions if they broke: the external "See a live invite" link
// must carry rel="noopener noreferrer" (reverse-tabnabbing), and the primary CTA
// must point at the organiser portal. Mirrors the ?raw idiom in legal-pages.test.
describe("Hero", () => {
  it('protects the external demo link with rel="noopener noreferrer"', () => {
    expect(hero).toContain("noopener noreferrer");
  });

  it("renders the primary CTA to the organiser portal", () => {
    expect(hero).toContain("Create your invitation");
    expect(hero).toContain("ORGANISER_URL");
  });
});
