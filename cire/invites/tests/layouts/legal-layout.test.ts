import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What each document shell renders around the page: which form the
 * first-layer consent prompt takes, and the footer that carries the legal
 * links and the standing privacy-choices control. `ConsentBanner` asks in a
 * dialog the guest must answer unless the shell passes `prompt="banner"`, and
 * both choices live in `.astro` markup that no component test renders — so
 * they are read here as text.
 */
const source = (path: string) => readFileSync(join(import.meta.dirname, "../../src", path), "utf8");

describe("LegalPage.astro", () => {
  it("keeps the consent banner after the footer, so the prompt never stands over the legal pages", () => {
    // The prompt's own "Privacy notice" and "Terms" links land here. A dialog
    // on this page would stand between the guest and the notice they came to
    // read before deciding.
    expect(source("layouts/LegalPage.astro")).toContain(
      '<ConsentBanner slot="after" client:idle prompt="banner" />',
    );
  });

  it("ends on the guest footer", () => {
    expect(source("layouts/LegalPage.astro")).toContain('<GuestFooter slot="footer"');
  });
});

describe("GuestFooter.astro", () => {
  it("puts the privacy-choices control in the footer's legal row, styled as its peers", () => {
    // Consent must be as easy to withdraw as it was to give: the control has
    // to be on every page, and the shared footer styles it only by this class.
    const footer = source("components/GuestFooter.astro");
    const control = /<ConsentPreferencesLink slot="consent"[^>]*\/>/.exec(footer)?.[0];
    expect(control).toBeDefined();
    expect(control).toContain('class="consent-link"');
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

  it("ends on the guest footer", () => {
    expect(source(path)).toContain("<GuestFooter");
  });
});
