/**
 * Cire's corners, measured and pictured: action buttons are pills, text fields
 * take a 14px corner, and cards a 16px one, in the organiser portal and on the
 * guest site in both invitation designs.
 *
 * The organiser signs in and opens the sample wedding: its overview, its guest
 * list, its guest editor and its RSVP table. Then, in a second tab, the organiser opens Ada's
 * invitation at a link carrying her household's code, which claims on load,
 * and opens the RSVP sheet for the Reception, choosing Attending and ticking
 * "Other" so the sheet shows its text field. Nothing is saved. The organiser
 * then switches the wedding to the Gala design, and the guest tab reloads:
 * the claim's cookie restores the session, so the second design costs no
 * second claim. Last, the organiser switches the wedding back to Classic,
 * leaving it as seeded. That switch runs when a Gala step fails too, but its
 * own failure there is dropped so the Gala step's error is the one reported:
 * if both fail, a later flow finds the sample wedding on Gala.
 *
 * Each view is shot at a phone width and a desktop width, light and dark, into
 * `screenshots/cire-soft-shapes/`. The portal follows the colour scheme (with
 * no stored choice, `lib/theme.ts` puts the system's on `data-theme`); the
 * guest site has no dark theme, so its dark shots show the same page as its
 * light ones.
 *
 * Every corner is read from computed style: a pill is a radius of at least
 * half the control's height, and more than 16px, so a 16px card corner on a
 * 32px button does not pass for one. A field is one of two shapes
 * (`cire/host/DESIGN.md` §4, "One form-field height"): a filter in the view
 * bar — a search box, the RSVP sort select — is 28px with the 14px field
 * corner, half its height, so its ends are round; a form field — the guest
 * editor's — is 34px with the same corner, short of a pill, and a boxed button
 * beside one, Delete household and Add guest, is 34px too. The bar's action,
 * Add household, is the filters' 28px. The guest site is not a portal: its
 * fields are the ink fill at the touch size, whose heights the forms checks
 * read; here only their 14px corner is.
 *
 * Before the guest site, a third tab opens the marketing site with no claim and
 * no sign-in. At a phone and a desktop width it reads the hero's two calls to
 * action, "Create your invitation" and "See a live invite", as pills with
 * their labels as written. At a phone's width it opens the demo's Respond
 * sheet, answers Attending and Other, and reads that the sheet's width holds
 * its contents and that its "Anything else" field takes the 14px corner. Both
 * views are shot, the top of the page and the open sheet.
 *
 * Along the way it runs the forms checks (`../support/cire-forms.ts`): the
 * budget's per-head radios and boxes, the import picker, the claim panel's
 * code field, the RSVP sheet's ink field and consent box, and the demo's
 * field, shot into `screenshots/cire-forms/`. And the buttons checks
 * (`../support/cire-buttons.ts`): the
 * RSVP table's reply key, the consent prompt's link, the guest sheet's close ×
 * and answer pair in both designs, and the demo's answer pair, shot into
 * `screenshots/cire-buttons/`. And the surfaces checks (`../support/cire-surfaces.ts`):
 * the cards, small-caps labels and disclosures every cire app takes from
 * `@cire/ui`, read from computed style and shot into `screenshots/cire-surfaces/`
 * — on the overview, the settings, the import panel, a fresh Gold wedding's
 * overview and budget, the Gold seating wedding's chart, the invite builder,
 * the marketing site's FAQ and demo, and the guest FAQ in both designs. The
 * guest FAQ needs entries the stack's seed does not have, so the organiser adds
 * two through the API before the guest tab opens and removes them at the end.
 *
 * The claim goes out from `ORGANISER_ADDRESS`, so it spends the organiser's
 * window of cire-api's claim limit, not the guests' (`flows.test.ts`).
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { CIRE_GUEST, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { consentLink, demoPair, guestSheet, replyKey } from "../support/cire-buttons";
import { builderFeedback, landingFeedback } from "../support/cire-feedback";
import { claimForms, demoForms, hostForms, sheetForms } from "../support/cire-forms";
import {
  addGuestFaq,
  builderSurfaces,
  guestFaqSurfaces,
  hostSurfaces,
  landingSurfaces,
  loginSurfaces,
  overviewSurfaces,
  removeGuestFaq,
} from "../support/cire-surfaces";
import {
  claimFromOrganiserAddress,
  expect,
  guestSitePaths,
  signInToCireHost,
  test,
  type Flow,
} from "../support/fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-soft-shapes");
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
const SCHEMES = ["light", "dark"] as const;

const { weddingId, slug, code, guestName } = CIRE_GUEST;
const HOST = `${ORIGINS.cireHost}/#/w/${weddingId}`;
const INVITE = `${ORIGINS.cireInvites}/cire/invite?slug=${slug}`;
const CLAIM_URL = `${ORIGINS.cireApi}/api/claim`;
const DESIGN_URL = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/invite/design`;
/** The seeded Reception (`cire/db/seed/data/events.ts`), which no other flow answers for Ada. */
const EVENT = "Reception";

