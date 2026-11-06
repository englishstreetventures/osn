/**
 * Musubi's base styles, measured and pictured: the ink a resting label takes,
 * the hairline a bare `border` draws, the colour fade that leaves the focus
 * ring out, the house focus outline (inset where a box would clip it), the
 * 8px corner a text field's edge sits on, and the legal pages' prose. Each rule
 * lives in `musubi/social/src/App.css` and reaches many screens at once, so a
 * lost rule shows here before it shows on any one of them.
 *
 * `musubi-passkey` calls it while signed in, after its own `POST /token`
 * check, so it spends no sign-in of its own (`tests/flows.test.ts` counts
 * them). Every check reads computed style against a probe painted with the
 * token itself, as `cire-surfaces.ts` does, so a token that resolves elsewhere
 * fails it. Each view is shot into `screenshots/musubi-surfaces/`.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "musubi-surfaces");
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
const WIDTHS = [PHONE, DESKTOP] as const;
const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

/** Tailwind's `transition-colors` with the outline left out: the house fade. */
const HOUSE_FADE = "color, background-color, border-color, text-decoration-color";

/** The app follows the system scheme live (`src/lib/theme.ts`); wait for `.dark` to follow. */
async function scheme(page: Page, colorScheme: Scheme): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await page.waitForFunction(
    (dark) => document.documentElement.classList.contains("dark") === dark,
    colorScheme === "dark",
  );
}

/** One width and scheme, with the rail or the bottom bar that width mounts. */
async function at(page: Page, size: { width: number; height: number }, colorScheme: Scheme) {
  await page.setViewportSize(size);
  await scheme(page, colorScheme);
  await expect(size.width >= 768 ? rail(page) : primaryBar(page)).toBeVisible();
  // A scheme change fades every `transition-ui-colors` row; a read or a shot
  // taken mid-fade sees the colour between the two themes.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
}

const primaryBar = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const rail = (page: Page) => page.locator("aside");

