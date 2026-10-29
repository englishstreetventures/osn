/**
 * Cire's surfaces, measured and pictured: the cards, small-caps labels and
 * disclosures every cire app now takes from `@cire/ui` (`Card`, `Eyebrow`,
 * `Disclosure`). `cire-soft-shapes` calls these from its signed-in page and its
 * guest and marketing tabs, so they spend no sign-in and no claim of their own
 * (`tests/flows.test.ts` counts both).
 *
 * Each check reads computed style against a probe drawn with the part's own
 * class, so a lost class or a token that resolves elsewhere fails it, and most
 * read a property the hand-drawn copies painted differently: the readable gold
 * and the one letter-spacing on a label, the sunk fill of a disclosure, the
 * gold rule on the getting-started card, the house focus ring on the marketing
 * FAQ. Each view is shot into `screenshots/cire-surfaces/`.
 *
 * The vendor portal is not in this stack; its cards are drawn by
 * `cire/vendor/tests/components/surfaces.browser.test.tsx`.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { CIRE_GUEST, CIRE_ORGANISER, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { expect, type Flow } from "./fixtures";

const SHOTS = resolve(SCREENSHOT_DIR, "cire-surfaces");
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
const WIDTHS = [PHONE, DESKTOP] as const;
type Scheme = "light" | "dark";

const HOST_APP = `${ORIGINS.cireHost}/#/w`;
const SAMPLE = `${HOST_APP}/${CIRE_GUEST.weddingId}`;
const FRESH = `${HOST_APP}/${CIRE_ORGANISER.checklist.weddingId}`;
const SEATING = `${HOST_APP}/${CIRE_ORGANISER.seating.weddingId}`;
const FAQ_URL = `${ORIGINS.cireApi}/api/organiser/weddings/${CIRE_GUEST.weddingId}/invite/faqs`;

/** The two entries the guest FAQ shows while the flow reads it. */
const FAQ = [
  { question: "Is there parking at the venue?", answer: "Yes, behind the hall." },
  { question: "Can we bring our children?", answer: "Children are welcome at the ceremony." },
] as const;

/** Shoots `view` at `widths` in each scheme; `settle` runs after each change. */
async function shoot(
  page: Page,
  view: string,
  settle: (scheme: Scheme) => Promise<void>,
  options: {
    widths?: readonly { width: number; height: number }[];
    schemes?: readonly Scheme[];
  } = {},
): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
  for (const size of options.widths ?? WIDTHS) {
    for (const colorScheme of options.schemes ?? (["light", "dark"] as const)) {
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
}

/** The portal puts the scheme it resolved on `data-theme`; wait for it. */
const hostTheme = (page: Page, target?: Locator) => async (scheme: Scheme) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  if (target) {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
  }
};

/** Light, at a desktop width: where the checks read. */
async function reading(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light" });
}

/** One computed property of `target`, or of its pseudo-element. */
function computed(target: Locator, property: string, pseudo?: string): Promise<string> {
  return target.evaluate(
    (el, [prop, ps]) => getComputedStyle(el, ps ?? null).getPropertyValue(prop!),
    [property, pseudo] as const,
  );
}

/**
 * The value `property` takes on a probe that wears `classes` beside `target`,
 * so the probe sits in the same scope and the part's own class decides it.
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

/** "0.16" when a label's letter-spacing is 0.16 of its size, as `tracking-ui-widest` is. */
async function trackingRatio(label: Locator): Promise<string> {
  const [spacing, size] = await Promise.all([
    computed(label, "letter-spacing"),
    computed(label, "font-size"),
  ]);
  return (Number.parseFloat(spacing) / Number.parseFloat(size)).toFixed(2);
}

/** The marker of the `<details>` at `details`: the summary's `aria-hidden` glyph. */
const markerOf = (details: Locator) => details.locator(":scope > summary > [aria-hidden='true']");

/** The marker's turn once its transition has run: a read mid-turn sees the way between. */
async function turn(details: Locator): Promise<string> {
  const marker = markerOf(details);
  await marker.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  return computed(marker, "rotate");
}

