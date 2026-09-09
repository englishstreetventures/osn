import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The same hole that opened on the cire guest pages, closed where it is most
 * likely to reopen. A legal page that hardcodes a contact address drifts
 * silently, and the only symptom is a reader emailing an address nobody reads.
 */
const pages = ["PrivacyPage.tsx", "TermsPage.tsx"] as const;
const dir = join(import.meta.dirname, "..", "src", "pages");

/** Any literal address in the body. The real one arrives via LEGAL_ENTITY. */
const LITERAL_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

describe.each(pages)("%s", (page) => {
  const source = readFileSync(join(dir, page), "utf8");

  it("takes the operator's identity from the shared legal module", () => {
    expect(source).toContain("@shared/legal");
    expect(source).toContain("LEGAL_ENTITY.contactEmail");
  });

  it("hardcodes no email address", () => {
    expect(source.replaceAll("${LEGAL_ENTITY.contactEmail}", "")).not.toMatch(LITERAL_EMAIL);
  });

  it("publishes no repo path to the reader", () => {
    expect(source).not.toContain("shared/legal/src/index.ts");
  });
});

describe("PrivacyPage.tsx", () => {
  const source = readFileSync(join(dir, "PrivacyPage.tsx"), "utf8");

  /**
   * `oauth_consents` rows are kept, marked withdrawn, until the account is
   * deleted — the row IS the withdrawal record. The page said "deletes the
   * grant", which is the friendlier claim and the wrong one.
   */
  it("does not claim a withdrawn OIDC grant is deleted", () => {
    expect(source).not.toMatch(/deletes the grant/i);
  });
});
