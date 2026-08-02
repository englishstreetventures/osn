import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the bare-domain (`/`) route.
 *
 * Every decision this route embodies lives in two lines of Astro frontmatter,
 * and each is a one-character revert away from a real regression that nothing
 * else would catch:
 *
 *  - **302, not 301.** Where the root points is a product decision we expect to
 *    revisit; a permanent redirect would sit in browser caches indefinitely and
 *    could not be recalled.
 *  - **The destination is `MARKETING_URL`**, not a literal — so the resolution
 *    rule (and its fallback for an empty/relative/non-http value) actually
 *    applies. A hardcoded URL here would bypass `resolveMarketingUrl` entirely.
 *  - **No query string is forwarded.** The only query that ever rode the bare
 *    domain was a `?code=` host-preview deep link — a claim credential.
 *    Reinstating `${Astro.url.search}` would deposit it in the marketing site's
 *    access logs and `Referer` chain.
 *
 * The route renders nothing, so there is no DOM to assert against and no Astro
 * test harness in this workspace. A source-text guard is the cheapest thing
 * that can actually fail when the contract is reverted — the same approach
 * `src/styles/gold-text-token.test.ts` takes over `.astro` files here.
 */
describe("pages/index.astro (bare-domain redirect)", () => {
  const source = readFileSync(join(import.meta.dirname, "index.astro"), "utf8");
  // Assertions run against the CODE, not the prose. The comments in this route
  // legitimately mention `301`, the API endpoint it replaced, and the query
  // string it stopped forwarding — all as explanation of what it must NOT do.
  const code = source.replaceAll(/^\s*\/\/.*$/gm, "");

  it("redirects to MARKETING_URL with a 302", () => {
    expect(code).toContain("Astro.redirect(MARKETING_URL, 302)");
  });

  it("never hardcodes the destination, so the resolver's fallback always applies", () => {
    expect(code).not.toContain("cireweddings.com");
  });

  it("is not a permanent redirect", () => {
    expect(code).not.toContain("301");
  });

  it("reads nothing from the request, so no query string can be forwarded", () => {
    expect(code).not.toContain("Astro.url");
    expect(code).not.toContain("Astro.request");
    expect(code).not.toContain("search");
  });
});
