/**
 * Musubi's base styles, measured and pictured: the ink a resting label takes,
 * the hairline a bare `border` draws and the ink edge a bare field keeps, the
 * colour fade that leaves the focus ring out, the house focus outline (inset
 * where a box would clip it), the 8px corner a text field's edge sits on, the
 * theme menu's radio rows, the bar that marks the current bottom-bar tab, and
 * the legal pages' head and prose, and (`musubiNotice`) the notices the shell
 * draws. Each rule lives in
 * `musubi/social/src/App.css` or one shared shell part and reaches many
 * screens at once, so a lost rule shows here before it shows on any one of
 * them.
 *
 * `musubi-passkey` calls it while signed in, after its own `POST /token`
 * check, so it spends no sign-in of its own (`tests/flows.test.ts` counts
 * them). Every check reads computed style against a probe painted with the
 * token itself, or wearing the class itself, as `cire-surfaces.ts` does, so a
 * token that resolves elsewhere fails it. Each view is shot into
 * `screenshots/musubi-surfaces/`.
 *
 * The exports after it check the call sites that draw from shared parts, from
 * the flows that already reach them: `musubi-org-detail` the organisation
 * dialogs (their plain `Field` labels among them), list rows, roster, a search
 * result, the row actions' phone height and `/authorize`'s dead end;
 * `musubi-passkey` the create-account and sign-in dialogs' fields and
 * standalone link, a busy button, Discover's empty note, the authenticator
 * setup's span labels, the signed-out note, `/authorize`'s link inside a
 * sentence, the first-party consent screen's mark and chosen profile, and the
 * third-party consent screen's chip and scope rows. Each puts back the
 * viewport, scheme and motion preference it found.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";
import { menuSeparator } from "./menu-separator";
import { type HeldFrame, holdOverlay } from "./overlay-frames";

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

/**
 * One width and scheme, with the rail or the bottom bar that width mounts —
 * or, on `/authorize`, which runs with no shell, none.
 */
async function at(
  page: Page,
  size: { width: number; height: number },
  colorScheme: Scheme,
  bare = false,
) {
  await page.setViewportSize(size);
  await scheme(page, colorScheme);
  if (!bare) await expect(size.width >= 768 ? rail(page) : primaryBar(page)).toBeVisible();
  // A scheme change fades every `transition-ui-colors` row; a read or a shot
  // taken mid-fade sees the colour between the two themes.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
}

// By selector, not role: a modal menu or dialog hides the rest of the page from
// the accessibility tree, and `at()` still has to find the shell behind it.
const primaryBar = (page: Page) => page.locator('nav[aria-label="Primary"]');
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

/**
 * The value `property` takes on a probe that wears `classes` beside `target`,
 * so the probe sits in the same scope and the class decides it.
 */
function probed(target: Locator, classes: string, property: string): Promise<string> {
  return target.evaluate(
    (el, [cls, prop]) => {
      const probe = document.createElement("span");
      probe.className = cls!;
      el.parentElement!.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(prop!);
      probe.remove();
      return value;
    },
    [classes, property] as const,
  );
}

