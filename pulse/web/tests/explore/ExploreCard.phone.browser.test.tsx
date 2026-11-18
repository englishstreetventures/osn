/**
 * Does a non-featured event card show its text whole on a phone?
 *
 * The explore page lays every card out in real Chromium with the app's own
 * stylesheet, at 320 and 390px, with five events: one live, one featured and
 * three more, so four cards are non-featured. One of them is built to break
 * each wrap rule: a venue that is one unbroken word and a status long enough
 * to push the footer onto two lines. For every non-featured card, the time,
 * title, venue, host and footer sit inside the card with nothing cut off: no
 * line wider than its box, no text past the card's edge, and the card not wider
 * than it draws. Then each rule `pulse/DESIGN.md` §Event Cards lists for the
 * wrapped body: the time on one line, the clock, pin and avatar on their line's
 * first line, each separator dot on the line of the word before it, the
 * footer's status flush right on whichever line it lands, and the title at
 * most two lines, ending in an ellipsis when it is longer. A narrowed line
 * checks the dot's tie: it must move down with its word, never start a line.
 *
 * The arrangement is the one §Event Cards records: below 768px a 112px media
 * column beside the body, with the live tag reading "Live" inside it; from
 * 768px up a 180px column, with the tag reading "Happening now".
 *
 * The clock is pinned, so every label and date stamp is the same on every run.
 * Every width is shot in light and dark into the gitignored
 * `e2e-artifacts/pulse-web/explore-card/`.
 */

import { render } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/app.css";
import type { EventItem } from "../../src/lib/types";
import { makeEvent } from "../helpers/events";
import { wrapRouter } from "../helpers/router";

const feed = vi.hoisted(() => ({ events: [] as EventItem[] }));

vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({
    session: () => null,
    activeProfileId: () => null,
    authFetch: fetch,
    signIn: () => {},
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(null),
  }),
  AuthProvider: (props: { children?: unknown }) => props.children,
}));

vi.mock("../../src/lib/api", () => ({
  api: {
    events: {
      discover: {
        get: () =>
          Promise.resolve({
            data: { events: feed.events, nextCursor: null, series: {} },
            error: null,
          }),
      },
    },
  },
}));

vi.mock("../../src/lib/venues", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/venues")>("../../src/lib/venues");
  return { ...actual, fetchVenuePins: () => Promise.resolve([]) };
});

const { ExplorePage } = await import("../../src/routes/index");

/** From the test file to the checkout root's gitignored `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/pulse-web/explore-card";
const PHONES = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
] as const;
const DESKTOP = { width: 1440, height: 900 } as const;
/** The media column below `md`, `grid-cols-[112px_1fr]`. */
const PHONE_MEDIA = 112;
/** The media column from `md` up, `md:grid-cols-[180px_1fr]`. */
const DESKTOP_MEDIA = 180;
/** Sub-pixel slack for a rect compared with another. */
const EPSILON = 0.5;
/**
 * Saturday 14 November 2026, noon, local time. Four days later is a
 * Wednesday, the longest weekday name, so the widest day label shows.
 */
const NOW = new Date(2026, 10, 14, 12, 0);

