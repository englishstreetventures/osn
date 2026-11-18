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
 *   two glass strips with a divider between them — and the chosen event wears
 *   the strips' glass in the readable gold;
 * - the reply filter is one more glass strip of radios (owner, 2026-11-04):
 *   one row that scrolls sideways, the chosen reply on the glass in the
 *   readable gold, a second press keeping it and All clearing it; on a phone
 *   the replies show as their marks, "All" keeping its word.
 */

const { authFetch, changes } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  // The rows a guest changed since the organiser last looked; none unless a
  // test says so.
  changes: {
    value: null as null | { markSeq: number; rows: { guestId: string; eventId: string | null }[] },
  },
}));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
  toasts: () => [],
}));
vi.mock("../../src/lib/touch-feedback", () => ({
  haptic: () => {},
  hapticsAvailable: () => false,
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => changes.value,
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
import { backdrop, over } from "../test-support/painted";

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
  changes.value = null;
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
    // 320px, the reflow floor. Whether the fixture's longest surname overflows
    // its block there depends on the platform's font metrics, so the name is
    // doubled to overflow in any font.
    await page.viewport(320, 844);
    await households(true);
    const names = [...document.querySelectorAll<HTMLElement>("[data-name]")];
    const long = names.find((n) => n.textContent?.includes("Wolfeschlegel"))!;
    long.textContent = `${long.textContent} ${long.textContent}`;
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
    for (const theme of THEMES) {
      it(`sets the sections apart from the events at ${width}, ${theme}`, async () => {
        document.documentElement.dataset.theme = theme;
        await page.viewport(width, height);
        // A guest on every event changed a reply, so each tab, the chosen one
        // included, says "New".
        changes.value = { markSeq: 1, rows: [{ guestId: "g1", eventId: null }] };
        routeFetch(authFetch, ROUTES);
        renderOrganiserPage({ module: "guests", sub: "rsvps" });
        await vi.waitFor(() => expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(20), {
          timeout: 10_000,
        });
        const sections = within(bar()).getByRole("tablist", { name: "Views" });
        const events = within(bar()).getByRole("tablist", { name: "Events" });
        // Two groups, a divider between them, each its own glass strip.
        const divider = bar().querySelector("[data-bar-divider]")!;
        expect(divider).not.toBeNull();
        expect(divider.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          sections.getBoundingClientRect().right - 0.5,
        );
        expect(divider.getBoundingClientRect().right).toBeLessThanOrEqual(
          events.getBoundingClientRect().left + 0.5,
        );
        for (const strip of [sections, events]) {
          expect(strip.getBoundingClientRect().height).toBeCloseTo(28, 0);
          expect(getComputedStyle(strip).borderTopWidth).toBe("1px");
        }
        // The chosen event's word reads on the glass under it; an unchosen
        // one's count is muted on the track beside its name.
        const [chosen, other] = within(events).getAllByRole("tab");
        expect(getComputedStyle(chosen!).color).toBe(probe("text-gold-ink", "color"));
        const glass = getComputedStyle(events.querySelector("[data-segmented-glass]")!);
        const onGlass = over(glass.backgroundColor, backdrop(chosen!));
        const onGlassRatio = (el: Element) =>
          contrastRatio(over(getComputedStyle(el).color, onGlass), onGlass)!;
        // The chosen tab's word, its count and its "New", each on the glass.
        const chosenNew = await vi.waitFor(() => {
          const mark = [...chosen!.querySelectorAll("span")].find((s) => s.textContent === "New");
          expect(mark).toBeDefined();
          return mark!;
        });
        const marks = {
          word: chosen!,
          count: chosen!.querySelector("[data-count]")!,
          new: chosenNew,
        };
        for (const [name, el] of Object.entries(marks)) {
          expect([name, theme, onGlassRatio(el) >= WCAG_TEXT_MIN]).toEqual([name, theme, true]);
        }
        const count = other!.querySelector("[data-count]")!;
        expect(getComputedStyle(count).color).toBe(probe("text-text-muted", "color"));
        expect([theme, inkRatio(count) >= WCAG_TEXT_MIN]).toEqual([theme, true]);
      });
    }
  }

  for (const theme of THEMES) {
    it(`keeps the reply filter in one glass strip that scrolls, and only All clears it, ${theme}`, async () => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(390, 844);
      routeFetch(authFetch, ROUTES);
      renderOrganiserPage({ module: "guests", sub: "rsvps" });
      await vi.waitFor(() => expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(20), {
        timeout: 10_000,
      });
      const strip = within(bar()).getByRole("radiogroup", { name: /by reply$/ });
      const radios = within(strip).getAllByRole("radio");
      expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
        expect.stringMatching(/^All, \d+ guests?$/),
        expect.stringMatching(/^Attending, \d+ guests?$/),
        expect.stringMatching(/^Declined, \d+ guests?$/),
        expect.stringMatching(/^Maybe, \d+ guests?$/),
        expect.stringMatching(/^No reply, \d+ guests?$/),
      ]);
      // One 28px track with a hairline, on one row, inside a box that scrolls.
      expect(strip.getBoundingClientRect().height).toBeCloseTo(28, 0);
      expect(getComputedStyle(strip).borderTopWidth).toBe("1px");
      const tops = new Set(radios.map((r) => Math.round(r.getBoundingClientRect().top)));
      expect(tops.size).toBe(1);
      expect(getComputedStyle(strip.parentElement!).overflowX).toBe("auto");
      // On a phone a reply is its mark and its count; All keeps its word.
      const [all, , declined] = radios as [HTMLElement, HTMLElement, HTMLElement];
      const word = (r: HTMLElement) => r.querySelector<HTMLElement>("[data-label]")!;
      expect(word(all).className).not.toContain("sr-only");
      for (const reply of radios.slice(1)) {
        expect(word(reply).className).toContain("sr-only");
        expect(reply.querySelector("[data-status-dot]")).not.toBeNull();
      }
      // At rest a reply's count reads on the track.
      const count = (r: HTMLElement) => r.querySelector<HTMLElement>("[data-count]")!;
      expect([theme, inkRatio(count(declined)) >= WCAG_TEXT_MIN]).toEqual([theme, true]);

      await userEvent.click(declined);
      expect(declined.getAttribute("aria-checked")).toBe("true");
      // Chosen, it sits on the strip's glass, its count in the readable gold
      // at medium weight.
      const glass = strip.querySelector<HTMLElement>("[data-segmented-glass]")!;
      await vi.waitFor(() =>
        expect(
          Math.abs(glass.getBoundingClientRect().left - declined.getBoundingClientRect().left),
        ).toBeLessThan(1),
      );
      expect(getComputedStyle(declined).color).toBe(probe("text-gold-ink", "color"));
      expect(getComputedStyle(declined).fontWeight).toBe("500");
      const onGlass = over(getComputedStyle(glass).backgroundColor, backdrop(declined));
      const ratio = contrastRatio(over(getComputedStyle(count(declined)).color, onGlass), onGlass)!;
      expect([theme, ratio >= WCAG_TEXT_MIN]).toEqual([theme, true]);
      const before = document.querySelectorAll(ROWS).length;
      expect(before).toBeLessThan(400);
      // A second press keeps the reply; All clears it.
      await userEvent.click(declined);
      expect(declined.getAttribute("aria-checked")).toBe("true");
      expect(document.querySelectorAll(ROWS).length).toBe(before);
      await userEvent.click(all);
      expect(all.getAttribute("aria-checked")).toBe("true");
      expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(before);
    });
  }

  it("shows every reply's word beside its mark at 1280", async () => {
    await page.viewport(1280, 800);
    routeFetch(authFetch, ROUTES);
    renderOrganiserPage({ module: "guests", sub: "rsvps" });
    await vi.waitFor(() => expect(document.querySelectorAll(ROWS).length).toBeGreaterThan(20), {
      timeout: 10_000,
    });
    const strip = within(bar()).getByRole("radiogroup", { name: /by reply$/ });
    for (const radio of within(strip).getAllByRole("radio")) {
      expect(radio.querySelector("[data-label]")!.className).not.toContain("sr-only");
    }
  });
});
