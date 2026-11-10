/**
 * Does a non-featured event card show its text whole on a phone?
 *
 * The explore page lays every card out in real Chromium with the app's own
 * stylesheet, at 320 and 390px, with four events: one live, one featured and
 * two more, so three cards are non-featured. For each of those, the time, the
 * title, the venue, the host and the footer must sit inside the card with
 * nothing cut off: no line wider than its box, no text past the card's edge,
 * and the card itself not wider than it draws. The title may end in the
 * two-line ellipsis `pulse/DESIGN.md` §Event Cards names; nothing else may be
 * cut.
 *
 * The arrangement is the one §Event Cards records: below 768px a 112px media
 * column beside the body, with the live tag reading "Live" inside it; from
 * 768px up a 180px column, with the tag reading "Happening now". Every width is
 * shot in light and dark into `e2e-artifacts/pulse-web/explore-card/`.
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

/** A day 2–6 days out whose weekday name is longest, so its label is widest. */
function widestWeekday(now: Date): Date {
  let best = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 12, 30);
  for (let offset = 3; offset <= 6; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12, 30);
    const name = (d: Date) => d.toLocaleString("en-US", { weekday: "long" });
    if (name(day).length > name(best).length) best = day;
  }
  return best;
}

/** Four events: live, featured, and two more. Only the featured one stacks. */
function events(): EventItem[] {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 19, 30);
  const later = widestWeekday(now);
  return [
    makeEvent({
      id: "evt_live",
      title: "Late-night vinyl session with guest selectors",
      status: "ongoing",
      startTime: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      category: "music",
      venue: "Public Records",
      location: "Gowanus",
      createdByName: "Fitzroy Okonkwo-Hale",
    }),
    makeEvent({
      id: "evt_featured",
      title: "Rooftop Jazz Session",
      startTime: tomorrow.toISOString(),
      category: "music",
      venue: "The Vessel",
      location: "East Village",
      createdByName: "Maya Chen",
    }),
    makeEvent({
      id: "evt_ceramics",
      title: "Ceramics open studio and wheel-throwing night",
      startTime: later.toISOString(),
      category: "art",
      venue: "Brooklyn Clay Collective",
      location: "Williamsburg",
      createdByName: "Sana Patel",
    }),
    makeEvent({
      id: "evt_run",
      title: "Sunday Run Club",
      startTime: later.toISOString(),
      category: "outdoor",
      venue: "Prospect Park Boathouse",
      location: "Park Slope",
      createdByName: "Kai Ito",
    }),
  ];
}

const NON_FEATURED = ["evt_live", "evt_ceramics", "evt_run"] as const;

interface CardParts {
  readonly card: HTMLElement;
  readonly media: HTMLElement;
  readonly body: HTMLElement;
  /** Time, title, venue, host and footer, in the order the card draws them. */
  readonly lines: readonly HTMLElement[];
}

function cardParts(id: string): CardParts {
  const card = document.querySelector<HTMLElement>(`a[href="/events/${id}"]`);
  if (!card) throw new Error(`no card for ${id}`);
  const [media, body] = Array.from(card.children) as HTMLElement[];
  const lines = Array.from(body.children) as HTMLElement[];
  return { card, media, body, lines };
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

/** Every rect the text inside `el` draws, one per line box. */
function textRects(el: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  return Array.from(range.getClientRects()).filter((r) => r.width > 0);
}

async function mount(size: { width: number; height: number }) {
  await page.viewport(size.width, size.height);
  feed.events = events();
  const view = render(wrapRouter(() => <ExplorePage />));
  await view.findByText("Sunday Run Club");
  await document.fonts.ready;
  return view;
}

async function shoot(name: string) {
  const height = document.documentElement.scrollHeight;
  await page.viewport(window.innerWidth, height);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

beforeAll(() => {
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
  feed.events = [];
});

describe("a non-featured event card on a phone", () => {
  for (const size of PHONES) {
    it(`shows its time, title, venue and host whole at ${size.width}px`, async () => {
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
        const { card, lines } = cardParts(id);
        const box = card.getBoundingClientRect();

        expect(card.scrollWidth, `${id} card overflows`).toBeLessThanOrEqual(card.clientWidth);
        expect(lines).toHaveLength(5);
        for (const line of lines) {
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
        expectBeside(id, PHONE_MEDIA);
      }

      const tag = liveTag();
      expect(tag.label).toBe("Live");
      expect(tag.fits, "the live tag runs past the media column").toBe(true);
    });
  }

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