/** One computed property of `target`. */
function computed(target: Locator, property: string): Promise<string> {
  return target.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

/** `value` resolved by the browser as a colour, on a probe beside `target`. */
function painted(target: Locator, value: string): Promise<string> {
  return target.evaluate((el, colour) => {
    const probe = document.createElement("span");
    probe.style.color = colour;
    el.parentElement!.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, value);
}

/** Waits out `target`'s running transitions, so a read is of the settled colour. */
async function settled(target: Locator): Promise<void> {
  await target.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
}

/** Outline style, width and offset, in one string. */
async function outline(target: Locator): Promise<string> {
  const [style, width, offset] = await Promise.all([
    computed(target, "outline-style"),
    computed(target, "outline-width"),
    computed(target, "outline-offset"),
  ]);
  return `${style} ${width} ${offset}`;
}

/** Focus `before` from script, then Tab to `target`, as a keyboard user arrives. */
async function tabTo(page: Page, before: Locator, target: Locator): Promise<void> {
  await before.focus();
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  expect(await target.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
}

/** Shoots the view at `size` × `colorScheme`, after `settle`. */
async function shoot(
  page: Page,
  view: string,
  settle: () => Promise<void>,
  options: { widths?: readonly { width: number; height: number }[]; whole?: boolean } = {},
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  for (const size of options.widths ?? WIDTHS) {
    for (const colorScheme of SCHEMES) {
      await at(page, size, colorScheme);
      await settle();
      if (options.whole) {
        // The page scrolls inside the app's column, not the document, so a
        // full-page shot would stop at the viewport. Grow the viewport to the
        // column's whole height instead.
        const extra = await page.evaluate(() => {
          const column = document.querySelector("article")!.closest(".overflow-y-auto")!;
          return column.scrollHeight - column.clientHeight;
        });
        await page.setViewportSize({ width: size.width, height: size.height + extra });
      }
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: resolve(SHOTS, `${view}-${size.width}-${colorScheme}.png`),
        animations: "disabled",
      });
    }
  }
}

/** Rail, bottom bar, borders and focus, on the signed-in Connections page. */
async function shell(flow: Flow, page: Page): Promise<void> {
  await at(page, DESKTOP, "light");
  const discover = rail(page).getByRole("link", { name: "Discover" });

  for (const colorScheme of SCHEMES) {
    await at(page, DESKTOP, colorScheme);
    const [div, field] = await page.evaluate(() => {
      const box = document.createElement("div");
      box.className = "border";
      const input = document.createElement("input");
      input.className = "border";
      document.body.append(box, input);
      const read = [getComputedStyle(box).borderTopColor, getComputedStyle(input).borderTopColor];
      box.remove();
      input.remove();
      return read;
    });
    flow.check(
      `shell (${colorScheme}): a bare border draws the hairline`,
      await painted(discover, "var(--border)"),
      div ?? "",
    );
    flow.check(
      `shell (${colorScheme}): a bare-bordered field draws the field edge`,
      await painted(discover, "var(--input)"),
      field ?? "",
    );
  }

  await at(page, DESKTOP, "light");
  flow.check(
    "rail: a link fades its colours and never its outline",
    HOUSE_FADE,
    await computed(discover, "transition-property"),
  );
  const social = rail(page).getByText("Social", { exact: true });
  flow.check(
    "rail: the wordmark's tag rests in --subtle",
    await painted(social, "var(--subtle)"),
    await computed(social, "color"),
  );
  flow.check(
    "rail: --subtle is #8d8d8d in light",
    "rgb(141, 141, 141)",
    await computed(social, "color"),
  );

  await flow.step("surfaces: reach a rail link from the keyboard", () =>
    tabTo(page, rail(page).getByRole("link", { name: "Connections" }), discover),
  );
  flow.check(
    "rail: a focused link takes the house outline",
    "solid 2px 2px",
    await outline(discover),
  );
  flow.check(
    "rail: the outline is the focus colour",
    await painted(discover, "var(--ring)"),
    await computed(discover, "outline-color"),
  );

  const filters = page.getByRole("navigation", { name: "Connection filters" });
  const tabs = filters.getByRole("button");
  await flow.step("surfaces: reach a section tab from the keyboard", async () => {
    await expect(tabs.nth(1)).toBeVisible();
    await tabTo(page, tabs.first(), tabs.nth(1));
  });
  flow.check(
    "tabs: a focused tab draws its outline inside the scrolling row",
    "solid 2px -2px",
    await outline(tabs.nth(1)),
  );
  await flow.step("surfaces: shoot a focused section tab", () =>
    shoot(page, "connections-tab-focus", async () => {
      await tabTo(page, tabs.first(), tabs.nth(1));
    }),
  );

  await at(page, PHONE, "light");
  const bar = primaryBar(page);
  const tab = bar.getByRole("link", { name: "Discover" });
  await settled(tab);
  flow.check(
    "bottom bar: a resting tab's label is secondary ink",
    await painted(tab, "var(--muted-foreground)"),
    await computed(tab.getByText("Discover", { exact: true }), "color"),
  );
  flow.check(
    "bottom bar: a resting tab's icon is --subtle",
    await painted(tab, "var(--subtle)"),
    await computed(tab.locator("svg"), "color"),
  );
  await flow.step("surfaces: reach a bottom-bar tab from the keyboard", () =>
    tabTo(page, bar.getByRole("link", { name: "Search" }), tab),
  );
  flow.check(
    "bottom bar: a focused tab draws its outline inside the cell",
    "solid 2px -2px",
    await outline(tab),
  );
  await flow.step("surfaces: shoot a focused bottom-bar tab", () =>
    shoot(
      page,
      "bottom-bar-focus",
      async () => {
        await tabTo(page, bar.getByRole("link", { name: "Search" }), tab);
      },
      { widths: [PHONE] },
    ),
  );
}

/** Settings → Security: the rows and rules a bare `border` draws, as hairlines. */
async function security(flow: Flow, page: Page): Promise<void> {
  const row = page.locator("li.rounded-md.border").first();
  await flow.step("surfaces: open Settings → Security", async () => {
    await at(page, DESKTOP, "light");
    await rail(page).getByRole("link", { name: "Settings" }).click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Security" })
      .click();
    await expect(page.getByRole("heading", { name: "Recovery codes" })).toBeVisible();
    await expect(row).toBeVisible();
  });
  flow.check(
    "security: a passkey row's edge is the hairline",
    await painted(row, "var(--border)"),
    await computed(row, "border-top-color"),
  );
  const rule = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Recovery codes" }) });
  flow.check(
    "security: the rule between sections is the hairline",
    await painted(rule, "var(--border)"),
    await computed(rule, "border-top-color"),
  );
  await flow.step("surfaces: shoot Settings → Security", () =>
    shoot(page, "security", async () => {
      await expect(row).toBeVisible();
      await settled(row);
    }),
  );
}

/** `/privacy` and `/terms`: the body on Musubi's scale, the header left alone. */
async function legal(flow: Flow, page: Page): Promise<void> {
  for (const [view, title] of [
    ["privacy", "Privacy Notice"],
    ["terms", "Terms of Service"],
  ] as const) {
    const heading = page.getByRole("heading", { level: 1, name: title });
    await flow.step(`surfaces: open /${view}`, async () => {
      await page.goto(`${ORIGINS.musubi}/${view}`);
      await at(page, DESKTOP, "light");
      await expect(heading).toBeVisible();
    });
    const prose = page.locator(".prose-legal");
    const h2 = prose.locator("h2").first();
    const p = prose.locator("h2 ~ p").first();
    const type = async (target: Locator) =>
      `${await computed(target, "font-size")} ${await computed(target, "font-weight")}`;
    flow.check(`${view}: a section heading is 14px at 500`, "14px 500", await type(h2));
    flow.check(`${view}: a paragraph is 13px`, "13px", await computed(p, "font-size"));
    flow.check(`${view}: a paragraph's line is 1.65`, "21.45px", await computed(p, "line-height"));
    flow.check(
      `${view}: the "Last updated" line keeps its own line height`,
      "20px",
      await computed(page.getByText(/^Last updated:/), "line-height"),
    );
    if (view === "privacy") {
      flow.check(
        "privacy: a subsection heading is 13px at 500",
        "13px 500",
        await type(prose.locator("h3").first()),
      );
    } else {
      const list = prose.locator("ul").first();
      flow.check("terms: a list takes discs", "disc", await computed(list, "list-style-type"));
      flow.check(
        "terms: a list item is 13px on a 1.65 line",
        "13px 21.45px",
        `${await computed(list.locator("li").first(), "font-size")} ${await computed(list.locator("li").first(), "line-height")}`,
      );
      flow.check(
        "terms: bold in the body is 500",
        "500",
        await computed(prose.locator("strong").first(), "font-weight"),
      );
    }
    await flow.step(`surfaces: shoot /${view}`, () =>
      shoot(page, view, () => expect(heading).toBeVisible(), { whole: true }),
    );
  }
}

/**
 * Every surface above, then the viewport and scheme the flow had, so its next
 * step finds the page as it left it.
 */
export async function musubiSurfaces(flow: Flow, page: Page): Promise<void> {
  const viewport = page.viewportSize();
  await shell(flow, page);
  await security(flow, page);
  await legal(flow, page);
  if (viewport) await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: null });
}
