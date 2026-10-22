import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The Events list's details, measured in Chromium: organiser text can hold a
 * link or a word longer than a card is wide, and only an engine can say
 * whether it stays inside the card. The factories below are written literally:
 * the shared-factory idiom in `test-support/mocks.ts` does not resolve in the
 * browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import EventTable from "../../src/components/EventTable";
import { __resetEventsCache } from "../../src/lib/events-store";

const LINK = `https://maps.app.goo.gl/${"q47t9XaBcDeFgHiJkLmNoPqRsTuVwXyZ".repeat(3)}`;

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
  description: `Shuttle times: ${LINK}`,
  runOfShow: [{ time: "16:00", label: "Tea is poured" }],
  gettingThere: `Shuttle from the station: ${LINK}`,
  childrenPolicy: null,
  plusOnePolicy: null,
  guestPolicyNote: `Ask first: ${LINK}`,
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

describe.each([
  ["a phone", 390, 844],
  ["a desktop", 1280, 800],
] as const)("the Events list's details, on %s", (_name, width, height) => {
  afterEach(() => {
    cleanup();
    __resetEventsCache();
  });

  it("keeps a long link inside the event's card", async () => {
    authFetch.mockImplementation(async () => json([KITCHEN_TEA]));
    await page.viewport(width, height);
    render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    const term = await screen.findByText("Getting there");
    const card = term.closest("li")!;
    const edge = card.getBoundingClientRect().right;
    for (const dd of card.querySelectorAll<HTMLElement>("dd")) {
      expect({
        text: dd.textContent?.slice(0, 20),
        right: dd.getBoundingClientRect().right <= edge + 0.5,
      }).toEqual({ text: dd.textContent?.slice(0, 20), right: true });
      expect(dd.scrollWidth).toBeLessThanOrEqual(dd.clientWidth + 1);
    }
  });
});