/** Font size and weight, in one string: "14px 500", read from one element in one pass. */
function type(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.fontSize} ${style.fontWeight}`;
  });
}

/** Font size and weight a probe wearing `classes` takes beside `target`. */
async function probedType(target: Locator, classes: string): Promise<string> {
  return `${await probed(target, classes, "font-size")} ${await probed(target, classes, "font-weight")}`;
}

/** Padding on all four sides, in one string. */
async function padding(target: Locator): Promise<string> {
  const sides = ["top", "right", "bottom", "left"] as const;
  const read = await Promise.all(sides.map((side) => computed(target, `padding-${side}`)));
  return read.join(" ");
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

/**
 * An overlay's held frame, read as Musubi's fade with no scale: no transform
 * on it, and opacity 0 as it starts to open or part-faded half-way out
 * (DESIGN.md §Motion).
 */
function fadesOnly(flow: Flow, what: string, run: "open" | "close", frame: HeldFrame): void {
  const when = run === "open" ? "as it opens" : "half-way out";
  flow.check(`${what}: no transform ${when}`, true, frame.identity);
  if (run === "open") flow.check(`${what}: opacity 0 as it opens`, 0, frame.opacity);
  else flow.check(`${what}: part-faded half-way out`, true, frame.opacity > 0 && frame.opacity < 1);
}

/**
 * A sheet's held frame, read as its slide below `md` (DESIGN.md §Motion): at
 * full opacity and unscaled throughout, its own height below the bottom edge
 * as it starts to open, part-way down half-way out.
 */
function slides(flow: Flow, what: string, run: "open" | "close", frame: HeldFrame): void {
  const when = run === "open" ? "as it opens" : "half-way out";
  flow.check(`${what}: unscaled ${when}`, 1, frame.scale);
  flow.check(`${what}: full opacity ${when}`, 1, frame.opacity);
  if (run === "open") {
    flow.check(
      `${what}: its own height below the edge as it opens`,
      true,
      Math.abs(frame.shiftY - frame.height) <= 1,
    );
  } else {
    flow.check(
      `${what}: part-way down half-way out`,
      true,
      frame.shiftY > 0 && frame.shiftY < frame.height,
    );
  }
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
  options: {
    widths?: readonly { width: number; height: number }[];
    whole?: boolean;
    bare?: boolean;
  } = {},
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  for (const size of options.widths ?? WIDTHS) {
    for (const colorScheme of SCHEMES) {
      await at(page, size, colorScheme, options.bare);
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
  const discover = rail(page).getByRole("link", { name: "Discover" });

  for (const colorScheme of SCHEMES) {
    await at(page, DESKTOP, colorScheme);
    const [div, field, ink] = await page.evaluate(() => {
      const box = document.createElement("div");
      box.className = "border";
      const input = document.createElement("input");
      input.className = "border";
      document.body.append(box, input);
      const read = [
        getComputedStyle(box).borderTopColor,
        getComputedStyle(input).borderTopColor,
        getComputedStyle(input).color,
      ];
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
      `shell (${colorScheme}): a bare-bordered field keeps its ink edge`,
      ink ?? "",
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
  const current = bar.getByRole("link", { name: "Connections" });
  await settled(tab);
  await settled(current);
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
  flow.check(
    "bottom bar: the current tab draws a 2px bar on its top edge",
    "2px",
    await computed(current, "border-top-width"),
  );
  flow.check(
    "bottom bar: the current tab's bar is full ink",
    await painted(current, "var(--foreground)"),
    await computed(current, "border-top-color"),
  );
  flow.check(
    "bottom bar: a resting tab draws no bar",
    "rgba(0, 0, 0, 0)",
    await computed(tab, "border-top-color"),
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

/**
 * The rail's theme menu and account menu, then the phone's account menu and
 * the profile switcher it opens: the shared radio rows, the house outline on
 * two controls drawn by hand, the account menu's separator as a hairline, the
 * switcher's title on Musubi's title step, the fade with no scale each menu
 * opens and closes on, and the switcher's slide, a sheet at the phone width.
 */
async function menus(flow: Flow, page: Page): Promise<void> {
  await at(page, DESKTOP, "light");
  // Out of the way of every menu, so no row takes the pointer's highlight.
  await page.mouse.move(0, 0);
  const theme = rail(page).getByRole("button", { name: /^Theme:/ });
  const rows = page.getByRole("menuitemradio");
  await flow.step("surfaces: open the theme menu from the keyboard", async () => {
    await theme.focus();
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
  });
  flow.check(
    "theme menu: the theme in force is the checked radio row",
    "System",
    (await page.getByRole("menuitemradio", { checked: true }).textContent()) ?? "",
  );
  flow.check(
    "theme menu: a focused row takes the sunk fill",
    await painted(rows.nth(1), "var(--ui-surface-sunk)"),
    await computed(rows.nth(1), "background-color"),
  );
  await flow.step("surfaces: shoot the theme menu", async () => {
    await shoot(page, "theme-menu", () => expect(rows.nth(1)).toBeFocused(), {
      widths: [DESKTOP],
    });
    await page.keyboard.press("Escape");
    await expect(rows).toHaveCount(0);
  });

  await at(page, DESKTOP, "light");
  const account = rail(page).getByRole("button", { name: /@/ });
  await flow.step("surfaces: reach the rail's account menu from the keyboard", () =>
    tabTo(page, rail(page).locator("nav a").last(), account),
  );
  flow.check(
    "rail: the account menu's trigger takes the house outline",
    "solid 2px 2px",
    await outline(account),
  );
  const menu = page.getByRole("menu");
  const rule = menu.getByRole("separator").first();
  const railOpened = await holdOverlay(page, '[role="menu"]', "ui-enter", 0);
  await flow.step("surfaces: open the rail's account menu", async () => {
    await page.keyboard.press("Enter");
    await expect(rule).toBeVisible();
  });
  fadesOnly(flow, "rail's account menu", "open", await railOpened());
  await menuSeparator(flow, "rail's account menu separator (light)", rule);
  await flow.step("surfaces: shoot the rail's account menu", () =>
    shoot(page, "account-menu", () => expect(rule).toBeVisible(), { widths: [DESKTOP] }),
  );
  await menuSeparator(flow, "rail's account menu separator (dark)", rule);
  const railClosed = await holdOverlay(page, '[role="menu"]', "ui-exit", 0.5);
  await flow.step("surfaces: close the rail's account menu", async () => {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
  fadesOnly(flow, "rail's account menu", "close", await railClosed());

  await at(page, PHONE, "light");
  const header = page.locator("header");
  const avatar = header.getByRole("button").last();
  await flow.step("surfaces: reach the top bar's account menu from the keyboard", () =>
    tabTo(page, header.getByRole("button", { name: /^Theme:/ }), avatar),
  );
  flow.check(
    "top bar: the account menu's trigger takes the house outline",
    "solid 2px 2px",
    await outline(avatar),
  );
  const switchProfile = page.getByRole("menuitem", { name: "Switch profile" });
  const barOpened = await holdOverlay(page, '[role="menu"]', "ui-enter", 0);
  await flow.step("surfaces: open the top bar's account menu", async () => {
    await page.keyboard.press("Enter");
    await expect(switchProfile).toBeFocused();
  });
  fadesOnly(flow, "top bar's account menu", "open", await barOpened());
  await menuSeparator(flow, "top bar's account menu separator (light)", rule);
  await flow.step("surfaces: shoot the top bar's account menu", () =>
    shoot(page, "account-menu", () => expect(switchProfile).toBeFocused(), { widths: [PHONE] }),
  );
  await menuSeparator(flow, "top bar's account menu separator (dark)", rule);

  await at(page, PHONE, "light");
  const switcher = page.getByRole("dialog", { name: "Switch profile" });
  const title = switcher.getByRole("heading", { name: "Switch profile" });
  const profile = switcher.getByRole("button").first();
  const switcherOpened = await holdOverlay(page, '[role="dialog"]', "ui-sheet-enter", 0);
  await flow.step("surfaces: open the profile switcher from the keyboard", async () => {
    await expect(switchProfile).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(profile).toBeVisible();
    // The dialog holds focus; Tab lands on its one row as a keyboard user's would.
    await page.keyboard.press("Tab");
    await expect(profile).toBeFocused();
    expect(await profile.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  });
  slides(flow, "profile switcher (sheet)", "open", await switcherOpened());
  flow.check(
    "profile switcher: the title is at title size and 500",
    await probedType(title, "text-title font-medium"),
    await type(title),
  );
  flow.check(
    "profile switcher: a focused row draws its outline inside the row",
    "solid 2px -2px",
    await outline(profile),
  );
  await flow.step("surfaces: shoot a focused profile row", () =>
    shoot(page, "profile-switcher-focus", () => expect(profile).toBeFocused(), {
      widths: [PHONE],
    }),
  );
  // The dialog stays open across the 768px switch: a sheet below, a card above.
  await flow.step("surfaces: shoot the profile switcher", () =>
    shoot(page, "profile-switcher", () => expect(title).toBeVisible()),
  );
  await at(page, PHONE, "light");
  const switcherClosed = await holdOverlay(page, '[role="dialog"]', "ui-sheet-exit", 0.5);
  await flow.step("surfaces: close the profile switcher", async () => {
    await page.keyboard.press("Escape");
    await expect(switcher).toHaveCount(0);
  });
  slides(flow, "profile switcher (sheet)", "close", await switcherClosed());
}

/**
 * Settings: the Profile section's name and the add-a-profile card's title at
 * title size, its hint in secondary ink and its field on the 8px corner, then
 * Security's rows and rules, drawn as hairlines.
 */
async function security(flow: Flow, page: Page, profileName: string): Promise<void> {
  // A passkey row: `Card radius="md" padding="sm"` inside its `li`, the nested row's 8px corner.
  const row = page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: /^Rename / }) })
    .first()
    .locator(":scope > div");
  const hint = page.getByText("Handles cannot be changed.", { exact: true });
  await flow.step("surfaces: open Settings → Profile", async () => {
    await at(page, DESKTOP, "light");
    await rail(page).getByRole("link", { name: "Settings" }).click();
    await expect(hint).toBeVisible();
  });
  const name = page.getByRole("main").getByText(profileName, { exact: true });
  flow.check(
    "settings: the profile's name is at title size and 500",
    await probedType(name, "text-title font-medium"),
    await type(name),
  );
  // The person has one profile and a fresh browser, so the card that offers a
  // second one shows; its `CardTitle` is the one card title Musubi draws.
  const onboarding = page.getByRole("heading", { name: "Add another profile" });
  await expect(onboarding).toBeVisible();
  flow.check(
    "settings: the add-a-profile card's title is at title size and 500",
    await probedType(onboarding, "text-title font-medium"),
    await type(onboarding),
  );
  await flow.step("surfaces: shoot the add-a-profile card", () =>
    shoot(page, "profile-onboarding", () => expect(onboarding).toBeVisible()),
  );
  await at(page, DESKTOP, "light");
  flow.check(
    "settings: a field's hint is secondary ink",
    await painted(hint, "var(--muted-foreground)"),
    await computed(hint, "color"),
  );
  const handle = page.locator("input[disabled]").first();
  flow.check(
    "settings: a text field takes the 8px field corner",
    "8px",
    await computed(handle, "border-top-left-radius"),
  );
  await flow.step("surfaces: open Settings → Security", async () => {
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Security" })
      .click();
    await expect(page.getByRole("heading", { name: "Recovery codes" })).toBeVisible();
    await expect(row).toBeVisible();
  });
  flow.check(
    "security: a passkey row draws a 1px edge",
    "1px",
    await computed(row, "border-top-width"),
  );
  flow.check(
    "security: a passkey row's edge is the hairline",
    await painted(row, "var(--border)"),
    await computed(row, "border-top-color"),
  );
  await securityPanelSurfaces(flow, page, row);
  const rule = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Recovery codes" }) });
  flow.check(
    "security: the rule between sections is 1px",
    "1px",
    await computed(rule, "border-top-width"),
  );
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

/**
 * Settings → Security's own parts, each read against a probe wearing the
 * classes the contract gives it: the panel headings at `DialogTitle`'s type,
 * a passkey row as a nested `Card` (8px corner, 16px inside, the card's
 * fill), its meta line and its actions 40px tall on a phone, and the
 * "Signing in somewhere new?" summary taking Button's ring from the keyboard.
 */
async function securityPanelSurfaces(flow: Flow, page: Page, row: Locator): Promise<void> {
  for (const name of ["Passkeys", "Authenticator app", "Recovery codes"]) {
    const heading = page.getByRole("heading", { name, exact: true });
    flow.check(
      `security: the "${name}" heading is at the title step and weight`,
      await probedType(heading, "text-ui-md font-ui-title"),
      await type(heading),
    );
  }
  flow.check(
    "security: a passkey row takes the nested card's 8px corner",
    await probed(row, "rounded-ui-md", "border-top-left-radius"),
    await computed(row, "border-top-left-radius"),
  );
  flow.check("security: a passkey row is 16px inside", "16px 16px 16px 16px", await padding(row));
  flow.check(
    "security: a passkey row takes the card's fill",
    await painted(row, "var(--ui-surface)"),
    await computed(row, "background-color"),
  );
  const meta = row.getByText(/^Added /);
  flow.check(
    "security: a passkey row's meta line is the meta step in the secondary ink",
    `${await probedType(meta, "text-ui-xs font-normal")} ${await probed(meta, "text-ui-ink-secondary", "color")}`,
    `${await type(meta)} ${await computed(meta, "color")}`,
  );
  await onPhone(page, async () => {
    await phoneTall(flow, row.getByRole("button", { name: /^Rename / }), "security: Rename");
    await phoneTall(flow, row.getByRole("button", { name: /^Remove / }), "security: Remove");
  });
  const summary = page.getByText("Signing in somewhere new?", { exact: true });
  await tabTo(page, row.getByRole("button", { name: /^Remove / }), summary);
  flow.check(
    "security: the summary takes Button's 2px focus ring, no outline",
    `none ${await probed(summary, "ring-2 ring-ui-focus", "box-shadow")}`,
    `${await computed(summary, "outline-style")} ${await computed(summary, "box-shadow")}`,
  );
  // Focus leaves the page's controls, so the shots after this show no ring.
  await summary.evaluate((el) => (el as HTMLElement).blur());
}

/**
 * A removal's step-up sheet on a phone: a bottom sheet as wide as the screen,
 * shot in both schemes.
 */
export async function removalSheetSurfaces(flow: Flow, page: Page, sheet: Locator): Promise<void> {
  await restoring(page, async () => {
    await at(page, PHONE, "light");
    const box = await sheet.boundingBox();
    flow.check(
      "removal sheet: as wide as a 390px screen",
      PHONE.width,
      Math.round(box?.width ?? 0),
    );
    flow.check(
      "removal sheet: pinned to the bottom edge",
      PHONE.height,
      Math.round((box?.y ?? 0) + (box?.height ?? 0)),
    );
    await flow.step("surfaces: shoot the removal sheet", () =>
      shoot(page, "totp-remove-sheet", () => expect(sheet).toBeVisible(), { widths: [PHONE] }),
    );
  });
}

/** `/privacy` and `/terms`: the page head and the body, on Musubi's scale. */
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
    flow.check(`${view}: a section heading is 14px at 500`, "14px 500", await type(h2));
    flow.check(`${view}: a paragraph is 13px`, "13px", await computed(p, "font-size"));
    flow.check(`${view}: a paragraph's line is 1.65`, "21.45px", await computed(p, "line-height"));
    flow.check(`${view}: the title is 24px at 500`, "24px 500", await type(heading));
    const updated = page.getByText(/^Last updated:/);
    flow.check(
      `${view}: the "Last updated" line is a 13px subtitle on an 18px line`,
      "13px 18px",
      `${await computed(updated, "font-size")} ${await computed(updated, "line-height")}`,
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
    // The contact address: a link inside a sentence on /privacy, and the
    // whole paragraph under "Contact" on /terms. `.prose-legal` sets no rule
    // on `a`, so the link classes alone decide it.
    const address = prose.locator('a[href^="mailto:"]').first();
    await settled(address);
    flow.check(
      `${view}: the contact address flows in its line`,
      "inline",
      await computed(address, "display"),
    );
    await inlineLink(flow, `${view}: the contact address`, address);
    await flow.step(`surfaces: shoot /${view}`, () =>
      shoot(page, view, () => expect(heading).toBeVisible(), { whole: true }),
    );
  }
}

