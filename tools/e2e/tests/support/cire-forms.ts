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
 * - the sample wedding's budget, signed in: the first line's per-head panel
 *   open with "Only these events" chosen and its payments open, so the
 *   vertical radio group, the event boxes and the "paid" boxes are on screen
 *   beside the add form's "Priced per head" box. Nothing is saved: the panel
 *   saves only on its own Save, which this never presses;
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

import { SCREENSHOT_DIR } from "../../src/config";
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
 * The sample wedding's budget: the per-head panel's radios and event boxes,
 * the payments' "paid" boxes and the add form's box; then the import picker.
 */
export async function hostForms(flow: Flow, page: Page, sample: string): Promise<void> {
  const firstLine = page.getByText("Reception venue", { exact: true });
  await flow.step("forms: open the sample wedding's budget", async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${sample}/budget`);
    await expect(firstLine).toBeVisible({ timeout: 60_000 });
  });
  const scope = page.getByRole("radiogroup", { name: "Count guests at" });
  const these = scope.getByRole("radio", { name: "Only these events" });
  await flow.step(
    "forms: open the first line's per head and its payments, choose these events",
    async () => {
      await page.getByRole("button", { name: "per head", exact: true }).first().click();
      await expect(scope).toBeVisible();
      await page
        .getByRole("button", { name: /^payments \(/ })
        .first()
        .click();
      await these.click();
      await expect(these).toBeChecked();
    },
  );
  const every = scope.getByRole("radio", { name: "Every event" });
  const eventBoxes = scope.locator("xpath=..").getByRole("checkbox");
  const paid = page.getByRole("checkbox", { name: / paid$/ }).first();
  const perHead = page.getByRole("checkbox", { name: "Priced per head" });
  flow.check("forms: an unchosen radio is the native 13px, round", ROUND, await boxShape(every));
  flow.check(
    "forms: a chosen radio is the browser's own",
    "auto",
    await these.evaluate((el) => getComputedStyle(el).appearance),
  );
  flow.check(
    "forms: the scope's radios are 8px apart in a column",
    8,
    await scope.evaluate((el) => {
      const [a, b] = [...el.querySelectorAll("label")].map((l) => l.getBoundingClientRect());
      return Math.round((b?.top ?? 0) - (a?.bottom ?? 0));
    }),
  );
  flow.check("forms: the event boxes show", true, (await eventBoxes.count()) > 0);
  flow.check(
    "forms: an event box is the native 13px",
    true,
    (await boxShape(eventBoxes.first())).startsWith("13x13"),
  );
  flow.check(
    "forms: a payment's paid box is the native 13px",
    true,
    (await boxShape(paid)).startsWith("13x13"),
  );
  flow.check("forms: the add form's box is the native 13px", UNTICKED, await boxShape(perHead));
  await flow.step("forms: shoot the budget's per head and payments", () =>
    shoot(page, "host-budget-per-head", async () => {
      await scope.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(scope).toBeInViewport();
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
  // The guest site's root is 17px from 1024px, and the code is one rem.
  flow.check("forms: the code field on a desk", "54 17px uppercase center", await fieldShape(code));
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
