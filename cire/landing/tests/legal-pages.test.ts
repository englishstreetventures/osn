import guestNotice from "@cire/ui/guest-privacy-notice.astro?raw";
import { LEGAL_ENTITY, isPlaceholder } from "@shared/legal";
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
const IDENTITY = ["name", "postalAddress", "contactEmail"] as const;

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
     * The invariant the old version of this test only looked like it checked.
     * It asserted a page may ship `{{TOKEN}}` text while a banner is present —
     * but no page has held a token in its own source since the identity moved
     * into `@shared/legal`, so it passed on its empty half and went on passing
     * while all three pages published a live `{{MERCHANT_OF_RECORD}}` with the
     * banner already gone.
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
    const flat = (page: string) => page.replace(/\s+/g, " ");
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
    const flat = (page: string) => page.replace(/\s+/g, " ");
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
});
