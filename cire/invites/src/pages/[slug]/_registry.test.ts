/*
 * Underscore-prefixed on purpose. Astro routes every file under `src/pages`, so
 * without that prefix this drift guard is BUILT AND DEPLOYED: `/index.test`,
 * `/legal-pages.test` and `/<slug>/registry.test` were all live routes on the
 * guest site, and the vitest the three of them import was a 534 KB (119 KB
 * gzip) chunk in the SSR Worker — 28% of the bundle (tracker #287). A leading
 * `_` is what excludes a file from Astro's router; it stays colocated beside
 * the `.astro` it reads, and vitest's default include still picks it up.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the gift list's route, `/<slug>/registry`.
 *
 * Every decision this route embodies lives in a few lines of Astro frontmatter,
 * and each is one edit away from a real regression nothing else would catch:
 *
 *  - **It fetches the invite and NOT the list.** The list is gated on
 *    `cire_session`, a cookie host-scoped to the API origin, so the browser
 *    never sends it here and the server has no household to be. An SSR list
 *    fetch would be an anonymous one, which can only ever be a 401 — and the
 *    page would then render "you are not signed in" to a guest who is.
 *  - **The only 404 is an unknown wedding.** The API answers one code for "no
 *    registry", "not entitled", "not published" and "a cookie for another
 *    wedding", so that no caller can tell them apart. A route that 404'd for a
 *    missing list would answer, to anyone holding a slug, the exact question
 *    that code exists to refuse.
 *  - **A failed invite read still renders the page.** The list is what the page
 *    is for; losing the couple's colours is a worse-looking page, not a missing
 *    one.
 *
 * The route renders whole documents, so there is no DOM to assert against and no
 * Astro test harness in this workspace. A source-text guard is the cheapest
 * thing that can actually fail when the contract is reverted — the same approach
 * `pages/_index.test.ts` takes over the bare-domain route.
 */
describe("pages/[slug]/registry.astro (the gift list's route)", () => {
  const source = readFileSync(join(import.meta.dirname, "registry.astro"), "utf8");
  // Assertions run against the CODE, not the prose: the comments in this route
  // legitimately explain every fetch and status it does NOT make.
  const code = source.replaceAll(/^\s*\/\/.*$/gm, "");

  it("reads the invite server-side", () => {
    expect(code).toContain("await fetchInvite(slug)");
  });

  it("never reads the list server-side — that read needs a household", () => {
    expect(code).not.toContain("fetchGiftRegistry");
  });

  it("404s an unknown wedding, and nothing else", () => {
    expect(code).toContain("result.kind === 'not-found'");
    expect(code).toContain("Astro.response.status = 404");
    expect(code).not.toContain("registry_not_found");
  });

  it("renders the gift shell for a real wedding, and the not-found one otherwise", () => {
    // Which document gets the props is one of this route's decisions, and the
    // props are how `API_URL` reaches the island that makes the credentialed
    // read. Swapping the component would otherwise pass every test here.
    expect(code).toContain(
      "<GiftRegistryDocument apiUrl={API_URL} slug={slug!} invite={invite} />",
    );
    expect(code).toContain("<NotFoundDocument");
  });

  it("still renders the page when only the invite read failed", () => {
    // `invite` degrades to null (built-in theme and copy); the island reports
    // whatever the list read finds.
    expect(code).toContain("result.kind === 'ok' ? result.invite : null");
  });
});