/**
 * One notice the shell draws — the signed-out note, a failed list, a page that
 * did not load — measured and pictured at both widths in both schemes: its
 * ink against a probe painted with `token`, the contract colour its tone
 * names, so a tone that resolves elsewhere fails here. Shot into
 * `screenshots/musubi-surfaces/<view>-<width>-<scheme>.png`. Leaves the
 * viewport and scheme as it found them.
 */
export async function musubiNotice(
  flow: Flow,
  page: Page,
  view: string,
  notice: Locator,
  token: string,
): Promise<void> {
  const viewport = page.viewportSize();
  for (const size of WIDTHS) {
    for (const colorScheme of SCHEMES) {
      await at(page, size, colorScheme);
      await expect(notice).toBeVisible();
      await settled(notice);
      flow.check(
        `${view} (${size.width}px, ${colorScheme}): the notice's ink is ${token}`,
        await painted(notice, `var(${token})`),
        await computed(notice, "color"),
      );
    }
  }
  await flow.step(`surfaces: shoot ${view}`, () =>
    shoot(page, view, () => expect(notice).toBeVisible()),
  );
  if (viewport) await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: null });
}

/**
 * Every surface above, then the viewport and scheme the flow had, so its next
 * step finds the page as it left it.
 */
export async function musubiSurfaces(flow: Flow, page: Page, profileName: string): Promise<void> {
  const viewport = page.viewportSize();
  await shell(flow, page);
  await menus(flow, page);
  await security(flow, page, profileName);
  await legal(flow, page);
  if (viewport) await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: null });
}

