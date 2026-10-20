import { contrastRatio, PALETTE_PRESET_KEYS, WCAG_TEXT_MIN, WCAG_UI_MIN } from "@cire/theme";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { ConsentGate } from "../../src/components/consent/ConsentGate";
import { EventSheet } from "../../src/components/EventSheet";
import { applyPaletteToRoot } from "../../src/components/invite-theme";
import type { EventSummary } from "../../src/components/types";
import { resetConsentForTest, seedConsentForTest } from "../test-support/consent";

/**
 * The details panel, measured inside the real event sheet: what a guest reads
 * first, what it is painted in on every built-in scheme, and how big and how
 * keyboard-operable its controls are. jsdom computes no layout and no colour,
 * so every claim here is one the fast tier can only make about class names.
 *
 * The guest's own timezone is pinned through `guestTimeZone`, the panel's one
 * read of it, so the "Your time" line does not depend on the machine the
 * suite runs on. It is set to London here — the worst case for the fold, since
 * it adds a line.
 */
const guestZone = vi.hoisted(() => ({ value: "Europe/London" }));
vi.mock("../../src/components/event-details", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/components/event-details")>()),
  guestTimeZone: () => guestZone.value,
}));

/** Every field filled: the event the fold has the most to fit around. */
const full: EventSummary = {
  id: "event-1",
  name: "Reception, Cocktail Hour & Dinner",
  description: "Join us for an evening of feasting and dancing under the fig trees.",
  startAt: "2026-11-13T18:00:00+11:00",
  endAt: "2026-11-15T11:00:00+11:00",
  timezone: "Australia/Sydney",
  address: "The Grand Ballroom, Curzon Hall, 53 Agincourt Road, Marsfield NSW 2122, Australia",
  dressCodeDescription: "Festive colours, nothing white.",
  dressCodePalette: [
    { name: "Marigold", color: "#e8a33d" },
    // Near the sheet's own colour on the dark presets: the swatch that
    // vanished without an edge.
    { name: "Midnight", color: "#14231b" },
    { name: "Ivory", color: "#f6f1e7" },
  ],
  pinterestUrl: "https://www.pinterest.com.au/example/catholic-wedding-guest-moodboard/",
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const PHONE = [390, 844] as const;

async function settle() {
  await new Promise(requestAnimationFrame);
  const dialog = document.querySelector("dialog");
  const running = (dialog?.getAnimations({ subtree: true }) ?? []).filter(
    (a) => a.effect?.getComputedTiming().endTime !== Infinity,
  );
  await Promise.allSettled(running.map((a) => a.finished));
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
}

async function openSheet(event: EventSummary = full) {
  render(() => (
    <EventSheet
      event={event}
      panel="details"
      siteUrl="https://invite.test/abc-123"
      members={[]}
      apiUrl="https://api.test"
      onClose={() => {}}
    />
  ));
  await settle();
  const panel = document.querySelector<HTMLElement>('[data-panel="details"]')!;
  const scroller = document.querySelector("dialog")!.lastElementChild as HTMLElement;
  return { panel, scroller };
}

/** Colours painted one over another, as the 8-bit sRGB pixel the screen shows. */
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

/** Every background painted behind `el`, outermost first — the stack it sits on. */
function backdrop(el: Element): string[] {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.unshift(bg);
  }
  return ["rgb(255, 255, 255)", ...layers];
}

function ratio(fg: string, behind: Element): number {
  const back = backdrop(behind);
  return contrastRatio(painted(...back, fg), painted(...back)) ?? 0;
}

afterEach(() => {
  cleanup();
  resetConsentForTest();
  guestZone.value = "Europe/London";
  applyPaletteToRoot(null);
  const root = document.documentElement;
  for (const name of Array.from(root.style)) {
    if (name.startsWith("--")) root.style.removeProperty(name);
  }
});

describe.each(PALETTE_PRESET_KEYS)("the %s scheme", (palettePreset) => {
  const apply = () => applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });

  it("writes the time and its timezone at 4.5:1 on the sheet", async () => {
    apply();
    const { panel } = await openSheet();
    const time = [...panel.querySelectorAll("dd p")].find((p) =>
      (p.textContent ?? "").includes("Sydney time"),
    )!;
    const local = [...panel.querySelectorAll("dd p")].find((p) =>
      (p.textContent ?? "").startsWith("Your time"),
    )!;
    expect(time.textContent).toMatch(/^Fri 6:00\s*pm – Sun 11:00\s*am · AEDT \(Sydney time\)$/);
    // One colour for the whole line: the zone carries no fainter span.
    expect(time.querySelectorAll("span")).toHaveLength(0);
    for (const line of [time, local]) {
      expect(ratio(getComputedStyle(line).color, line)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    }
  });

  it("edges every swatch at 3:1 against the sheet", async () => {
    apply();
    const { panel } = await openSheet();
    const circles = [...panel.querySelectorAll<HTMLElement>("li > span[aria-hidden='true']")];
    expect(circles).toHaveLength(3);
    for (const circle of circles) {
      const style = getComputedStyle(circle);
      expect(parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
      expect(ratio(style.borderTopColor, circle.parentElement!)).toBeGreaterThanOrEqual(
        WCAG_UI_MIN,
      );
    }
  });

  it("paints the drawn map from the scheme's own colours", async () => {
    apply();
    const { panel } = await openSheet();
    const card = panel.querySelector<HTMLElement>("[data-map-card]")!;
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--color-bg)";
    probe.style.color = "var(--color-gold)";
    document.body.append(probe);
    const expected = getComputedStyle(probe);
    expect(getComputedStyle(card).backgroundColor).toBe(expected.backgroundColor);
    expect(getComputedStyle(card.querySelector("svg")!).color).toBe(expected.color);
    // No colour written out in the card: every layer resolves from a token.
    expect(card.getAttribute("style") ?? "").not.toMatch(/oklch\(/);
    probe.remove();
  });
});

