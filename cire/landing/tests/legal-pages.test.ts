import { LEGAL_ENTITY, isPlaceholder } from "@shared/legal";
import { describe, expect, it } from "vitest";

import footer from "../src/components/SiteFooter.astro?raw";
import privacy from "../src/pages/privacy.astro?raw";
import refunds from "../src/pages/refunds.astro?raw";
import terms from "../src/pages/terms.astro?raw";

const legalPages = { terms, privacy, refunds };

/** The fields `draftPending` already checks on every page's behalf. */
const IDENTITY = ["name", "postalAddress", "contactEmail"] as const;

/** The `LEGAL_ENTITY.x` fields named inside the page's `draftPending(...)` gate. */
function gateFields(source: string): string[] {
  const call = source.match(/draftPending\(([\s\S]*?)\)/);
  return call ? [...call[1].matchAll(/LEGAL_ENTITY\.(\w+)/g)].map((m) => m[1]) : [];
}

/** The fields the page actually publishes, ignoring the gate that guards them. */
function renderedFields(source: string): string[] {
  const body = source.replace(/draftPending\(([\s\S]*?)\)/, "");
  return [...new Set([...body.matchAll(/LEGAL_ENTITY\.(\w+)/g)].map((m) => m[1]))];
}

describe("legal pages", () => {
  for (const [name, source] of Object.entries(legalPages)) {
    /**
     * The invariant the old version of this test only looked like it checked.
     * It asserted a page may ship `{{TOKEN}}` text while a banner is present —
     * but no page has held a token in its own source since the identity moved
     * into `@shared/legal`, so it passed on its empty half and went on passing
     * while all three pages published a live `{{MERCHANT_OF_RECORD}}` with the
     * banner already gone.
     */
    it(`${name} gates its banner on every field it publishes`, () => {
      const covered = new Set<string>([...IDENTITY, ...gateFields(source)]);
      expect(renderedFields(source).filter((f) => !covered.has(f))).toEqual([]);
    });

    it(`${name} is still flagged a draft while any field it publishes is unfilled`, () => {
      const unfilled = renderedFields(source).filter((f) =>
        isPlaceholder(LEGAL_ENTITY[f as keyof typeof LEGAL_ENTITY]),
      );
      if (unfilled.length === 0) return;
      expect(source).toContain("{draft && (");
      expect(source).toContain("draft-banner");
    });
  }

  it("footer links every legal page", () => {
    for (const name of Object.keys(legalPages)) {
      expect(footer).toContain(`href="/${name}"`);
    }
  });
});
