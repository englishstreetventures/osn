import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalRedirectTarget, redirectToCanonicalHost } from "../../src/lib/canonical-host";

/**
 * Stands in for `window` with only the bit the guard reads and the one call it
 * makes. The default vitest environment here is `node`, so there is no real
 * `window` to fight with — `typeof window === "undefined"` until this runs,
 * which also gives the "no browser" case for free.
 */
function stubWindow(href: string) {
  const replace = vi.fn();
  vi.stubGlobal("window", { location: { href, replace } });
  return replace;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonicalRedirectTarget", () => {
  it("sends the pages.dev copy to the custom domain", () => {
    expect(canonicalRedirectTarget("https://osn-social.pages.dev/")).toBe("https://musubi.social/");
  });

  it("carries the path, query and fragment across", () => {
    // A link someone shared should land where it meant to, not on the home page.
    expect(
      canonicalRedirectTarget("https://osn-social.pages.dev/authorize?client_id=cire#top"),
    ).toBe("https://musubi.social/authorize?client_id=cire#top");
  });

  it("leaves the custom domain alone", () => {
    // The whole point. A guard that fires here is an infinite reload.
    expect(canonicalRedirectTarget("https://musubi.social/settings")).toBeNull();
  });

  it("leaves preview deployments alone", () => {
    // `<branch>.osn-social.pages.dev` is how a PR gets reviewed. Suffix matching
    // would break that, so the host check is exact.
    expect(canonicalRedirectTarget("https://feat-x.osn-social.pages.dev/")).toBeNull();
  });

  it("leaves the dev project alone", () => {
    expect(canonicalRedirectTarget("https://osn-social-dev.pages.dev/")).toBeNull();
  });

  it("leaves localhost alone", () => {
    expect(canonicalRedirectTarget("http://localhost:1422/")).toBeNull();
  });

  it("stays put on an href it cannot parse", () => {
    // Doing nothing beats guessing at a destination.
    expect(canonicalRedirectTarget("not a url")).toBeNull();
  });

  it("is not fooled by a lookalike host in the path or query", () => {
    expect(canonicalRedirectTarget("https://evil.example/osn-social.pages.dev")).toBeNull();
    expect(canonicalRedirectTarget("https://evil.example/?next=osn-social.pages.dev")).toBeNull();
  });
});

describe("redirectToCanonicalHost", () => {
  it("replaces the document and reports that it did", () => {
    const replace = stubWindow("https://osn-social.pages.dev/discover");

    // The return value is what stops the caller booting the app: `replace` does
    // not halt the running script, so without it the cold-start token grant
    // would still fire — the request this whole change exists to remove.
    expect(redirectToCanonicalHost()).toBe(true);
    expect(replace).toHaveBeenCalledWith("https://musubi.social/discover");
  });

  it("does nothing on the custom domain", () => {
    const replace = stubWindow("https://musubi.social/discover");

    expect(redirectToCanonicalHost()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it("is inert with no window", () => {
    expect(redirectToCanonicalHost()).toBe(false);
  });
});
