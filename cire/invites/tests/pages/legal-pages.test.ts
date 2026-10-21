/*
 * Underscore-prefixed on purpose. Astro routes every file under `src/pages`, so
 * without that prefix this drift guard is BUILT AND DEPLOYED: `/index.test`,
 * `/legal-pages.test` and `/<slug>/registry.test` were all live routes on the
 * guest site, and the vitest the three of them import was a 534 KB (119 KB
 * gzip) chunk in the SSR Worker — 28% of the bundle. A leading
 * `_` is what excludes a file from Astro's router; it stays colocated beside
 * the `.astro` it reads, and vitest's default include still picks it up.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import guestNotice from "@cire/ui/guest-privacy-notice.astro?raw";
import { LEGAL_ENTITY } from "@shared/legal";
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
 *
 * The privacy page renders the guest notice from `@cire/ui`, which
 * cireweddings.com publishes too. What the notice says is checked there
 * (`cire/ui/tests/guest-privacy-notice.test.ts`); what this site serves is the
 * page and the notice together, so that is what these read.
 */
const pages = {
  "privacy.astro": `${readPage("privacy.astro")}\n${guestNotice}`,
  "terms.astro": readPage("terms.astro"),
} as const;

function readPage(page: string): string {
  return readFileSync(join(import.meta.dirname, "../../src/pages", page), "utf8");
}

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

/** The fields `draftPending` already checks on every page's behalf. */
const IDENTITY = ["name", "postalAddress", "contactEmail"] as const;

/** The `LEGAL_ENTITY.x` fields named inside the page's `draftPending(...)` gate. */
function gateFields(source: string): string[] {
  const call = source.match(/draftPending\(([\s\S]*?)\)/);
  return call ? [...call[1]!.matchAll(/LEGAL_ENTITY\.(\w+)/g)].map((m) => m[1]!) : [];
}

/** The fields the page publishes, ignoring the gate that guards them. */
function renderedFields(source: string): string[] {
  const body = source.replace(/draftPending\(([\s\S]*?)\)/, "");
  return [...new Set([...body.matchAll(/LEGAL_ENTITY\.(\w+)/g)].map((m) => m[1]!))];
}

describe.each(Object.entries(pages))("%s", (page, served) => {
  const source = readPage(page);

  it("hardcodes no email address", () => {
    expect(template(source)).not.toMatch(LITERAL_EMAIL);
  });

  it("takes the operator's identity from the shared legal module", () => {
    expect(served).toContain("@shared/legal");
    expect(served).toContain("LEGAL_ENTITY.contactEmail");
  });

  // The asset layer serves a prerendered page without running the Worker, so
  // the middleware's `X-Robots-Tag: noindex` never reaches it. Turn this off
  // and the page becomes SSR, gets that header and drops out of search.
  it("is prerendered, so it stays indexable", () => {
    expect(source).toMatch(/^export const prerender = true$/m);
  });

  it("shows its draft banner only while the operator's details are unfilled", () => {
    expect(source).toContain("draftPending(");
    expect(source).toContain("{draft && (");
  });

  /**
   * A field the page publishes, through its own template or the shared notice,
   * that its `draftPending(...)` does not name could stay a `{{TOKEN}}` with no
   * banner over it.
   */
  it("gates its banner on every field it publishes", () => {
    const covered = new Set<string>([...IDENTITY, ...gateFields(source)]);
    expect(renderedFields(served).filter((field) => !covered.has(field))).toEqual([]);
    // A misspelt field renders `undefined`, and no type check reads the
    // `.astro` template that names it.
    for (const field of renderedFields(served)) {
      expect(LEGAL_ENTITY).toHaveProperty(field);
    }
  });
});
