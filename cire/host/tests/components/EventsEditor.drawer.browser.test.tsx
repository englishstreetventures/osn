import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The event drawer's run of show, measured in Chromium. Each item is a row of
 * four controls — the grip, a time, a name and a remove button — inside a
 * drawer that is the whole width of a phone, and only an engine can say
 * whether they fit: a `type="time"` input's width is the browser's, and a row
 * that overflows clips sideways in the drawer's scroller. The fast tier pins
 * the draft's rules (`tests/lib/guest-event-draft.test.ts`); the end-to-end
 * flow (`cire-event-details`) adds, reorders and saves a run of show.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import EventsEditor from "../../src/components/EventsEditor";
import { __resetEventsCache } from "../../src/lib/events-store";

/** SC 2.5.8's floor, in CSS pixels. */
const MINIMUM_TARGET = 24;

const KITCHEN_TEA = {
  id: "evt_tea",
  name: "Kitchen Tea",
  slug: "kitchen-tea",
  sortOrder: 0,
  startAt: "2026-11-20T16:00:00+11:00",
  endAt: "2026-11-20T18:00:00+11:00",
  timezone: "Australia/Sydney",
  venueName: "The Glasshouse",
  address: "124 Sample Avenue, Exampleville NSW 2001",
  description: "",
  // The second item is earlier on the clock than the 4 pm start, so a guest
  // reads it as after midnight; the last name is as long as a name may be.
  runOfShow: [
    { time: "16:00", label: "Tea is poured" },
    { time: "15:30", label: "Doors" },
    { time: "17:15", label: "Speeches from both families, then a toast. ".repeat(4).trim() },
  ],
  gettingThere: "Park on Sample Lane.",
  childrenPolicy: "adults_only",
  plusOnePolicy: "welcome",
  guestPolicyNote: null,
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null,
  imageCrop: null,
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function openDrawer(width: number, height: number) {
  __resetEventsCache();
  authFetch.mockImplementation(async (url: unknown) =>
    String(url).endsWith("/changes/head") ? json({ revision: "rev_1" }) : json([KITCHEN_TEA]),
  );
  await page.viewport(width, height);
  render(() => <EventsEditor weddingId="wed_1" />);
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const drawer = await screen.findByRole("dialog", { name: "Edit event" });
  const list = within(drawer).getByTestId("run-of-show");
  list.scrollIntoView({ block: "center" });
  await settle();
  return { drawer, list };
}

/** Wait until the drawer's opening motion has finished: a box measured mid-way is scaled. */
async function settle() {
  await new Promise(requestAnimationFrame);
  const running = document
    .getAnimations()
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
  await Promise.allSettled(running.map((a) => a.finished));
  await new Promise(requestAnimationFrame);
}

/** The nearest ancestor that scrolls: the drawer's own scroller. */
function scrollerOf(el: Element): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return document.documentElement;
}

describe.each([
  ["a phone", 390, 844],
  ["a desktop", 1280, 800],
] as const)("the run of show in the event drawer, on %s", (_name, width, height) => {
  afterEach(() => cleanup());

  it("fits every item's controls inside the drawer, each at least 24px", async () => {
    const { list } = await openDrawer(width, height);
    const scroller = scrollerOf(list);
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);

    const rows = [...list.querySelectorAll<HTMLElement>(":scope > li")];
    expect(rows).toHaveLength(3);
    const edge = list.getBoundingClientRect().right;
    for (const row of rows) {
      const controls = [...row.querySelectorAll<HTMLElement>("input, button")].filter(
        (el) => el.getClientRects().length > 0 && getComputedStyle(el).position !== "absolute",
      );
      // The grip, the time, the name and Remove; the move buttons are hidden
      // until focused.
      expect(controls).toHaveLength(4);
      for (const control of controls) {
        const box = control.getBoundingClientRect();
        expect({
          name: control.getAttribute("aria-label") ?? control.id,
          w: box.width >= MINIMUM_TARGET,
          h: box.height >= MINIMUM_TARGET,
          inside: box.right <= edge + 0.5,
        }).toEqual({
          name: control.getAttribute("aria-label") ?? control.id,
          w: true,
          h: true,
          inside: true,
        });
      }
    }
  });

  it("marks only the item a guest reads as after midnight", async () => {
    const { list } = await openDrawer(width, height);
    const marked = [...list.querySelectorAll<HTMLElement>(":scope > li")].map((row) =>
      row.textContent?.includes("guests read it as after midnight"),
    );
    expect(marked).toEqual([false, true, false]);
  });
});
