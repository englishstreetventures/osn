/**
 * Cire's form parts, read from computed style and pictured: the checkboxes
 * and radios `@shared/ui`'s `Checkbox` and `RadioGroup` draw as the browser's
 * own box, the 34px portal fields and the guest site's ink fields at the touch
 * size, and the portal's file picker (`cire/host/DESIGN.md` §4 and §7). Shots
 * go to `screenshots/cire-forms/`.
 *
 * Places the `cire-soft-shapes` flow already stands in, so it signs in and
 * claims no more than it did:
 *
 * - the money wedding's gift-list settings, signed in: the visibility radios in
 *   a row and the "Let guests give money" box with its description. Nothing is
 *   saved: the form saves only on its own Save, which this never presses;
 * - the guest editor's spreadsheet import, signed in: the file picker;
 * - the invitation's claim panel, opened with no code, so no claim is spent:
 *   the code field;
 * - the guest RSVP sheet the flow opens with Attending and Other: the ink
 *   "Anything else" field and the dietary consent box;
 * - the marketing site's demo sheet, open the same way: its ink field.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { BrowserContext, Locator, Page } from "@playwright/test";

import { CIRE_ORGANISER, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-forms");
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
type Scheme = "light" | "dark";

/** Shoots `view` at both widths in both schemes, with `settle` after each change. */
async function shoot(
  page: Page,
  view: string,
  settle: (scheme: Scheme) => Promise<void>,
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  for (const size of [PHONE, DESKTOP]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme });
      await page.mouse.move(0, 0);
      await settle(colorScheme);
      await page.screenshot({
        path: resolve(SHOTS, `${view}-${size.width}-${colorScheme}.png`),
        animations: "disabled",
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The unticked native box as the base rule and the part draw it, or what it is instead. */
async function boxShape(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return `${r.width}x${r.height} ${s.appearance} ${s.borderTopLeftRadius}`;
  });
}

const UNTICKED = "13x13 none 2px";
const ROUND = "13x13 none 50%";

/** A field's height, type size, case and alignment. */
async function fieldShape(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const s = getComputedStyle(el);
    return `${el.getBoundingClientRect().height} ${s.fontSize} ${s.textTransform} ${s.textAlign}`;
  });
}

/**
 * A wedding's gift-list settings: the visibility radios and the money
 * box; then the import picker.
 */