/** Five events: live, featured, and three more. Only the featured one stacks. */
function events(): EventItem[] {
  const at = (days: number, hours: number, minutes: number) =>
    new Date(2026, 10, 14 + days, hours, minutes).toISOString();
  return [
    makeEvent({
      id: "evt_live",
      title: "Late-night vinyl session with guest selectors",
      status: "ongoing",
      startTime: at(0, 11, 0),
      category: "music",
      venue: "Public Records",
      location: "Gowanus",
      createdByName: "Fitzroy Okonkwo-Hale",
    }),
    makeEvent({
      id: "evt_featured",
      title: "Rooftop Jazz Session",
      startTime: at(1, 19, 30),
      category: "music",
      venue: "The Vessel",
      location: "East Village",
      createdByName: "Maya Chen",
    }),
    makeEvent({
      id: "evt_ceramics",
      title: "Ceramics open studio and wheel-throwing night",
      startTime: at(4, 12, 30),
      category: "art",
      venue: "Brooklyn Clay Collective",
      location: "Williamsburg",
      createdByName: "Sana Patel",
    }),
    // Over a week out, so its day label ("Sun, Nov 22") has words to break between.
    makeEvent({
      id: "evt_run",
      title: "Sunday Run Club",
      startTime: at(8, 7, 30),
      category: "outdoor",
      venue: "Prospect Park Boathouse",
      location: "Park Slope",
      createdByName: "Kai Ito",
    }),
    makeEvent({
      id: "evt_long",
      title: "Zine fair and risograph workshop",
      status: "maybe_finished",
      startTime: at(4, 12, 30),
      category: "outdoor",
      venue: "KunstvereinHalleWilliamsburg",
      location: "Williamsburg",
      createdByName: "Ana Ruiz",
    }),
  ];
}

const NON_FEATURED = ["evt_live", "evt_ceramics", "evt_run", "evt_long"] as const;

interface CardParts {
  readonly card: HTMLElement;
  readonly media: HTMLElement;
  readonly body: HTMLElement;
  readonly time: HTMLElement;
  readonly title: HTMLElement;
  readonly place: HTMLElement;
  readonly host: HTMLElement;
  readonly footer: HTMLElement;
}

function cardParts(id: string): CardParts {
  const card = document.querySelector<HTMLElement>(`a[href="/events/${id}"]`);
  if (!card) throw new Error(`no card for ${id}`);
  const [media, body] = Array.from(card.children) as HTMLElement[];
  const [time, title, place, host, footer] = Array.from(body.children) as HTMLElement[];
  return { card, media, body, time, title, place, host, footer };
}

/** Every rect the text inside `node` draws, one per line box. */
function textRects(node: Node): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(node);
  return Array.from(range.getClientRects()).filter((r) => r.width > 0);
}

/** The first `text` in `el`, as a range. */
function textRange(el: HTMLElement, text: string): Range {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(text) ?? -1;
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    return range;
  }
  throw new Error(`no "${text}" in ${el.textContent}`);
}

/** The last line box of the text in `el` before `end`. */
function lastLineBefore(el: HTMLElement, end: Range | Node): DOMRect {
  const range = document.createRange();
  range.setStart(el, 0);
  if (end instanceof Range) range.setEnd(end.startContainer, end.startOffset);
  else range.setEndBefore(end);
  const last = Array.from(range.getClientRects()).findLast((r) => r.width > 0);
  if (!last) throw new Error(`no text before the mark in ${el.textContent}`);
  return last;
}

/** Two boxes on one line: each one's vertical centre inside the other. */
function sameLine(a: DOMRect, b: DOMRect): boolean {
  const ca = (a.top + a.bottom) / 2;
  const cb = (b.top + b.bottom) / 2;
  return ca > b.top && ca < b.bottom && cb > a.top && cb < a.bottom;
}

/** The time line's dot and the venue line's dot, each with the text before it. */
function dots(id: string) {
  const { time, place } = cardParts(id);
  const timeText = time.lastElementChild as HTMLElement;
  const placeText = place.lastElementChild as HTMLElement;
  const timeDot = textRange(timeText, "·");
  const venueDot = placeText.querySelector<HTMLElement>('span[aria-hidden="true"]');
  if (!venueDot) throw new Error(`no venue dot on ${id}`);
  return {
    timeText,
    placeText,
    time: { dot: timeDot.getBoundingClientRect(), before: lastLineBefore(timeText, timeDot) },
    venue: { dot: venueDot.getBoundingClientRect(), before: lastLineBefore(placeText, venueDot) },
  };
}