/**
 * Runs `body`, then puts back the viewport the flow had, the system scheme and
 * the system's motion preference.
 */
async function restoring(page: Page, body: () => Promise<void>): Promise<void> {
  const viewport = page.viewportSize();
  try {
    await body();
  } finally {
    if (viewport) await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: null, reducedMotion: null });
  }
}

/** Runs `body` at the phone width, then puts back what `restoring` does. */
export async function onPhone(page: Page, body: () => Promise<void>): Promise<void> {
  await restoring(page, async () => {
    await page.setViewportSize(PHONE);
    await body();
  });
}

/**
 * A row's action on a phone: 40px tall, as every row action is below `md`
 * (`max-md:h-10`). Read at the width the page is at; `onPhone` sets it.
 */
export async function phoneTall(flow: Flow, button: Locator, what: string): Promise<void> {
  await expect(button).toBeVisible();
  flow.check(`${what}: 40px tall on a phone`, "40px", await computed(button, "height"));
}

/**
 * The code boxes' digits (`OtpInput`, through `--ui-text-md`): on Musubi's
 * title step from 768px, as a text field is, and 16px below it, where the
 * mobile input rule keeps a focused field from zooming the page (DESIGN.md
 * §Typography). `box` is one shown box; the flow passes the authenticator
 * setup's first. Read at the flow's own width, at 768px and on a phone; puts
 * back the viewport.
 */
export async function otpDigitSurfaces(flow: Flow, page: Page, box: Locator): Promise<void> {
  await expect(box).toBeVisible();
  const titleSize = await probed(box, "text-title", "font-size");
  flow.check("code boxes: a digit is at title size", titleSize, await computed(box, "font-size"));
  await restoring(page, async () => {
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(box).toBeVisible();
    flow.check(
      "code boxes at 768px: a digit is at title size",
      titleSize,
      await computed(box, "font-size"),
    );
    await page.setViewportSize(PHONE);
    await expect(box).toBeVisible();
    flow.check("code boxes on a phone: a digit is 16px", "16px", await computed(box, "font-size"));
  });
}

/** The vertical space between the bottom of `above` and the top of `below`, in whole px. */
async function gapBetween(above: Locator, below: Locator): Promise<string> {
  // The two boxes are read one after the other, so every animation that ends
  // is waited out first and nothing on the page moves between the reads. A
  // loading pulse never ends, so it is left running.
  await above.page().evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const [a, b] = await Promise.all([above.boundingBox(), below.boundingBox()]);
  if (!a || !b) return "no box";
  return `${Math.round(b.y - (a.y + a.height))}px`;
}

/** The text of every element `target`'s `aria-describedby` names, in order. */
function description(target: Locator): Promise<string> {
  return target.evaluate((el) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter((id) => id !== "")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" "),
  );
}

/**
 * A plain `Field` label (`@shared/ui`'s `Field`, `labelTreatment="plain"`):
 * `Label`'s default look — the control type step at 500, the full ink, the
 * words as written — 6px above its control.
 */
async function plainLabel(
  flow: Flow,
  name: string,
  label: Locator,
  control: Locator,
): Promise<void> {
  flow.check(
    `${name}: the label takes the control step at 500`,
    await probedType(label, "text-ui-base font-medium"),
    await type(label),
  );
  flow.check(
    `${name}: the label is full ink`,
    await painted(label, "var(--ui-ink)"),
    await computed(label, "color"),
  );
  flow.check(
    `${name}: the label is set as written`,
    "none",
    await computed(label, "text-transform"),
  );
  flow.check(
    `${name}: the label sits 6px above its control`,
    "6px",
    await gapBetween(label, control),
  );
}

/**
 * A form dialog's body and footer: the fields padded 16px from the dialog's
 * edge, the actions in `DialogFooter` under a hairline. `field` is one of the
 * body's fields, `action` the footer's commit button.
 */
async function formDialog(flow: Flow, label: string, field: Locator, action: Locator) {
  // The field sits in its label's column; the column sits in the body.
  const body = field.locator("xpath=../..");
  const footer = action.locator("xpath=..");
  flow.check(`${label}: the body is padded 16px`, "16px 16px 16px 16px", await padding(body));
  flow.check(`${label}: the footer is padded 16px`, "16px 16px 16px 16px", await padding(footer));
  flow.check(
    `${label}: the footer draws a 1px rule`,
    "1px",
    await computed(footer, "border-top-width"),
  );
  flow.check(
    `${label}: the footer's rule is the hairline`,
    await painted(footer, "var(--border)"),
    await computed(footer, "border-top-color"),
  );
}

/** A dialog's `DialogTitle`, on Musubi's title step at 500 (DESIGN.md §Typography). */
async function dialogTitle(flow: Flow, label: string, dialog: Locator, name: string) {
  const title = dialog.getByRole("heading", { name });
  flow.check(
    `${label}: the title is at title size and 500`,
    await probedType(title, "text-title font-medium"),
    await type(title),
  );
}

