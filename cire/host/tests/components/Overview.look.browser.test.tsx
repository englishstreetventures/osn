import { cleanup, screen, within } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The Overview as a host sees it, in the real page and the real stylesheet, at
 * a phone width and a laptop width, with a wedding whose event names are long
 * and whose counts run to three digits.
 *
 * The RSVPs card lists each event's attending count. Each count stays on one
 * line however long the event's name is: the name gives way and is cut short,
 * the count does not wrap, and no row runs past the card's inner edge. The word
 * "Attending" heads the column once rather than following every count.
 *
 * The page head, the RSVPs card and the Budget card are screenshotted at both
 * widths into `e2e-artifacts/cire-host/overview-look/` at the repository root
 * (gitignored), so a reviewer can see what the assertions describe.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
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

import { renderOrganiserPage } from "../test-support/organiser-page";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/cire-host/overview-look";

const VIEWPORTS = [
  { name: "1280", width: 1280, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

/** A local `YYYY-MM-DD`, `days` from today. */
function dayKey(days: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const EVENTS = [
  { id: "ev_1", name: "Sangeet night and welcome dinner", attending: 186 },
  {
    id: "ev_2",
    name: "Ceremony and blessing at the old boathouse down by the river",
    attending: 200,
  },
  { id: "ev_3", name: "Reception", attending: 200 },
  { id: "ev_4", name: "Mehndi afternoon in the garden", attending: 64 },
  { id: "ev_5", name: "Farewell brunch", attending: 120 },
] as const;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function route() {
  authFetch.mockImplementation(async (input: unknown) => {
    const path = String(input).split("?")[0]!;
    if (path.endsWith("/settings")) {
      return json({
        wedding: {
          id: "wed_1",
          slug: "rosa-and-viktor",
          displayName: "Rosa & Viktor",
          weddingDate: dayKey(120),
          guestCountEstimate: 220,
          currency: "AUD",
          budgetTotalMinor: 5_000_000,
          rsvpDeadline: null,
          rsvpDeadlineTimezone: null,
        },
      });
    }
    if (path.endsWith("/rsvps")) {
      return json({
        events: EVENTS.map((e) => ({
          id: e.id,
          name: e.name,
          invited: 220,
          attending: e.attending,
          declined: 6,
          maybe: 4,
          responded: e.attending + 10,
          noResponse: 210 - e.attending,
        })),
      });
    }
    if (path.endsWith("/events")) {
      return json(
        EVENTS.map((e, i) => ({
          id: e.id,
          name: e.name,
          slug: e.id,
          sortOrder: i,
          startAt: `${dayKey(110 + i)}T17:00:00.000Z`,
          endAt: `${dayKey(110 + i)}T21:00:00.000Z`,
          timezone: "Australia/Sydney",
          address: null,
          description: "",
        })),
      );
    }
    if (path.endsWith("/guests")) {
      return json([
        {
          guestId: "g_1",
          familyId: "f_1",
          publicId: "p_1",
          familyName: "Okafor",
          firstName: "Ada",
          lastName: "Okafor",
          nickname: null,
        },
      ]);
    }
    if (path.endsWith("/tasks")) return json({ tasks: [] });
    if (path.endsWith("/vendors")) return json({ vendors: [] });
    if (path.endsWith("/budget")) {
      return json({
        items: [],
        payments: [
          {
            id: "pay_1",
            budgetItemId: "b_1",
            label: "Balance",
            amountMinor: 250_000,
            dueAt: dayKey(30),
            paidAt: null,
            createdAt: 1,
          },
        ],
        budgetTotalMinor: 5_000_000,
        currency: "AUD",
      });
    }
    return json({});
  });
}

/** The card a label leads: the nearest ancestor that draws a card's edge. */
function cardOf(label: HTMLElement): HTMLElement {
  let el: HTMLElement | null = label.parentElement;
  while (el && Number.parseFloat(getComputedStyle(el).borderTopWidth) === 0) {
    el = el.parentElement;
  }
  if (!el) throw new Error("no card around the label");
  return el;
}

afterEach(() => {
  cleanup();
  authFetch.mockReset();
});

for (const viewport of VIEWPORTS) {
  it(`keeps each event's attending count on one line under one head, at ${viewport.name}`, async () => {
    await page.viewport(viewport.width, viewport.height);
    route();
    renderOrganiserPage({ module: "overview", sub: "" });

    // The loaded card, not the hollow one drawn while the replies load: only
    // the loaded one names the events.
    const rsvpCard = cardOf(await screen.findByText(EVENTS[0].name));
    const budgetCard = cardOf(await screen.findByText(/Next: Balance/));
    // Let the panel's height settle before the pictures are taken.
    await new Promise((done) => setTimeout(done, 400));

    const head = document.querySelector<HTMLElement>("main header")!;
    await page.screenshot({ path: `${SHOTS}/page-head-${viewport.name}.png`, element: head });
    await page.screenshot({ path: `${SHOTS}/rsvps-card-${viewport.name}.png`, element: rsvpCard });
    await page.screenshot({
      path: `${SHOTS}/budget-card-${viewport.name}.png`,
      element: budgetCard,
    });

    const list = within(rsvpCard).getByRole("list", { name: "Attending" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(EVENTS.length);

    const inner = rsvpCard.getBoundingClientRect();
    const padRight = Number.parseFloat(getComputedStyle(rsvpCard).paddingRight);
    for (const [i, row] of rows.entries()) {
      const name = within(row).getByText(EVENTS[i]!.name);
      const count = row.lastElementChild as HTMLElement;
      // The figure alone: the word lives in the head, once.
      expect(count.textContent?.trim()).toBe(String(EVENTS[i]!.attending));
      const lineHeight = Number.parseFloat(getComputedStyle(count).lineHeight);
      expect(count.getBoundingClientRect().height).toBeLessThan(lineHeight * 1.5);
      // The name gives way to the count rather than running under it.
      expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(
        count.getBoundingClientRect().left,
      );
      // Nothing in the row runs into the card's padding.
      expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(inner.right - padRight + 0.5);
      expect(count.getBoundingClientRect().right).toBeLessThanOrEqual(inner.right - padRight + 0.5);
    }
    // The longest name is longer than either card is wide, so it is the one
    // cut short.
    const longest = within(rows[1]!).getByText(EVENTS[1].name);
    expect(longest.scrollWidth).toBeGreaterThan(longest.clientWidth);
  });
}