/** The `<details>` whose summary reads `name`. */
const disclosure = (scope: Page | Locator, name: string) => {
  // An inner `has` locator is matched inside each candidate, so it starts from the page.
  const page = "page" in scope ? scope.page() : scope;
  return scope.locator("details").filter({ has: page.locator("summary", { hasText: name }) });
};

/** The nearest box round `target` drawn from the card's corner. */
const cardOf = (target: Locator) =>
  target.locator("xpath=ancestor::*[contains(@class,'rounded-ui-lg')][1]");

/** The sample wedding's overview, already open: a card's label is `Eyebrow`. */
export async function overviewSurfaces(flow: Flow, page: Page): Promise<void> {
  const label = page.getByText("Guests & events", { exact: true });
  await reading(page);
  flow.check("overview: a card's label is 0.16em wide", "0.16", await trackingRatio(label));
  flow.check(
    "overview: a card's label is the readable gold",
    await probed(label, "base:text-ui-accent-ink", "color"),
    await computed(label, "color"),
  );
  await flow.step("surfaces: shoot the overview's cards", () =>
    shoot(page, "host-overview", hostTheme(page, label)),
  );
}

/**
 * The portal's other surfaces: the settings panel and danger zone, the import
 * panel's guide, tips and change history, the getting-started card and the
 * budget's bars on a fresh Gold wedding, and the seating chart's "Arrange
 * tables" on the Gold seating wedding. Leaves the page on the seating chart.
 */