type Scheme = (typeof SCHEMES)[number];

/** A control's top-left corner, its height and its label's case, from computed style and layout. */
function corner(target: Locator): Promise<{ radius: string; height: number; transform: string }> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      radius: style.borderTopLeftRadius,
      height: el.getBoundingClientRect().height,
      transform: style.textTransform,
    };
  });
}

const PILL = "a pill";
const BUTTON = `${PILL}, label as written`;

/**
 * {@link PILL} when the corner is at least half the height and over 16px; the
 * corner and height read otherwise.
 */
async function pillShape(target: Locator): Promise<string> {
  const { radius, height } = await corner(target);
  const r = Number.parseFloat(radius);
  return r >= height / 2 && r > 16 ? PILL : `${radius} on ${height}px`;
}

/** {@link BUTTON} when the control is a pill and nothing transforms its label. */
async function buttonShape(target: Locator): Promise<string> {
  const { transform } = await corner(target);
  const label = transform === "none" ? "label as written" : `label ${transform}`;
  return `${await pillShape(target)}, ${label}`;
}

const FILTER = "28px, round ends at the 14px corner";
const FORM_FIELD = "34px, the 14px corner short of a pill";

/**
 * {@link FILTER} or {@link FORM_FIELD} when a small field is one of the two
 * shapes; its corner and height otherwise.
 */
async function fieldShape(target: Locator): Promise<string> {
  const { radius, height } = await corner(target);
  const r = Number.parseFloat(radius);
  if (radius === "14px" && height === 28 && r >= height / 2) return FILTER;
  if (radius === "14px" && height === 34 && r < height / 2) return FORM_FIELD;
  return `${radius} on ${height}px`;
}

async function radiusOf(target: Locator): Promise<string> {
  return (await corner(target)).radius;
}

/**
 * Shoots `view` at both widths, light and dark. `settle` runs after each change
 * and waits for whatever says the page has taken it.
 */
async function shootAll(
  page: Page,
  view: string,
  settle: (scheme: Scheme) => Promise<void>,
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  // `astro dev` draws its own toolbar over the page; it is not the page.
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  for (const size of WIDTHS) {
    for (const colorScheme of SCHEMES) {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme });
      // Off every control, so no shot catches a hover the last click left.
      await page.mouse.move(0, 0);
      await settle(colorScheme);
      await page.screenshot({
        path: resolve(SHOTS, `${view}-${size.width}-${colorScheme}.png`),
        animations: "disabled",
      });
    }
  }
}

/** The portal puts the scheme it resolved on `data-theme`; wait for it. */
const hostTheme = (page: Page) => async (scheme: Scheme) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
};

/** Measures at each width in light, where the corners are read. */
async function atEachWidth(page: Page, measure: (width: number) => Promise<void>): Promise<void> {
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: "light" });
    await measure(size.width);
  }
}

/**
 * The invitation's views in one design: its top, with the household's email
 * box; the Reception's card; then the Reception's RSVP sheet.
 */
