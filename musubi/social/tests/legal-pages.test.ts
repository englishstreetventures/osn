import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The same hole that opened on the cire guest pages, closed where it is most
 * likely to reopen. A legal page that hardcodes a contact address drifts
 * silently, and the only symptom is a reader emailing an address nobody reads.
 * Each page names its own mailbox: the privacy notice the privacy one, the
 * terms the support one.
 */
const pages = {
  "PrivacyPage.tsx": { names: "privacyEmail", not: "supportEmail" },
  "TermsPage.tsx": { names: "supportEmail", not: "privacyEmail" },
} as const;
const dir = join(import.meta.dirname, "..", "src", "pages");

/** Any literal address in the body. The real one arrives via LEGAL_ENTITY. */
const LITERAL_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

/** A page's source with every run of whitespace as one space. */
function flat(source: string): string {
  return source.replace(/\s+/g, " ");
}

/**
 * The page's text under the heading `heading` at `level`, up to the next
 * heading at that level or above, or the end.
 */
function section(source: string, heading: string, level: "h2" | "h3" = "h2"): string {
  const text = flat(source);
  const open = `<${level}>${heading}</${level}>`;
  const start = text.indexOf(open);
  expect(start).toBeGreaterThan(-1);
  const ends = [...new Set(["<h2>", `<${level}>`])]
    .map((tag) => text.indexOf(tag, start + open.length))
    .filter((at) => at !== -1);
  return text.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

/**
 * The operator's change-notice run emails every account's address, and its
 * check refuses a notice whose day has passed (`wiki/osn/change-notices.md`).
 * The app shows nothing of a change but the date at the top
 * (`LegalDocument.tsx` reads `updated` and nothing else). So each page says
 * its date changes and that a change that matters is emailed before it takes
 * effect, and promises no notice in the app.
 */
describe.each([
  ["PrivacyPage.tsx", "Changes", /If this changes, the date at the top changes with it\./],
  ["TermsPage.tsx", "Changes to these terms", /The date at the top changes when we do/],
] as const)("%s, on its own changes", (page, heading, date) => {
  const read = () => section(readFileSync(join(dir, page), "utf8"), heading);

  it("says the date at the top changes", () => {
    expect(read()).toMatch(date);
  });

  it("says a change that matters is emailed to the account's address before it takes effect", () => {
    const changes = read();
    expect(changes).toMatch(/a change matters/);
    expect(changes).toMatch(/email the address on your account/);
    expect(changes).toMatch(/before it takes effect/);
    expect(changes).toMatch(/what changes/);
  });

  it("promises no notice in the app", () => {
    expect(read()).not.toMatch(/flagged|in the app/i);
  });
});

describe.each(Object.entries(pages))("%s", (page, mailbox) => {
  const source = readFileSync(join(dir, page), "utf8");

  it("takes the operator's identity from the shared legal module", () => {
    expect(source).toContain("@shared/legal");
    expect(source).toContain(`LEGAL_ENTITY.${mailbox.names}`);
    expect(source).not.toContain(`LEGAL_ENTITY.${mailbox.not}`);
  });

  it("hardcodes no email address", () => {
    expect(source.replaceAll(`\${LEGAL_ENTITY.${mailbox.names}}`, "")).not.toMatch(LITERAL_EMAIL);
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
    const text = flat(source);
    expect(text).toMatch(/we keep it for 7 days in case you change your mind/);
    expect(text).toMatch(/usually within a day of the date we show you/);
    expect(text).toMatch(/no one can take your handles for 30 days/);
    expect(text).toMatch(/not the handle itself/);
    expect(text).toMatch(/erased once any payment or gift for it has settled/);
    expect(text).not.toMatch(/tombstone/i);
  });

  /**
   * The databases are Cloudflare D1, whose Time Travel restores a database to
   * any minute of the last 30 days on Workers Paid, the production account's
   * plan (`wiki/compliance/backup-dr.md`).
   */
  it("says how long deleted data stays in the restore copies", () => {
    expect(flat(source)).toMatch(
      /Deleted data can stay in our database provider&rsquo;s restore copies for up to 30 days\./,
    );
  });

  /**
   * osn-api keeps no IP hash on a session (`sessions` in
   * `osn/db/src/schema/index.ts` declares none, and nothing writes one), but
   * each security event keeps a keyed hash of the request's IP and a coarse
   * device label for its 12 months (`securityEvents.ipHash`, `uaLabel`;
   * `wiki/compliance/data-map.md`). The notice puts the hash where it is.
   */
  it("puts the IP hash on the security records, not the sessions", () => {
    expect(section(source, "Your sessions", "h3")).not.toMatch(/hash|IP address/i);
    const records = section(source, "Security records", "h3");
    expect(records).toMatch(/<em>hash<\/em> of the IP address/);
    expect(records).toMatch(/coarse label for the device/);
    expect(records).toMatch(/cannot be turned back into an address/);
    expect(section(source, "The legal bases")).toMatch(
      /The IP hash and device label on each security record/,
    );
  });

  /** Settings mounts no list of sessions or devices (`SettingsPage.tsx`). */
  it("rests nothing on a device list Settings does not show", () => {
    expect(source).not.toMatch(/device list/i);
  });

  /**
   * Sign-up checks a date of birth against 13 and never stores it
   * (`osn/api/src/services/auth/registration.ts`). The notice says so, and
   * promises no deletion of an under-age account, for which no procedure
   * exists.
   */
  it("states the minimum age and what the sign-up check does with a date of birth", () => {
    const text = flat(source);
    expect(text).toMatch(/13 or older/);
    expect(text).toMatch(/date of birth/);
    expect(text).toMatch(/do not store it/);
    expect(text).not.toMatch(/we (will )?delete (it|the account|their account)/i);
  });

  /**
   * With the browser Email Verification API on (production), osn-api asks
   * Cloudflare's public resolver about the sign-up address's domain and
   * fetches the provider's public keys (`wiki/osn/email-verification-api.md`).
   */
  it("names the email-verification lookup and what it sends", () => {
    const text = flat(source);
    expect(text).toMatch(/Cloudflare&rsquo;s public DNS resolver|Cloudflare's public DNS resolver/);
    expect(text).toMatch(/the part after the @/);
  });

  /**
   * The browser asks the email provider for the token itself, from the
   * person's own connection (`wiki/osn/email-verification-api.md`), so only
   * what osn-api sends may be described as withheld.
   */
  it("says the browser, not Musubi, asks the email provider", () => {
    const text = flat(source);
    expect(text).toMatch(/your browser asks your email provider/);
    expect(text).toMatch(/We send neither/);
    expect(text).not.toMatch(/Neither the resolver nor the provider is sent/);
  });
});

describe("TermsPage.tsx", () => {
  const source = readFileSync(join(dir, "TermsPage.tsx"), "utf8");

  it("says a deletion waits 7 days and can be undone until then", () => {
    const text = flat(source);
    expect(text).toMatch(/We delete it once 7 days have passed/);
    expect(text).toMatch(/until then you can keep it: sign in and choose Keep my account/);
  });

  it("states the cap, the minimum age and the courts", () => {
    const text = flat(source);
    expect(text).toMatch(/limited to AUD 100/);
    expect(text).toMatch(/13 or older/);
    expect(text).toMatch(/the courts of that state have non-exclusive jurisdiction/);
    expect(text).not.toMatch(/re-suppl/);
  });
});
