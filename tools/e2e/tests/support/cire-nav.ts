/**
 * The portal's navigation, signed in: the account menu on the shared menu's
 * accent look, the glass strips (the Guests views, the Edit modes, the RSVP
 * events), and the invite builder's two tiers — on one row at a desktop width,
 * one glass pill and its menu on a phone — with a draft kept, and no prompt,
 * across a move between the builder's views.
 *
 * Runs inside `cire-soft-shapes` on its signed-in page: no sign-in of its own.
 * Leaves the page on Invite → Template, in the system theme.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-nav");
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;

/** One computed property of `target`. */
function computed(target: Locator, property: string): Promise<string> {
  return target.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

const height = (target: Locator) => target.evaluate((el) => el.getBoundingClientRect().height);
const top = (target: Locator) => target.evaluate((el) => el.getBoundingClientRect().top);

/** Shoots the page at `size` in both schemes, with `settle` after each change. */
async function shoot(
  page: Page,
  view: string,
  size: { width: number; height: number },
  settle: () => Promise<void> = async () => {},
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await settle();
    await page.screenshot({
      path: resolve(SHOTS, `${view}-${size.width}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

export async function navSurfaces(flow: Flow, page: Page, host: string): Promise<void> {
  // ── The account menu ───────────────────────────────────────────────────
  const account = page.getByRole("button", { name: "Account menu" });
  const menu = page.getByRole("menu");
  await flow.step("nav: open the account menu", async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${host}/guests`);
    await account.click();
    await expect(menu).toBeVisible();
  });
  const dark = menu.getByRole("menuitemradio", { name: "Dark" });
  const system = menu.getByRole("menuitemradio", { name: "System" });
  flow.check(
    "nav: the theme rows are radios, System chosen",
    "true",
    (await system.getAttribute("aria-checked")) ?? "",
  );
  await flow.step("nav: choose Dark from the menu, which stays open", async () => {
    await dark.click();
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(menu).toBeVisible();
  });
  const haptics = menu.getByRole("menuitemcheckbox", { name: "Haptics" });
  if ((await haptics.count()) > 0) {
    flow.check(
      "nav: the haptics row draws the shared switch",
      1,
      await haptics.locator("[data-menu-switch]").count(),
    );
  }
  await flow.step("nav: shoot the open account menu", async () => {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({
      path: resolve(SHOTS, "account-menu-1440-dark.png"),
      animations: "disabled",
    });
  });
  await flow.step("nav: back to the system theme, and close the menu", async () => {
    await system.click();
    await expect(system).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(account).toBeFocused();
  });

  // ── The glass strips ───────────────────────────────────────────────────
  const views = page.getByRole("tablist", { name: "Views" });
  const chosenView = views.getByRole("tab", { selected: true });
  flow.check("nav: the Guests views strip is 28px", 28, await height(views));
  flow.check(
    "nav: the chosen view's word is at medium weight",
    "500",
    await computed(chosenView, "font-weight"),
  );
  await flow.step("nav: shoot the Guests views strip", () => shoot(page, "guests-strip", DESKTOP));

  const modes = page.getByRole("radiogroup", { name: "How do you want to edit?" });
  await flow.step("nav: open Edit, its modes a glass strip of radios", async () => {
    await views.getByRole("tab", { name: "Edit" }).click();
    await expect(modes).toBeVisible();
  });
  flow.check("nav: the Edit modes strip is 28px", 28, await height(modes));
  flow.check("nav: the Edit modes are two radios", 2, await modes.getByRole("radio").count());

  const events = page.getByRole("tablist", { name: "Events" });
  await flow.step("nav: open RSVPs, its events a glass strip", async () => {
    await views.getByRole("tab", { name: "RSVPs" }).click();
    await expect(events).toBeVisible({ timeout: 30_000 });
  });
  flow.check("nav: the RSVP events strip is 28px", 28, await height(events));
  await flow.step("nav: shoot the RSVP bar's two strips", () =>
    shoot(page, "rsvp-strips", DESKTOP),
  );

  // ── The invite builder's two tiers ─────────────────────────────────────
  const sections = page.getByRole("tablist", { name: "Invite sections" });
  const title = page.getByLabel("Couple title");
  await flow.step("nav: open Invite → Content, Hero", async () => {
    await page.goto(`${host}/invite/content`);
    await expect(sections).toBeVisible({ timeout: 60_000 });
    await sections.getByRole("tab", { name: /^Hero/ }).click();
    await expect(title).toBeVisible();
  });
  flow.check(
    "nav: the views and the sections share one row at 1440",
    true,
    Math.abs((await top(sections)) - (await top(views))) <= 1,
  );
  flow.check(
    "nav: the views are Template, Style, Content, Codes",
    "Template|Style|Content|Codes",
    (await views.getByRole("tab").allTextContents()).join("|"),
  );
  await flow.step("nav: shoot the invite tiers", () => shoot(page, "invite-tiers", DESKTOP));

  const saved = await title.inputValue();
  const asked: string[] = [];
  const onDialog = (dialog: { message(): string; dismiss(): Promise<void> }) => {
    asked.push(dialog.message());
    void dialog.dismiss();
  };
  page.on("dialog", onDialog);
  await flow.step("nav: a draft survives Content → Style → Content with no prompt", async () => {
    await title.fill(`${saved} (draft)`);
    await views.getByRole("tab", { name: "Style" }).click();
    await expect(page.getByLabel("Heading font")).toBeVisible();
    await views.getByRole("tab", { name: "Content" }).click();
    await expect(title).toHaveValue(`${saved} (draft)`);
  });
  flow.check("nav: no unsaved-changes prompt between the builder's views", "", asked.join(" | "));
  await flow.step("nav: put the title back, so the draft is clean", async () => {
    await title.fill(saved);
    await expect(page.getByRole("button", { name: "Save invite" })).toBeDisabled();
  });
  page.off("dialog", onDialog);

  // ── The phone ──────────────────────────────────────────────────────────
  const place = page.getByRole("button", { name: /Choose a view or section$/ });
  await flow.step("nav: on a phone, one pill names the place", async () => {
    await page.setViewportSize(PHONE);
    await expect(place).toBeVisible();
  });
  flow.check("nav: the phone's pill is 28px", 28, await height(place));
  flow.check("nav: the phone draws no section strip", 0, await sections.count());
  await flow.step("nav: shoot the phone's pill", () => shoot(page, "invite-phone", PHONE));
  await flow.step("nav: the pill's menu moves to Welcome", async () => {
    await place.click();
    await expect(menu.getByRole("menuitemradio", { name: "Codes" })).toBeVisible();
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({
      path: resolve(SHOTS, "invite-phone-menu-390-light.png"),
      animations: "disabled",
    });
    await menu.getByRole("menuitemradio", { name: "Welcome" }).click();
    await expect(place).toHaveAccessibleName("Invite: Welcome. Choose a view or section");
  });
  await flow.step("nav: back to Template at a desktop width", async () => {
    await page.setViewportSize(DESKTOP);
    await views.getByRole("tab", { name: "Template" }).click();
    await expect(page.getByRole("radiogroup", { name: "Invite design" })).toBeVisible();
  });
}
