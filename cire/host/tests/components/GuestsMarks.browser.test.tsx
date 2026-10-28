import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The Guests views' marks, as painted: what the design pass promises and only
 * a stylesheet and a compositor can show (`cire/host/DESIGN.md` §Status marks,
 * §Names and meta lines, §Chips).
 *
 * - every reply's status is a filled circle with a glyph and a word in caps,
 *   no outlined badge: the word clears 4.5:1 on what it is painted over and
 *   the glyph 4.5:1 on its circle, in both themes;
 * - a guest's name holds one line and ends in an ellipsis, never breaking
 *   mid-word, with its relationship and provenance on a muted line under it;
 * - a plus-one is "+1" to the eye, never "Plus-one", while a screen reader
 *   still hears whose plus-one they are;
 * - a provenance badge is an icon, named, with nothing written beside it;
 * - the module's sections and the RSVP page's events read as two groups —
 *   a segmented control, then a divider, then pills — and the chosen event
 *   and an applied reply filter are filled in the brand green;
 * - the reply chips sit in one row that scrolls sideways, and a second press
 *   on the chosen chip clears it.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/haptics", () => ({ haptic: () => {}, hapticsAvailable: () => false }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => null,
  markRsvpChangesSeen: async () => {},
}));
vi.mock("../../src/lib/osn", () => ({
  CIRE_API_URL: "https://api.test",
  CIRE_WEB_URL: "https://guests.test",
  CIRE_MARKETING_URL: "https://cire.test",
}));

import GuestTable from "../../src/components/GuestTable";
import RsvpView from "../../src/components/RsvpView";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { EVENTS_300, GUESTS_300, HOUSEHOLDS_300, RSVPS_300 } from "../test-support/guests-300";
import { renderOrganiserPage, routeFetch } from "../test-support/organiser-page";

const ROUTES = {
  rsvps: RSVPS_300,
  guests: GUESTS_300,
  events: EVENTS_300,
  households: HOUSEHOLDS_300,
};
const ROWS = 'tbody > tr, ul[aria-label^="Replies"] > li';
const THEMES = ["light", "dark"] as const;

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  __resetGuestsCache();
  __resetEventsCache();
  __resetHouseholdsCache();
  window.scrollTo(0, 0);
  delete document.documentElement.dataset.theme;
});

async function rsvps(compact: boolean) {
  routeFetch(authFetch, ROUTES);
  render(() => <RsvpView weddingId="wed_1" canEdit compact={compact} />);
  await vi.waitFor(() => expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(20), {
    timeout: 10_000,
  });
  await document.fonts.ready;
}

async function households(compact: boolean) {
  routeFetch(authFetch, ROUTES);
  render(() => (
    <GuestTable
      weddingId="wed_1"
      canManage
      canEdit
      compact={compact}
      weddingName="Rosa & Viktor"
      weddingSlug="rosa-and-viktor"
    />
  ));
  await vi.waitFor(
    () => expect(document.querySelectorAll("[data-household-bar]").length).toBeGreaterThan(20),
    { timeout: 10_000 },
  );
  await document.fonts.ready;
}

/** The colour an element is painted on: its ancestors' grounds, composited. */
function backdrop(el: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.push(bg);
  }
  layers.push(getComputedStyle(document.documentElement).backgroundColor);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers.toReversed()) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** `colour` composited over `ground`, as an opaque rgb string. */
function over(colour: string, ground: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

const inkRatio = (el: Element) => {
  const ground = backdrop(el);
  return contrastRatio(over(getComputedStyle(el).color, ground), ground)!;
};

/** The words a sighted reader sees in `el`: every text node outside hidden text. */
function visibleText(el: Element): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest('[class~="sr-only"], [class~="base:sr-only"]')) continue;
    out.push(node.textContent ?? "");
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** A probe's computed property, for a utility class. */
function probe(className: string, property: "backgroundColor" | "color"): string {
  const el = document.createElement("div");
  el.className = className;
  document.body.append(el);
  const value = getComputedStyle(el)[property];
  el.remove();
  return value;
}

