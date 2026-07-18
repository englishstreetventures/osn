import { describe, expect, it } from "vitest";

import footer from "./components/SiteFooter.astro?raw";
import privacy from "./pages/privacy.astro?raw";
import refunds from "./pages/refunds.astro?raw";
import terms from "./pages/terms.astro?raw";

const legalPages = { terms, privacy, refunds };

describe("legal pages", () => {
  // A page may only ship {{...}} placeholder tokens while its draft banner is
  // still present — the lawyer-review cleanup must remove both together.
  for (const [name, source] of Object.entries(legalPages)) {
    it(`${name} keeps the draft banner while placeholders remain`, () => {
      const hasPlaceholders = /\{\{[A-Z_]+\}\}/.test(source);
      const hasDraftBanner = source.includes("draft-banner");
      expect(!hasPlaceholders || hasDraftBanner).toBe(true);
    });
  }

  it("footer links every legal page", () => {
    for (const name of Object.keys(legalPages)) {
      expect(footer).toContain(`href="/${name}"`);
    }
  });
});
