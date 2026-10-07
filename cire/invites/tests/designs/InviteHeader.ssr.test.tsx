import { DESIGNS } from "@cire/invite-designs";
import { Suspense, type JSX } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  returningHousehold,
  setReturningHousehold,
} from "../../src/components/returning-household";
import ClassicInviteHeader from "../../src/designs/classic/InviteHeader";
import GalaInviteHeader from "../../src/designs/gala/InviteHeader";
import type { InviteCustomisation } from "../../src/designs/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const initial: InviteCustomisation = {
  hero: { title: "Anita & Ben", subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: { headingFont: null, bodyFont: null, palette: null, tones: null },
};

/**
 * Render the way Astro's Solid renderer does for a hydrated island:
 * `renderToStringAsync` around a `Suspense`, which awaits any resource the
 * island starts. A fetch made here is a Worker subrequest the HTML waits on.
 */
function serverRender(island: () => JSX.Element): Promise<string> {
  return renderToStringAsync(() => <Suspense>{island()}</Suspense>);
}

const packs = [
  ["classic", ClassicInviteHeader],
  ["gala", GalaInviteHeader],
] as const;

it("covers every design in the catalog", () => {
  // A new pack fails here until it is listed above, and so until its hero is
  // checked for the scroll cue below.
  expect(packs.map(([id]) => id).toSorted()).toEqual(DESIGNS.map((d) => d.id).toSorted());
});

describe.each(packs)("%s InviteHeader, rendered on the server", (_pack, InviteHeader) => {
  it("paints the route's payload and fetches nothing", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(initial)));
    vi.stubGlobal("fetch", fetchMock);

    const html = await serverRender(() => (
      <InviteHeader apiUrl="https://api.test" slug="anita-and-ben" initial={initial} />
    ));

    // The route already fetched this payload and passed it in; a second request
    // for it from inside the render would only delay the HTML.
    expect(html).toContain("Anita &amp; Ben");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches nothing when the route had no payload either — the retry is the browser's", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(initial)));
    vi.stubGlobal("fetch", fetchMock);

    const html = await serverRender(() => (
      <InviteHeader apiUrl="https://api.test" slug="anita-and-ben" initial={null} />
    ));

    // The route's own fetch just failed; asking again from the Worker would hold
    // the shell back on an API that is already failing.
    expect(html).not.toContain("Anita &amp; Ben");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts the scroll cue in the HTML, shown, before any script runs", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const html = await serverRender(() => (
      <InviteHeader apiUrl="https://api.test" slug="anita-and-ben" initial={initial} />
    ));

    // Its entry and drift are CSS, so they play from the server's HTML; only
    // the hide on scroll waits for the island.
    expect(html).toContain('data-scroll-cue="shown"');
    expect(html).toContain("animate-scroll-cue");
  });

  it("serves the first-visit title even when the store says the household is returning", async () => {
    // The Worker never learns the household, and the store ignores writes
    // there; force it true to prove the hero's own guard. The hero's first
    // render must match this HTML, since hydration keeps the server's text.
    vi.stubGlobal("window", {});
    setReturningHousehold(true);
    vi.unstubAllGlobals();
    expect(returningHousehold()).toBe(true);
    vi.stubGlobal("fetch", vi.fn());

    try {
      const html = await serverRender(() => (
        <InviteHeader
          apiUrl="https://api.test"
          slug="anita-and-ben"
          // No couple title, so the hero draws its fallback.
          initial={{ ...initial, hero: { title: null, subtitle: "Lisbon", imageUrl: null } }}
        />
      ));

      expect(html).toContain("You're Invited");
      expect(html).not.toContain("Welcome back to your invite");
    } finally {
      vi.stubGlobal("window", {});
      setReturningHousehold(false);
      vi.unstubAllGlobals();
    }
  });

  it("renders no scroll cue when the hero is switched off", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const html = await serverRender(() => (
      <InviteHeader
        apiUrl="https://api.test"
        slug="anita-and-ben"
        initial={{ ...initial, visibility: { hero: false } }}
      />
    ));

    expect(html).not.toContain("data-scroll-cue");
  });
});
