import { describe, expect, it } from "vitest";

import source from "../src/guest-privacy-notice.astro?raw";

/*
 * The guest privacy notice, as both sites publish it: the guest site at
 * `/privacy` and cireweddings.com at `/privacy/guests`. These pin the statements
 * the notice makes about what the code does, so a change to either side fails
 * here rather than in a guest's reading of it.
 */

/**
 * The rendered template alone. The frontmatter is imports and comments no
 * guest sees, and asserting against it would fail on an explanation rather
 * than on the notice.
 */
function template(text: string): string {
  const end = text.indexOf("---", 3);
  return end === -1 ? text : text.slice(end + 3);
}

const body = template(source);

/** `text` as a pattern that matches it across the template's line breaks. */
function phrase(text: string): RegExp {
  return new RegExp(
    text
      .split(" ")
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );
}

/**
 * A bare `mailto:` or an address written into the prose. The operator's own
 * contact arrives through `LEGAL_ENTITY.contactEmail`, so any literal address
 * in the notice is a hardcoded one, and served to the guests of every wedding.
 */
const LITERAL_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

describe("guest privacy notice", () => {
  it("hardcodes no email address", () => {
    expect(body).not.toMatch(LITERAL_EMAIL);
  });

  it("takes the operator's identity from the shared legal module", () => {
    expect(source).toContain("@shared/legal");
    expect(source).toContain("LEGAL_ENTITY.contactEmail");
  });

  /**
   * The personal/family/household exemption (Privacy Act 1988 s 16, GDPR
   * Art. 2(2)(c)) covers a couple running their own wedding. It has never
   * covered the platform underneath them.
   */
  it("claims no personal/household exemption from the Privacy Act", () => {
    expect(body).not.toMatch(/outside the strict reach/i);
    expect(body).not.toMatch(/not as a business/i);
  });

  it("states a lawful basis for the protected dietary field", () => {
    expect(body).toMatch(/explicit consent/i);
    expect(body).toContain("Art. 9(2)(a)");
    expect(body).toContain("APP 3.3");
  });

  /**
   * `cire/api/src/services/retention.ts` names this notice as the thing that
   * must move whenever `RETENTION_AFTER_FINAL_EVENT_MS` does.
   */
  it("states the retention window the sweep actually enforces", () => {
    expect(body).toContain("1 year after the final wedding event");
    // The sweep can hold a wedding back up to 30 days past that, on purpose
    // as well as on failure (`GIFT_SUMMARY_HOLD_BACK_MS`), and says so.
    expect(body).toMatch(/up to 30 days later/);
  });

  /**
   * The sweep leaves the couple a record of their gifts: no names, but the
   * amount, currency and day of each money gift (`GiftSummary` in
   * `cire/api/src/services/retention.ts`). It outlives the year, so the notice
   * names it, and names gifts among what is collected.
   */
  it("names the gift record the hosts keep after the year, and gifts as collected", () => {
    expect(body).toContain("Gifts, if you give one through the registry");
    expect(body).toMatch(/your hosts keep a record of their gifts with no names in it/);
    expect(body).toMatch(/the amount, currency and day of\s+each money gift/);
  });

  it("says Stripe takes a money gift on the hosts' account and sees the card, not cire", () => {
    expect(body).toMatch(
      /the payment is taken by <strong>Stripe<\/strong>\s+on your hosts’ own Stripe account/,
    );
    expect(body).toMatch(/Stripe collects your card details and the name and\s+email you give it/);
    expect(body).toMatch(/we never see your card/);
  });

  /**
   * `RSVP_CHANGE_RETENTION_MS` in `cire/api/src/services/rsvp-changes.ts` is
   * 90 days; the record of when a household's replies changed is guest data,
   * so the notice names it and its window.
   */
  it("names the RSVP change record and its 90-day window", () => {
    expect(body).toContain("When your household’s replies changed");
    expect(body).toMatch(/kept for\s+<strong>90 days<\/strong>/);
  });

  /**
   * cire-api records which household member sent each reply and change
   * (`rsvps.submitted_by_guest_id`, `rsvp_changes.actor_guest_id`) and shows
   * it to the household and its hosts, so the notice names it.
   */
  it("names the record of which member sent each reply, and who sees it", () => {
    expect(body).toContain("Which of you sent each reply");
    expect(body).toMatch(/Answered by[\s\S]{0,80}your hosts see it too/);
  });

  /**
   * The page must name a region and tell an EEA or UK reader that their data
   * leaves that area — those two are the disclosure; the exact city is not.
   */
  it("names the region and flags the transfer out of the EEA/UK", () => {
    expect(body).toMatch(/primary region is <strong>Australia<\/strong>/);
    expect(body).toMatch(/transferred outside/i);
  });

  /**
   * A plus-one's details come from the guest who brings them, and the plus-one
   * never sees the invite — the household is asked to pass this notice on.
   * GDPR Art. 14 then needs the notice itself to tell them where their details
   * came from, on what basis they are held, and how to have them withdrawn,
   * corrected or erased without an invitation code of their own.
   */
  it("tells a person a guest brings where their details came from and what they can do", () => {
    expect(body).toContain("If a guest is bringing you");
    expect(body).toMatch(/the guest who is\s+bringing you gave us your name/);
    // The basis for their dietary requirements, and whose word it rests on.
    expect(body).toMatch(/confirmation of the guest who is\s+bringing you that you agreed/);
    // Their rights, without a code of their own.
    expect(body).toMatch(/do not need a code to\s+use them/);
    expect(body).toMatch(/remove you until RSVPs close/);
    expect(body).not.toContain(
      "You only ever fill in details for the members of your own household.",
    );
  });

  /**
   * An organiser can record a plus-one's reply in the organiser portal, and
   * their dietary requirements under the organiser's own attestation
   * (`consent_source = 'organiser_attested'`). The section must name that
   * source too, and whose confirmation is then stored.
   */
  it("tells a person a guest brings that a host may record their reply, and on whose confirmation", () => {
    expect(body).toMatch(
      phrase("One of your hosts may also record your RSVP and dietary requirements on your behalf"),
    );
    expect(body).toMatch(
      phrase("when they record your dietary requirements, what is stored is their confirmation"),
    );
  });

  /**
   * Each sentence about the email address states something the code does:
   * only the chosen member's own address reaches the invitation; a removal
   * stops mail to the guest even if the address is added back, and removing
   * or replacing an address the hosts added stops it for every seat; the
   * removed address is kept only as a hash and goes with the year's sweep; the
   * hash of an address the guest added binds that guest alone, and the hosts
   * are warned when they add it back for them.
   */
  it("names the email address, its basis, who sees it, and how to withdraw it", () => {
    expect(body).toMatch(phrase("Your email address, if you or your hosts add one"));
    expect(body).toMatch(phrase("The basis is your consent"));
    expect(body).toMatch(
      phrase("never shows one member’s address to someone who says they are another"),
    );
    expect(body).toMatch(
      phrase("Remove the address on your invitation to withdraw it at any time, and we delete it"),
    );
    expect(body).toMatch(
      phrase(
        "After that we will not email it to you about this wedding, even if it is added again, unless you add it back yourself",
      ),
    );
    expect(body).toMatch(
      phrase("if your hosts added it, we will not email it to anyone else at the wedding either"),
    );
    expect(body).toMatch(
      phrase(
        "When you remove your email address, or replace one your hosts added, it comes off your guest record at once",
      ),
    );
    expect(body).toMatch(
      phrase("We keep a fingerprint of the removed address, not the address itself"),
    );
    expect(body).toMatch(
      phrase(
        "For an address you added yourself, the fingerprint applies to you alone: your hosts are told if they add it back for you",
      ),
    );
    expect(body).toMatch(phrase("names, RSVPs, dietary needs, email addresses — is deleted"));
    expect(body).toMatch(phrase("or to your email address being used"));
  });

  /**
   * The notice is read on cireweddings.com as well as on the invitation, so
   * "the site" has to say which site it means before it is used.
   */
  it("says which site it means by the site", () => {
    expect(body).toMatch(
      /Each wedding invitation sent with Cire is a private website\s+\(“the site”/,
    );
    expect(body).not.toMatch(/through this site/);
  });

  /**
   * Hosts on Gold can seat guests at tables, which shows who sits beside whom
   * to the hosts and, on paper, to the venue. The notice names it among what is
   * held, and who sees it.
   */
  it("names where a guest sits among what is held, and that other guests never see it", () => {
    expect(body).toMatch(phrase("Where you sit, if your hosts plan seating"));
    expect(body).toMatch(phrase("may print it or send it to the venue; other guests never do."));
  });

  it("publishes no notes addressed to the site owner", () => {
    expect(body).not.toContain("Note for the site owner");
    expect(body).not.toContain("owner-note");
  });
});
