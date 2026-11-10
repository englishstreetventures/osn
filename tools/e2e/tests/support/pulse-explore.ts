/**
 * Pulse's explore page from a phone to a desktop: no sideways scroll, the
 * whole search field on screen with its placeholder unclipped, the header's
 * phone arrangement (brand and actions, then the search, then the tabs) below
 * 768px and its one line from there up, the active tab's coral underline on
 * the header's bottom border, the hero's stats under the headline on a phone,
 * the header pinned only from 768px up, and the create form's two times
 * stacked on a phone. The rules are `pulse/DESIGN.md` §Explore Page Layout.
 *
 * `pulse-event-rsvp` calls it on its own pages, so it spends no sign-in: on the
 * host's page signed in, after the host has made an event, and on the guest's
 * page before the guest signs in. Each view is shot into
 * `screenshots/pulse-explore/` at 320, 390 and 1440 in light and dark. Dark is
 * `.dark` on `<html>`, the only switch `pulse/web/src/app.css` reads. Leaves
 * the page on `/` at 1280×720, in light.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "pulse-explore");
/** Playwright's own viewport, which the rest of the flow runs at. */
const DEFAULT = { width: 1280, height: 720 } as const;
const SIZES = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;
/** Tailwind's `md`, where `pulse/DESIGN.md` puts the header back on one line. */
const MD = 768;
const SHOT_WIDTHS: readonly number[] = [320, 390, 1440];
/** The phone gutter, `px-4`. */
const GUTTER = 16;
/** `.explore-tab-active::after { bottom: -15px }` in `pulse/web/src/explore/explore.css`. */
const UNDERLINE_DROP = 15;

interface Box {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

interface Layout {
  readonly innerWidth: number;
  readonly scrollWidth: number;
  readonly headerPosition: string;
  readonly row: Box;
  readonly brand: Box;
  readonly tabs: Box;
  readonly activeTab: Box;
  readonly search: Box;
  readonly action: Box;
  readonly headline: Box;
  readonly stats: Box;
  readonly placeholderFits: boolean;
}

/**
 * Reads the header's geometry. The brand row is the header's first child, the
 * search box the search input's parent, the stats the block after the
 * headline's, and the action the row's Host or "Continue with musubi" pill —
 * the one on the brand's line on a phone.
 */
function measure(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      if (!el) throw new Error("explore header: element missing");
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    };
    const header = document.querySelector("header");
    const row = header?.firstElementChild;
    const input = row?.querySelector<HTMLInputElement>('input[placeholder^="Search events"]');
    const headline = header?.querySelector("h1");
    const action = [...(row?.querySelectorAll("button") ?? [])].find((b) =>
      ["Host", "Continue with musubi"].includes(b.textContent?.trim() ?? ""),
    );
    if (!header || !input) throw new Error("explore header: header or search missing");
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) throw new Error("explore header: no 2d context");
    ctx.font = getComputedStyle(input).font;
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headerPosition: getComputedStyle(header).position,
      row: box(row),
      brand: box(row?.firstElementChild),
      tabs: box(row?.querySelector("nav")),
      activeTab: box(row?.querySelector('nav [class*="explore-tab-active"]')),
      search: box(input.parentElement),
      action: box(action),
      headline: box(headline),
      stats: box(headline?.parentElement?.nextElementSibling),
      placeholderFits: ctx.measureText(input.placeholder).width <= input.clientWidth,
    };
  });
}

const centre = (b: Box) => (b.top + b.bottom) / 2;
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

/** Sets `.dark` on `<html>`, or takes it off. */
const scheme = (page: Page, dark: boolean) =>
  page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);

