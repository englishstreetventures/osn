import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The seating chart in real Chromium, for the two things no DOM without layout
 * can show, and the pictures a reviewer checks without running anything:
 *
 * - a guest dragged with a real pointer onto a table is seated there, and the
 *   row being dragged paints above the cards it crosses rather than under them;
 * - printing the page prints the chart and nothing of the portal around it;
 * - a guest's menu opens, seats and closes from the keyboard, focus and all.
 *
 * The organiser portal has no end-to-end flow yet (englishstreetventures/osn#1591),
 * so this tier, against a fake of the seating routes, is the proof of the
 * screen. The API's own behaviour is proven in cire-api's route tests.
 *
 * Artifact: `cire/host/.vitest/attachments/seating/` — the chart at desktop
 * width in the dark ramp, at phone width in the light ramp, and the print
 * layout. Same fixture and viewport every run.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import SeatingView from "../../src/components/SeatingView";
import { __resetEventsCache, setCachedEvents } from "../../src/lib/events-store";
import type { SeatingChart } from "../../src/lib/seating-api";

const ARTIFACTS = "../../.vitest/attachments/seating";

function chart(): SeatingChart {
  const guest = (
    id: string,
    firstName: string,
    familyName: string,
    over: Partial<SeatingChart["guests"][number]> = {},
  ) => ({
    id,
    firstName,
    lastName: familyName,
    rsvp: "attending" as const,
    withdrawn: false,
    tableId: null,
    ...over,
  });
  return {
    event: { id: "e_rec", name: "Reception" },
    tables: [
      { id: "t1", name: "Table 1", capacity: 8, sortOrder: 0 },
      { id: "t2", name: "Table 2", capacity: 8, sortOrder: 1 },
    ],
    guests: [
      guest("g_ada", "Ada", "Alpha"),
      guest("g_bo", "Bo", "Alpha", { rsvp: "declined", tableId: "t1" }),
      guest("g_cy", "Cy", "Charlie", { rsvp: "maybe" }),
      guest("g_dot", "Dot", "Delta", { rsvp: null, tableId: "t1" }),
      guest("g_eve", "Eve", "Echo", { tableId: "t2" }),
    ],
  };
}

const writes: Array<{ method: string; url: string; body: unknown }> = [];

beforeEach(() => {
  __resetEventsCache();
  writes.length = 0;
  setCachedEvents("wed_1", [
    {
      id: "e_rec",
      name: "Reception",
      slug: "reception",
      sortOrder: 0,
      startAt: "2027-03-01T18:00",
      endAt: "",
      timezone: "UTC",
      address: null,
      description: "",
      dressCodeDescription: null,
      dressCodePalette: null,
      pinterestUrl: null,
      mapsUrl: null,
      imageUrl: null,
      imageCrop: null,
    },
  ]);
  const state = chart();
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify(state), { status: 200 });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    writes.push({ method, url, body });
    const guestId = /\/guests\/([^/]+)$/.exec(url)?.[1];
    return new Response(JSON.stringify({ guestId, tableId: body?.tableId ?? null }), {
      status: 200,
    });
  });
});

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ media: null, colorScheme: "no-preference" });
});

async function renderChart() {
  render(() => (
    // The module panel is a named container; the chart's two columns key on it.
    <div class="bg-bg text-text @container/panel min-h-screen p-6">
      <SeatingView weddingId="wed_1" weddingSlug="ada-and-bo" canEdit={true} canManage={true} />
    </div>
  ));
  await screen.findByRole("region", { name: "Table 2" });
}

const centre = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};

