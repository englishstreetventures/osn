import { describe, expect, it } from "bun:test";

import {
  GUEST_EMAIL_CONSENT,
  isValidGuestEmail,
  MAX_GUEST_EMAIL_LENGTH,
  normaliseGuestEmail,
  ORGANISER_EMAIL_ATTESTATION,
  parseGuestEmail,
} from "../src/index";

// One test per way an address can be wrong. Each is an input the API must
// refuse at both doors (the guest's own entry and the organiser's sheet or
// editor), so a looser check would store an address no mail could reach, or
// a string that is not one address at all.
describe("isValidGuestEmail refuses", () => {
  it("an address with no @", () => {
    expect(isValidGuestEmail("ada.example.com")).toBe(false);
  });

  // Each part would pass on its own, so only the one-@ rule can refuse it.
  it("an address with two @", () => {
    expect(isValidGuestEmail("ada@home.example@example.com")).toBe(false);
  });

  it("an empty local part", () => {
    expect(isValidGuestEmail("@example.com")).toBe(false);
  });

  it("an empty domain", () => {
    expect(isValidGuestEmail("ada@")).toBe(false);
  });

  it("a domain without a dot", () => {
    expect(isValidGuestEmail("ada@localhost")).toBe(false);
  });

  it("whitespace inside the address", () => {
    expect(isValidGuestEmail("ada lovelace@example.com")).toBe(false);
    expect(isValidGuestEmail("ada@exam\tple.com")).toBe(false);
  });

  it("an address longer than 254 characters, and not one of exactly 254", () => {
    const of = (length: number) => {
      const domain = `${"d".repeat(length - "ada@".length - ".com".length)}.com`;
      return `ada@${domain}`;
    };
    expect(of(MAX_GUEST_EMAIL_LENGTH).length).toBe(254);
    expect(isValidGuestEmail(of(MAX_GUEST_EMAIL_LENGTH))).toBe(true);
    expect(isValidGuestEmail(of(MAX_GUEST_EMAIL_LENGTH + 1))).toBe(false);
  });

  it("a local part longer than 64 characters", () => {
    expect(isValidGuestEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
    expect(isValidGuestEmail(`${"a".repeat(64)}@example.com`)).toBe(true);
  });

  it("a control character", () => {
    expect(isValidGuestEmail("ada\u0000@example.com")).toBe(false);
    expect(isValidGuestEmail("ada@example.com\u007f")).toBe(false);
  });

  it("a list of addresses", () => {
    expect(isValidGuestEmail("ada@example.com,bo@example.com")).toBe(false);
    expect(isValidGuestEmail("ada@example.com;bo@example.com")).toBe(false);
  });

  it("a display-name form", () => {
    expect(isValidGuestEmail("Ada <ada@example.com>")).toBe(false);
    expect(isValidGuestEmail('"Ada" ada@example.com')).toBe(false);
  });

  it("a domain with an empty label", () => {
    expect(isValidGuestEmail("ada@example..com")).toBe(false);
    expect(isValidGuestEmail("ada@.example.com")).toBe(false);
    expect(isValidGuestEmail("ada@example.com.")).toBe(false);
  });
});

// The stored form is the one string the suppression hash and the import diff
// compare, so one mailbox must have exactly one. Anything outside printable
// ASCII could store the same mailbox as a second string, or show an organiser
// a different address from the one held. Each input goes through the stored
// form first, as every door sends it.
describe("parseGuestEmail refuses anything outside printable ASCII", () => {
  it("a zero-width space", () => {
    expect(parseGuestEmail("ada\u200b@example.com")).toBeNull();
  });

  it("a right-to-left override", () => {
    expect(parseGuestEmail("ada@\u202emoc.elpmaxe")).toBeNull();
  });

  it("a bidi isolate", () => {
    for (const isolate of ["\u2066", "\u2067", "\u2068", "\u2069"]) {
      expect(parseGuestEmail(`ada${isolate}@example.com`)).toBeNull();
    }
  });

  it("a soft hyphen", () => {
    expect(parseGuestEmail("ada@exam\u00adple.com")).toBeNull();
  });

  it("a C1 control character", () => {
    expect(parseGuestEmail("ada\u0080@example.com")).toBeNull();
    expect(parseGuestEmail("ada@example.com\u009f")).toBeNull();
  });

  // Trimming removes one at either end, so only an inner one reaches the rule.
  it("a no-break space inside the address", () => {
    expect(parseGuestEmail("ada\u00a0lovelace@example.com")).toBeNull();
  });

  it("an accented letter, composed or decomposed", () => {
    expect(parseGuestEmail("andr\u00e9@example.com")).toBeNull();
    expect(parseGuestEmail("andre\u0301@example.com")).toBeNull();
  });

  it("a domain in Unicode, while its xn-- form stays valid", () => {
    expect(parseGuestEmail("anna@m\u00fcller.de")).toBeNull();
    expect(parseGuestEmail("anna@xn--mller-kva.de")).toBe("anna@xn--mller-kva.de");
  });

  it("a local part outside ASCII", () => {
    expect(parseGuestEmail("\u5c71\u7530@example.com")).toBeNull();
  });

  it("a fullwidth at sign", () => {
    expect(parseGuestEmail("ada\uff20example.com")).toBeNull();
    expect(parseGuestEmail("ada\uff20home@example.com")).toBeNull();
  });
});

describe("normaliseGuestEmail", () => {
  // The stored form is what the diff compares and what the suppression hash
  // is taken over, so two spellings of one address must store one value.
  it("folds surrounding space and case to one stored value", () => {
    expect(normaliseGuestEmail("  Ada.Lovelace@Example.COM \n")).toBe("ada.lovelace@example.com");
  });
});

describe("parseGuestEmail", () => {
  it("answers the stored form for a valid address and null for anything else", () => {
    expect(parseGuestEmail(" Ada@Example.com ")).toBe("ada@example.com");
    expect(parseGuestEmail("not an address")).toBeNull();
    expect(parseGuestEmail("")).toBeNull();
  });
});

describe("the consent wordings", () => {
  /**
   * The wording and the version are pinned together on purpose. The API stamps
   * the version onto every stored address as the evidence of which words were
   * on screen when the guest consented or the organiser attested, so changing
   * the words without the version makes that evidence false. If this fails
   * because the wording changed, change the version in the same commit, then
   * update both strings here.
   */
  it("pins the guest's consent to its version", () => {
    expect(GUEST_EMAIL_CONSENT.version).toBe("guest-email-2026-10-21");
    expect(GUEST_EMAIL_CONSENT.text).toBe(
      "I’d like emails about this wedding from my hosts, sent through Cire to this address. I can remove it here at any time.",
    );
  });

  it("pins the organiser's attestation to its version", () => {
    expect(ORGANISER_EMAIL_ATTESTATION.version).toBe("organiser-email-2026-10-21");
    expect(ORGANISER_EMAIL_ATTESTATION.text).toBe(
      "I confirm each guest whose email address I’m adding or changing agreed to get emails about this wedding, and I’ll share Cire’s guest privacy notice with them.",
    );
  });

  // A stored version must say whose words it names on its own.
  it("never lets the two versions be confused", () => {
    expect(GUEST_EMAIL_CONSENT.version).not.toBe(ORGANISER_EMAIL_ATTESTATION.version);
    expect(GUEST_EMAIL_CONSENT.version.startsWith("guest-")).toBe(true);
    expect(ORGANISER_EMAIL_ATTESTATION.version.startsWith("organiser-")).toBe(true);
  });
});