async function inviteViews(flow: Flow, guest: Page, design: "classic" | "gala"): Promise<void> {
  const card = guest
    .getByRole("article")
    .filter({ has: guest.getByRole("heading", { name: EVENT, exact: true }) });
  const respond = card.getByRole("button", { name: "Respond", exact: true });
  const sheet = guest.getByRole("dialog");

  await flow.step(`${design}: shoot the top of the invitation and the ${EVENT} card`, async () => {
    await expect(respond).toBeVisible();
    await shootAll(guest, `invite-${design}-top`, async () => {
      await guest.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => guest.evaluate(() => window.scrollY)).toBe(0);
    });
    await shootAll(guest, `invite-${design}`, async () => {
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeInViewport();
    });
  });
  const email = guest.getByRole("textbox", { name: `Your email, ${guestName}` });
  await atEachWidth(guest, async (width) => {
    flow.check(`${design} at ${width}: the email field's corner`, "14px", await radiusOf(email));
    flow.check(`${design} at ${width}: the event card's corner`, "16px", await radiusOf(card));
    flow.check(
      `${design} at ${width}: Respond's corner and label`,
      BUTTON,
      await buttonShape(respond),
    );
  });

  await flow.step(`${design}: open the ${EVENT} RSVP sheet, Attending, Other`, async () => {
    await respond.click();
    await expect(sheet.getByRole("heading", { name: `Respond, ${EVENT}` })).toBeVisible();
    const attending = sheet.getByRole("button", { name: "Attending", exact: true });
    await attending.click();
    await expect(attending).toHaveAttribute("aria-pressed", "true");
    // The pill is the label; its checkbox is visually hidden under it.
    const other = sheet.getByRole("checkbox", { name: "Other", exact: true });
    await sheet
      .locator("label")
      .filter({ has: guest.getByRole("checkbox", { name: "Other", exact: true }) })
      .click();
    await expect(other).toBeChecked();
    await expect(sheet.getByRole("textbox", { name: "Anything else" })).toBeVisible();
  });
  await guestSheet(flow, guest, sheet, design);
  await sheetForms(flow, guest, sheet, design);

  const field = sheet.getByRole("textbox", { name: "Anything else" });
  const save = sheet.getByRole("button", { name: "Save", exact: true });
  await atEachWidth(guest, async (width) => {
    flow.check(
      `${design} sheet at ${width}: the text field's corner`,
      "14px",
      await radiusOf(field),
    );
    flow.check(
      `${design} sheet at ${width}: Save's corner and label`,
      BUTTON,
      await buttonShape(save),
    );
  });

  await flow.step(`${design}: shoot the RSVP sheet`, async () => {
    await shootAll(guest, `invite-${design}-rsvp`, async () => {
      // The sheet's footer is sticky over its scrollport, so a field at the
      // scrollport's foot counts as in view while the footer hides it.
      await field.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(field).toBeInViewport({ ratio: 1 });
      await expect(save).toBeInViewport();
    });
  });
}

