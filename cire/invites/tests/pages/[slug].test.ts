import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the invitation's path route, `/<slug>`.
 *
 * New links use `/cire/invite?slug=…`, but every invitation already sent says
 * `/<slug>` and cannot be recalled, so this route has to keep answering them.
 * Nothing else in the suite names the path shape any more, so this guard is
 * what fails if the route is deleted or its answers change.
 */
describe("pages/[slug].astro (existing invitation links)", () => {
  const source = readFileSync(join(import.meta.dirname, "../../src/pages/[slug].astro"), "utf8");
  const code = source.replaceAll(/^\s*\/\/.*$/gm, "");

  it("reads the slug from the path and the invite through the slug path", () => {
    expect(code).toContain("const { slug } = Astro.params");
    expect(code).toContain("await fetchInvite(slug)");
  });

  it("404s an unknown wedding, and nothing else", () => {
    expect(code).toContain("if (result.kind === 'not-found') {");
    expect(code).toContain("Astro.response.status = 404");
    expect(code).not.toMatch(/Astro\.response\.status = (?!404)/);
  });

  it("renders the invitation unless the wedding is unknown", () => {
    expect(code).toContain("{result.kind === 'not-found' ? (");
    expect(code).toContain(
      "<Document apiUrl={API_URL} slug={slug!} initialInvite={invite} siteUrl={siteUrl} />",
    );
  });
});