export async function hostSurfaces(flow: Flow, page: Page): Promise<void> {
  // ── Settings: a full-width panel and the danger zone ───────────────────
  const profile = page.getByRole("heading", { name: "Wedding profile" });
  const danger = page.getByRole("region", { name: "Delete this wedding" });
  await flow.step("surfaces: open the sample wedding's settings", async () => {
    await page.goto(`${SAMPLE}/settings/wedding`);
    await expect(profile).toBeVisible({ timeout: 60_000 });
    await expect(danger).toBeVisible();
  });
  await reading(page);
  const panel = cardOf(profile);
  flow.check(
    "settings: the panel takes the large padding step",
    "24px",
    await computed(panel, "padding-top"),
  );
  flow.check(
    "settings: the danger zone's border is the danger tone",
    await probed(danger, "base:border-ui-danger/30", "border-top-color"),
    await computed(danger, "border-top-color"),
  );
  flow.check(
    "settings: the danger zone has no fill",
    "rgba(0, 0, 0, 0)",
    await computed(danger, "background-color"),
  );
  await flow.step("surfaces: shoot the settings panel and the danger zone", async () => {
    await shoot(page, "host-settings", hostTheme(page, profile));
    await shoot(page, "host-danger-zone", hostTheme(page, danger));
  });

  // ── The import panel, met for the first time in this context ───────────
  const importMode = page.getByRole("radio", { name: "Spreadsheet import" });
  const guide = disclosure(page, "How to structure your sheet");
  const tips = disclosure(guide, "Formatting tips").first();
  const history = disclosure(page, "Change history");
  await flow.step("surfaces: open the guest editor's spreadsheet import", async () => {
    await page.goto(`${SAMPLE}/guests/edit`);
    await importMode.click({ timeout: 60_000 });
    await expect(guide).toBeVisible();
  });
  await reading(page);
  flow.check(
    "import: the guide opens itself on a first visit",
    true,
    await guide.evaluate((el) => el.hasAttribute("open")),
  );
  flow.check(
    "import: the guide's wrapper carries the first-visit glow",
    true,
    await guide.evaluate((el) => el.parentElement!.classList.contains("attention-glow")),
  );
  const sunk = await probed(guide, "base:bg-ui-surface-sunk", "background-color");
  flow.check(
    "import: the guide's fill is the well",
    sunk,
    await computed(guide, "background-color"),
  );
  flow.check(
    "import: the guide takes the card corner",
    "16px",
    await computed(guide, "border-top-left-radius"),
  );
  flow.check(
    "import: the tips take the nested corner",
    "6px",
    await computed(tips, "border-top-left-radius"),
  );
  flow.check(
    "import: the tips' fill is the well, not a gold tint",
    sunk,
    await computed(tips, "background-color"),
  );
  flow.check(
    "import: the open guide's marker is turned, the closed tips' is not",
    "90deg none",
    `${await turn(guide)} ${await turn(tips)}`,
  );
  flow.check(
    "import: a marker is the readable gold",
    await probed(markerOf(guide), "base:text-ui-accent-ink", "color"),
    await computed(markerOf(guide), "color"),
  );
  await flow.step("surfaces: shoot the open guide", () =>
    shoot(page, "host-import-guide-open", hostTheme(page, guide.locator(":scope > summary"))),
  );
  await flow.step("surfaces: open the formatting tips", async () => {
    await reading(page);
    await tips.locator(":scope > summary").click();
    await expect(tips).toHaveAttribute("open", "");
  });
  flow.check("import: the open tips' marker is turned", "90deg", await turn(tips));
  await flow.step("surfaces: shoot the open tips", () =>
    shoot(page, "host-import-tips-open", hostTheme(page, tips)),
  );
  await flow.step("surfaces: close the guide", async () => {
    await reading(page);
    await guide.locator(":scope > summary").click();
    await expect(guide).not.toHaveAttribute("open", "");
  });
  flow.check("import: the closed guide's marker is back", "none", await turn(guide));
  await flow.step("surfaces: shoot the closed guide and change history", () =>
    shoot(page, "host-import-closed", hostTheme(page, history)),
  );
  await flow.step("surfaces: open the change history", async () => {
    await reading(page);
    await history.locator(":scope > summary").click();
    await expect(history).toHaveAttribute("open", "");
    await expect(history.getByText(/Loading/)).toHaveCount(0);
  });
  flow.check(
    "history: the card disclosure's fill is the well",
    sunk,
    await computed(history, "background-color"),
  );
  flow.check("history: the open marker is turned", "90deg", await turn(history));
  await flow.step("surfaces: shoot the open change history", () =>
    shoot(page, "host-change-history-open", hostTheme(page, history)),
  );
  await flow.step("surfaces: reload the import panel", async () => {
    await page.reload();
    await importMode.click({ timeout: 60_000 });
    await expect(guide).toBeVisible();
  });
  flow.check(
    "import: the guide starts closed once met, with no glow",
    "false false",
    `${await guide.evaluate((el) => el.hasAttribute("open"))} ${await guide.evaluate((el) =>
      el.parentElement!.classList.contains("attention-glow"),
    )}`,
  );

  // ── A fresh Gold wedding: getting started and the budget's bars ────────
  const started = page.getByRole("region", { name: "Getting started" });
  await flow.step("surfaces: open a fresh wedding's overview", async () => {
    await page.goto(FRESH);
    await expect(started).toBeVisible({ timeout: 60_000 });
  });
  await reading(page);
  flow.check(
    "getting started: the border is the accent tone",
    await probed(started, "base:border-ui-accent/30", "border-top-color"),
    await computed(started, "border-top-color"),
  );
  flow.check("getting started: no gradient", "none", await computed(started, "background-image"));
  flow.check(
    "getting started: the large padding step",
    "24px",
    await computed(started, "padding-top"),
  );
  await flow.step("surfaces: shoot getting started", () =>
    shoot(page, "host-getting-started", hostTheme(page, started)),
  );

  const spent = page.getByText("Spent so far", { exact: true });
  const addItem = page.getByRole("button", { name: "Add item" });
  await flow.step("surfaces: open the fresh wedding's budget", async () => {
    await page.goto(`${FRESH}/budget`);
    await expect(spent).toBeVisible({ timeout: 60_000 });
    await expect(addItem).toBeVisible();
  });
  await reading(page);
  const band = cardOf(spent);
  const bar = addItem.locator("xpath=ancestor::form[1]");
  const wash = await probed(band, "base:bg-ui-surface/30", "background-color");
  flow.check(
    "budget: the summary band is the card's wash",
    wash,
    await computed(band, "background-color"),
  );
  flow.check(
    "budget: the add form is the card's wash",
    wash,
    await computed(bar, "background-color"),
  );
  flow.check(
    "budget: both take the small padding step",
    "16px 16px",
    `${await computed(band, "padding-top")} ${await computed(bar, "padding-top")}`,
  );
  flow.check(
    "budget: the band's label is the muted ink",
    await probed(spent, "base:text-ui-ink-secondary", "color"),
    await computed(spent, "color"),
  );
  await flow.step("surfaces: shoot the budget's bars", () =>
    shoot(page, "host-budget", hostTheme(page, bar)),
  );

  // ── The Gold seating wedding: "Arrange tables" ────────────────────────
  const arrange = disclosure(page, "Arrange tables");
  await flow.step("surfaces: open the seating chart", async () => {
    await page.goto(`${SEATING}/seating`);
    await expect(arrange).toBeVisible({ timeout: 60_000 });
  });
  await reading(page);
  flow.check(
    "seating: Arrange tables takes the card corner",
    "16px",
    await computed(arrange, "border-top-left-radius"),
  );
  flow.check(
    "seating: Arrange tables is the well",
    sunk,
    await computed(arrange, "background-color"),
  );
  await flow.step("surfaces: open Arrange tables", async () => {
    await arrange.locator(":scope > summary").click();
    await expect(arrange).toHaveAttribute("open", "");
  });
  flow.check("seating: the open marker is turned", "90deg", await turn(arrange));
  await flow.step("surfaces: shoot Arrange tables open", () =>
    shoot(page, "host-seating-arrange", hostTheme(page, arrange)),
  );
}