/** A line's leading mark (icon box or avatar) and its text's first line box. */
function leadAndFirstLine(line: HTMLElement) {
  const [lead, text] = Array.from(line.children) as HTMLElement[];
  const first = textRects(text)[0];
  if (!first) throw new Error(`no text in ${line.textContent}`);
  return { lead: lead.getBoundingClientRect(), first };
}

/** The media column sits beside the body, top-aligned, at `width`. */
function expectBeside(id: string, width: number) {
  const { media, body } = cardParts(id);
  const m = media.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  expect(m.width, `${id} media column`).toBeCloseTo(width, 0);
  expect(Math.abs(m.top - b.top), `${id} media and body tops`).toBeLessThan(EPSILON);
  expect(b.left, `${id} body starts after the media`).toBeGreaterThanOrEqual(m.right - EPSILON);
}

/** The live card's status tag: its rendered label, and whether it fits the media. */
function liveTag() {
  const { media } = cardParts("evt_live");
  const tag = Array.from(media.querySelectorAll<HTMLElement>("div")).find((d) =>
    d.textContent?.includes("Happening now"),
  );
  if (!tag) throw new Error("no live tag");
  const t = tag.getBoundingClientRect();
  const m = media.getBoundingClientRect();
  return { label: tag.innerText.trim(), fits: t.right <= m.right + EPSILON };
}

async function mount(size: { width: number; height: number }) {
  await page.viewport(size.width, size.height);
  feed.events = events();
  const view = render(wrapRouter(() => <ExplorePage />));
  await view.findByText("Sunday Run Club");
  await document.fonts.ready;
  return view;
}

/** Two frames: `page.viewport()` resolves before the resized frame is drawn. */
const settle = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