describe("a reply's status", () => {
  for (const theme of THEMES) {
    for (const compact of [false, true]) {
      it(`is a filled mark and a word, readable, in the ${theme} theme${compact ? " on a phone" : ""}`, async () => {
        document.documentElement.dataset.theme = theme;
        await page.viewport(compact ? 390 : 1280, 844);
        await rsvps(compact);
        for (const status of ["attending", "declined", "maybe", "none"]) {
          const mark = document.querySelector(`[data-status="${status}"]`)!;
          expect([status, mark !== null]).toEqual([status, true]);
          const dot = mark.querySelector("[data-status-dot]")!;
          const word = mark.querySelector("[data-status-label]")!;
          // A circle, and no outlined badge round the word.
          const r = dot.getBoundingClientRect();
          expect([status, Math.abs(r.width - r.height) < 0.5]).toEqual([status, true]);
          expect([status, parseFloat(getComputedStyle(dot).borderRadius) >= r.height / 2]).toEqual([
            status,
            true,
          ]);
          for (const el of [mark, word]) {
            expect([status, getComputedStyle(el).borderTopWidth]).toEqual([status, "0px"]);
          }
          expect([status, getComputedStyle(word).textTransform]).toEqual([status, "uppercase"]);
          // The word on the page, at the text floor.
          const wordRatio = inkRatio(word);
          expect([status, theme, wordRatio >= WCAG_TEXT_MIN]).toEqual([status, theme, true]);
          // The glyph on its circle, at the text floor. No reply has no
          // glyph: its ring, at 3:1, is checked below.
          const glyph = dot.querySelector("svg");
          const fill = backdrop(dot);
          const ink = glyph ? contrastRatio(over(getComputedStyle(glyph).color, fill), fill)! : 0;
          expect([status, theme, glyph === null || ink >= WCAG_TEXT_MIN]).toEqual([
            status,
            theme,
            true,
          ]);
          expect([status, glyph === null]).toEqual([status, status === "none"]);
        }
        const ring = document.querySelector('[data-status="none"] [data-status-dot]')!;
        const ground = backdrop(ring.parentElement!);
        const edge = over(getComputedStyle(ring).borderTopColor, ground);
        expect([theme, contrastRatio(edge, ground)! >= 3]).toEqual([theme, true]);
      });
    }
  }
});

