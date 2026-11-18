import guestNotice from "@cire/ui/guest-privacy-notice.astro?raw";
import { IDENTITY_FIELD_NAMES, LEGAL_ENTITY, isPlaceholder } from "@shared/legal";
import { describe, expect, it } from "vitest";

import footer from "../src/components/MarketingFooter.astro?raw";
import guestsPage from "../src/pages/privacy/guests.astro?raw";
import hosts from "../src/pages/privacy/hosts.astro?raw";
import privacy from "../src/pages/privacy/index.astro?raw";
import vendors from "../src/pages/privacy/vendors.astro?raw";
import refunds from "../src/pages/refunds.astro?raw";
import terms from "../src/pages/terms.astro?raw";

/**
 * `/privacy/guests` renders the guest notice from `@cire/ui`, so the fields it
 * publishes are the page's and the notice's together.
 */
const guests = `${guestsPage}\n${guestNotice}`;

/** Every page whose draft banner must cover what it publishes. */
const legalPages = {
  terms,
  privacy,
  "privacy/hosts": hosts,
  "privacy/guests": guests,
  "privacy/vendors": vendors,
  refunds,
};

/** The pages the site footer links to; the three notices are reached from `/privacy`. */
const footerPages = ["terms", "privacy", "refunds"] as const;

/** The fields `draftPending` already checks on every page's behalf. */
const IDENTITY = IDENTITY_FIELD_NAMES;

/** The `LEGAL_ENTITY.x` fields named inside the page's `draftPending(...)` gate. */
function gateFields(source: string): string[] {
  const call = source.match(/draftPending\(([\s\S]*?)\)/);
  return call ? [...call[1].matchAll(/LEGAL_ENTITY\.(\w+)/g)].map((m) => m[1]) : [];
}

/** The fields the page actually publishes, ignoring the gate that guards them. */
function renderedFields(source: string): string[] {
  const body = source.replace(/draftPending\(([\s\S]*?)\)/, "");
  return [...new Set([...body.matchAll(/LEGAL_ENTITY\.(\w+)/g)].map((m) => m[1]))];
}

