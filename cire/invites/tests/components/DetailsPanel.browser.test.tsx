import { contrastRatio, PALETTE_PRESET_KEYS, WCAG_TEXT_MIN, WCAG_UI_MIN } from "@cire/theme";
import { cleanup, render, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { AddToCalendar } from "../../src/components/AddToCalendar";
import { ConsentGate } from "../../src/components/consent/ConsentGate";
import { EventSheet } from "../../src/components/EventSheet";
import { applyPaletteToRoot } from "../../src/components/invite-theme";
import type { EventSummary, FamilyMember } from "../../src/components/types";
import { isCategoryGranted } from "../../src/lib/consent/store";
import { resetConsentForTest } from "../test-support/consent";
import { pinGuestTimeZone } from "../test-support/time-zone";

/**
 * The event details sheet, measured in Chromium on every built-in scheme.
 *
 * What only a real engine can say: the colour a line of text is painted in
 * against the sheet it is painted on (jsdom parses no stylesheet, and the
 * palette arrives as custom properties on `<html>`); how tall a control
 * really is; where the calendar menu lands and what the arrow keys do to the
 * focus and to the sheet's scroll; and whether the date and the venue are on
 * the first screen of a phone. The fast tier pins the structure — which rows
 * render, the words, the class contracts — in `DetailsPanel.test.tsx`.
 */

const PHONE = [390, 844] as const;

/** Every field the sheet shows, at realistic lengths: what a guest sees most. */
const event: EventSummary = {
  id: "ev-full",
  name: "Sangeet & Reception",
  description:
    "Join us for an evening of performances from both families, followed by dinner and dancing under the fig trees.",
  startAt: "2026-11-14T17:30:00+11:00",
  endAt: "2026-11-14T23:30:00+11:00",
  timezone: "Australia/Sydney",
  // The name over the address: the taller of the two venue rows, and the one
  // whose second line is in muted ink.
  venueName: "The Grounds of Alexandria",
  address: "7a/2 Huntley Street, Alexandria NSW 2015, Australia",
  dressCodeDescription: "Black tie optional. Jewel tones encouraged.",
  // Midnight is the case the ring exists for: a near-black colour on a
  // near-black invite has no edge but its ring.
  dressCodePalette: [
    { name: "Emerald", color: "#1f6f50" },
    { name: "Champagne Gold", color: "#d8b26e" },
    { name: "Midnight", color: "#1b1f3a" },
  ],
  pinterestUrl: "https://www.pinterest.com/cireweddings/sangeet-inspiration/",
  mapsUrl: "https://maps.app.goo.gl/example",
  sortOrder: 0,
  imageUrl: null,
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["ev-full"],
};

/**
 * Colours painted one over another, as the 8-bit sRGB pixel the screen shows.
 * A canvas does the compositing, so a translucent layer is blended with what
 * is under it rather than measured as if it were opaque.
 */
function painted(...layers: string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** How opaque a CSS colour is, 0–255, read off the pixel it paints. */
function alphaOf(colour: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3] ?? 0;
}

/** The nearest background behind `el` that paints anything: the surface it sits on. */
function backdropOf(el: Element): string {
  for (let node: Element | null = el.parentElement; node; node = node.parentElement) {
    const colour = getComputedStyle(node).backgroundColor;
    if (alphaOf(colour) > 0) return colour;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/** The contrast of `fg` painted over `bg`, against `bg`. */
function ratio(fg: string, bg: string): number {
  return contrastRatio(painted(bg, fg), painted(bg)) ?? 0;
}

function dialog(): HTMLDialogElement {
  const el = document.querySelector("dialog");
  if (!el) throw new Error("no sheet open");
  return el;
}

function scroller(): HTMLElement {
  return dialog().lastElementChild as HTMLElement;
}

/** Wait until nothing that ends is still moving, and the webfonts are in. */
async function settle() {
  await new Promise(requestAnimationFrame);
  const running = document
    .getAnimations()
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
  await Promise.allSettled(running.map((a) => a.finished));
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
}

async function openSheet(sheetEvent: EventSummary = event) {
  render(() => (
    <EventSheet
      event={sheetEvent}
      panel="details"
      siteUrl="https://invite.test/w"
      members={[priya]}
      apiUrl="https://api.test"
      onClose={() => {}}
    />
  ));
  await settle();
}

/** The element whose own text includes `text`, inside the sheet. */
function line(text: string | RegExp): HTMLElement {
  return within(dialog()).getByText(text);
}

/** The open calendar menu, once its deferred `showPopover()` and placement ran. */
async function calendarMenu(): Promise<HTMLElement> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise(requestAnimationFrame);
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("no calendar menu open");
  return menu;
}

/**
 * Keep every `<script>` the page appends out of the document, so allowing the
 * moodboard makes no request to Pinterest from the test runner. The embed then
 * stays on "Loading board…", which is the state a guest is in at the moment
 * they press "Show it here".
 */
function holdBackScripts(): () => void {
  const append = document.body.appendChild.bind(document.body);
  const spy = vi
    .spyOn(document.body, "appendChild")
    .mockImplementation(<T extends Node>(node: T) =>
      node instanceof HTMLScriptElement ? node : append(node),
    );
  return () => spy.mockRestore();
}

let unpinZone: () => void = () => {};

beforeAll(() => {
  // Colours are read in settled states; how they ease is not the question.
  const stop = document.createElement("style");
  stop.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(stop);
});

beforeEach(() => {
  resetConsentForTest();
  unpinZone = pinGuestTimeZone("Australia/Sydney");
});

afterEach(() => {
  cleanup();
  unpinZone();
  document.documentElement.style.overflow = "";
  document.documentElement.style.scrollbarGutter = "";
  applyPaletteToRoot(null);
  const root = document.documentElement;
  for (const name of Array.from(root.style)) {
    if (name.startsWith("--")) root.style.removeProperty(name);
  }
});

describe.each(PALETTE_PRESET_KEYS)("on the %s scheme", (palettePreset) => {
  const apply = () => applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });

  it("writes every key fact, the timezone included, at 4.5:1 on the sheet", async () => {
    apply();
    unpinZone();
    // A guest elsewhere, so the "Your time" line is painted too.
    unpinZone = pinGuestTimeZone("Europe/London");
    await page.viewport(...PHONE);
    await openSheet();

    const facts = [
      line("Saturday 14 November 2026"),
      line(/AEDT \(Sydney time\)/),
      line(/^Your time:/),
      within(dialog()).getByRole("button", { name: "Add to calendar" }),
      line(/The Grounds of Alexandria/),
      line(/7a\/2 Huntley Street/),
      within(dialog()).getByRole("button", { name: "Open in maps" }),
    ];
    for (const el of facts) {
      const measured = ratio(getComputedStyle(el).color, backdropOf(el));
      expect({ text: el.textContent, ok: measured >= WCAG_TEXT_MIN, measured }).toMatchObject({
        text: el.textContent,
        ok: true,
      });
    }
  });

  it("rings every dress-code swatch at 3:1 against the sheet", async () => {
    apply();
    await page.viewport(...PHONE);
    await openSheet();

    const circles = within(dialog())
      .getAllByRole("listitem")
      .map((item) => item.querySelector<HTMLElement>('[aria-hidden="true"]')!);
    expect(circles).toHaveLength(3);
    for (const circle of circles) {
      const style = getComputedStyle(circle);
      expect(parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
      const surface = backdropOf(circle);
      expect(ratio(style.borderTopColor, surface)).toBeGreaterThanOrEqual(WCAG_UI_MIN);
    }
  });

  it("draws the map card in the scheme's own colours", async () => {
    apply();
    await page.viewport(...PHONE);
    await openSheet();

    const card = dialog().querySelector<HTMLElement>('[aria-hidden="true"].h-24')!;
    const ground = getComputedStyle(document.documentElement).getPropertyValue("--color-bg");
    expect(painted(getComputedStyle(card).backgroundColor)).toBe(painted(ground));
  });
});

describe("the map card", () => {
  it("is drawn from the palette, not one scheme's literals", async () => {
    // The gold glow and the ink roads are token mixes, so two schemes paint
    // two different cards. A hard-coded colour would paint the same one.
    await page.viewport(...PHONE);
    const images: string[] = [];
    for (const palettePreset of ["evergreen", "fog"] as const) {
      applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });
      await openSheet();
      const card = dialog().querySelector<HTMLElement>('[aria-hidden="true"].h-24')!;
      images.push(getComputedStyle(card).backgroundImage);
      cleanup();
    }
    expect(images[0]).not.toBe(images[1]);
  });
});