async function shoot(page: Page, view: string, width: number): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await scheme(page, colorScheme === "dark");
    await page.screenshot({
      path: resolve(SHOTS, `${view}-${width}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await scheme(page, false);
}

/**
 * The explore page's layout at each width, for `who` — `host` signed in with
 * the bell, Host and avatar and three tabs, `guest` signed out with "Continue
 * with musubi" and Home alone.
 */
export async function exploreLayout(flow: Flow, page: Page, who: string): Promise<void> {
  await flow.step(`explore: ${who} opens the explore page`, async () => {
    await page.goto(`${ORIGINS.pulseWeb}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
  });

  for (const size of SIZES) {
    const at = `explore: ${who} at ${size.width}`;
    const layout = await flow.step(`${at}: measure the header`, async () => {
      await page.setViewportSize(size);
      return measure(page);
    });
    const phone = size.width < MD;

    flow.check(`${at}: no sideways scroll`, true, layout.scrollWidth <= layout.innerWidth);
    flow.check(
      `${at}: the search field is wholly on screen`,
      true,
      layout.search.left >= 0 && layout.search.right <= layout.innerWidth,
    );
    flow.check(`${at}: the search placeholder is not clipped`, true, layout.placeholderFits);
    flow.check(
      `${at}: the active tab's underline lands on the header's bottom border`,
      UNDERLINE_DROP,
      Math.round(layout.row.bottom - layout.activeTab.bottom),
    );
    flow.check(`${at}: the header pins`, phone ? "static" : "sticky", layout.headerPosition);

    if (phone) {
      flow.check(
        `${at}: the search runs gutter to gutter`,
        true,
        near(layout.search.left, GUTTER) && near(layout.search.right, layout.innerWidth - GUTTER),
      );
      flow.check(
        `${at}: the action sits on the brand's line`,
        true,
        near(centre(layout.action), centre(layout.brand)),
      );
      flow.check(
        `${at}: brand line, then the search, then the tabs`,
        true,
        layout.brand.bottom <= layout.search.top && layout.search.bottom <= layout.tabs.top,
      );
      flow.check(
        `${at}: the hero's stats sit under the headline`,
        true,
        layout.stats.top >= layout.headline.bottom,
      );
    } else {
      flow.check(
        `${at}: brand, tabs, search and action share one line`,
        true,
        [layout.tabs, layout.search, layout.action].every((b) =>
          near(centre(b), centre(layout.brand)),
        ),
      );
      flow.check(
        `${at}: the hero's stats sit beside the headline`,
        true,
        layout.stats.left >= layout.headline.right,
      );
    }

    if (SHOT_WIDTHS.includes(size.width)) {
      await flow.step(`${at}: shoot the page`, () => shoot(page, who, size.width));
    }
  }

  await flow.step(`explore: ${who} back at 1280×720`, () => page.setViewportSize(DEFAULT));
}

/** The create form's start and end times: stacked on a phone, side by side from 768px. */
export async function exploreCreateForm(flow: Flow, page: Page): Promise<void> {
  const host = page.getByRole("button", { name: "Host", exact: true });
  const start = page.getByLabel("Start time");
  const end = page.getByLabel("End time");
  await flow.step("explore: open the create form", async () => {
    await host.click();
    await expect(start).toBeVisible();
  });
  for (const size of [SIZES[0], SIZES[1], SIZES[3]]) {
    const at = `explore: create form at ${size.width}`;
    const [scrolls, startBox, endBox] = await flow.step(`${at}: measure the times`, async () => {
      await page.setViewportSize(size);
      return Promise.all([
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        start.boundingBox(),
        end.boundingBox(),
      ]);
    });
    flow.check(`${at}: no sideways scroll`, true, scrolls);
    const stacked = startBox && endBox ? endBox.y >= startBox.y + startBox.height : false;
    flow.check(`${at}: the end time sits under the start time`, size.width < MD, stacked);
    if (size.width === 390) {
      await flow.step(`${at}: shoot the form`, async () => {
        mkdirSync(SHOTS, { recursive: true });
        await start.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(SHOTS, "host-form-390-light.png"),
          animations: "disabled",
        });
      });
    }
  }
  await flow.step("explore: close the create form, back at 1280×720", async () => {
    await page.setViewportSize(DEFAULT);
    await host.click();
    await expect(start).toBeHidden();
  });
}