/**
 * The invite builder, already open on the sample wedding's designs: the chosen
 * design keeps its gold rule over the card's hairline, and a field disclosure
 * inside the builder takes the nested corner. Read at a desktop's width, where
 * the section tabs are a strip; a phone's opens them as a menu.
 */
export async function builderSurfaces(
  flow: Flow,
  page: Page,
  design: (name: "Classic" | "Gala") => Locator,
): Promise<void> {
  await reading(page);
  const chosen = design("Classic").locator("xpath=..");
  const other = design("Gala").locator("xpath=..");
  flow.check(
    "builder: the chosen design's card keeps its gold rule",
    await probed(chosen, "border-gold", "border-top-color"),
    await computed(chosen, "border-top-color"),
  );
  flow.check(
    "builder: another design's card is the hairline",
    await probed(other, "base:border-ui-hairline", "border-top-color"),
    await computed(other, "border-top-color"),
  );
  await flow.step("surfaces: shoot the design cards", () =>
    shoot(page, "host-builder-designs", hostTheme(page, chosen), { widths: [DESKTOP] }),
  );

  const sections = page.getByLabel("Invite sections");
  const typography = disclosure(page, "Fine-tune typography");
  await flow.step("surfaces: open the builder's Look tab and its typography", async () => {
    await sections.getByRole("tab", { name: /^Look/ }).click();
    await expect(typography).toBeVisible();
    await typography.locator(":scope > summary").click();
    await expect(typography).toHaveAttribute("open", "");
  });
  flow.check(
    "builder: a field disclosure takes the nested corner",
    "6px",
    await computed(typography, "border-top-left-radius"),
  );
  flow.check("builder: its open marker is turned", "90deg", await turn(typography));
  await flow.step("surfaces: shoot the open typography disclosure", () =>
    shoot(page, "host-builder-typography", hostTheme(page, typography), { widths: [DESKTOP] }),
  );
  await flow.step("surfaces: back to the builder's Design tab", async () => {
    await sections.getByRole("tab", { name: /^Design/ }).click();
    await expect(design("Classic")).toBeVisible();
  });
}

/**
 * The marketing site, already open: the FAQ is served as static HTML, the
 * labels take the one letter-spacing, the FAQ's question takes the house focus
 * ring, and the demo's event card keeps its button to its own width.
 */