describe("on a phone", () => {
  it("shows the date and the venue on the first screen", async () => {
    await page.viewport(...PHONE);
    await openSheet();

    const visible = Math.min(PHONE[1], scroller().getBoundingClientRect().bottom);
    for (const text of [
      "Saturday 14 November 2026",
      /The Grounds of Alexandria/,
      /7a\/2 Huntley Street/,
    ]) {
      const box = line(text).getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(visible);
    }
  });

  it("gives every control in the panel a 44px target, the calendar menu's included", async () => {
    await page.viewport(...PHONE);
    await openSheet();
    // The guest has not allowed Pinterest, so the moodboard block shows both
    // its actions; the RSVP form's way in is offered.
    expect(within(dialog()).getByRole("button", { name: "Show it here" })).toBeTruthy();
    await userEvent.click(within(dialog()).getByRole("button", { name: "Add to calendar" }));
    await calendarMenu();

    const controls = [
      ...dialog().querySelectorAll<HTMLElement>("a[href], button, [role='menuitem']"),
    ].filter((el) => el.getClientRects().length > 0);
    // The close button, the switch's two segments, Add to calendar, its two
    // items, Open in maps, Open on Pinterest and Show it here.
    expect(controls.length).toBeGreaterThanOrEqual(9);
    const short = controls
      .map((el) => ({ name: el.textContent?.trim(), height: el.getBoundingClientRect().height }))
      .filter((c) => c.height < 44);
    expect(short).toEqual([]);
  });

  // An organiser pastes a link into the description, and a link with no
  // hyphen has nowhere a line may break.
  it("keeps a link in the description inside the sheet", async () => {
    await page.viewport(...PHONE);
    await openSheet({
      ...event,
      description:
        "Parking is on Huntley Street. Shuttle times: https://maps.app.goo.gl/q4Zt9XaBcDeFgHiJkLmNoPqRsTuVwXyZ12345\nSee you there!",
    });

    const about = line(/^Parking is on Huntley Street/);
    expect(about.scrollWidth).toBeLessThanOrEqual(about.clientWidth);
    expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth);
  });
});