test("cire-soft-shapes", async ({ page, context, flow }) => {
  await claimFromOrganiserAddress(context);
  await loginSurfaces(flow, page);
  await signInToCireHost(flow, page);

  // ── The portal ────────────────────────────────────────────────────────────
  const guestsCard = page.getByText("Guests & events", { exact: true }).locator("xpath=..");
  await flow.step("open the sample wedding's overview", async () => {
    await page.goto(HOST);
    await expect(guestsCard).toBeVisible({ timeout: 60_000 });
  });
  await atEachWidth(page, async (width) => {
    flow.check(
      `overview at ${width}: the Guests card's corner`,
      "16px",
      await radiusOf(guestsCard),
    );
  });
  await overviewSurfaces(flow, page);

  const preview = page.getByRole("button", { name: "Preview invite" });
  /**
   * Preview invite draws its label only where the bar is `@2xl/frame` wide; at
   * a phone's width it draws a glyph and keeps the label for screen readers, so
   * there the check reads its corner alone.
   */
  const checkPreview = async (view: string, width: number) => {
    if (width === WIDTHS[0].width) {
      flow.check(`${view} at ${width}: Preview invite's corner`, PILL, await pillShape(preview));
    } else {
      flow.check(
        `${view} at ${width}: Preview invite's corner and label`,
        BUTTON,
        await buttonShape(preview),
      );
    }
  };
  const guestSearch = page.getByRole("searchbox", { name: "Search guests" });
  await flow.step("open the guest list", async () => {
    await page.getByRole("button", { name: "Open the guest list" }).click();
    await expect(guestSearch).toBeVisible();
  });
  await atEachWidth(page, async (width) => {
    await checkPreview("guest list", width);
    flow.check(`guest list at ${width}: the search field`, FILTER, await fieldShape(guestSearch));
  });
  await flow.step("shoot the guest list", () => shootAll(page, "host-guests", hostTheme(page)));

  // The sample wedding's households are fields here, so the first of each is
  // there whatever a flow before this one saved.
  const householdName = page.getByRole("textbox", { name: "Household name" }).first();
  const firstName = page.getByRole("textbox", { name: "First name" }).first();
  const addHousehold = page.getByRole("button", { name: "Add household", exact: true });
  const addGuest = page.getByRole("button", { name: "Add guest", exact: true }).first();
  const deleteHousehold = page
    .getByRole("button", { name: "Delete household", exact: true })
    .first();
  await flow.step("open the guest editor", async () => {
    await page.goto(`${HOST}/guests/edit`);
    await expect(householdName).toBeVisible({ timeout: 60_000 });
    await expect(addHousehold).toBeVisible();
  });
  await atEachWidth(page, async (width) => {
    flow.check(
      `guest editor at ${width}: the household name field`,
      FORM_FIELD,
      await fieldShape(householdName),
    );
    flow.check(
      `guest editor at ${width}: the first name field`,
      FORM_FIELD,
      await fieldShape(firstName),
    );
    flow.check(
      `guest editor at ${width}: Add household's height`,
      28,
      (await corner(addHousehold)).height,
    );
    flow.check(
      `guest editor at ${width}: Delete household's height`,
      34,
      (await corner(deleteHousehold)).height,
    );
    flow.check(`guest editor at ${width}: Add guest's height`, 34, (await corner(addGuest)).height);
  });
  await flow.step("shoot the guest editor", () =>
    shootAll(page, "host-guest-editor", hostTheme(page)),
  );

  const rsvpSearch = page.getByRole("searchbox", { name: /^Search .+ guests$/ });
  await flow.step("open the RSVP table", async () => {
    await page.goto(`${HOST}/guests/rsvps`);
    await expect(page.getByRole("tablist", { name: "Events" })).toBeVisible();
    await expect(rsvpSearch).toBeVisible();
  });
  const rsvpSort = page.getByRole("combobox", { name: "Sort guests" });
  await atEachWidth(page, async (width) => {
    await checkPreview("RSVP table", width);
    flow.check(`RSVP table at ${width}: the search field`, FILTER, await fieldShape(rsvpSearch));
    // A phone has no head row to sort from, so the sort is a select in the bar.
    if (width === WIDTHS[0].width) {
      flow.check(`RSVP table at ${width}: the sort select`, FILTER, await fieldShape(rsvpSort));
    }
  });
  await flow.step("shoot the RSVP table", () => shootAll(page, "host-rsvps", hostTheme(page)));
  await replyKey(flow, page);

  await hostSurfaces(flow, page);
  await hostForms(flow, page, HOST);

  const design = (name: "Classic" | "Gala") =>
    page
      .getByRole("radiogroup", { name: "Invite design" })
      .getByRole("radio", { name: new RegExp(`^${name}`) });
  await flow.step("open the invite designs", async () => {
    await page.goto(`${HOST}/invite/design`);
    await expect(design("Classic")).toBeVisible({ timeout: 60_000 });
  });
  flow.check(
    "the sample wedding starts on Classic",
    "true",
    (await design("Classic").getAttribute("aria-checked")) ?? "missing",
  );
  await builderSurfaces(flow, page, design);
  await builderFeedback(flow, page);

  // ── The marketing site ───────────────────────────────────────────────────
  // No claim and no sign-in: the page is public, and its demo sends nothing.
  const landing = await flow.newPage(context);
  const main = landing.getByRole("main");
  const create = main.getByRole("link", { name: "Create your invitation" }).first();
  const live = main.getByRole("link", { name: "See a live invite" }).first();
  await flow.step("open the marketing site", async () => {
    await landing.goto(ORIGINS.cireLanding);
    await expect(create).toBeVisible({ timeout: 60_000 });
  });
  await atEachWidth(landing, async (width) => {
    flow.check(
      `landing at ${width}: Create your invitation's corner and label`,
      BUTTON,
      await buttonShape(create),
    );
    flow.check(
      `landing at ${width}: See a live invite's corner and label`,
      BUTTON,
      await buttonShape(live),
    );
  });
  await flow.step("shoot the marketing site's top", () =>
    shootAll(landing, "landing-top", async () => {
      await landing.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => landing.evaluate(() => window.scrollY)).toBe(0);
    }),
  );
  await landingSurfaces(flow, landing);

  const demoRespond = landing.getByRole("article").first().getByRole("button", {
    name: "Respond",
    exact: true,
  });
  const demo = landing.getByRole("dialog");
  const demoField = demo.getByRole("textbox", { name: "Anything else" });
  await flow.step("open the demo's Respond sheet, Attending, Other", async () => {
    await landing.setViewportSize(WIDTHS[0]);
    await demoRespond.scrollIntoViewIfNeeded();
    // The demo hydrates when it scrolls into view; press until it answers.
    await expect(async () => {
      await demoRespond.click();
      await expect(demo).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await demo.getByRole("button", { name: "Attending", exact: true }).first().click();
    await demo
      .locator("label")
      .filter({ has: landing.getByRole("checkbox", { name: "Other", exact: true }) })
      .first()
      .click();
    await expect(demoField.first()).toBeVisible();
  });
  await demoPair(flow, landing, demo);
  await demoForms(flow, landing, demo);
  flow.check(
    "landing at 390: the demo sheet holds its contents",
    true,
    await demo.evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  flow.check(
    "landing at 390: the demo's Anything else field's corner",
    "14px",
    await radiusOf(demoField.first()),
  );
  await flow.step("shoot the demo's Respond sheet", () =>
    shootAll(landing, "landing-demo", async () => {
      await demoField.first().evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(demoField.first()).toBeInViewport();
    }),
  );
  await landingFeedback(flow, landing, demo);
  await landing.close();

  // ── The guest site, in Classic ───────────────────────────────────────────
  await claimForms(flow, context, INVITE);
  const faqIds = await addGuestFaq(flow, page);
  const guest = await flow.newPage(context);
  // The two FAQ entries come off however the guest steps end, so a failure
  // here leaves the sample wedding with no FAQ, as it was seeded.
  try {
    const served = guestSitePaths(guest);
    const claimed = await flow.step(`open ${guestName}'s invitation from its link`, async () => {
      const response = guest.waitForResponse(
        (r) => r.url() === CLAIM_URL && r.request().method() === "POST",
      );
      await guest.goto(`${INVITE}&code=${code}`);
      const status = (await response).status();
      await expect(guest.getByText(`Answering as ${guestName}`)).toBeVisible();
      return status;
    });
    flow.check(`claim with ${guestName}'s code`, 200, claimed);

    const prompt = guest.getByRole("dialog", { name: "Privacy choices" });
    await flow.step("see the consent prompt", async () => {
      // The consent prompt is an idle-hydrated island: wait for it rather than race it.
      await expect(prompt).toBeVisible({ timeout: 60_000 });
    });
    await consentLink(flow, prompt);
    await flow.step("decline optional storage", async () => {
      await prompt.getByRole("button", { name: "Reject all" }).click();
      await expect(prompt).toBeHidden();
    });
    /**
     * Whether the guest site served one of `name`'s modules since request `from`.
     * `astro dev` serves an island by its file path, so the path is matched
     * anywhere in it.
     */
    const designModules = (name: string, from = 0) =>
      served.slice(from).some((path) => path.includes(`/src/designs/${name}/`));
    flow.check("Classic's modules served", true, designModules("classic"));
    flow.check("Gala's modules not served", false, designModules("gala"));

    await guestFaqSurfaces(flow, guest, "classic");
    await inviteViews(flow, guest, "classic");

    // ── The guest site, in Gala ──────────────────────────────────────────────
    const switchTo = async (name: "Classic" | "Gala") => {
      const response = page.waitForResponse(
        (r) => r.url() === DESIGN_URL && r.request().method() === "PUT",
      );
      await design(name).click();
      const status = (await response).status();
      await expect(design(name)).toHaveAttribute("aria-checked", "true");
      return status;
    };
    const switchBack = async () =>
      flow.check(
        "the organiser switches the wedding back to Classic",
        200,
        await flow.step("switch back to Classic", () => switchTo("Classic")),
      );

    // The Gala half fails into `catch`, so the wedding goes back to Classic
    // whichever step fails, and the step that failed is the error reported.
    try {
      flow.check(
        "the organiser switches the wedding to Gala",
        200,
        await flow.step("switch to Gala", () => switchTo("Gala")),
      );

      const sinceReload = served.length;
      const restored = await flow.step("reload the invitation", async () => {
        const session = guest.waitForResponse(
          (r) => r.url().startsWith(`${CLAIM_URL}/session`) && r.request().method() === "GET",
        );
        await guest.goto(INVITE);
        const status = (await session).status();
        await expect(guest.getByText(`Answering as ${guestName}`)).toBeVisible();
        return status;
      });
      flow.check(`${guestName}'s session restored from the claim's cookie`, 200, restored);
      flow.check("Gala's modules served", true, designModules("gala", sinceReload));
      flow.check("Classic's modules not served", false, designModules("classic", sinceReload));

      await guestFaqSurfaces(flow, guest, "gala");
      await inviteViews(flow, guest, "gala");
    } catch (error) {
      // A switch to Gala that never landed leaves Classic chosen, and pressing a
      // chosen card sends nothing, so the restore would wait out its timeout.
      const classicChosen = await design("Classic")
        .getAttribute("aria-checked")
        .catch(() => null);
      if (classicChosen !== "true") await switchBack().catch(() => undefined);
      throw error;
    }

    await switchBack();
  } catch (error) {
    await removeGuestFaq(flow, page, faqIds).catch(() => undefined);
    throw error;
  }
  await removeGuestFaq(flow, page, faqIds);

  // The flow's own screenshot: the Gala RSVP sheet on a phone, in light.
  await guest.setViewportSize(WIDTHS[0]);
  await guest.emulateMedia({ colorScheme: "light" });
  flow.finalPage = guest;
});
