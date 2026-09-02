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
 * The guest legal pages are served to the guests of EVERY wedding, so they may
 * not name a couple, a wedding, or anyone's personal contact address.
 *
 * This is asserted because it already happened once and stayed for months: both
 * pages opened with one couple's name and gave that couple's private email as
 * the privacy contact, which was correct for the first wedding and wrong for
 * every one after it. Nothing failed — the pages rendered perfectly, and the
 * only way to notice was to read them as somebody else's guest.
 *
 * Anything wedding-specific belongs on the invite itself, which is per-tenant.
 */
const pages = ["privacy.astro", "terms.astro"] as const;

/**
 * A bare `mailto:` or an address written into the prose. The operator's own
 * contact arrives through `LEGAL_ENTITY.contactEmail`, so any literal address
 * in these files is a hardcoded one.
 */
const LITERAL_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

/**
 * The rendered template alone. Astro frontmatter is a comment-and-import block
 * that no guest sees, and these files deliberately quote the wording they
 * replaced — asserting against the whole file would fail on the explanation of
 * the fix rather than on the fix.
 */
function template(source: string): string {
  const end = source.indexOf("---", 3);
  return end === -1 ? source : source.slice(end + 3);
}

describe.each(pages)("%s", (page) => {
  const source = readFileSync(join(import.meta.dirname, page), "utf8");

  it("hardcodes no email address", () => {
    expect(template(source)).not.toMatch(LITERAL_EMAIL);
  });

  it("takes the operator's identity from the shared legal module", () => {
    expect(source).toContain("@shared/legal");
    expect(source).toContain("LEGAL_ENTITY.contactEmail");
  });

  it("shows its draft banner only while the operator's details are unfilled", () => {
    expect(source).toContain("draftPending(");
    expect(source).toContain("{draft && (");
  });
});

describe("privacy.astro", () => {
  const body = template(readFileSync(join(import.meta.dirname, "privacy.astro"), "utf8"));

  /**
   * The personal/family/household exemption (Privacy Act 1988 s 16, GDPR
   * Art. 2(2)(c)) covers a couple running their own wedding. It has never
   * covered the platform underneath them, and the notice claimed it did.
   */
  it("claims no personal/household exemption from the Privacy Act", () => {
    expect(body).not.toMatch(/outside the strict reach/i);
    expect(body).not.toMatch(/not as a business/i);
  });

  it("states a lawful basis for the protected dietary field", () => {
    expect(body).toMatch(/explicit consent/i);
    expect(body).toContain("Art. 9(2)(a)");
    expect(body).toContain("APP 3.3");
  });

  /**
   * `cire/api/src/services/retention.ts` names this notice as the thing that must
   * move whenever `RETENTION_AFTER_FINAL_EVENT_MS` does. Pin the sentence so the
   * pairing is enforced rather than remembered.
   */
  it("states the retention window the sweep actually enforces", () => {
    expect(body).toContain("1 year after the final wedding event");
  });

  /**
   * Softened from "hosted in Sydney" once the subprocessor register turned out to
   * record the D1/R2 region as unconfirmed. The page must still name a region and
   * still tell an EEA or UK reader that their data leaves that area — those two
   * are the disclosure; the exact city is not.
   */
  it("names the region and flags the transfer out of the EEA/UK", () => {
    expect(body).toMatch(/primary region is <strong>Australia<\/strong>/);
    expect(body).toMatch(/transferred outside/i);
  });

  /**
   * These were engineering instructions — file paths, the flag to flip —
   * published to guests on a legal page. The context they carried now lives in
   * `lib/consent/categories.ts`, next to the flag itself.
   */
  it("publishes no notes addressed to the site owner", () => {
    expect(body).not.toContain("Note for the site owner");
    expect(body).not.toContain("owner-note");
  });
});