/**
 * The organisation create dialog, filled and not yet sent: the fade it opened
 * on (`opened`, held from before the click), its title, its padded body and
 * its footer, measured and shot as card and as sheet.
 */
export async function orgCreateDialogSurfaces(
  flow: Flow,
  page: Page,
  opened: () => Promise<HeldFrame>,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Create organisation" });
  const field = dialog.getByLabel("Handle", { exact: true });
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  fadesOnly(flow, "create dialog (card)", "open", await opened());
  await dialogTitle(flow, "create dialog", dialog, "Create organisation");
  await formDialog(flow, "create dialog", field, create);
  await plainLabel(
    flow,
    "create dialog: Handle",
    dialog.getByText("Handle", { exact: true }),
    field,
  );
  flow.check(
    "create dialog: the handle is described by its hint",
    "Lowercase letters, numbers, and underscores only.",
    await description(field),
  );
  await restoring(page, () =>
    flow.step("surfaces: shoot the create dialog", () =>
      shoot(page, "org-create-dialog", () => expect(dialog).toBeVisible()),
    ),
  );
}

/** The organisation edit dialog, filled and not yet saved. */
export async function orgEditDialogSurfaces(flow: Flow, page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Edit organisation" });
  await dialogTitle(flow, "edit dialog", dialog, "Edit organisation");
  await formDialog(
    flow,
    "edit dialog",
    dialog.getByLabel("Name", { exact: true }),
    dialog.getByRole("button", { name: "Save", exact: true }),
  );
}

/**
 * The organisations list: a row is a `Card` inside its link, on the card's
 * fill in both themes and the 16px corner, which keeps its fill under the
 * pointer while its chevron turns to full ink.
 */
export async function orgListSurfaces(flow: Flow, page: Page, link: Locator): Promise<void> {
  const card = link.locator(":scope > div");
  await restoring(page, async () => {
    for (const colorScheme of SCHEMES) {
      await at(page, DESKTOP, colorScheme);
      // Off the row: a read under the pointer would see the hover fill.
      await page.mouse.move(0, 0);
      await settled(card);
      flow.check(
        `organisations (${colorScheme}): a row takes the card's fill`,
        await painted(card, "var(--card)"),
        await computed(card, "background-color"),
      );
    }
    flow.check(
      "organisations: a row takes the 16px card corner",
      "16px",
      await computed(card, "border-top-left-radius"),
    );
    // The card keeps its fill under the pointer; the chevron marks the hover.
    const chevron = card.locator("svg");
    await link.hover();
    await settled(chevron);
    await settled(card);
    flow.check(
      "organisations: a hovered row keeps the card's fill",
      await painted(card, "var(--card)"),
      await computed(card, "background-color"),
    );
    flow.check(
      "organisations: a hovered row's chevron is full ink",
      await painted(chevron, "var(--foreground)"),
      await computed(chevron, "color"),
    );
    await page.mouse.move(0, 0);
    await flow.step("surfaces: shoot the organisations list", () =>
      shoot(page, "organisations", () => expect(card).toBeVisible()),
    );
  });
}

/**
 * An organisation's roster: a member's name at title size and 500, and the
 * role as an outlined `Chip` tag — pill corner, hairline edge, secondary ink,
 * 12px, set as written — reading "Admin" for the owner and "Member" for the
 * member, never the API's raw value.
 */
export async function orgRosterSurfaces(flow: Flow, page: Page, memberName: string): Promise<void> {
  const main = page.getByRole("main");
  const name = main.getByText(memberName, { exact: true });
  flow.check(
    "roster: a member's name is at title size and 500",
    await probedType(name, "text-title font-medium"),
    await type(name),
  );
  const chip = main.getByText("Member", { exact: true });
  flow.check(
    "roster: the role chip takes the pill corner",
    await probed(chip, "rounded-pill", "border-top-left-radius"),
    await computed(chip, "border-top-left-radius"),
  );
  flow.check(
    "roster: the role chip draws a 1px edge",
    "1px",
    await computed(chip, "border-top-width"),
  );
  flow.check(
    "roster: the role chip's edge is the hairline",
    await painted(chip, "var(--border)"),
    await computed(chip, "border-top-color"),
  );
  flow.check(
    "roster: the role chip's word is secondary ink",
    await painted(chip, "var(--muted-foreground)"),
    await computed(chip, "color"),
  );
  flow.check("roster: the role chip's word is 12px", "12px", await computed(chip, "font-size"));
  flow.check(
    "roster: the role chip is set as written",
    "none",
    await computed(chip, "text-transform"),
  );
  flow.check(
    "roster: the role chip reads in sentence case",
    "Member",
    (await chip.textContent()) ?? "",
  );
  flow.check(
    "roster: the owner's role reads Admin",
    1,
    await main.getByText("Admin", { exact: true }).count(),
  );
  await restoring(page, () =>
    flow.step("surfaces: shoot the organisation's roster", () =>
      shoot(page, "organisation", async () => {
        await expect(chip).toBeVisible();
        await settled(chip);
      }),
    ),
  );
}

/** A search result's name at title size and 500, and the rail's field at `Input`'s own 36px. */
export async function searchSurfaces(
  flow: Flow,
  page: Page,
  option: Locator,
  resultName: string,
): Promise<void> {
  const name = option.getByText(resultName, { exact: true });
  flow.check(
    "search: a result's name is at title size and 500",
    await probedType(name, "text-title font-medium"),
    await type(name),
  );
  flow.check(
    "search: the rail's field is Input's 36px",
    "36px",
    await computed(
      page.getByRole("combobox", { name: "Search people and organisations" }),
      "height",
    ),
  );
}

/**
 * `/authorize` with no request id: the dead-end box, a `Card` on the card's
 * fill in both themes. Opened with a page load; the route runs outside the
 * session provider, so it trades no cookie for a token and lists no profiles.
 */
export async function authorizeDeadSurfaces(flow: Flow, page: Page): Promise<void> {
  const heading = page.getByRole("heading", { level: 1, name: "This sign-in link is not valid." });
  await flow.step("surfaces: open /authorize with no request", async () => {
    await page.goto(`${ORIGINS.musubi}/authorize`);
    await expect(heading).toBeVisible();
  });
  const box = heading.locator("xpath=..");
  await restoring(page, async () => {
    for (const colorScheme of SCHEMES) {
      await at(page, DESKTOP, colorScheme, true);
      await settled(box);
      flow.check(
        `authorize (${colorScheme}): the dead-end box takes the card's fill`,
        await painted(box, "var(--card)"),
        await computed(box, "background-color"),
      );
    }
    flow.check(
      "authorize: the dead-end box takes the 16px card corner",
      "16px",
      await computed(box, "border-top-left-radius"),
    );
    await flow.step("surfaces: shoot /authorize's dead end", () =>
      shoot(page, "authorize-dead", () => expect(heading).toBeVisible(), { bare: true }),
    );
  });
}

