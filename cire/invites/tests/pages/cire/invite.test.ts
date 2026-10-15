import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the invitation's fixed-path route, `/cire/invite?slug=…`.
 *
 * Every link the organiser portal generates lands here. Its decisions live in a
 * few lines of Astro frontmatter, so the guard reads the source, as
 * `tests/pages/[slug]/registry.test.ts` does (there is no Astro test harness in
 * this workspace):
 *
 *  - **The slug comes from the query and the lookup is a POST to a fixed API
 *    path.** That keeps the wedding out of the request path and the outbound URL
 *    a native trace records; production traces redact the query.
 *  - **It answers like `[slug].astro`.** An unknown wedding is a 404; an API
 *    error still renders the shell with built-in defaults, because the islands
 *    retry from the browser and a transient blip must not lose a guest's
 *    invitation.
 */
describe("pages/cire/invite.astro (the invitation's fixed-path route)", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../../src/pages/cire/invite.astro"),
    "utf8",
  );
  const code = source.replaceAll(/^\s*\/\/.*$/gm, "");

  it("reads the slug from the query", () => {
    expect(code).toContain("Astro.url.searchParams.get('slug')");
  });

  it("looks the wedding up through the fixed API path, never the slug path", () => {
    expect(code).toContain("await fetchInviteForQueryRoute(slug)");
    expect(code).not.toMatch(/\bfetchInvite\(/);
  });

  it("treats a missing slug as an unknown wedding, without a lookup", () => {
    expect(code).toContain(
      "slug ? await fetchInviteForQueryRoute(slug) : ({ kind: 'not-found' } as const)",
    );
  });

  it("404s an unknown wedding, and nothing else", () => {
    expect(code).toContain("if (result.kind === 'not-found') {");
    expect(code).toContain("Astro.response.status = 404");
    expect(code).not.toMatch(/Astro\.response\.status = (?!404)/);
  });

  it("renders the invitation unless the wedding is unknown", () => {
    // An API error falls through to the design document with `invite` null.
    expect(code).toContain("{result.kind === 'not-found' ? (");
    expect(code).toContain("result.kind === 'ok' ? result.invite : null");
    expect(code).toContain(
      "<Document apiUrl={API_URL} slug={slug!} initialInvite={invite} siteUrl={siteUrl} />",
    );
  });

  it("keeps the organiser's ?design= preview override", () => {
    expect(code).toContain("Astro.url.searchParams.get('design')");
    expect(code).toContain("isDesignId(designOverride)");
  });
});