export async function hostForms(flow: Flow, page: Page, sample: string): Promise<void> {
  const visibility = page.getByRole("radiogroup", { name: "Visibility" });
  const draft = visibility.getByRole("radio", { name: /^Draft/ });
  const published = visibility.getByRole("radio", { name: /^Published/ });
  const money = page.getByRole("checkbox", { name: "Let guests give money", exact: true });
  await flow.step("forms: open a wedding's gift-list settings", async () => {
    await page.setViewportSize(DESKTOP);
    // The gift list is a paid module: the money wedding has one, the sample
    // wedding does not.
    await page.goto(`${ORIGINS.cireHost}/#/w/${CIRE_ORGANISER.money.weddingId}/registry/settings`);
    await expect(draft).toBeVisible({ timeout: 60_000 });
  });
  const [chosen, other] = (await draft.isChecked()) ? [draft, published] : [published, draft];
  flow.check("forms: an unchosen radio is the native 13px, round", ROUND, await boxShape(other));
  flow.check(
    "forms: a chosen radio is the browser's own",
    "auto",
    await chosen.evaluate((el) => getComputedStyle(el).appearance),
  );
  flow.check(
    "forms: the visibility radios are 16px apart in a row",
    16,
    await visibility.evaluate((el) => {
      const [a, b] = [...el.querySelectorAll("label")].map((l) => l.getBoundingClientRect());
      return Math.round((b?.left ?? 0) - (a?.right ?? 0));
    }),
  );
  flow.check(
    "forms: the money box is the native 13px, named by its words alone",
    (await money.isChecked()) ? "13x13 auto 0px" : UNTICKED,
    await boxShape(money),
  );
  await flow.step("forms: shoot the gift-list settings' radios and box", () =>
    shoot(page, "host-registry-settings", async () => {
      await visibility.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(visibility).toBeInViewport();
    }),
  );

  const picker = page.locator('input[type="file"]');
  await flow.step("forms: open the guest editor's spreadsheet import", async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${sample}/guests/edit`);
    await page.getByRole("radio", { name: "Spreadsheet import" }).click({ timeout: 60_000 });
    await expect(picker).toBeVisible();
  });
  flow.check(
    "forms: the import picker is the 34px quiet pill's height",
    34,
    await picker.evaluate((el) => el.getBoundingClientRect().height),
  );
  await flow.step("forms: shoot the import picker", () =>
    shoot(page, "host-import-picker", async () => {
      await picker.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(picker).toBeInViewport();
    }),
  );
}

/**
 * The invitation's claim panel, opened with no code in a page of its own, so
 * the flow's one claim is still unspent.
 */
export async function claimForms(
  flow: Flow,
  context: BrowserContext,
  invite: string,
): Promise<void> {
  const panel = await flow.newPage(context);
  const code = panel.getByRole("textbox", { name: "Invitation code" });
  await flow.step("forms: open the invitation with no code", async () => {
    await panel.setViewportSize(PHONE);
    await panel.goto(invite);
    await expect(code).toBeVisible({ timeout: 60_000 });
  });
  flow.check(
    "forms: the code field on a phone",
    "54 16px uppercase center",
    await fieldShape(code),
  );
  await panel.setViewportSize(DESKTOP);
  // The guest site's root is 17px from 1024px; the code is one rem and the
  // field 3.375rem, so both grow with it, as the field's padding did.
  flow.check(
    "forms: the code field on a desk",
    "57.375 17px uppercase center",
    await fieldShape(code),
  );
  await flow.step("forms: shoot the claim panel", () =>
    shoot(panel, "invite-claim", async () => {
      await expect(code).toBeInViewport();
    }),
  );
  await panel.close();
}

/** The RSVP sheet with Other ticked: the ink field and the dietary consent box. */
export async function sheetForms(
  flow: Flow,
  guest: Page,
  sheet: Locator,
  design: string,
): Promise<void> {
  const field = sheet.getByRole("textbox", { name: "Anything else" });
  const consent = sheet.getByRole("checkbox", { name: /I agree to the dietary requirements/ });
  await guest.setViewportSize(PHONE);
  flow.check(
    `forms: ${design}'s Anything else on a phone`,
    "46 16px none start",
    await fieldShape(field),
  );
  flow.check(`forms: ${design}'s consent box`, UNTICKED, await boxShape(consent));
  await guest.setViewportSize(DESKTOP);
  // 2.75rem on the guest site's 17px desk root.
  flow.check(
    `forms: ${design}'s Anything else on a desk`,
    46.75,
    Number.parseFloat(await fieldShape(field)),
  );
  await flow.step(`forms: shoot ${design}'s consent box`, () =>
    shoot(guest, `invite-${design}-consent`, async () => {
      await consent.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(consent).toBeInViewport();
    }),
  );
}

/** The demo sheet's ink field, on a phone. */
export async function demoForms(flow: Flow, landing: Page, demo: Locator): Promise<void> {
  await landing.setViewportSize(PHONE);
  flow.check(
    "forms: the demo's Anything else on a phone",
    "46 16px none start",
    await fieldShape(demo.getByRole("textbox", { name: "Anything else" }).first()),
  );
}

/**
 * The invite builder's Hero section, signed in: the picture picker, named by
 * the picture it sets, at the 34px form height. The flow leaves the builder on
 * its Design tab; this opens Hero and goes back.
 */
export async function builderForms(flow: Flow, page: Page): Promise<void> {
  const sections = page.getByLabel("Invite sections");
  const picker = page.getByLabel(/: choose a picture$/).first();
  await flow.step("forms: open the builder's Hero tab", async () => {
    await page.setViewportSize(DESKTOP);
    await sections.getByRole("tab", { name: /^Hero/ }).click();
    await expect(picker).toBeVisible();
  });
  flow.check(
    "forms: the invite picture's picker is named and 34px",
    34,
    await picker.evaluate((el) => el.getBoundingClientRect().height),
  );
  await flow.step("forms: shoot the hero picture's picker", () =>
    shoot(page, "host-builder-picture-picker", async () => {
      await picker.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(picker).toBeInViewport();
    }),
  );
  await flow.step("forms: back to the builder's Design tab", async () => {
    await sections.getByRole("tab", { name: /^Design/ }).click();
  });
}
