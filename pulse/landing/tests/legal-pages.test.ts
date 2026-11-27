import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LEGAL_ENTITY } from "@shared/legal";
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

  /** Each page names only details the operator's record holds. The record
   *  holds no postal address, so a contact line that still prints one fails
   *  here. */
  it("name only the operator details the shared record holds", () => {
    for (const page of [privacy, terms]) {
      const fields = [...page.matchAll(/LEGAL_ENTITY\.(\w+)/g)].map((m) => m[1]!);
      expect(fields).toContain("name");
      for (const field of fields) expect(LEGAL_ENTITY).toHaveProperty(field);
    }
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

  /** A link inside the text is in the body ink and underlined: never told
   *  apart by colour alone, and never in the ember, which is under 4.5:1. */
  it("draws a link inside the text in the body ink, underlined", () => {
    const layout = readFileSync(
      join(import.meta.dirname, "..", "src", "layouts", "LegalLayout.astro"),
      "utf8",
    );
    const rule =
      layout.match(/\.legal p:not\(\.legal-back\) a,\s*\.legal li a \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/color: var\(--color-text\)/);
    expect(rule).toMatch(/text-decoration: underline/);
  });

  it("names the courts of the governing state", () => {
    expect(terms).toMatch(/the courts of that state have non-exclusive jurisdiction/);
  });
});