export async function landingSurfaces(flow: Flow, landing: Page): Promise<void> {
  const html = await flow.step("surfaces: fetch the marketing page's HTML", async () => {
    const response = await landing.request.get(ORIGINS.cireLanding);
    expect(response.status()).toBe(200);
    return response.text();
  });
  const served = html.slice(html.indexOf('id="faq"'));
  const entries = served.match(/<details[\s\S]*?<\/summary>/g) ?? [];
  // A class holds `>` (the marker's `[details[open]>summary>&]` variant), so
  // each tag is read with its attribute values blanked.
  const openTag = (entry: string) => entry.replace(/"[^"]*"/g, '""').split(">")[0]!;
  flow.check("landing: the FAQ is in the served HTML", 6, entries.length);
  flow.check(
    "landing: every served question starts closed",
    0,
    entries.filter((entry) => /\sopen(\s|=|$)/.test(openTag(entry))).length,
  );
  flow.check(
    "landing: every served question carries its hidden marker",
    6,
    entries.filter((entry) => entry.includes('aria-hidden="true"') && entry.includes(">+</span>"))
      .length,
  );

  await reading(landing);
  const hero = landing.getByText("Bespoke digital wedding invitations", { exact: true });
  flow.check("landing: the hero's label is 0.16em wide", "0.16", await trackingRatio(hero));

  const faq = landing.locator("#faq");
  const first = faq.locator("details").first();
  const summary = first.locator(":scope > summary");
  await flow.step("surfaces: scroll to the FAQ", async () => {
    await faq.scrollIntoViewIfNeeded();
    await expect(first).toBeVisible();
  });
  flow.check(
    "landing: the FAQ marker is the readable gold",
    await probed(markerOf(first), "base:text-ui-accent-ink", "color"),
    await computed(markerOf(first), "color"),
  );
  flow.check(
    "landing: a question's row is a comfortable tap target",
    true,
    ((await summary.boundingBox())?.height ?? 0) >= 44,
  );
  await flow.step("surfaces: shoot the FAQ closed", () =>
    shoot(landing, "landing-faq", async () => {
      await faq.scrollIntoViewIfNeeded();
      await expect(first).toBeInViewport();
    }),
  );
  await flow.step("surfaces: reach a question from the keyboard", async () => {
    await reading(landing);
    await summary.focus();
    await landing.keyboard.press("Shift+Tab");
    await landing.keyboard.press("Tab");
    await expect(summary).toBeFocused();
  });
  flow.check(
    "landing: a focused question takes the house ring",
    "solid 2px 2px",
    `${await computed(summary, "outline-style")} ${await computed(summary, "outline-width")} ${await computed(summary, "outline-offset")}`,
  );
  await flow.step("surfaces: open the first question", async () => {
    await landing.keyboard.press("Enter");
    await expect(first).toHaveAttribute("open", "");
  });
  flow.check("landing: the open marker is turned into a cross", "45deg", await turn(first));
  await flow.step("surfaces: shoot the FAQ open, its question holding focus", () =>
    shoot(landing, "landing-faq-open", async () => {
      await first.scrollIntoViewIfNeeded();
      await expect(first).toBeInViewport();
    }),
  );

  const card = landing.getByRole("article").first();
  const respond = card.getByRole("button", { name: "Respond", exact: true });
  await flow.step("surfaces: scroll to the demo", async () => {
    await reading(landing);
    await card.scrollIntoViewIfNeeded();
    await expect(respond).toBeVisible({ timeout: 60_000 });
  });
  flow.check(
    "landing: the demo's event card takes the card corner",
    "16px",
    await computed(card, "border-top-left-radius"),
  );
  const [cardBox, buttonBox] = await Promise.all([card.boundingBox(), respond.boundingBox()]);
  flow.check(
    "landing: Respond keeps to its own width in the card",
    true,
    (buttonBox?.width ?? 0) < (cardBox?.width ?? 0) / 2,
  );
  await flow.step("surfaces: shoot the demo's event cards", () =>
    shoot(landing, "landing-demo-cards", async () => {
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeInViewport();
    }),
  );
}