/**
 * `/authorize`'s consent screen for a first-party client: "Verified by Musubi"
 * a `text-meta` line at 500, and the chosen profile's name at title size and
 * 500.
 */
export async function authorizeVerifiedSurfaces(
  flow: Flow,
  page: Page,
  profileName: string,
): Promise<void> {
  const verified = page.getByText("Verified by Musubi", { exact: true });
  flow.check(
    "authorize: the first-party mark takes text-meta at 500",
    await probedType(verified, "text-meta font-medium"),
    await type(verified),
  );
  flow.check(
    "authorize: the first-party mark is 12px",
    "12px",
    await computed(verified, "font-size"),
  );
  const name = page.getByText(profileName, { exact: true });
  flow.check(
    "authorize: the chosen profile's name is at title size and 500",
    await probedType(name, "text-title font-medium"),
    await type(name),
  );
}

/**
 * `/authorize`'s consent screen for a third-party client: "Third-party app" an
 * outlined `Chip` tag — pill corner, hairline edge — whose word keeps 500 at
 * 12px, and each scope row a `Card` on the card's fill in both themes.
 */
export async function authorizeThirdPartySurfaces(flow: Flow, page: Page): Promise<void> {
  const word = page.getByText("Third-party app", { exact: true });
  const chip = word.locator("xpath=..");
  flow.check("authorize: the third-party mark is 12px at 500", "12px 500", await type(word));
  flow.check(
    "authorize: the third-party chip takes the pill corner",
    await probed(chip, "rounded-pill", "border-top-left-radius"),
    await computed(chip, "border-top-left-radius"),
  );
  flow.check(
    "authorize: the third-party chip draws a 1px edge",
    "1px",
    await computed(chip, "border-top-width"),
  );
  flow.check(
    "authorize: the third-party chip's edge is the hairline",
    await painted(chip, "var(--border)"),
    await computed(chip, "border-top-color"),
  );
  // The app's name is its own words: it breaks anywhere, and at 320px the
  // checks under it stay on screen beside it.
  const name = page.getByRole("heading", { level: 1 });
  flow.check(
    "authorize: the app's name breaks anywhere",
    "anywhere",
    await computed(name, "overflow-wrap"),
  );
  const checks = chip.locator("xpath=..");
  await restoring(page, async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    const box = await checks.boundingBox();
    flow.check(
      "authorize at 320px: the third-party chip and the domain stay inside the screen",
      true,
      box !== null && box.x >= 0 && box.x + box.width <= 320,
    );
    await expect(word).toBeInViewport();
  });
  const scopeRow = page.getByRole("listitem").first().locator(":scope > div");
  await restoring(page, async () => {
    for (const colorScheme of SCHEMES) {
      await at(page, DESKTOP, colorScheme, true);
      await settled(scopeRow);
      flow.check(
        `authorize (${colorScheme}): a scope row takes the card's fill`,
        await painted(scopeRow, "var(--card)"),
        await computed(scopeRow, "background-color"),
      );
    }
    flow.check(
      "authorize: a scope row takes the 16px card corner",
      "16px",
      await computed(scopeRow, "border-top-left-radius"),
    );
    await flow.step("surfaces: shoot /authorize's third-party consent", () =>
      shoot(page, "authorize-third-party", () => expect(word).toBeVisible(), { bare: true }),
    );
  });
}

/**
 * A signed-out page's note: the message alone in the `<output>`, one Sign in
 * under it outside the live region, which opens the shell's sign-in dialog
 * and takes focus back when it closes.
 */
export async function signedOutSurfaces(flow: Flow, page: Page, message: string): Promise<void> {
  const main = page.getByRole("main");
  // No `.first()`: strict mode fails if the note draws its button twice.
  const signIn = main.getByRole("button", { name: "Sign in" });
  const note = main.getByRole("status").filter({ hasText: message });
  await expect(signIn).toBeVisible();
  flow.check(
    "signed out: the note's live region holds the message alone",
    message,
    (await note.textContent()) ?? "",
  );
  flow.check(
    "signed out: the note's Sign in sits outside its live region",
    true,
    await signIn.evaluate((el) => el.closest("output") === null),
  );
  const dialog = page.getByRole("dialog", { name: "Sign in to Musubi", exact: true });
  await flow.step("surfaces: open sign-in from the signed-out note", async () => {
    await signIn.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(signIn).toBeFocused();
  });
  flow.check(
    "signed out: closing the dialog gives focus back to the note's Sign in",
    true,
    await signIn.evaluate((el) => el === document.activeElement),
  );
  await restoring(page, () =>
    flow.step("surfaces: shoot the signed-out note", () =>
      shoot(page, "signed-out", () => expect(signIn).toBeVisible()),
    ),
  );
}

/**
 * The create-account dialog's details step, before anything is typed: every
 * field's label a plain `Field` label 6px above its control — Email's too,
 * though it is a bare `Label` beside its "i" — and the date of birth read with
 * its hint as its description. Then the "i" opens its popover, the one
 * Popover Musubi draws, held at its first frame opening and half-way closing
 * and found to fade with no scale, as the menus and card dialogs do (DESIGN.md
 * §Motion); the dialog stays open behind it.
 */
export async function registerFieldSurfaces(flow: Flow, page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Create your Musubi account", exact: true });
  const dob = dialog.getByLabel("Date of birth");
  await expect(dob).toBeVisible();
  await plainLabel(
    flow,
    "register: Date of birth",
    dialog.getByText("Date of birth", { exact: true }),
    dob,
  );
  flow.check(
    "register: the date of birth is described by its hint",
    "You must be 13 or older to create an account.",
    await description(dob),
  );
  const email = dialog.getByLabel("Email", { exact: true });
  flow.check(
    "register: Email's label row sits 6px above its control",
    "6px",
    await gapBetween(dialog.getByText("Email", { exact: true }).locator("xpath=.."), email),
  );
  await restoring(page, () =>
    flow.step("surfaces: shoot the register dialog's details", () =>
      shoot(page, "register-details", () => expect(dob).toBeVisible()),
    ),
  );

  // Kobalte gives the popover's panel `role="dialog"` too; the positioner
  // Popper wraps it in tells it from the register dialog.
  const panel = '[data-popper-positioner] [role="dialog"]';
  const uses = page.locator(panel);
  const opened = await holdOverlay(page, panel, "ui-enter", 0);
  await flow.step("register: open what the address is used for", async () => {
    await dialog.getByRole("button", { name: "What this address is used for" }).click();
    await expect(uses).toBeVisible();
  });
  fadesOnly(flow, "register's email popover", "open", await opened());
  const closed = await holdOverlay(page, panel, "ui-exit", 0.5);
  await flow.step("register: close what the address is used for", async () => {
    await page.keyboard.press("Escape");
    await expect(uses).toHaveCount(0);
    await expect(dob).toBeVisible();
  });
  fadesOnly(flow, "register's email popover", "close", await closed());
}