async function shoot(name: string) {
  const height = document.documentElement.scrollHeight;
  await page.viewport(window.innerWidth, height);
  await settle();
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

beforeAll(() => {
  // Only `Date` is faked: timers and animation frames stay real, so the
  // page's resource and `findByText` still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // A theme switch starts colour transitions; a shot taken mid-fade shows
  // neither theme.
  const stop = document.createElement("style");
  stop.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(stop);
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.replaceChildren();
});

afterAll(() => {
  vi.useRealTimers();
  feed.events = [];
});

describe("a non-featured event card on a phone", () => {
  for (const size of PHONES) {
    it(`shows its time, title, venue, host and footer whole at ${size.width}px`, async () => {
      await mount(size);
      // Shot first, so a failing run still leaves the picture of what failed.
      for (const theme of ["light", "dark"] as const) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        await shoot(`${size.width}-${theme}`);
        await page.viewport(size.width, size.height);
      }
      document.documentElement.classList.remove("dark");

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

      for (const id of NON_FEATURED) {
        const parts = cardParts(id);
        const { card, body, time, title, place, host, footer } = parts;
        const box = card.getBoundingClientRect();

        expect(card.scrollWidth, `${id} card overflows`).toBeLessThanOrEqual(card.clientWidth);
        expect(body.children, `${id} body lines`).toHaveLength(5);
        for (const line of [time, title, place, host, footer]) {
          const label = `${id}: "${line.textContent?.trim()}"`;
          expect(line.scrollWidth, `${label} is wider than its line`).toBeLessThanOrEqual(
            line.clientWidth,
          );
          for (const rect of textRects(line)) {
            expect(rect.left, `${label} starts outside the card`).toBeGreaterThanOrEqual(
              box.left - EPSILON,
            );
            expect(rect.right, `${label} runs past the card`).toBeLessThanOrEqual(
              box.right + EPSILON,
            );
          }
        }

        // The time keeps its AM or PM on one line.
        const walker = document.createTreeWalker(time, NodeFilter.SHOW_TEXT);
        let clock: Node | null = walker.nextNode();
        while (clock && !/\d:\d\d [AP]M/.test(clock.textContent ?? "")) clock = walker.nextNode();
        expect(clock, `${id} has no time`).not.toBeNull();
        expect(textRects(clock!), `${id} time splits`).toHaveLength(1);

        // The clock and pin sit centred on their text's first line.
        for (const line of [time, place]) {
          const { lead, first } = leadAndFirstLine(line);
          const offset = (lead.top + lead.bottom) / 2 - (first.top + first.bottom) / 2;
          expect(Math.abs(offset), `${id} icon off its first line`).toBeLessThan(1);
        }
        // The avatar starts level with the host's first line, not centred on two.
        const avatar = leadAndFirstLine(host);
        expect(avatar.lead.top, `${id} avatar below its first line`).toBeLessThanOrEqual(
          avatar.first.top + EPSILON,
        );

        // Each separator dot sits on the line of the word before it.
        const d = dots(id);
        expect(sameLine(d.time.dot, d.time.before), `${id} time dot`).toBe(true);
        expect(sameLine(d.venue.dot, d.venue.before), `${id} venue dot`).toBe(true);

        // The status sits flush right on whichever footer line it lands.
        const status = footer.lastElementChild!.getBoundingClientRect();
        const f = footer.getBoundingClientRect();
        expect(Math.abs(status.right - f.right), `${id} status off the right`).toBeLessThan(
          EPSILON,
        );

        // The title stops at two lines.
        const leading = parseFloat(getComputedStyle(title).lineHeight);
        expect(title.clientHeight, `${id} title over two lines`).toBeLessThanOrEqual(
          2 * leading + EPSILON,
        );
      }

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      for (const id of NON_FEATURED) expectBeside(id, PHONE_MEDIA);

      const tag = liveTag();
      expect(tag.label).toBe("Live");
      expect(tag.fits, "the live tag runs past the media column").toBe(true);
    });
  }

  it("cuts a long title at two lines and wraps a long footer at 320px", async () => {
    await mount(PHONES[0]);

    // The live card's title runs to three lines at 320px, so the clamp shows.
    const { title } = cardParts("evt_live");
    expect(getComputedStyle(title).webkitLineClamp).toBe("2");
    expect(title.scrollHeight).toBeGreaterThan(title.clientHeight);

    // "Maybe finished" does not fit beside the category, so it drops a line.
    const [category, status] = Array.from(cardParts("evt_long").footer.children);
    expect(status.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      category.getBoundingClientRect().bottom - EPSILON,
    );
  });

  it("moves a dot down with the word before it when the line is just too short", async () => {
    await mount(PHONES[0]);

    // Narrow each line's text to 2px past the word before its dot, so the dot
    // no longer fits beside it: the line has to break before that word.
    const run = dots("evt_run");
    const day = textRange(run.timeText, "22").getBoundingClientRect();
    run.timeText.style.width = `${day.right - run.timeText.getBoundingClientRect().left + 2}px`;
    const live = dots("evt_live");
    const venue = textRange(live.placeText, "Records").getBoundingClientRect();
    live.placeText.style.width = `${venue.right - live.placeText.getBoundingClientRect().left + 2}px`;

    const after = { run: dots("evt_run"), live: dots("evt_live") };
    expect(textRects(after.run.timeText).length, "the time did not wrap").toBeGreaterThan(1);
    expect(sameLine(after.run.time.dot, after.run.time.before), "time dot starts a line").toBe(
      true,
    );
    expect(textRects(after.live.placeText).length, "the venue did not wrap").toBeGreaterThan(1);
    expect(sameLine(after.live.venue.dot, after.live.venue.before), "venue dot starts a line").toBe(
      true,
    );
  });

  it("keeps the 180px media column and the full live tag at 1440px", async () => {
    await mount(DESKTOP);

    for (const id of NON_FEATURED) expectBeside(id, DESKTOP_MEDIA);
    expect(liveTag().label).toBe("Happening now");

    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await shoot(`${DESKTOP.width}-${theme}`);
      await page.viewport(DESKTOP.width, DESKTOP.height);
    }
  });
});
