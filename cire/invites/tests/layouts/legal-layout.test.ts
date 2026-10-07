import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Which form the first-layer consent prompt takes, per document shell.
 * `ConsentBanner` asks in a dialog the guest must answer unless the shell
 * passes `prompt="banner"`, and the choice lives in `.astro` markup that no
 * component test renders — so it is read here as text.
 */
const source = (path: string) => readFileSync(join(import.meta.dirname, "../../src", path), "utf8");

describe("LegalLayout.astro", () => {
  it("keeps the consent banner, so the prompt never stands over the legal pages", () => {
    // The prompt's own "Privacy notice" and "Terms" links land here. A dialog
    // on this page would stand between the guest and the notice they came to
    // read before deciding.
    expect(source("layouts/LegalLayout.astro")).toContain(
      '<ConsentBanner client:idle prompt="banner" />',
    );
  });
});

describe.each([
  "designs/classic/Document.astro",
  "designs/gala/Document.astro",
  "components/gift-registry/GiftRegistryDocument.astro",
  "components/NotFoundDocument.astro",
])("%s", (path) => {
  it("asks in a dialog, leaving nothing over the page once answered", () => {
    expect(source(path)).toContain("<ConsentBanner client:idle />");
  });
});
