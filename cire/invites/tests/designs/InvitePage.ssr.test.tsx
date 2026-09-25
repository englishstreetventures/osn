import { Suspense, type JSX } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

import ClassicInvitePage from "../../src/designs/classic/InvitePage";
import GalaInvitePage from "../../src/designs/gala/InvitePage";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Render the way Astro's Solid renderer does for a hydrated island:
 * `renderToStringAsync` around a `Suspense`, which awaits any resource the
 * island starts. A fetch made here is a Worker subrequest the HTML waits on.
 */
function serverRender(island: () => JSX.Element): Promise<string> {
  return renderToStringAsync(() => <Suspense>{island()}</Suspense>);
}

const packs = [
  ["classic", ClassicInvitePage],
  ["gala", GalaInvitePage],
] as const;

describe.each(packs)("%s InvitePage, rendered on the server", (_pack, InvitePage) => {
  it("renders the code entry from its props and fetches nothing", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetchMock);

    const html = await serverRender(() => (
      <InvitePage
        apiUrl="https://api.test"
        slug="anita-and-ben"
        // Only the welcome tone is set, and it is the one thing that reaches the
        // code-entry section before a claim — so the HTML carrying it proves
        // the render used these props.
        theme={{ headingFont: null, bodyFont: null, tones: { welcome: "card" } }}
        details={null}
        welcomeMessage={null}
      />
    ));

    expect(html).toContain("Enter Your Code");
    expect(html).toContain("--invite-section-bg:var(--color-surface)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches nothing when the route had no payload either — the retry is the browser's", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetchMock);

    const html = await serverRender(() => (
      <InvitePage apiUrl="https://api.test" slug="anita-and-ben" inviteMissing />
    ));

    expect(html).toContain("Enter Your Code");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
