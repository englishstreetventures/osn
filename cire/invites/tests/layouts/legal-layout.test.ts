import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Which form the first-layer consent prompt takes on a phone, per document
 * shell. `ConsentBanner` asks in a modal dialog below the `md` breakpoint
 * unless the shell passes `phone="banner"`, and the choice lives in `.astro`
 * markup that no component test renders — so it is read here as text.
 */
const source = (path: string) => readFileSync(join(import.meta.dirname, "../../src", path), "utf8");

describe("LegalLayout.astro", () => {
  it("keeps the consent banner on a phone, so the prompt never covers the privacy notice", () => {
    // The prompt's own "Privacy notice" link lands here. A modal on this page
    // would stand between the guest and the notice they came to read before
    // deciding.
    expect(source("layouts/LegalLayout.astro")).toContain(
      '<ConsentBanner client:idle phone="banner" />',
    );
  });
});

describe.each([
  "designs/classic/Document.astro",
  "designs/gala/Document.astro",
  "components/gift-registry/GiftRegistryDocument.astro",
  "components/NotFoundDocument.astro",
])("%s", (path) => {
  it("asks in a dialog on a phone, leaving nothing over the page once answered", () => {
    expect(source(path)).toContain("<ConsentBanner client:idle />");
  });
});