describe("at phone width", () => {
  it("shows the date and the venue before any scrolling", async () => {
    await page.viewport(...PHONE);
    const { panel, scroller } = await openSheet();
    expect(scroller.scrollTop).toBe(0);
    const fold = Math.min(scroller.getBoundingClientRect().bottom, window.innerHeight);
    const date = [...panel.querySelectorAll("dd p")].find((p) =>
      (p.textContent ?? "").includes("November 2026"),
    )!;
    const venue = panel.querySelector<HTMLElement>("[data-venue-address]")!;
    expect(date.getBoundingClientRect().bottom).toBeLessThanOrEqual(fold);
    expect(venue.getBoundingClientRect().bottom).toBeLessThanOrEqual(fold);
  });

  it("makes every control in the panel, the calendar menu's included, at least 44px tall", async () => {
    await page.viewport(...PHONE);
    const { panel } = await openSheet();
    await userEvent.click(page.getByRole("button", { name: "Add to calendar" }));
    await settle();
    const controls = [
      ...panel.querySelectorAll<HTMLElement>("a[href], button, [role='menuitem']"),
    ].filter((el) => el.getClientRects().length > 0);
    // The RSVP button, Add to calendar and its two items, Open in maps,
    // Open on Pinterest and Show it here.
    expect(controls.length).toBeGreaterThanOrEqual(7);
    const short = controls
      .map((el) => ({ name: el.textContent?.trim(), height: el.getBoundingClientRect().height }))
      .filter(({ height }) => height < 44);
    expect(short).toEqual([]);
  });

  it("makes the standard consent placeholder's two buttons 44px targets too", async () => {
    // No embed uses it today — both pass their own fallback — so it is drawn
    // on its own, as a newly gated vendor would get it.
    await page.viewport(...PHONE);
    seedConsentForTest({ pinterest: false });
    render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <div>content</div>
      </ConsentGate>
    ));
    await settle();
    const buttons = [...document.querySelectorAll<HTMLElement>("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Allow Pinterest moodboards",
      "Privacy choices",
    ]);
    for (const button of buttons) {
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("the calendar menu from the keyboard", () => {
  const trigger = () => page.getByRole("button", { name: "Add to calendar" }).element();
  const items = () => [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];

  // Whether an unclaimed arrow would scroll the sheet is not asserted here:
  // Chromium scrolls nothing from a top-layer menu either way (measured: a
  // scrollable sheet stays at 0 with the keys unclaimed). The fast tier pins
  // that the keys are claimed, for engines and the no-popover fallback, where
  // the menu is a fixed box inside the scrollport.
  it("moves and jumps with the keys", async () => {
    await page.viewport(...PHONE);
    await openSheet();
    (trigger() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    await settle();
    expect(document.activeElement).toBe(items()[0]);

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items()[1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items()[0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(items()[1]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(items()[0]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(items()[1]);
  });

  it("closes on Escape with focus back on the trigger and the sheet still open", async () => {
    await openSheet();
    await userEvent.click(trigger());
    await settle();
    await userEvent.keyboard("{Escape}");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
    expect(document.querySelector("dialog")?.open).toBe(true);
  });

  it("closes on Tab and moves on from the trigger", async () => {
    await openSheet();
    await userEvent.click(trigger());
    await settle();
    await userEvent.keyboard("{Tab}");
    await settle();
    expect(items()).toHaveLength(0);
    // The next control after the trigger in the sheet: the Where row's link.
    expect(document.activeElement?.textContent).toContain("Open in maps");
  });

  it("opens above the trigger when it does not fit below", async () => {
    // A viewport that ends just under the trigger leaves no room beneath it.
    await page.viewport(...PHONE);
    await openSheet();
    const bottom = (trigger() as HTMLElement).getBoundingClientRect().bottom;
    await page.viewport(PHONE[0], Math.ceil(bottom + 40));
    await settle();
    const rect = (trigger() as HTMLElement).getBoundingClientRect();
    await userEvent.click(trigger());
    await settle();
    const menu = document.querySelector<HTMLElement>("[role='menu']")!;
    const box = menu.getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(rect.top);
    expect(box.top).toBeGreaterThanOrEqual(0);
  });
});