describe("the venue row", () => {
  // The name over the address reads as the day over the time does, so the
  // address is set as the time line is: muted, at the same weight.
  it("sets the address under a name at the time line's weight", async () => {
    await page.viewport(...PHONE);
    await openSheet();

    const address = getComputedStyle(line(/7a\/2 Huntley Street/));
    const time = getComputedStyle(line(/AEDT \(Sydney time\)/));
    expect(address.fontWeight).toBe(time.fontWeight);
    expect(address.color).toBe(time.color);
  });
});

describe("the text actions", () => {
  it("are underlined at rest, since a phone has no hover to reveal it (B10)", async () => {
    await page.viewport(...PHONE);
    await openSheet();

    const actions = [
      within(dialog()).getByRole("button", { name: "Add to calendar" }),
      within(dialog()).getByRole("button", { name: "Open in maps" }),
      within(dialog()).getByRole("link", { name: "Open on Pinterest" }),
    ];
    for (const el of actions) {
      expect({ text: el.textContent, line: getComputedStyle(el).textDecorationLine }).toEqual({
        text: el.textContent,
        line: "underline",
      });
    }
  });
});

describe("the moodboard", () => {
  it("keeps focus in the sheet when Show it here gives way to the board (B8)", async () => {
    const release = holdBackScripts();
    try {
      await page.viewport(...PHONE);
      await openSheet();
      const show = within(dialog()).getByRole("button", { name: "Show it here" });
      show.focus();

      await userEvent.keyboard("{Enter}");

      expect(show.isConnected).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog().contains(document.activeElement)).toBe(true);
      expect(dialog().open).toBe(true);
    } finally {
      release();
    }
  });

  it("offers the way back off at 44px, deaf to the second tap of a double tap, keeping focus in the sheet (B13, B14)", async () => {
    const release = holdBackScripts();
    // One frozen instant stands for "straight after", however long the
    // runner takes between the two presses.
    let now = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      await page.viewport(...PHONE);
      await openSheet();
      await userEvent.click(within(dialog()).getByRole("button", { name: "Show it here" }));

      const stop = within(dialog()).getByRole("button", { name: "Stop showing moodboards" });
      expect(stop.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

      // Near the foot of the sheet the scroll shifts as the block gives way,
      // and this button can arrive under the finger that pressed Show it here.
      await userEvent.click(stop);
      expect(isCategoryGranted("pinterest")).toBe(true);

      now += 1_000;
      await userEvent.click(stop);
      expect(isCategoryGranted("pinterest")).toBe(false);
      // The runner's reload is a no-op, as a real one is when the cookie
      // write cannot be confirmed: the button is gone and the page stays, so
      // focus has to stay in the sheet (B14).
      expect(stop.isConnected).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog().contains(document.activeElement)).toBe(true);
    } finally {
      clock.mockRestore();
      release();
    }
  });
});