/**
 * The sign-in dialog, before anything is typed: "Email or @handle" a plain
 * `Field` label, and "Lost your passkey?" under Continue a standalone link —
 * `Button`'s `link` at `sm`, in the accent ink, no underline until hovered, a
 * 32px box centred under Continue.
 */
export async function signInLinkSurfaces(flow: Flow, page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Sign in to Musubi", exact: true });
  const identifier = dialog.getByLabel("Email or @handle");
  await expect(identifier).toBeVisible();
  await plainLabel(
    flow,
    "sign in: Email or @handle",
    dialog.getByText("Email or @handle", { exact: true }),
    identifier,
  );
  // No error line is up, so this is the standalone link, not the one inside a line.
  const link = dialog.getByRole("button", { name: "Lost your passkey?" });
  const proceed = dialog.getByRole("button", { name: "Continue" });
  await restoring(page, async () => {
    await page.mouse.move(0, 0);
    await settled(link);
    flow.check(
      "sign in: the standalone link has no underline at rest",
      "none",
      await computed(link, "text-decoration-line"),
    );
    flow.check(
      "sign in: the standalone link is the accent ink",
      await painted(link, "var(--ui-accent-ink)"),
      await computed(link, "color"),
    );
    flow.check(
      "sign in: the standalone link takes the small step at 500",
      await probedType(link, "text-ui-sm font-medium"),
      await type(link),
    );
    flow.check(
      "sign in: the standalone link is a 32px box",
      "32px",
      await computed(link, "height"),
    );
    const [linkBox, proceedBox] = await Promise.all([link.boundingBox(), proceed.boundingBox()]);
    flow.check(
      "sign in: the standalone link sits centred under Continue",
      true,
      linkBox !== null &&
        proceedBox !== null &&
        Math.abs(linkBox.x + linkBox.width / 2 - (proceedBox.x + proceedBox.width / 2)) <= 1,
    );
    await link.hover();
    await settled(link);
    flow.check(
      "sign in: the standalone link underlines under the pointer",
      "underline",
      await computed(link, "text-decoration-line"),
    );
    await page.mouse.move(0, 0);
    await flow.step("surfaces: shoot the sign-in dialog", () =>
      shoot(page, "sign-in", () => expect(link).toBeVisible()),
    );
  });
}

/**
 * A call site's busy `Button` while its wait is held: it reads the wait's own
 * label, is announced busy and unavailable but is not `disabled`, and still
 * holds focus. `what` starts each check's name, so two buttons' reads stay
 * apart. A call site that puts `disabled` back for the wait fails here.
 */
export async function busyButtonHeld(
  flow: Flow,
  button: Locator,
  label: string,
  what: string,
): Promise<void> {
  flow.check(
    `${what}: the button reads "${label}"`,
    label,
    ((await button.textContent()) ?? "").trim(),
  );
  flow.check(
    `${what}: the button is aria-busy`,
    "true",
    (await button.getAttribute("aria-busy")) ?? "",
  );
  flow.check(
    `${what}: the button is aria-disabled`,
    "true",
    (await button.getAttribute("aria-disabled")) ?? "",
  );
  flow.check(
    `${what}: the button is not disabled`,
    false,
    await button.evaluate((el) => (el as HTMLButtonElement).disabled),
  );
  flow.check(
    `${what}: the button keeps focus`,
    true,
    await button.evaluate((el) => el === document.activeElement),
  );
}

/**
 * A busy `Button`, pressed with the pointer and waiting: what
 * `busyButtonHeld` reads, plus dimmed, with the 20px orb before its label.
 * Shot under reduced motion, so the orb is one still frame.
 */
export async function busyButtonSurfaces(
  flow: Flow,
  page: Page,
  button: Locator,
  label: string,
): Promise<void> {
  // The orb's module loads on demand; until it lands a box holds its room.
  const orb = button.locator('canvas[aria-hidden="true"]');
  await expect(orb).toHaveCount(1);
  await busyButtonHeld(flow, button, label, "busy");
  flow.check(
    "busy: a pointer-pressed busy button is dimmed",
    "0.5",
    await computed(button, "opacity"),
  );
  flow.check("busy: one orb", 1, await orb.count());
  flow.check(
    "busy: the orb is 20px",
    "20px 20px",
    `${await computed(orb, "width")} ${await computed(orb, "height")}`,
  );
  await restoring(page, async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await flow.step("surfaces: shoot a busy button", () =>
      shoot(page, "busy-button", () => expect(orb).toHaveCount(1)),
    );
  });
}

/**
 * A link inside a sentence (`Button`'s `link` at `inline`, or an `<a>` wearing
 * its classes): underlined at rest 2px under the text, in its sentence's own
 * size and weight, in the accent ink. The sentence is the link's parent.
 * `what` starts each check's name.
 */
async function inlineLink(flow: Flow, what: string, link: Locator): Promise<void> {
  const sentence = link.locator("xpath=..");
  flow.check(
    `${what} is underlined at rest`,
    "underline",
    await computed(link, "text-decoration-line"),
  );
  flow.check(
    `${what}'s underline sits 2px under it`,
    "2px",
    await computed(link, "text-underline-offset"),
  );
  flow.check(
    `${what} takes its sentence's size and weight`,
    await type(sentence),
    await type(link),
  );
  flow.check(
    `${what} is the accent ink`,
    await painted(link, "var(--ui-accent-ink)"),
    await computed(link, "color"),
  );
}

/**
 * `/authorize`'s sign-in: "Create one" a link inside the sentence "No account
 * yet? Create one" — `Button`'s `link` at `inline`: no padding and no height
 * past its line, underlined at rest 2px under the text, in the sentence's own
 * size and weight, in the accent ink.
 */