describe("a guest's name", () => {
  for (const [width, compact] of [
    [1280, false],
    [390, true],
  ] as const) {
    it(`holds one line and ends in an ellipsis at ${width}`, async () => {
      await page.viewport(width, 844);
      await rsvps(compact);
      const rows = [...document.querySelectorAll<HTMLElement>(ROWS)];
      // The longest surname, on a plus-one, so the row has a meta line too.
      const long = rows.find(
        (row) =>
          row.querySelector("[data-name]")?.textContent?.includes("Wolfeschlegel") &&
          row.querySelector("[data-meta]") !== null,
      )!;
      const name = long.querySelector<HTMLElement>("[data-name]")!;
      const style = getComputedStyle(name);
      expect(style.whiteSpace).toBe("nowrap");
      expect(style.textOverflow).toBe("ellipsis");
      expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
      expect(name.getBoundingClientRect().height).toBeLessThanOrEqual(
        parseFloat(style.lineHeight) + 1,
      );
      // Its meta line sits under it, muted; nothing in the row runs past it.
      const meta = long.querySelector<HTMLElement>("[data-meta]")!;
      expect(meta.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        name.getBoundingClientRect().bottom - 1,
      );
      expect(getComputedStyle(meta).whiteSpace).toBe("nowrap");
      const right = long.getBoundingClientRect().right;
      for (const el of long.querySelectorAll("span, p, button")) {
        expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
      }
    });
  }

  it("is the household list's too, on the narrowest phone", async () => {
    // 320px, the reflow floor: the longest surname no longer fits its block.
    await page.viewport(320, 844);
    await households(true);
    const names = [...document.querySelectorAll<HTMLElement>("[data-name]")];
    const long = names.find((n) => n.textContent?.includes("Wolfeschlegel"))!;
    expect(getComputedStyle(long).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(long).textOverflow).toBe("ellipsis");
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

describe("a plus-one", () => {
  it("reads +1 and whose, never Plus-one, on both lists and both layouts", async () => {
    for (const compact of [false, true]) {
      await page.viewport(compact ? 390 : 1280, 844);
      await rsvps(compact);
      const rsvpText = [...document.querySelectorAll(ROWS)].map(visibleText).join(" ");
      expect([compact, /plus-one/i.test(rsvpText)]).toEqual([compact, false]);
      expect([compact, /\+1 · \S+/.test(rsvpText)]).toEqual([compact, true]);
      cleanup();
      __resetGuestsCache();
      __resetEventsCache();
      await households(compact);
      const listText = visibleText(document.body);
      expect([compact, /plus-one/i.test(listText)]).toEqual([compact, false]);
      expect([compact, /\+1 · \S+/.test(listText)]).toEqual([compact, true]);
      cleanup();
      __resetGuestsCache();
      __resetEventsCache();
    }
  });

  it("is still named in full for a screen reader", async () => {
    await page.viewport(1280, 844);
    await rsvps(false);
    expect(screen.getAllByText(/^Plus-one of /).length).toBeGreaterThan(10);
  });
});

describe("a provenance badge", () => {
  it("is an icon with a name and a tooltip, and no word beside it", async () => {
    await page.viewport(1280, 844);
    await rsvps(false);
    for (const name of ["Host-entered", "Household-entered"]) {
      const hidden = screen.getAllByText(name)[0]!;
      const trigger = hidden.closest("[data-provenance]")!;
      expect([name, trigger !== null]).toEqual([name, true]);
      expect([name, visibleText(trigger)]).toEqual([name, ""]);
      expect([name, trigger.querySelector("svg") !== null]).toEqual([name, true]);
      expect([name, getComputedStyle(trigger).whiteSpace]).toEqual([name, "nowrap"]);
    }
  });
});

describe("the RSVP page's bar", () => {
  const bar = () => document.querySelector<HTMLElement>("[data-view-bar]")!;

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    it(`sets the sections apart from the events at ${width}`, async () => {
      await page.viewport(width, height);
      routeFetch(authFetch, ROUTES);
      renderOrganiserPage({ module: "guests", sub: "rsvps" });
      await vi.waitFor(() => expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(20), {
        timeout: 10_000,
      });
      const sections = within(bar()).getByRole("tablist", { name: "Views" });
      const events = within(bar()).getByRole("tablist", { name: "Events" });
      // Two groups, a divider between them, in different shapes: the
      // sections a segmented track, the events free pills.
      const divider = bar().querySelector("[data-bar-divider]")!;
      expect(divider).not.toBeNull();
      expect(divider.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        sections.getBoundingClientRect().right - 0.5,
      );
      expect(divider.getBoundingClientRect().right).toBeLessThanOrEqual(
        events.getBoundingClientRect().left + 0.5,
      );
      expect(getComputedStyle(events).borderTopWidth).toBe("0px");
      const [chosen, other] = within(events).getAllByRole("tab");
      const pill = chosen!.getBoundingClientRect();
      expect(parseFloat(getComputedStyle(chosen!).borderRadius)).toBeGreaterThanOrEqual(
        pill.height / 2 - 0.5,
      );
      const sectionTab = within(sections).getAllByRole("tab")[0]!;
      expect(parseFloat(getComputedStyle(sectionTab).borderRadius)).toBeLessThan(
        sectionTab.getBoundingClientRect().height / 2 - 1,
      );
      // The chosen event is filled in the brand green and reads on it; an
      // unchosen one's count is muted beside its name.
      expect(getComputedStyle(chosen!).backgroundColor).toBe(probe("bg-brand", "backgroundColor"));
      expect(inkRatio(chosen!)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
      const count = other!.querySelector("[data-count]")!;
      expect(getComputedStyle(count).color).toBe(probe("text-text-muted", "color"));
      expect(inkRatio(count)).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    });
  }

  it("keeps the reply chips in one row that scrolls, and clears the chosen one on a second press", async () => {
    await page.viewport(390, 844);
    routeFetch(authFetch, ROUTES);
    renderOrganiserPage({ module: "guests", sub: "rsvps" });
    await vi.waitFor(() => expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(20), {
      timeout: 10_000,
    });
    const group = within(bar()).getByRole("group", { name: /by reply$/ });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("aria-label") ?? c.textContent)).toHaveLength(5);
    const tops = new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top)));
    expect(tops.size).toBe(1);
    expect(getComputedStyle(group).flexWrap).toBe("nowrap");
    expect(getComputedStyle(group).overflowX).toBe("auto");

    const declined = chips.find((c) =>
      /declined/i.test(c.getAttribute("aria-label") ?? c.textContent ?? ""),
    )!;
    await userEvent.click(declined);
    expect(declined.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(declined).backgroundColor).toBe(probe("bg-brand", "backgroundColor"));
    const before = document.querySelectorAll(ROWS).length;
    expect(before).toBeLessThan(400);
    await userEvent.click(declined);
    expect(declined.getAttribute("aria-pressed")).toBe("false");
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(before);
  });
});
