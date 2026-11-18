import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The marketing site's notice and terms, read as source. Each sends a reader
 * to its own mailbox, calls the reader's account a Musubi account, and claims
 * no agreement the sign-up flow never asked for.
 */
const dir = join(import.meta.dirname, "..", "src", "pages");
const read = (page: string) => readFileSync(join(dir, page), "utf8").replace(/\s+/g, " ");
const privacy = read("privacy.astro");
const terms = read("terms.astro");

describe("Pulse site legal pages", () => {
  it("send privacy requests and terms questions to their own mailboxes", () => {
    expect(privacy).toContain("LEGAL_ENTITY.privacyEmail");
    expect(privacy).not.toContain("LEGAL_ENTITY.supportEmail");
    expect(terms).toContain("LEGAL_ENTITY.supportEmail");
    expect(terms).not.toContain("LEGAL_ENTITY.privacyEmail");
  });

  it("call the reader's account a Musubi account", () => {
    for (const page of [privacy, terms]) {
      expect(page).not.toMatch(/OSN privacy notice|OSN terms/);
      expect(page).toMatch(/Musubi/);
    }
  });

  it("claim no agreement at sign-in", () => {
    expect(terms).not.toMatch(/you accept when you sign in/);
  });

  it("names the courts of the governing state", () => {
    expect(terms).toMatch(/the courts of that state have non-exclusive jurisdiction/);
  });
});