export async function authorizeSignInSurfaces(flow: Flow, page: Page): Promise<void> {
  const link = page.getByRole("button", { name: "Create one" });
  const sentence = link.locator("xpath=..");
  await expect(link).toBeVisible();
  // The app's name leads at the display step, the panel's own heading
  // under it at the title step, and the panel draws no frame of its own.
  const client = page.getByRole("heading", { level: 1 });
  const heading = page.getByRole("heading", { name: "Sign in to Musubi", exact: true });
  flow.check(
    "authorize: the app's name is at the display step and 500",
    await probedType(client, "text-display font-medium"),
    await type(client),
  );
  flow.check("authorize: the app's name is 24px at 500", "24px 500", await type(client));
  flow.check("authorize: the panel's heading is 14px at 500", "14px 500", await type(heading));
  const panelPlace = heading.locator("xpath=../../..");
  flow.check(
    "authorize: the panel draws no frame",
    "0px",
    await computed(panelPlace, "border-top-width"),
  );
  await restoring(page, async () => {
    await page.mouse.move(0, 0);
    await settled(link);
    // A `<button>` stays one box at `display: inline` (Chromium computes
    // `inline-block`), so "no box" is no padding and no height past its line.
    flow.check("authorize: Create one has no padding", "0px 0px 0px 0px", await padding(link));
    flow.check(
      "authorize: Create one is one line of its sentence tall",
      await computed(sentence, "line-height"),
      await computed(link, "height"),
    );
    await inlineLink(flow, "authorize: Create one", link);
    await flow.step("surfaces: shoot /authorize's sign-in", () =>
      shoot(page, "authorize-sign-in", () => expect(link).toBeVisible(), { bare: true }),
    );
  });
}

/**
 * Discover with nothing to suggest: "Search for someone" a link inside the
 * empty note's sentence, read as `/authorize`'s "Create one" is, and shot.
 */
export async function discoverEmptySurfaces(flow: Flow, page: Page): Promise<void> {
  const link = page.getByRole("link", { name: "Search for someone" });
  await expect(link).toBeVisible();
  await restoring(page, async () => {
    await page.mouse.move(0, 0);
    await settled(link);
    await inlineLink(flow, "discover: Search for someone", link);
    await flow.step("surfaces: shoot Discover's empty note", () =>
      shoot(page, "discover-empty", () => expect(link).toBeVisible()),
    );
  });
}

/**
 * `TotpView`'s setup panel, before the code is in: the two labels `Field`
 * cannot draw, over the setup key and over the code boxes, are spans in the
 * plain label's look, 6px above what they name. The code boxes are a group
 * named by their span, box 1 holds focus once the panel has opened after the
 * step-up, and on a phone the step drops its frame, so the row takes the
 * Settings card's whole column: recorded at 320 and 390px, and shot at 320.
 */
export async function totpSetupSurfaces(flow: Flow, page: Page): Promise<void> {
  const keyLabel = page.getByText("Or enter this setup key by hand", { exact: true });
  const codeLabel = page.getByText("Code from the app", { exact: true });
  const row = page.getByRole("group", { name: "Code from the app" });
  const firstBox = row.getByRole("textbox", { name: "Code from the app Digit 1" });
  await expect(codeLabel).toBeVisible();
  await expect(row).toBeVisible();
  await expect(firstBox).toBeFocused();
  flow.check(
    "totp: the six boxes are named after the label",
    6,
    await row.getByRole("textbox", { name: /^Code from the app Digit [1-6]$/ }).count(),
  );
  // The card's column: the viewport less `main`'s `px-4`, the card's `p-5` and
  // its 1px edges. The boxes share it at a gap of 4px to 8px, to 48px each
  // (`OtpInput`'s geometry).
  const widths = [
    { width: 320, column: "246px", box: "37.7px" },
    { width: 390, column: "316px", box: "48px" },
  ] as const;
  await restoring(page, async () => {
    for (const { width, column, box } of widths) {
      await page.setViewportSize({ width, height: 844 });
      await expect(primaryBar(page)).toBeVisible();
      const measured = async (target: Locator) =>
        `${Math.round((await target.evaluate((el) => el.getBoundingClientRect().width)) * 10) / 10}px`;
      flow.check(`totp: at ${width}px the code row is`, column, await measured(row));
      flow.check(`totp: at ${width}px each box is`, box, await measured(firstBox));
    }
    await flow.step("surfaces: shoot the authenticator setup on a 320px phone", () =>
      shoot(page, "totp-setup", () => expect(row).toBeVisible(), {
        widths: [{ width: 320, height: 844 }],
      }),
    );
  });
  await plainLabel(
    flow,
    "totp: the setup key's label",
    keyLabel,
    keyLabel.locator("xpath=following-sibling::*[1]"),
  );
  await plainLabel(
    flow,
    "totp: the code boxes' label",
    codeLabel,
    codeLabel.locator("xpath=following-sibling::*[1]"),
  );
}

/**
 * Settings → Security with `GET /passkeys` held: the passkey list's place is
 * `Skeleton`'s one row, in a region that says it is busy, under the heading
 * that has already drawn, rather than Settings' fallback for the whole tab.
 * The block paints the sunk well (`--muted`) and pulses, and stands still
 * under reduced motion. Shot at 390 and 1440px in both schemes. Returns the
 * block's height at the flow's own viewport, for the row that replaces it.
 */
export async function securityLoadingSurfaces(flow: Flow, page: Page): Promise<string> {
  const view = page.getByRole("heading", { name: "Passkeys", exact: true }).locator("xpath=../..");
  const region = view.locator(':scope > [aria-busy="true"]');
  // One block per width: the row is taller below `md`, so the placeholder
  // draws the one this width shows.
  const block = region.locator('[aria-hidden="true"]').filter({ visible: true });
  await expect(block).toBeVisible();
  const height = await computed(block, "height");
  flow.check("security loading: the list's place is busy", 1, await region.count());
  flow.check("security loading: one row's placeholder", 1, await block.count());
  flow.check(
    "security loading: the placeholder paints the sunk well",
    await painted(block, "var(--muted)"),
    await computed(block, "background-color"),
  );
  flow.check(
    "security loading: the placeholder takes a row's 8px corner",
    "8px",
    await computed(block, "border-top-left-radius"),
  );
  flow.check(
    "security loading: the placeholder pulses",
    "pulse",
    await computed(block, "animation-name"),
  );
  await restoring(page, async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    flow.check(
      "security loading: under reduced motion the placeholder stands still",
      "none",
      await computed(block, "animation-name"),
    );
  });
  // Shot under reduced motion: the pulse never ends, and `at()` waits for
  // every running animation to finish before a shot.
  await flow.step("surfaces: shoot Settings → Security while the list loads", () =>
    restoring(page, async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await shoot(page, "security-loading", () => expect(block).toBeVisible());
    }),
  );
  return height;
}
