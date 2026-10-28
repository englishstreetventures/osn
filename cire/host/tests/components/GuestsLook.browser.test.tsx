// oxlint-disable vitest/expect-expect -- a picture tool, not a test: it asserts nothing, and runs only when asked.
import { cleanup } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Pictures of the Guests views for a person to judge: each tab scrolled, at
 * 1280×800 and 390×844, in both themes, and close crops of the parts a design
 * pass is about — the status column, a row with the longest names, and the
 * view bar's two tab groups. Written to `__screenshots__/` beside this file
 * (gitignored). What must hold is asserted in `GuestsStack.browser.test.tsx`,
 * `GuestsMarks.browser.test.tsx` and the views' own tests; this file only
 * draws, so it is no part of the browser tier's run. It draws when asked:
 * `VITE_GUESTS_LOOK=1 bun run --cwd cire/host test:browser
 * tests/components/GuestsLook.browser.test.tsx`.
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
  fetchRsvpChangeRows: async () => ({
    markSeq: 1,
    rows: [
      { guestId: "g3", eventId: "evt_ceremony" },
      { guestId: "g7", eventId: "evt_reception" },
    ],
  }),
  markRsvpChangesSeen: async () => {},
}));
vi.mock("../../src/lib/osn", () => ({
  CIRE_API_URL: "https://api.test",
  CIRE_WEB_URL: "https://guests.test",
  CIRE_MARKETING_URL: "https://cire.test",
}));

import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { EVENTS_300, GUESTS_300, HOUSEHOLDS_300, RSVPS_300 } from "../test-support/guests-300";
import { renderOrganiserPage, routeFetch } from "../test-support/organiser-page";

const DIR = "__screenshots__/GuestsLook.browser.test.tsx";
const SIZES = [
  [1280, 800],
  [390, 844],
] as const;
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

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(n);
  });

async function open(sub: string, width: number, height: number, theme: string) {
  document.documentElement.dataset.theme = theme;
  await page.viewport(width, height);
  routeFetch(authFetch, {
    rsvps: RSVPS_300,
    guests: GUESTS_300,
    events: EVENTS_300,
    households: HOUSEHOLDS_300,
  });
  renderOrganiserPage({ module: "guests", sub });
  const marker =
    sub === "list"
      ? "[data-household-bar]"
      : sub === "edit"
        ? "[data-card-head]"
        : 'tbody > tr, ul[aria-label^="Replies"] > li';
  await vi.waitFor(
    () => {
      if (document.querySelectorAll(marker).length < 20) throw new Error("not drawn");
    },
    { timeout: 10_000 },
  );
  await document.fonts.ready;
  await frames();
}

/** A picture of `rect` in the window: an element screenshot of a fixed box. */
async function shot(name: string, rect?: { x: number; y: number; w: number; h: number }) {
  const frame = document.createElement("div");
  frame.style.cssText = rect
    ? `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;pointer-events:none`
    : "position:fixed;inset:0;pointer-events:none";
  document.body.append(frame);
  await page.screenshot({ path: `${DIR}/${name}.png`, element: frame });
  frame.remove();
}

/** Scroll so `el` sits 40px under the stuck stack. */
async function bringUnderStack(el: Element) {
  const bar = document.querySelector("[data-view-bar]")!.getBoundingClientRect().bottom;
  window.scrollTo(0, scrollY + el.getBoundingClientRect().top - bar - 90);
  await frames();
}

describe.runIf(import.meta.env.VITE_GUESTS_LOOK === "1")("the Guests views, drawn", () => {
  for (const [width, height] of SIZES) {
    for (const theme of THEMES) {
      for (const sub of ["rsvps", "list", "edit"]) {
        it(`${sub} at ${width}, ${theme}, scrolled`, async () => {
          await open(sub, width, height, theme);
          window.scrollTo(0, Math.round(document.documentElement.scrollHeight / 3));
          await frames();
          await shot(`${sub}-${width}-${theme}-scrolled`);
        });
      }

      it(`crops at ${width}, ${theme}`, async () => {
        await open("rsvps", width, height, theme);
        // The view bar: the module's sections and the RSVP page's events.
        const bar = document.querySelector("[data-view-bar]")!.getBoundingClientRect();
        await shot(`crop-tabbar-${width}-${theme}`, {
          x: bar.left,
          y: bar.top,
          w: bar.width,
          h: bar.height,
        });

        // A row with the longest names: a plus-one brought by a guest with
        // the 35-letter surname, as the RSVP page draws it.
        const rows = [
          ...document.querySelectorAll<HTMLElement>('tbody > tr, ul[aria-label^="Replies"] > li'),
        ];
        const long =
          rows.find(
            (row) =>
              row.textContent?.includes("Maximilian-Alexander") &&
              row.textContent.includes("Wolfeschlegel"),
          ) ?? rows.find((row) => row.textContent?.includes("Wolfeschlegel"))!;
        await bringUnderStack(long);
        const r = long.getBoundingClientRect();
        await shot(`crop-longname-rsvp-${width}-${theme}`, {
          x: Math.max(0, r.left - 8),
          y: r.top - 8,
          w: Math.min(innerWidth, r.width + 16),
          h: r.height + 16,
        });

        // A plus-one brought by a guest with the longest surname: the row that
        // has to say whose plus-one they are.
        const plusOne = rows.find(
          (row) =>
            row.textContent?.includes("Plus-one of") && row.textContent.includes("Wolfeschlegel"),
        )!;
        await bringUnderStack(plusOne);
        const p = plusOne.getBoundingClientRect();
        await shot(`crop-plusone-rsvp-${width}-${theme}`, {
          x: Math.max(0, p.left - 8),
          y: p.top - 8,
          w: Math.min(innerWidth, p.width + 16),
          h: p.height + 16,
        });

        // The status column: six rows of replies, as they read down the page.
        const first = rows[12]!;
        await bringUnderStack(first);
        const top = first.getBoundingClientRect().top;
        const bottom = rows[18]!.getBoundingClientRect().bottom;
        const head = [...document.querySelectorAll("thead th")].find((th) =>
          th.textContent?.trim().toLowerCase().startsWith("status"),
        );
        const left = head ? head.getBoundingClientRect().left - 120 : 0;
        const w = head ? head.getBoundingClientRect().width + 240 : innerWidth;
        await shot(`crop-status-${width}-${theme}`, {
          x: Math.max(0, left),
          y: top - 4,
          w: Math.min(innerWidth - Math.max(0, left), w),
          h: Math.min(innerHeight - top, bottom - top + 8),
        });
      });

      it(`household crop at ${width}, ${theme}`, async () => {
        await open("list", width, height, theme);
        const groups = [...document.querySelectorAll<HTMLElement>("[role=group][aria-labelledby]")];
        const long =
          groups.find(
            (g) =>
              g.textContent?.includes("Wolfeschlegel") && g.textContent.includes("Plus-one of"),
          ) ?? groups.find((g) => g.textContent?.includes("Wolfeschlegel"))!;
        await bringUnderStack(long);
        const r = long.getBoundingClientRect();
        await shot(`crop-longname-households-${width}-${theme}`, {
          x: Math.max(0, r.left - 8),
          y: r.top - 8,
          w: Math.min(innerWidth, r.width + 16),
          h: Math.min(innerHeight - r.top + 8, r.height + 16),
        });
      });
    }
  }
});