describe("legal pages", () => {
  for (const [name, source] of Object.entries(legalPages)) {
    /**
     * Every `LEGAL_ENTITY` field a page renders is covered by its banner: the
     * identity fields by `draftPending` itself, any other by the page's own
     * `draftPending(...)` call. A field rendered and not covered could publish
     * a live `{{TOKEN}}` with no banner over it.
     */
    it(`${name} gates its banner on every field it publishes`, () => {
      const covered = new Set<string>([...IDENTITY, ...gateFields(source)]);
      expect(renderedFields(source).filter((f) => !covered.has(f))).toEqual([]);
    });

    it(`${name} is still flagged a draft while any field it publishes is unfilled`, () => {
      const unfilled = renderedFields(source).filter((f) =>
        isPlaceholder(LEGAL_ENTITY[f as keyof typeof LEGAL_ENTITY]),
      );
      if (unfilled.length === 0) return;
      expect(source).toContain("{draft && (");
      expect(source).toContain("draft-banner");
    });
  }

  /**
   * The guest-data sweep leaves the couple an unnamed record of their gifts
   * (`GiftSummary` in `cire/api/src/services/retention.ts`) that outlives the
   * year, so the couples' notice says what it holds and how long it stays.
   */
  // The hosts' attestation is evidence the couple rely on: the notice names
  // what is recorded, the duty to pass on the guest notice, that a guest's
  // removal or replacement of a host's address stops mail to it, and that a
  // host cannot change a guest's own address.
  it("the hosts' notice names the guest-email attestation and its limits", () => {
    const text = hosts.replace(/\s+/g, " ");
    expect(text).toMatch(/you confirm that the guest agreed to get emails about the wedding/);
    expect(text).toMatch(
      /you also agree to pass our <a href="\/privacy\/guests\/">guest privacy notice<\/a> on to them/,
    );
    expect(text).toMatch(
      /once they remove or replace it, we do not email it about the wedding again, even if it is added back/,
    );
    expect(text).toMatch(/You cannot change an address a guest added themselves, only remove it/);
    expect(text).toMatch(
      /our legitimate interest, and the couple&rsquo;s, in being able to show the consent/,
    );
  });

  /**
   * The guest-data sweep (`cire/api/src/services/retention.ts`) deletes a year
   * after the final event, or, for a wedding with an event it cannot date,
   * three calendar years after the wedding was created, whatever its other
   * events' dates; either way it can hold a wedding back up to 30 days for the
   * gift record. Every page that states the window states all of it, the
   * hold-back after both rules.
   */
  it("the hosts' notice and the overview state both retention bounds and the hold-back", () => {
    const flat = (page: string) => page.replace(/\s+/g, " ");
    for (const page of [hosts, privacy].map(flat)) {
      expect(page).toMatch(/one year after the wedding&rsquo;s final event/);
      expect(page).toMatch(
        /three years after the wedding was created instead, whatever the other events&rsquo; dates/,
      );
      expect(page).not.toMatch(/whichever is later/);
      // The hold-back comes after both rules, so it reads as applying to each.
      expect(page.indexOf("up to 30 days later")).toBeGreaterThan(
        page.indexOf("whatever the other events"),
      );
    }
  });

  it("the hosts' notice names the gift record the couple keep after the guest data goes", () => {
    expect(hosts).toMatch(/the couple keep a record of their gifts with no guest names in it/);
    expect(hosts).toMatch(/the amount, currency and day of each money gift/);
    expect(hosts).toMatch(/up to 30 days later/);
  });

  /**
   * `GET …/hosts` hands every member of a wedding each seat's musubi name,
   * handle and photo, and the checklist shows who holds each task, so the
   * hosts' notice names that disclosure and who receives it.
   */
  it("the hosts' notice says the wedding team sees each organiser's photo and the tasks they hold", () => {
    expect(hosts).toMatch(/everyone on a wedding/);
    expect(hosts).toMatch(/musubi name, handle and profile photo/);
    expect(hosts).toMatch(/which checklist tasks each of you holds/);
  });

  /** Seating charts are wedding content the couple create, and a table
   *  assignment is guest information they record; the couples' notice says
   *  both. */
  it("the hosts' notice names seating charts and table assignments", () => {
    expect(hosts).toMatch(/checklists,\s+budgets and seating charts you create/);
    expect(hosts).toMatch(/which table each guest sits at/);
  });

  /**
   * Where the data is, as `cire/infra/src/declaration.ts` places it: `cire-db`
   * has its primary in Oceania (`locationHint: "oc"`) and read replicas
   * wherever Cloudflare puts them (`readReplication: "auto"`), and it holds the
   * organiser sessions too, so no notice may place sign-in state in Oceania
   * alone. The R2 buckets, which hold what organisers upload, are in Eastern
   * North America (`locationHint: "enam"`); the vendor portal stores nothing
   * there, so the vendors' notice names no file storage.
   */
  it("each organiser-facing page says where Cloudflare holds the data", () => {
    for (const page of [privacy, hosts, vendors].map(flat)) {
      expect(page).toMatch(/primary region is (<strong>)?Oceania/);
      expect(page).toMatch(/read-only copies/);
      expect(page).toMatch(/which (it|Cloudflare) chooses and can change/);
      expect(page).not.toMatch(/sign-in state in Oceania/);
    }
    for (const page of [privacy, hosts].map(flat)) {
      expect(page).toMatch(/in Eastern North America/);
    }
    expect(flat(vendors)).not.toMatch(/Eastern North America/);
    for (const page of [hosts, vendors].map(flat)) {
      expect(page).toMatch(/hold your sign-in sessions too/);
      expect(page).toMatch(/transferred out of that area to Oceania and elsewhere/);
    }
    expect(flat(hosts)).toMatch(/live updates/);
  });

  /**
   * Resized copies of invite, event and gift images (and the original upload
   * when a resize fails) sit in Cloudflare's cache for up to a year; link
   * thumbnails for 30 days. Nothing deletes a copy on removal, so the notices
   * say removal deletes the stored file and a cached copy can outlive it.
   */
  it("the privacy pages say cached image copies can outlive removal", () => {
    expect(flat(privacy)).toMatch(
      /copies of images are cached where they are viewed, for up to a year/,
    );
    expect(flat(hosts)).toMatch(/Removing a file deletes the stored file/);
    expect(flat(hosts)).toMatch(/up to a year after they were stored/);
    expect(flat(hosts)).toMatch(/link thumbnails for up to 30 days/);
    expect(flat(hosts)).not.toMatch(/removed when you ask us to\./);
  });

  /**
   * An OSN account deletion reaches cire at the end of its 7 days
   * (`cire/api/src/services/account-erasure.ts`): the person's seats go and
   * their profile ids are cleared; a wedding with another owner stays; one
   * they alone own is an open action Musubi's flow will not pass until they
   * add an owner or answer delete, and one left with no owner is deleted. The
   * purge that erases it waits on money still moving
   * (`maintenance-sweeps.ts`, `purgeHeld`), so the notice promises no time
   * and never says cire keeps nothing. Cire refuses the account during the 7
   * days, so the wedding download is offered before the person asks.
   */
  it("the hosts' notice says what deleting the Musubi account does to a wedding", () => {
    const text = hosts.replace(/\s+/g, " ");
    expect(text).toMatch(/or 7 days after you ask to delete your Musubi account/);
    expect(text).toMatch(/we remove your place on each wedding/);
    expect(text).toMatch(/A wedding with another owner stays with them/);
    expect(text).toMatch(
      /A wedding you are the only owner of when the deletion happens is deleted, with its guest information/,
    );
    expect(text).toMatch(
      /add another owner to each wedding you are the only owner of, or to agree to its deletion/,
    );
    expect(text).toMatch(/download a wedding you want to keep from its settings/i);
    expect(text).toMatch(/waits while a payment or gift for it is still being settled/);
    expect(text).not.toMatch(/keeps? nothing/);
  });

  /**
   * A host can remove their Cire data from the organiser portal's account
   * menu (`cire/host/src/components/ProfileMenu.tsx`, "Remove my Cire data")
   * and keep their Musubi account, so the notice names that way beside asking.
   */
  it("the hosts' notice names the portal's own way to remove Cire data", () => {
    const text = hosts.replace(/\s+/g, " ");
    expect(text).toMatch(
      /You can also remove your Cire data yourself, and keep your Musubi account, from Remove my Cire data in the organiser portal&rsquo;s account menu\./,
    );
  });

  it("footer links every legal page", () => {
    // The footer hands its links to `@cire/ui`'s footer as data, in either
    // quote: the formatter does not reach `.astro` files. Each by the address
    // it is served at, with its slash: the asset server redirects `/terms`.
    for (const name of footerPages) {
      expect(footer).toMatch(new RegExp(`href: ['"]/${name}/['"]`));
    }
  });

  /** Each page sends a reader to the right mailbox: privacy requests to one,
   *  refunds and terms questions to the other. */
  it("privacy pages name the privacy mailbox, terms and refunds the support one", () => {
    for (const page of [privacy, hosts, vendors, guestNotice]) {
      expect(page).toContain("LEGAL_ENTITY.privacyEmail");
      expect(page).not.toContain("LEGAL_ENTITY.supportEmail");
    }
    for (const page of [terms, refunds]) {
      expect(page).toContain("LEGAL_ENTITY.supportEmail");
      expect(page).not.toContain("LEGAL_ENTITY.privacyEmail");
    }
  });

  /** Cire sells its plans itself, on its own Stripe account
   *  (`cire/api/src/services/stripe.ts`, a platform Checkout Session). */
  it("no page says a separate merchant of record sells the plans", () => {
    for (const page of Object.values(legalPages)) {
      expect(flat(page)).not.toMatch(/merchant of record/i);
    }
    expect(flat(terms)).toMatch(/Stripe takes the payment/);
    expect(flat(hosts)).toMatch(/<strong>Stripe<\/strong>/);
  });

  /** Cire sells two plan tiers, Gold and Crimson, and has no AI feature; the
   *  free plan holds no budget or checklist (`cire/api/src/services/tiers.ts`). */
  it("pages describe plans, not add-ons, and the free plan as it is", () => {
    for (const page of [terms, refunds, privacy, hosts, vendors]) {
      expect(flat(page)).not.toMatch(/add-on|AI features/i);
    }
    const free = flat(terms).match(/<li>The free plan[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(free).not.toBe("");
    expect(free).not.toMatch(/budget|checklist/i);
    expect(flat(terms)).toMatch(/Gold and Crimson/);
  });

  /** Every Cire site serves its own fonts, so no notice may say Google sees a
   *  reader's address when a page loads. */
  it("no notice says pages load fonts from Google", () => {
    for (const page of [hosts, vendors, privacy]) {
      expect(page).not.toMatch(/Google Fonts|fonts from Google/i);
    }
  });

  it("the terms state the cap, the refund carve-out, the age and the courts", () => {
    const text = flat(terms);
    expect(text).toMatch(/limited to AUD 100/);
    expect(text).toMatch(
      /does not reduce a refund under our <a href="\/refunds\/">Refund Policy<\/a>/,
    );
    expect(text).toMatch(/18 or older/);
    expect(text).toMatch(/the courts of that state have non-exclusive jurisdiction/);
    expect(text).toMatch(/Prices include GST/);
    expect(text).toMatch(/vendor\.cireweddings\.com/);
    expect(text).not.toMatch(/re-suppl/);
  });

  /** The sale and refund records carry no name but can be matched to the
   *  payment (`wiki/compliance/retention.md`, `platform_sales` and
   *  `platform_refunds`), so the notice must not call them anonymous. */
  it("the hosts' notice says what purchase records are kept, and for how long", () => {
    const text = flat(hosts);
    expect(text).not.toMatch(/anonymous/i);
    expect(text).toMatch(/seven years/);
    expect(text).toMatch(/no set end date/);
    expect(text).toMatch(/can be matched to the payment/);
    expect(text).toMatch(/Stripe collects your identity and business details directly/);
    expect(text).toMatch(/which owner connected it/);
    expect(text).toMatch(/18 or older/);
  });

  /** Every mailbox a page names is a `mailto:` link, the same way on every
   *  page. */
  it("names each mailbox as a link", () => {
    for (const page of [terms, refunds, privacy, hosts, vendors]) {
      const plain = flat(page).match(
        /(?<!mailto:\$\{LEGAL_ENTITY\.\w+\}`\}> ?)<span class=\{ph\(LEGAL_ENTITY\.(privacy|support)Email\)\}>/g,
      );
      expect(plain).toBeNull();
    }
  });

  it("the vendors' notice states the age to run a listing", () => {
    expect(flat(vendors)).toMatch(/18 or older/);
  });
});

/** A page's source with every run of whitespace as one space. */
function flat(page: string): string {
  return page.replace(/\s+/g, " ");
}
