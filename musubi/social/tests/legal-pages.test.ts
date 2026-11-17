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

  /**
   * An account is deleted once its 7 days have passed
   * (`ACCOUNT_DELETION_GRACE_SECONDS`, `osn/api/src/services/account-erasure.ts`),
   * by a cron that runs every 6 hours and waits for every app to finish, so it
   * lands hours after the date shown: the notice says "usually within a day",
   * never a tighter time. What outlives it is a keyed hash of each handle for
   * 30 days (`lib/handle-hold.ts`), not the account.
   */
  it("says when a deleted account goes and what holds its handles", () => {
    const text = source.replace(/\s+/g, " ");
    expect(text).toMatch(/we keep it for 7 days in case you change your mind/);
    expect(text).toMatch(/usually within a day of the date we show you/);
    expect(text).toMatch(/no one can take your handles for 30 days/);
    expect(text).toMatch(/not the handle itself/);
    expect(text).not.toMatch(/tombstone/i);
  });

  /** Settings mounts no list of sessions or devices (`SettingsPage.tsx`). */
  it("rests nothing on a device list Settings does not show", () => {
    expect(source).not.toMatch(/device list/i);
  });
});

describe("TermsPage.tsx", () => {
  const source = readFileSync(join(dir, "TermsPage.tsx"), "utf8");

  it("says a deletion waits 7 days and can be undone until then", () => {
    const text = source.replace(/\s+/g, " ");
    expect(text).toMatch(/We delete it once 7 days have passed/);
    expect(text).toMatch(/you can keep it by signing in/);
  });
});