async function mouse(
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  at: { x: number; y: number },
) {
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: at.x,
    y: at.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

async function touch(type: "touchStart" | "touchMove" | "touchEnd", at?: { x: number; y: number }) {
  await cdp().send("Input.dispatchTouchEvent", {
    type,
    touchPoints: at ? [{ x: at.x, y: at.y }] : [],
  });
}

const aFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

describe("SeatingView in Chromium", () => {
  it("seats a guest dragged onto a table, painting the row above the cards it crosses", async () => {
    await page.viewport(1280, 900);
    await commands.emulateMedia({ colorScheme: "dark" });
    await renderChart();
    await page.screenshot({ path: `${ARTIFACTS}/chart-desktop-dark.png` });

    const row = screen.getByText("Ada Alpha").closest("li")!;
    const handle = row.querySelector("[data-drag-handle]")!;
    const target = screen.getByRole("region", { name: "Table 2" });
    const from = centre(handle);
    const to = centre(target);

    await mouse("mouseMoved", from);
    await mouse("mousePressed", from);
    await mouse("mouseMoved", { x: from.x + 10, y: from.y + 10 });
    await mouse("mouseMoved", to);
    // Mid-drag: the card lights, and what is under the pointer is the row
    // being dragged, not the card it is over.
    await waitFor(() => expect(target.getAttribute("data-over")).toBe("true"));
    expect(row.contains(document.elementFromPoint(to.x, to.y))).toBe(true);
    await mouse("mouseReleased", to);

    await waitFor(() => expect(within(target).getByText("Ada Alpha")).toBeTruthy());
    expect(writes).toEqual([
      {
        method: "PUT",
        url: "https://api.test/api/organiser/weddings/wed_1/seating/events/e_rec/guests/g_ada",
        body: { tableId: "t2" },
      },
    ]);
    await screen.findByText("Ada Alpha seated at Table 2.");
  });

  it("drags the same guest again after a move to an earlier table, and after the menu unseats one", async () => {
    await page.viewport(1280, 900);
    await renderChart();
    // The print sheet names seated guests too; the row is the one on screen.
    const rowOf = (name: string) =>
      screen
        .getAllByText(name)
        .find((el) => el.closest("body > [data-print-sheet]") === null)!
        .closest("li")!;
    const drag = async (name: string, tableName: string) => {
      const handle = rowOf(name).querySelector("[data-drag-handle]")!;
      const target = screen.getByRole("region", { name: tableName });
      const from = centre(handle);
      const to = centre(target);
      await mouse("mouseMoved", from);
      await mouse("mousePressed", from);
      await mouse("mouseMoved", { x: from.x + 10, y: from.y + 10 });
      await mouse("mouseMoved", to);
      await mouse("mouseReleased", to);
      await waitFor(() => expect(within(target).getByText(name)).toBeTruthy());
    };
    // Eve moves to the table before hers and back: her row is unmounted from
    // one card and mounted in the other each time.
    await drag("Eve Echo", "Table 1");
    await drag("Eve Echo", "Table 2");
    // Bo is unseated from his menu, then dragged from the list.
    const trigger = screen.getByRole("button", { name: "Move Bo Alpha" });
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
    const notSeated = await screen.findByRole("menuitemradio", { name: "Not seated" });
    notSeated.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Not seated" })).getByText("Bo Alpha"),
      ).toBeTruthy(),
    );
    await drag("Bo Alpha", "Table 2");
    const base = "https://api.test/api/organiser/weddings/wed_1/seating/events/e_rec/guests";
    expect(writes).toEqual([
      { method: "PUT", url: `${base}/g_eve`, body: { tableId: "t1" } },
      { method: "PUT", url: `${base}/g_eve`, body: { tableId: "t2" } },
      { method: "PUT", url: `${base}/g_bo`, body: { tableId: null } },
      { method: "PUT", url: `${base}/g_bo`, body: { tableId: "t2" } },
    ]);
  });

  it("lays out for a phone in the light ramp", async () => {
    await page.viewport(390, 844);
    await commands.emulateMedia({ colorScheme: "light" });
    await renderChart();
    // One column at phone width: the unseated list sits above the tables.
    const pool = screen.getByRole("region", { name: "Not seated" }).getBoundingClientRect();
    const first = screen.getByRole("region", { name: "Table 1" }).getBoundingClientRect();
    expect(first.top).toBeGreaterThanOrEqual(pool.bottom);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${ARTIFACTS}/chart-phone-light.png` });
  });

  it("seats a guest from the keyboard, and Escape hands focus back to the row", async () => {
    await page.viewport(1280, 900);
    await renderChart();
    const trigger = screen.getByRole("button", { name: "Seat Ada Alpha" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("menuitemradio", { name: /^Table 2/ });
    // A menu button's Enter lands on the first item.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Not seated"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Seat Ada Alpha");

    await userEvent.keyboard("{ArrowDown}");
    const item = await screen.findByRole("menuitemradio", { name: /^Table 2/ });
    for (let step = 0; step < 4 && document.activeElement !== item; step++) {
      await userEvent.keyboard("{ArrowDown}");
    }
    expect(document.activeElement).toBe(item);
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Table 2" })).getByText("Ada Alpha"),
      ).toBeTruthy(),
    );
    expect(writes).toEqual([
      {
        method: "PUT",
        url: "https://api.test/api/organiser/weddings/wed_1/seating/events/e_rec/guests/g_ada",
        body: { tableId: "t2" },
      },
    ]);
  });

  it("opens a guest's menu on the up arrow at its last item", async () => {
    await page.viewport(1280, 900);
    await renderChart();
    screen.getByRole("button", { name: "Seat Cy Charlie" }).focus();
    await userEvent.keyboard("{ArrowUp}");
    await screen.findByRole("menu");
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Table 2/));
  });

  it("opens a guest's menu on a real press and on a tap, and not on a touch that scrolls", async () => {
    await page.viewport(1280, 900);
    await renderChart();
    // A real press and release, where the press swaps the button for the menu's trigger.
    const ada = centre(screen.getByRole("button", { name: "Seat Ada Alpha" }));
    await mouse("mouseMoved", ada);
    await mouse("mousePressed", ada);
    await mouse("mouseReleased", ada);
    await screen.findByRole("menu");
    await aFrame();
    await aFrame();
    expect(screen.queryByRole("menu")).not.toBeNull();
    await page.screenshot({ path: `${ARTIFACTS}/menu-open.png` });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Pressed again, the menu's own trigger now takes the press and its click.
    await mouse("mousePressed", ada);
    await mouse("mouseReleased", ada);
    await screen.findByRole("menu");
    await aFrame();
    await aFrame();
    expect(screen.queryByRole("menu")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // A tap.
    const cy = centre(await waitFor(() => screen.getByRole("button", { name: "Seat Cy Charlie" })));
    await touch("touchStart", cy);
    await touch("touchEnd");
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // A touch that moves 40px is a scroll, not a tap.
    // The closed menu's outside-hiding clears a frame later.
    const dot = await waitFor(() => screen.getByRole("button", { name: "Move Dot Delta" }));
    const from = centre(dot);
    await touch("touchStart", from);
    await touch("touchMove", { x: from.x, y: from.y + 20 });
    await touch("touchMove", { x: from.x, y: from.y + 40 });
    await touch("touchEnd");
    await aFrame();
    await aFrame();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("prints the chart and nothing of the page around it", async () => {
    await page.viewport(1280, 900);
    await renderChart();
    // Nothing is built for paper until the page prints.
    expect(document.querySelector("body > [data-print-sheet]")).toBeNull();
    window.dispatchEvent(new Event("beforeprint"));
    await commands.emulateMedia({ media: "print" });

    const sheet = document.querySelector("body > [data-print-sheet]") as HTMLElement;
    expect(getComputedStyle(sheet).display).toBe("block");
    for (const child of document.body.children) {
      if (child === sheet || child.tagName === "SCRIPT" || child.tagName === "STYLE") continue;
      expect({ tag: child.tagName, display: getComputedStyle(child).display }).toEqual({
        tag: child.tagName,
        display: "none",
      });
    }
    expect(sheet.textContent).toContain("Reception");
    expect(sheet.textContent).toContain("Table 1");
    expect(sheet.textContent).toContain("Bo Alpha (declined)");
    expect(sheet.textContent).toContain("Eve Echo");
    // Paper is light whatever the screen ramp is.
    expect(getComputedStyle(sheet).color).toBe("rgb(0, 0, 0)");
    await page.screenshot({ path: `${ARTIFACTS}/print.png` });
    window.dispatchEvent(new Event("afterprint"));
    expect(document.querySelector("body > [data-print-sheet]")).toBeNull();
  });
});