/**
 * Gives the sample wedding a two-entry FAQ through the organiser API, so the
 * guest site has one to draw; the stack's seed gives it none. Returns the
 * entries' ids for {@link removeGuestFaq}.
 */
export async function addGuestFaq(flow: Flow, page: Page): Promise<string[]> {
  const request = page.context().request;
  const ids: string[] = [];
  for (const entry of FAQ) {
    const id = await flow.step(`surfaces: add the FAQ entry "${entry.question}"`, async () => {
      const response = await request.post(FAQ_URL, {
        headers: { origin: ORIGINS.cireHost },
        data: entry,
      });
      flow.recordRequest("POST", FAQ_URL, response.status());
      expect(response.status(), "add FAQ entry").toBe(200);
      return ((await response.json()) as { faq: { id: string } }).faq.id;
    });
    ids.push(id);
  }
  return ids;
}

/** Deletes the entries {@link addGuestFaq} made, leaving the wedding as seeded. */
export async function removeGuestFaq(
  flow: Flow,
  page: Page,
  ids: readonly string[],
): Promise<void> {
  const request = page.context().request;
  for (const id of ids) {
    const url = `${FAQ_URL}/${id}`;
    const status = await flow.step("surfaces: remove a FAQ entry", async () => {
      const response = await request.delete(url, { headers: { origin: ORIGINS.cireHost } });
      flow.recordRequest("DELETE", url, response.status());
      return response.status();
    });
    flow.check("surfaces: a FAQ entry removed", 200, status);
  }
}

/**
 * The guest site's FAQ in one design, the household already claimed: each
 * entry a rule-tone disclosure drawing the rule under it, closed, then one
 * open. The guest site has no dark theme, so it is shot in light alone.
 */
export async function guestFaqSurfaces(
  flow: Flow,
  guest: Page,
  design: "classic" | "gala",
): Promise<void> {
  const list = guest.locator("[data-faq-list]");
  const entries = list.locator("details");
  await flow.step(`${design}: scroll to the FAQ`, async () => {
    await list.scrollIntoViewIfNeeded({ timeout: 60_000 });
    await expect(entries).toHaveCount(FAQ.length);
  });
  await reading(guest);
  const ruled = await entries.evaluateAll((all) =>
    all.map((el) => getComputedStyle(el).borderBottomWidth).join(" "),
  );
  flow.check(`${design} FAQ: each entry draws the rule under it`, "1px 1px", ruled);
  flow.check(
    `${design} FAQ: the list draws its top rule only`,
    design === "classic" ? "1px 0px" : "0px 0px",
    `${await computed(list, "border-top-width")} ${await computed(list, "border-bottom-width")}`,
  );
  const first = entries.first();
  flow.check(
    `${design} FAQ: the marker is the couple's readable gold`,
    await probed(markerOf(first), "base:text-ui-accent-ink", "color"),
    await computed(markerOf(first), "color"),
  );
  await flow.step(`${design}: shoot the FAQ closed`, () =>
    shoot(
      guest,
      `invite-${design}-faq`,
      async () => {
        await list.scrollIntoViewIfNeeded();
        await expect(list).toBeInViewport();
      },
      { schemes: ["light"] },
    ),
  );
  await flow.step(`${design}: open the first question`, async () => {
    await reading(guest);
    await first.locator(":scope > summary").click();
    await expect(first).toHaveAttribute("open", "");
  });
  flow.check(`${design} FAQ: the open marker is a cross`, "45deg", await turn(first));
  await flow.step(`${design}: shoot the FAQ open`, () =>
    shoot(
      guest,
      `invite-${design}-faq-open`,
      async () => {
        await first.scrollIntoViewIfNeeded();
        await expect(first).toBeInViewport();
      },
      { schemes: ["light"] },
    ),
  );
  await flow.step(`${design}: close the question`, async () => {
    await first.locator(":scope > summary").click();
    await expect(first).not.toHaveAttribute("open", "");
  });
}
