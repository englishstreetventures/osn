import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the gift list's fixed-path route, `/cire/registry?slug=…`.
 *
 * Every gift-list link the guest site builds and both Stripe return URLs land
 * here, so it keeps every rule `tests/pages/[slug]/registry.test.ts` pins on the
 * path route, plus the two that make it fixed-path:
 *
 *  - the slug comes from the query, and the invite is read through the fixed
 *    API path;
 *  - it reads the invite and never the list (the list needs a household the
 *    server cannot be);
 *  - the only 404 is an unknown wedding;
 *  - a failed invite read still renders the page — a guest coming back from
 *    paying must see the list, not "unavailable".
 */
describe("pages/cire/registry.astro (the gift list's fixed-path route)", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../../src/pages/cire/registry.astro"),
    "utf8",
  );
  const code = source.replaceAll(/^\s*\/\/.*$/gm, "");

  it("reads the slug from the query and the invite through the fixed API path", () => {
    expect(code).toContain("Astro.url.searchParams.get('slug')");
    expect(code).toContain("await fetchInviteForQueryRoute(slug)");
    expect(code).not.toMatch(/\bfetchInvite\(/);
  });

  it("never reads the list server-side — that read needs a household", () => {
    expect(code).not.toContain("fetchGiftRegistry");
  });

  it("404s an unknown wedding, and nothing else", () => {
    expect(code).toContain("if (result.kind === 'not-found') {");
    expect(code).toContain("Astro.response.status = 404");
    expect(code).not.toMatch(/Astro\.response\.status = (?!404)/);
  });

  it("renders the gift page unless the wedding is unknown", () => {
    expect(code).toContain("{result.kind === 'not-found' ? (");
    expect(code).toContain("result.kind === 'ok' ? result.invite : null");
    expect(code).toContain(
      "<GiftRegistryDocument apiUrl={API_URL} slug={slug!} invite={invite} />",
    );
  });
});
