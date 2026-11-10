/**
 * Pulse's explore page from a phone to a desktop: no sideways scroll, the
 * whole search field on screen with its placeholder unclipped, the header's
 * phone arrangement (brand and actions, then the search, then the tabs) below
 * 768px and its one line from there up, the active tab's coral underline on
 * the header's bottom border, the hero's stats under the headline on a phone,
 * the header pinned only from 768px up, Home marked as the current tab, the
 * greeting's date and "View all"'s chevron each kept on one line with what
 * they follow, and the create form's two times stacked on a phone. The rules
 * are `pulse/DESIGN.md` §Explore Page Layout. Then the header's motion and
 * focus: what its controls fade and on what timing, the search's focus
 * outline, and its loops stopping under reduced motion (§Motion).
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
const SHOT_WIDTHS: ReadonlySet<number> = new Set([320, 390, 1440]);
/** The phone gutter, `px-4`. */
const GUTTER = 16;
/** `.explore-tab-active::after { bottom: -15px }` in `pulse/web/src/explore/explore.css`. */
const UNDERLINE_DROP = 15;
/** The search input's accessible name, its `aria-label`. */
const SEARCH_NAME = "Search events, people, venues";
/** `--ui-dur-fast` and `--ui-ease-out` as `getComputedStyle` writes them. */
const DUR_FAST = "0.12s";
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

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
  /** The greeting's date and the `·` before it. */
  readonly date: Box;
  readonly separator: Box;
  /** "View all"'s text and its chevron. */
  readonly viewAllText: Box;
  readonly viewAllIcon: Box;
  /** The text of every tab marked `aria-current="page"`. */
  readonly currentTabs: readonly string[];
  readonly placeholderFits: boolean;
}

/**
 * Reads the header's geometry. The brand row is the header's first child, the
 * search box the search input's parent, the stats the block after the
 * headline's, the date the greeting's `<b>` and the separator the element
 * before it, and the action the row's Host or "Continue with musubi" pill —
 * the one on the brand's line on a phone. "View all" is the featured section's
 * link, below the header.
 */
function measure(page: Page): Promise<Layout> {
  return page.evaluate((searchName) => {
    const box = (el: Element | Range | null | undefined) => {
      if (!el) throw new Error("explore header: element missing");
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    };
    const header = document.querySelector("header");
    const row = header?.firstElementChild;
    const input = row?.querySelector<HTMLInputElement>(`input[aria-label="${searchName}"]`);
    const headline = header?.querySelector("h1");
    const date = headline?.previousElementSibling?.querySelector("b");
    const viewAll = [...document.querySelectorAll("span")].find(
      (el) => el.firstChild?.textContent?.trim() === "View all",
    );
    const viewAllText = viewAll?.firstChild ? document.createRange() : null;
    if (viewAll?.firstChild && viewAllText) viewAllText.selectNodeContents(viewAll.firstChild);
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
      date: box(date),
      separator: box(date?.previousElementSibling),
      viewAllText: box(viewAllText),
      viewAllIcon: box(viewAll?.querySelector("svg")),
      currentTabs: [...(row?.querySelectorAll('nav [aria-current="page"]') ?? [])].map(
        (el) => el.textContent?.trim() ?? "",
      ),
      placeholderFits: ctx.measureText(input.placeholder).width <= input.clientWidth,
    };
  }, SEARCH_NAME);
}

const centre = (b: Box) => (b.top + b.bottom) / 2;
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

/** Sets `.dark` on `<html>`, or takes it off. */
const scheme = (page: Page, dark: boolean) =>
  page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);

/** SolidStart's dev toolbar, which `dev:app` draws over the page's bottom corner. */
const HIDE_DEV_TOOLBAR = "[data-start-dev-toolbar] { display: none !important; }";

async function shoot(page: Page, view: string, width: number): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: HIDE_DEV_TOOLBAR });
  for (const colorScheme of ["light", "dark"] as const) {
    await scheme(page, colorScheme === "dark");
    // Two frames, so the shot shows the page painted at this width: straight
    // after a resize the bottom of the frame can still hold the header drawn a
    // second time.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
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
    await expect(page.getByRole("textbox", { name: SEARCH_NAME })).toBeVisible();
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
    // At 768 the signed-in row narrows the search to about 170px, and its
    // placeholder ends in an ellipsis: `pulse/DESIGN.md` §Navigation.
    if (size.width !== MD) {
      flow.check(`${at}: the search placeholder is not clipped`, true, layout.placeholderFits);
    }
    const drop = Math.round(layout.row.bottom - layout.activeTab.bottom);
    // Below md the tabs have a line of their own, so the underline lands on
    // the border. From md up the row's tallest control centres the tab above
    // it, and the underline stays inside the row.
    flow.check(
      phone
        ? `${at}: the active tab's underline lands on the header's bottom border`
        : `${at}: the active tab's underline stays inside the header row`,
      true,
      phone ? drop === UNDERLINE_DROP : drop >= UNDERLINE_DROP,
    );
    flow.check(`${at}: the header pins`, phone ? "static" : "sticky", layout.headerPosition);
    flow.check(`${at}: Home is the current tab`, "Home", layout.currentTabs.join(" | "));
    flow.check(
      `${at}: the greeting's separator sits on the date's line`,
      true,
      near(centre(layout.separator), centre(layout.date)),
    );
    flow.check(
      `${at}: "View all" keeps its chevron on its line`,
      true,
      near(centre(layout.viewAllIcon), centre(layout.viewAllText)),
    );

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
      flow.check(
        `${at}: the greeting's date ends inside the gutter`,
        true,
        layout.date.right <= layout.innerWidth - GUTTER,
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

    if (SHOT_WIDTHS.has(size.width)) {
      await flow.step(`${at}: shoot the page`, () => shoot(page, who, size.width));
    }
  }

  await flow.step(`explore: ${who} back at 1280×720`, () => page.setViewportSize(DEFAULT));
}

