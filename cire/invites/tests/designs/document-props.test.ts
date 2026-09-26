import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for how each pack's `Document.astro` tells its islands whether
 * the route's invite fetch succeeded.
 *
 * The header retries when its `initial` prop is `null`; the page retries when
 * `inviteMissing` is true. Only these two lines keep the gates in step. Drop the
 * page's and a failed route leaves the events section on defaults while the
 * header recovers; invert it and every healthy page load makes the browser
 * fetch the invite the route already passed down. The island tests pass either
 * way, because they hand the flag in by hand.
 *
 * No Astro render harness exists in this workspace, so this reads the source,
 * as `tests/pages/index.test.ts` does for the bare-domain route.
 */
describe.each(["classic", "gala"])("designs/%s/Document.astro", (pack) => {
  const source = readFileSync(
    join(import.meta.dirname, `../../src/designs/${pack}/Document.astro`),
    "utf8",
  );
  const element = (name: string) => {
    const match = new RegExp(`<${name}\\b[^>]*/>`, "s").exec(source);
    expect(match, `<${name} … /> in ${pack}/Document.astro`).not.toBeNull();
    return match![0];
  };

  it("hands the header the route's payload, null when the fetch failed", () => {
    expect(element("InviteHeader")).toMatch(/\binitial=\{initialInvite\}/);
  });

  it("flags the page exactly when the route's fetch failed", () => {
    expect(element("InvitePage")).toMatch(/\binviteMissing=\{initialInvite === null\}/);
  });

  // The preload has to honour the hero's switch, which only `heroPreloadHref`
  // does. An inline preload built straight from `hero.imageUrl` would fetch a
  // switched-off hero's image at top priority for a section that never paints.
  it("builds the hero preload with heroPreloadHref, never inline", () => {
    expect(source).toMatch(/\bconst preloadHeroHref = heroPreloadHref\(apiUrl, initialInvite\)/);
    expect(source).not.toMatch(/variant=hero-bg/);
    expect(source).not.toMatch(/\bheroBase\b/);
  });
});
