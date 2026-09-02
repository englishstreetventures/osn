import { describe, expect, it } from "vitest";

import { DEFAULT_MARKETING_URL, MARKETING_URL, resolveMarketingUrl } from "../../src/lib/invite";

/**
 * The bare domain (`/`) redirects to the marketing site rather than to any one
 * couple's invite — cire is multi-tenant, and the root previously served
 * whichever wedding happened to be newest.
 *
 * The property that makes that redirect safe is that the destination is an
 * absolute off-origin URL. A same-origin, relative or empty destination turns
 * `/` into a redirect loop and takes the guest site's root down — and an empty
 * `Location` is the easy one to ship, because `PUBLIC_MARKETING_URL=` in a
 * `.env` is present-but-empty, which a `??` fallback does not catch.
 */
describe("resolveMarketingUrl", () => {
  it("falls back to the apex for values that would loop or fail to navigate", () => {
    const unusable: [string, string | undefined][] = [
      ["unset", undefined],
      ["empty string (the `PUBLIC_MARKETING_URL=` case)", ""],
      ["whitespace only", "   "],
      ["root-relative path (resolves same-origin → loop)", "/foo"],
      ["bare path", "foo/bar"],
      ["protocol-relative", "//cireweddings.com"],
      ["not a URL at all", "not a url"],
      ["non-navigable scheme", "ftp://cireweddings.com"],
      ["javascript: scheme", "javascript:alert(1)"],
    ];

    // Compared as a whole object rather than asserted in a loop, so a failure
    // names the case that regressed instead of just its index.
    const resolved = Object.fromEntries(unusable.map(([l, i]) => [l, resolveMarketingUrl(i)]));
    const allDefault = Object.fromEntries(unusable.map(([l]) => [l, DEFAULT_MARKETING_URL]));
    expect(resolved).toEqual(allDefault);
  });

  it("honours an absolute http(s) override, so preview deploys can repoint it", () => {
    expect(resolveMarketingUrl("https://staging.example.com")).toBe("https://staging.example.com/");
    expect(resolveMarketingUrl("http://localhost:4323")).toBe("http://localhost:4323/");
    // Surrounding whitespace is a copy-paste artefact, not a different value.
    expect(resolveMarketingUrl("  https://example.com/landing  ")).toBe(
      "https://example.com/landing",
    );
  });
});

describe("MARKETING_URL", () => {
  it("is an absolute off-origin http(s) URL, so `/` can never redirect to itself", () => {
    const url = new URL(MARKETING_URL);
    expect(["http:", "https:"]).toContain(url.protocol);
    // The guest site serves invite.cireweddings.com; the destination must be a
    // different host, or the 302 re-enters the `/` route it came from.
    expect(url.hostname).not.toBe("invite.cireweddings.com");
  });
});