/** One element's transition: the properties it fades, and their timing. */
interface Fade {
  readonly properties: readonly string[];
  readonly durations: readonly string[];
  readonly easings: readonly string[];
}

interface Motion {
  /** `animation-name` of the brand mark's dot and of every live dot on the page. */
  readonly loops: readonly string[];
  readonly tab: Fade;
  readonly search: Fade;
}

function readMotion(page: Page): Promise<Motion> {
  return page.evaluate((searchName) => {
    const row = document.querySelector("header")?.firstElementChild;
    const tab = row?.querySelector('nav [class*="explore-tab-active"]');
    const search = row?.querySelector(`input[aria-label="${searchName}"]`)?.parentElement;
    if (!tab || !search) throw new Error("explore header: tab or search missing");
    // Commas inside `cubic-bezier(…)` are not list separators.
    const list = (value: string) => value.split(/,(?![^(]*\))/).map((p) => p.trim());
    const fade = (el: Element) => {
      const style = getComputedStyle(el);
      return {
        properties: list(style.transitionProperty),
        durations: list(style.transitionDuration),
        easings: list(style.transitionTimingFunction),
      };
    };
    return {
      loops: [...document.querySelectorAll(".brand-pulse, .live-dot")].map(
        (el) => getComputedStyle(el).animationName,
      ),
      tab: fade(tab),
      search: fade(search),
    };
  }, SEARCH_NAME);
}

/** A fade timed `--ui-dur-fast` on `--ui-ease-out`, as `pulse/DESIGN.md` §Motion gives a hover. */
const fastOut = (f: Fade) =>
  f.durations.every((d) => d === DUR_FAST) && f.easings.every((e) => e === EASE_OUT);

/** The search box's outline while its input has focus. */
async function readSearchFocus(
  page: Page,
): Promise<{ style: string; width: string; color: string }> {
  const input = page.getByRole("textbox", { name: SEARCH_NAME });
  await input.focus();
  try {
    return await input.evaluate((el) => {
      const box = el.parentElement;
      if (!box) throw new Error("explore header: search box missing");
      const style = getComputedStyle(box);
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
    });
  } finally {
    await input.blur();
  }
}

/**
 * The header's motion, against `pulse/DESIGN.md` §Motion: the tab fades its
 * colours and the search box its border, never the focus mark, and the brand
 * mark's and live dots' loops run, then stop under `prefers-reduced-motion:
 * reduce`. Leaves the page with no reduced-motion emulation.
 */
export async function exploreMotion(flow: Flow, page: Page): Promise<void> {
  const moving = await flow.step("explore: read the header's motion", () => readMotion(page));
  flow.check(
    "explore: the brand mark and live dots loop",
    true,
    moving.loops.length >= 2 && moving.loops.every((name) => name !== "none"),
  );
  flow.check(
    "explore: the tab fades its colours, not its focus outline",
    true,
    moving.tab.properties.includes("color") && !moving.tab.properties.includes("outline-color"),
  );
  flow.check(
    "explore: the search box fades its border, not its focus outline",
    true,
    moving.search.properties.includes("border-color") &&
      !moving.search.properties.some((p) => ["outline-color", "box-shadow", "all"].includes(p)),
  );
  flow.check("explore: the tab's fade is fast and eases out", true, fastOut(moving.tab));
  flow.check("explore: the search box's fade is fast and eases out", true, fastOut(moving.search));

  const focus = await flow.step("explore: focus the search", () => readSearchFocus(page));
  // An outline, not a box-shadow ring: forced-colours mode keeps an outline.
  flow.check(
    "explore: the focused search draws a 2px outline",
    true,
    focus.style === "solid" && focus.width === "2px" && focus.color !== "rgba(0, 0, 0, 0)",
  );

  const reduced = await flow.step("explore: read the loops under reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      return await readMotion(page);
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
  });
  flow.check(
    "explore: the loops stop under reduced motion",
    true,
    reduced.loops.length === moving.loops.length && reduced.loops.every((name) => name === "none"),
  );
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
    flow.check(`${at}: both times are drawn`, true, startBox !== null && endBox !== null);
    if (startBox && endBox) {
      if (size.width < MD) {
        flow.check(
          `${at}: the end time sits under the start time`,
          true,
          endBox.y >= startBox.y + startBox.height,
        );
      } else {
        flow.check(
          `${at}: the end time sits beside the start time`,
          true,
          near(startBox.y, endBox.y) && endBox.x >= startBox.x + startBox.width,
        );
      }
    }
    if (size.width === 390) {
      await flow.step(`${at}: shoot the form`, async () => {
        mkdirSync(SHOTS, { recursive: true });
        await page.addStyleTag({ content: HIDE_DEV_TOOLBAR });
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
