import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The same hole that opened on the cire guest pages, closed where it is most
 * likely to reopen: a legal page that hardcodes a contact address instead of
 * taking it from the shared module drifts silently, and the only symptom is a
 * reader emailing an address nobody reads.
 */
const routes = ["privacy.tsx", "terms.tsx"] as const;
const dir = join(import.meta.dirname, "..", "..", "src", "routes");

/** Any literal address in the body. The real one arrives via LEGAL_ENTITY. */
const LITERAL_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

describe.each(routes)("%s", (route) => {
  const source = readFileSync(join(dir, route), "utf8");

  it("takes the operator's identity from the shared legal module", () => {
    expect(source).toContain("@shared/legal");
    expect(source).toContain("LEGAL_ENTITY.contactEmail");
  });

  it("hardcodes no email address", () => {
    // Strip the mailto template that renders LEGAL_ENTITY.contactEmail itself.
    expect(source.replaceAll("${LEGAL_ENTITY.contactEmail}", "")).not.toMatch(LITERAL_EMAIL);
  });

  it("publishes no repo path to the reader", () => {
    expect(source).not.toContain("shared/legal/src/index.ts");
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
});
