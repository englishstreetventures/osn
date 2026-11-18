import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The same hole that opened on the cire guest pages, closed where it is most
 * likely to reopen: a legal page that hardcodes a contact address instead of
 * taking it from the shared module drifts silently, and the only symptom is a
 * reader emailing an address nobody reads.
 */
const routes = {
  "privacy.tsx": { names: "privacyEmail", not: "supportEmail" },
  "terms.tsx": { names: "supportEmail", not: "privacyEmail" },
} as const;
const dir = join(import.meta.dirname, "..", "..", "src", "routes");

/** Any literal address in the body. The real one arrives via LEGAL_ENTITY. */
const LITERAL_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

/** The rendered JSX alone: the header comment is for maintainers. */
function body(source: string): string {
  return source.slice(source.indexOf("export default")).replace(/\s+/g, " ");
}

describe.each(Object.entries(routes))("%s", (route, mailbox) => {
  const source = readFileSync(join(dir, route), "utf8");

  it("takes the operator's identity from the shared legal module", () => {
    expect(source).toContain("@shared/legal");
    expect(source).toContain(`LEGAL_ENTITY.${mailbox.names}`);
    expect(source).not.toContain(`LEGAL_ENTITY.${mailbox.not}`);
  });

  it("hardcodes no email address", () => {
    // Strip the mailto template that renders the mailbox itself.
    expect(source.replaceAll(`\${LEGAL_ENTITY.${mailbox.names}}`, "")).not.toMatch(LITERAL_EMAIL);
  });

  it("publishes no repo path to the reader", () => {
    expect(source).not.toContain("shared/legal/src/index.ts");
  });

  /** The account a reader signs in with is a Musubi account. */
  it("does not call the reader's account an OSN account", () => {
    expect(body(source)).not.toMatch(/\bOSN\b/);
  });

  it("states the minimum age", () => {
    expect(body(source)).toMatch(/13 or older/);
  });
});

describe("terms.tsx", () => {
  const text = body(readFileSync(join(dir, "terms.tsx"), "utf8"));

  it("states the cap and the courts, and claims no acceptance at sign-up", () => {
    expect(text).toMatch(/limited to AUD 100/);
    expect(text).toMatch(/the courts of that state have non-exclusive jurisdiction/);
    expect(text).not.toMatch(/re-suppl/);
    expect(text).not.toMatch(/accepted when you created/);
  });
});

describe("privacy.tsx", () => {
  const source = readFileSync(join(dir, "privacy.tsx"), "utf8");

  /**
   * Both fire from the browser, so both are disclosures the reader is owed.
   * The notice claimed the map was the only third-party content; Photon had
   * been sending keystrokes to Komoot the whole time.
   */
  it("names the third parties the browser contacts directly", () => {
    expect(source).toContain("OpenStreetMap");
    expect(source).toContain("Komoot");
  });

  /**
   * `wiki/compliance/data-map.md` asks for an explicit consent banner on RSVPs
   * to sensitive-category events. It does not exist yet, and the notice must not
   * claim it does. Delete this test when the ask ships — and change the copy.
   */
  it("does not claim a consent ask that pulse has not built", () => {
    expect(source).not.toMatch(/ask before recording it/i);
  });

  /**
   * An OSN account deletion reaches Pulse at the end of its 7 days
   * (`pulse/api/src/services/accountErasure.ts`, `purgeAccount`): the person's
   * RSVPs, close friends, messages and Pulse profile go; each upcoming event
   * they host is cancelled and kept 14 days for its guests, or deleted then if
   * they answered delete; past events they hosted go.
   */
  it("says what deleting the Musubi account does to Pulse data", () => {
    const text = source.replace(/\s+/g, " ");
    expect(text).toMatch(/If you delete your Musubi account/);
    expect(text).toMatch(/when the account goes, 7 days after you ask/);
    expect(text).toMatch(/your RSVPs, close friends, the messages you sent and your Pulse profile/);
    expect(text).toMatch(
      /cancelled and kept 14 days for its guests, or, if you chose that when you asked, deleted then/,
    );
  });
});
