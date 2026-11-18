import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The marketing site's notice and terms, read as source. Each sends a reader
 * to its own mailbox, says what the site actually loads, and claims no
 * agreement the sign-up flow never asked for.
 */
const dir = join(import.meta.dirname, "..", "src", "pages");
const read = (page: string) => readFileSync(join(dir, page), "utf8").replace(/\s+/g, " ");
const privacy = read("privacy.astro");
const terms = read("terms.astro");

describe("Musubi site legal pages", () => {
  it("send privacy requests and terms questions to their own mailboxes", () => {
    expect(privacy).toContain("LEGAL_ENTITY.privacyEmail");
    expect(privacy).not.toContain("LEGAL_ENTITY.supportEmail");
    expect(terms).toContain("LEGAL_ENTITY.supportEmail");
    expect(terms).not.toContain("LEGAL_ENTITY.privacyEmail");
  });

  /** The faces are self-hosted (`tests/self-hosted-fonts.test.ts`), so the
   *  notice may not say Google receives a visitor's address. */
  it("does not say the site loads fonts from Google", () => {
    expect(privacy).not.toMatch(/Google Fonts|from Google/i);
  });

  it("names the courts of the governing state", () => {
    expect(terms).toMatch(/the courts of that state have non-exclusive jurisdiction/);
  });

  /** Sign-up is where the account terms are shown; this site's terms point at
   *  them and say nothing about when a reader agreed. */
  it("points at the account terms without claiming when they were accepted", () => {
    expect(terms).not.toMatch(/entered into when you sign up/);
    expect(terms).toContain("${APP_URL}/terms");
  });
});
