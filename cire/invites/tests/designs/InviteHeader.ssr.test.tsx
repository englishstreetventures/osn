import { Suspense, type JSX } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
