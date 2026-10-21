import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The event drawer's run of show, measured in Chromium. Each item is a row of
 * four controls — the grip, a time, a name and a remove button — inside a
 * drawer that is the whole width of a phone, and only an engine can say
 * whether they fit: a `type="time"` input's width is the browser's, and a row
 * that overflows clips sideways in the drawer's scroller. A move button shown
 * on focus, where focus lands after Add and Remove, and how an item's error
 * and its after-midnight line are tied to its fields are a real browser's to
 * answer too. The fast tier pins the draft's rules
 * (`tests/lib/guest-event-draft.test.ts`); the end-to-end flow
 * (`cire-event-details`) adds, reorders and saves a run of show.
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

/** The visible controls in the run-of-show list: buttons and inputs with a box. */
function visibleControls(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>("input, button")].filter((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  });
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right - 0.5 &&
    b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 &&
    b.top < a.bottom - 0.5
  );
}

describe.each([
  ["a phone", 390, 844],
  ["a desktop", 1280, 800],
] as const)("moving, adding and removing items in the drawer, on %s", (_name, width, height) => {
  afterEach(() => cleanup());

  // A move button shows when it is focused, and is wider than the room beside
  // the grip on a phone: the row makes room for it rather than letting it sit
  // over the fields or Remove.
  it("keeps every control clear of the others while a move button is focused", async () => {
    const { list } = await openDrawer(width, height);
    // The enabled ones: an item at an end has no move that way, and a
    // disabled button takes no focus.
    const moves = [...list.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => (b.textContent ?? "").startsWith("Move ") && !b.disabled,
    );
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      move.focus();
      await settle();
      // Shown, not still a one-pixel sr-only box.
      expect(move.getBoundingClientRect().width).toBeGreaterThan(MINIMUM_TARGET);
      const boxes = visibleControls(list).map((el) => ({
        name: el.getAttribute("aria-label") ?? el.textContent ?? el.id,
        box: el.getBoundingClientRect(),
      }));
      const clashes: string[] = [];
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          if (overlaps(a.box, b.box)) clashes.push(`${a.name} / ${b.name}`);
        }
      }
      expect({ focused: move.textContent, clashes }).toEqual({
        focused: move.textContent,
        clashes: [],
      });
      expect(scrollerOf(list).scrollWidth).toBeLessThanOrEqual(scrollerOf(list).clientWidth);
    }
  });

  // Remove takes its own button with it: focus goes to the next item's grip,
  // else the previous one's, else Add item.
  it("puts focus on a neighbour's grip, then on Add item, as items are removed", async () => {
    const { drawer, list } = await openDrawer(width, height);
    const remove = (name: string) =>
      userEvent.click(within(drawer).getByRole("button", { name: `Remove ${name}` }));
    await remove("Tea is poured");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Reorder Doors,/);
    const last = list.querySelectorAll<HTMLElement>(":scope > li")[1]!;
    await userEvent.click(within(last).getByRole("button", { name: /^Remove / }));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Reorder Doors,/);
    await remove("Doors");
    expect(document.activeElement?.textContent).toBe("Add item");
  });

  // Add item opens a row ready to type in. A row is not called wrong while it
  // is being filled in; once focus leaves it, its error is said under the
  // field it is about, by the item's number, and the field is marked.
  it("focuses a new item's name, and names its error only once it is left", async () => {
    const { drawer } = await openDrawer(width, height);
    await userEvent.click(within(drawer).getByRole("button", { name: "Add item" }));
    const name = within(drawer).getByLabelText("Item 4");
    expect(document.activeElement).toBe(name);
    // An unnamed item is "item 4" wherever it is named.
    expect(
      within(drawer).getByRole("button", { name: /^Reorder item 4, position 4 of 4/ }),
    ).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Remove item 4" })).toBeTruthy();
    expect(drawer.textContent).not.toContain("needs a name");
    expect(name.getAttribute("aria-invalid")).toBeNull();

    await userEvent.click(within(drawer).getByLabelText("Venue name"));
    const error = within(drawer).getByText("Item 4 needs a name.");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const described = (name.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described.join(" ")).toContain("Item 4 needs a name.");
    // Said under the item, not in the list above the form.
    expect(name.closest("li")?.contains(error)).toBe(true);
  });

  // The after-midnight line is a description of the item's time.
  it("describes an after-midnight time with its line", async () => {
    const { drawer } = await openDrawer(width, height);
    const time = within(drawer).getByLabelText("Time of item 2");
    const line = within(drawer).getByText(
      "Earlier than the start, so guests read it as after midnight.",
    );
    expect(time.getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
    expect(
      within(drawer).getByLabelText("Time of item 1").getAttribute("aria-describedby"),
    ).toBeNull();
  });

  // A swatch's Remove goes with its row too: focus moves to the swatch that
  // took its place, else the one before, else Add swatch.
  it("puts focus on a neighbouring swatch, then on Add swatch, as swatches are removed", async () => {
    const { drawer } = await openDrawer(width, height);
    const add = within(drawer).getByRole("button", { name: "Add swatch" });
    await userEvent.click(add);
    await userEvent.click(add);
    await userEvent.click(within(drawer).getByRole("button", { name: "Remove swatch 1" }));
    expect(document.activeElement).toBe(within(drawer).getByLabelText("Swatch 1 name"));
    await userEvent.click(within(drawer).getByRole("button", { name: "Remove swatch 1" }));
    expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "Add swatch" }));
  });
});

describe("the rest of the drawer", () => {
  afterEach(() => cleanup());

  // The guest policy's two selects share a row where both fit and stack on a
  // phone (DESIGN.md §7).
  it.each([
    ["stack on a phone", 390, 844, true],
    ["share a row on a desktop", 1280, 800, false],
  ] as const)("the guest policy selects %s", async (_name, width, height, stacked) => {
    const { drawer } = await openDrawer(width, height);
    const children = within(drawer).getByLabelText("Children").getBoundingClientRect();
    const plusOnes = within(drawer).getByLabelText("Plus-ones").getBoundingClientRect();
    expect(plusOnes.top >= children.bottom).toBe(stacked);
  });

  // An API older than the run of show, notes and policy sends none of them; the
  // drawer then leaves them out rather than take what the save would drop.
  it("leaves the three sections out for an API whose events read carries none of them", async () => {
    __resetEventsCache();
    const {
      runOfShow: _runOfShow,
      gettingThere: _gettingThere,
      childrenPolicy: _childrenPolicy,
      plusOnePolicy: _plusOnePolicy,
      guestPolicyNote: _guestPolicyNote,
      ...older
    } = KITCHEN_TEA;
    authFetch.mockImplementation(async (url: unknown) =>
      String(url).endsWith("/changes/head") ? json({ revision: "rev_1" }) : json([older]),
    );
    await page.viewport(390, 844);
    render(() => <EventsEditor weddingId="wed_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit event" });
    expect(within(drawer).queryByTestId("run-of-show")).toBeNull();
    expect(within(drawer).queryByRole("button", { name: "Add item" })).toBeNull();
    expect(within(drawer).queryByLabelText("Getting there (optional)")).toBeNull();
    expect(within(drawer).queryByLabelText("Children")).toBeNull();
    expect(within(drawer).getByLabelText("Venue name")).toBeTruthy();
  });
});
