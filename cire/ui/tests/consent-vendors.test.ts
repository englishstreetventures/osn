import { describe, expect, it } from "vitest";

import { CONSENT_CATEGORIES, isConsentCategory } from "../src/consent-categories";
import {
  CONSENT_VENDORS,
  gatedVendorsInCategory,
  vendorById,
  vendorsInCategory,
} from "../src/consent-vendors";

/**
 * The registry's own shape. Its join with the guest site's CSP, and with the
 * `<ConsentGate>` ids in that site's source, is checked in
 * `cire/invites/tests/lib/consent/vendors.test.ts`, beside the CSP it reads.
 */
describe("vendor registry shape", () => {
  it("gives every vendor a known category", () => {
    for (const vendor of CONSENT_VENDORS) {
      expect(isConsentCategory(vendor.category)).toBe(true);
    }
  });

  it("uses unique ids", () => {
    const ids = CONSENT_VENDORS.map((vendor) => vendor.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // What decides whether withdrawing consent reloads the page. The Pinterest
  // widget's `pinit_main.js` runs in the invite page itself; the map runs only
  // inside its own iframe, which unmounting destroys.
  it("records which gated vendors run code in the page itself", () => {
    const runsInPage = Object.fromEntries(
      CONSENT_VENDORS.filter((vendor) => vendor.enforcement === "gated").map((vendor) => [
        vendor.id,
        vendor.runsInPage,
      ]),
    );
    expect(runsInPage).toEqual({ "google-maps": false, pinterest: true });
  });

  it("never marks a `necessary` vendor as gated", () => {
    // A strictly-necessary vendor by definition loads without consent; claiming
    // the toggle governs it would be false, and the toggle can't be switched off
    // anyway.
    for (const vendor of vendorsInCategory("necessary")) {
      expect(vendor.enforcement).toBe("always");
    }
  });

  it("gives every third party a privacy policy link and a named transfer destination", () => {
    // The privacy notice is generated from these fields, so a missing one is a
    // gap in the published disclosure rather than a cosmetic omission.
    for (const vendor of CONSENT_VENDORS.filter((v) => v.origins.length > 0)) {
      expect(vendor.privacyUrl, `${vendor.name} has no privacy URL`).toBeTruthy();
      expect(vendor.transfer, `${vendor.name} has no transfer destination`).toBeTruthy();
    }
  });

  it("only ever puts an https URL in the privacy-policy link", () => {
    // `privacyUrl` is rendered straight into an <a href> by both the
    // preferences dialog and the privacy notice. The values are hardcoded
    // today, but the registry is the documented "add a vendor here" extension
    // point — so a `javascript:` or `data:` URL pasted in later should fail the
    // test run rather than become a same-origin script-execution sink on click.
    for (const vendor of CONSENT_VENDORS) {
      if (vendor.privacyUrl === null) continue;
      expect(
        vendor.privacyUrl.startsWith("https://"),
        `${vendor.name}: privacyUrl must be https, got ${vendor.privacyUrl}`,
      ).toBe(true);
    }
  });

  it("declares no origins for first-party-only entries", () => {
    expect(vendorById("cire-session")!.origins).toEqual([]);
    expect(vendorById("consent-record")!.origins).toEqual([]);
  });
});

describe("category partitioning", () => {
  it("gives each consent switch exactly its own vendor", () => {
    // Two switches, one third party each, so a guest can allow the moodboard
    // without the map, or the map without the moodboard.
    expect(gatedVendorsInCategory("pinterest").map((vendor) => vendor.id)).toEqual(["pinterest"]);
    expect(gatedVendorsInCategory("maps").map((vendor) => vendor.id)).toEqual(["google-maps"]);
  });

  it("gates every vendor that is not strictly necessary", () => {
    for (const category of CONSENT_CATEGORIES) {
      if (category === "necessary") continue;
      expect(vendorsInCategory(category).every((vendor) => vendor.enforcement === "gated")).toBe(
        true,
      );
    }
  });

  it("defines no advertising, marketing, analytics or preferences category", () => {
    // Deliberate: the site does no personal tracking, and everything else it
    // stores is necessary. An unused switch is a claim we would have to keep
    // true.
    for (const absent of ["marketing", "analytics", "functional", "embeds"]) {
      expect(CONSENT_CATEGORIES as readonly string[]).not.toContain(absent);
    }
    expect(CONSENT_VENDORS.every((vendor) => (vendor.category as string) !== "marketing")).toBe(
      true,
    );
  });
});
