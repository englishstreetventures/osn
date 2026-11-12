/**
 * Pulse's two avatar menus and its "More filters" dialog, as `@shared/ui`'s
 * defaults draw them: the menus' separator a 1px fill in `--ui-hairline` with
 * no border of its own, in light and dark, and every one of these overlays
 * still growing from the contract's 96% as it opens, since pulse maps no
 * scale token (`pulse/DESIGN.md`; `wiki/shared/design-tokens.md` §Motion).
 * Musubi maps the scale to 1 and fades alone, so a scale that reached pulse
 * from Musubi's mapping, or a pulse mapping of its own, fails here.
 *
 * The 0.96 is the contract's default written out, the `@layer base` value in
 * `shared/design-tokens/src/tokens.css`, never a value read from the page: a
 * read would follow whatever pulse mapped.
 *
 * `pulse-event-rsvp` calls it once the host has signed in, so it spends no
 * sign-in, and it starts on the `/` sign-in leaves. The ExploreNav menu and
 * "More filters" are read there, then the Header menu on `/settings`, so the
 * whole pass loads two pages. Each menu is opened at 390 and 1440, in light
 * and with `.dark` on `<html>`, the only switch `pulse/web/src/app.css` reads,
 * and shot into `e2e-artifacts/screenshots/pulse-menus/`. It leaves the page
 * on `/` in light, at the viewport it found.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";
import { menuSeparator } from "./menu-separator";
import { type HeldFrame, holdOverlay } from "./overlay-frames";

const SHOTS = resolve(SCREENSHOT_DIR, "pulse-menus");
const SIZES = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
const SCHEMES = ["light", "dark"] as const;
/** The contract's `--ui-scale-enter` default, which an app that maps none draws. */
const CONTRACT_SCALE_ENTER = 0.96;

/** The avatar trigger, the last menu trigger in the page's header. */
const trigger = (page: Page) => page.locator('header button[aria-haspopup="true"]').last();

async function dark(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), on);
}

/** The held opening frame, read as the contract's zoom: scaled, and at 96%. */
function zooms(flow: Flow, what: string, frame: HeldFrame): void {
  flow.check(`${what}: scaled as it opens`, false, frame.identity);
  flow.check(`${what}: grows from 96%`, CONTRACT_SCALE_ENTER, frame.scale);
}

/** One avatar menu on the page already open, at both widths and in both schemes. */
async function avatarMenu(flow: Flow, page: Page, where: string, what: string): Promise<void> {
  for (const size of SIZES) {
    for (const scheme of SCHEMES) {
      const at = `${what} at ${size.width} (${scheme})`;
      await page.setViewportSize(size);
      await dark(page, scheme === "dark");
      const menu = page.getByRole("menu");
      const rule = menu.getByRole("separator").first();
      const opened = await holdOverlay(page, '[role="menu"]', "ui-enter", 0);
      await flow.step(`pulse menus: open the ${at}`, async () => {
        await expect(trigger(page)).toBeVisible();
        await trigger(page).click();
        await expect(rule).toBeVisible();
      });
      zooms(flow, at, await opened());
      await menuSeparator(flow, `${at} separator`, rule);
      await flow.step(`pulse menus: shoot and close the ${at}`, async () => {
        await menu.screenshot({
          path: resolve(SHOTS, `${where}-${size.width}-${scheme}.png`),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
      });
    }
  }
}

export async function pulseMenus(flow: Flow, page: Page): Promise<void> {
  const viewport = page.viewportSize();
  mkdirSync(SHOTS, { recursive: true });
  try {
    await flow.step("pulse menus: on /", async () => {
      await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/`);
      await expect(trigger(page)).toBeVisible();
    });
    await avatarMenu(flow, page, "explore", "ExploreNav menu");

    await page.setViewportSize(SIZES[1]);
    await dark(page, false);
    const filters = page.getByRole("dialog", { name: "More filters" });
    const opened = await holdOverlay(page, '[role="dialog"]', "ui-enter", 0);
    await flow.step("pulse menus: open More filters", async () => {
      await page.getByRole("button", { name: "More filters" }).click();
      await expect(filters).toBeVisible();
    });
    zooms(flow, "More filters dialog at 1440 (light)", await opened());
    await flow.step("pulse menus: close More filters", async () => {
      await page.keyboard.press("Escape");
      await expect(filters).toHaveCount(0);
    });

    await flow.step("pulse menus: open /settings", async () => {
      await page.goto(`${ORIGINS.pulseWeb}/settings`);
      await expect(trigger(page)).toBeVisible();
    });
    await avatarMenu(flow, page, "header", "Header menu");
  } finally {
    await dark(page, false);
    if (viewport) await page.setViewportSize(viewport);
  }
  await flow.step("pulse menus: back to /", async () => {
    await page.goto(`${ORIGINS.pulseWeb}/`);
    await expect(page.getByRole("button", { name: "Host", exact: true })).toBeVisible();
  });
}