describe("the consent framework's own placeholder", () => {
  it("gives Allow and Privacy choices a 44px target (B12)", async () => {
    // No surface on the invite renders it today; a gate given no fallback of
    // its own would, and its two buttons are the ones a thumb has to hit.
    await page.viewport(...PHONE);
    render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <div />
      </ConsentGate>
    ));
    await settle();

    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      "Allow Pinterest moodboards",
      "Privacy choices",
    ]);
    for (const button of buttons) {
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("the calendar menu", () => {
  const trigger = () => within(dialog()).getByRole("button", { name: "Add to calendar" });
  const items = () => within(dialog()).getAllByRole("menuitem");

  it("moves focus with the arrows, wrapping, and with Home and End, and keeps each key to itself", async () => {
    await page.viewport(...PHONE);
    await openSheet();
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await calendarMenu();
    const [google, ics] = items();
    expect(document.activeElement).toBe(google);
    // Reached by keyboard, so the item shows it: filled gold.
    expect(alphaOf(getComputedStyle(google!).backgroundColor)).toBe(255);

    // Each key's default is cancelled: the menu sits inside the sheet's
    // focusable scrollport, where an unclaimed arrow, Home or End scrolls the
    // sheet in an engine that scrolls a fixed box's DOM ancestors. Read on the
    // window, after every handler on the way has run.
    const unclaimed: string[] = [];
    const record = (e: KeyboardEvent) => {
      if (!e.defaultPrevented) unclaimed.push(e.key);
    };
    window.addEventListener("keydown", record);
    try {
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(ics);
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(google);
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(ics);
      await userEvent.keyboard("{Home}");
      expect(document.activeElement).toBe(google);
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(ics);
    } finally {
      window.removeEventListener("keydown", record);
    }
    expect(unclaimed).toEqual([]);
  });

  it("opens on the menu itself after a tap or click, with no item filled and no ring", async () => {
    // A guest who taps "Add to calendar" has chosen nothing yet; an item
    // filled gold the moment the menu opens reads as already chosen.
    await page.viewport(...PHONE);
    await openSheet();
    await userEvent.click(trigger());
    const menu = await calendarMenu();

    expect(document.activeElement).toBe(menu);
    expect(menu.hasAttribute("data-quiet-focus")).toBe(true);

    // Nor is an item a pointer focuses — a tap lands focus on the link it
    // presses. The fill follows keyboard focus (`focus-visible:`), not focus.
    const [first] = items();
    first!.focus();
    expect(alphaOf(getComputedStyle(first!).backgroundColor)).toBe(0);

    // The arrows still reach the items from the menu.
    menu.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("draws no ring on the menu while it is marked quiet, where a key press would draw one", async () => {
    // Chromium never matches `:focus-visible` on a script's focus after a
    // click, so the ring is asked for here the way an engine that does
    // (iOS Safari after a tap) would show it: focus moved by script after a
    // key press.
    await page.viewport(...PHONE);
    await openSheet();
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    const menu = await calendarMenu();

    menu.setAttribute("data-quiet-focus", "");
    menu.focus();
    expect(getComputedStyle(menu).outlineStyle).toBe("none");

    // Unmarked, the same focus draws the ring.
    menu.removeAttribute("data-quiet-focus");
    expect(getComputedStyle(menu).outlineStyle).toBe("solid");
  });

  it("opens from the trigger on the arrows, on the first item or the last", async () => {
    await page.viewport(...PHONE);
    await openSheet();
    trigger().focus();
    await userEvent.keyboard("{ArrowUp}");
    await calendarMenu();
    expect(document.activeElement).toBe(items()[1]);

    await userEvent.keyboard("{Escape}");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}");
    await calendarMenu();
    expect(document.activeElement).toBe(items()[0]);
  });

  it("closes on Escape with focus back on its trigger, leaving the sheet open", async () => {
    await page.viewport(...PHONE);
    await openSheet();
    await userEvent.click(trigger());
    await calendarMenu();

    await userEvent.keyboard("{Escape}");

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(dialog().open).toBe(true);
  });

  it("hands focus back to its trigger when a calendar is chosen, with the sheet still open (B9)", async () => {
    await page.viewport(...PHONE);
    await openSheet();
    // Opening Google or saving the file is not the question; the click's own
    // handlers still run, only the browser's default is held back.
    const stay = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("click", stay, true);
    try {
      for (const key of ["{Home}", "{End}"]) {
        trigger().focus();
        await userEvent.keyboard("{ArrowDown}");
        await calendarMenu();
        await userEvent.keyboard(key);

        await userEvent.keyboard("{Enter}");

        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(trigger());
        expect(dialog().open).toBe(true);
      }
    } finally {
      document.removeEventListener("click", stay, true);
    }
  });

  it("closes on Tab, and focus moves on to the next control", async () => {
    await page.viewport(...PHONE);
    await openSheet();
    await userEvent.click(trigger());
    await calendarMenu();

    await userEvent.keyboard("{Tab}");

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(
      within(dialog()).getByRole("button", { name: "Open in maps" }),
    );
  });

  it("opens upward when there is no room below, and stays on screen", async () => {
    await page.viewport(390, 600);
    render(() => (
      <div style={{ "padding-top": "540px" }}>
        <AddToCalendar event={event} siteUrl="https://invite.test/w" />
      </div>
    ));
    const button = document.querySelector("button")!;
    await userEvent.click(button);
    const menu = await calendarMenu();

    const menuBox = menu.getBoundingClientRect();
    expect(menuBox.bottom).toBeLessThanOrEqual(button.getBoundingClientRect().top);
    expect(menuBox.top).toBeGreaterThanOrEqual(0);
    expect(menuBox.bottom).toBeLessThanOrEqual(600);
  });

  it("opens downward, under its trigger's left edge, when there is room both ways (B11)", async () => {
    // Room above as well as below, so only a preference for below passes.
    await page.viewport(390, 600);
    render(() => (
      <div style={{ "padding-top": "250px", "padding-left": "40px" }}>
        <AddToCalendar event={event} siteUrl="https://invite.test/w" />
      </div>
    ));
    const button = document.querySelector("button")!;
    await userEvent.click(button);
    const menu = await calendarMenu();

    const menuBox = menu.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    expect(buttonBox.top).toBeGreaterThan(menuBox.height + 16);
    expect(menuBox.top).toBeGreaterThanOrEqual(buttonBox.bottom);
    expect(menuBox.left).toBeCloseTo(buttonBox.left, 0);
  });

  it("stays inside the viewport's gutter when its trigger is at the right edge (B11)", async () => {
    await page.viewport(390, 600);
    render(() => (
      <div style={{ display: "flex", "justify-content": "flex-end", "padding-top": "40px" }}>
        <AddToCalendar event={event} siteUrl="https://invite.test/w" />
      </div>
    ));
    const button = document.querySelector("button")!;
    await userEvent.click(button);
    const menu = await calendarMenu();

    const menuBox = menu.getBoundingClientRect();
    expect(menuBox.left).toBeLessThan(button.getBoundingClientRect().left);
    expect(menuBox.right).toBeLessThanOrEqual(window.innerWidth - 8 + 0.5);
    expect(menuBox.left).toBeGreaterThanOrEqual(8 - 0.5);
  });
});

describe("the maps menu", () => {
  const trigger = () => within(dialog()).getByRole("button", { name: "Open in maps" });

  it("offers the organiser's pin and the other map apps, over the sheet, at 390px", async () => {
    // The fixture's link is a Google share link, so it stands in for Google
    // Maps; Apple Maps and Waze search for the address.
    await page.viewport(...PHONE);
    await openSheet();
    trigger().scrollIntoView({ block: "center" });
    await userEvent.click(trigger());
    const menu = await calendarMenu();
    const items = within(menu).getAllByRole("menuitem") as HTMLAnchorElement[];
    expect(items.map((item) => item.textContent)).toEqual(["Google Maps", "Apple Maps", "Waze"]);
    expect(items[0]!.href).toBe(event.mapsUrl);

    // In the top layer: the item, not the sheet under it, answers a hit test.
    const waze = items[2]!;
    const box = waze.getBoundingClientRect();
    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(
      waze,
    );
    expect(menu.matches(":popover-open")).toBe(true);
    for (const item of items)
      expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: "__screenshots__/DetailsPanel.browser.test.tsx/maps-menu-open.png",
    });
  });
});
