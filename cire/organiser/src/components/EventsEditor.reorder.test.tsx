// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-ordering the schedule — the two input paths, kept apart from the main
 * EventsEditor suite because the pointer path needs geometry faked in.
 *
 * happy-dom does no layout: every `getBoundingClientRect()` is zeroes, so
 * solid-dnd's `closestCenter` would see every row's centre at (0,0) and pick a
 * collision arbitrarily. `stubRowGeometry` gives the rows real stacked rects so a
 * synthetic pointer drag resolves to a genuine drop target — which makes this an
 * end-to-end check of solid-dnd itself (sensor → collision → `onDragEnd`), not
 * just of our handler.
 */

const authFetchMock = vi.fn();

vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import { __resetEventsCache } from "../lib/events-store";
import { __resetGuestsCache } from "../lib/guests-store";
import EventsEditor from "./EventsEditor";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const baseEvent = {
  slug: "",
  endAt: "",
  timezone: "Australia/Sydney",
  address: null,
  description: "",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null,
  imageCrop: null,
};

const EVENTS = [
  {
    ...baseEvent,
    id: "evt_1",
    name: "Ceremony",
    sortOrder: 0,
    startAt: "2026-11-14T15:00:00+11:00",
  },
  {
    ...baseEvent,
    id: "evt_2",
    name: "Reception",
    sortOrder: 1,
    startAt: "2026-11-14T18:00:00+11:00",
  },
  { ...baseEvent, id: "evt_3", name: "Brunch", sortOrder: 2, startAt: "2026-11-15T10:00:00+11:00" },
];

const ROW_HEIGHT = 100;

/** The event rows, scoped to the schedule list. NOT a document-wide `li` query:
 *  `ChangePreview` and the drawer render list markup too, so a test that opens
 *  one would otherwise silently pick up foreign rows — and with the geometry
 *  stub below that failure would look like a solid-dnd bug. */
function rows() {
  const list = document.querySelector('ul[data-testid="event-list"]');
  return [...(list?.querySelectorAll(":scope > li") ?? [])] as HTMLLIElement[];
}

/** Give each event row a real stacked bounding box so collision detection works.
 *  Rects are derived from the row's CURRENT DOM position, so they stay correct
 *  after a reorder moves the nodes. */
function stubRowGeometry() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element): DOMRect {
      const index = rows().indexOf(this as HTMLLIElement);
      if (index === -1) return new DOMRect(0, 0, 0, 0);
      return new DOMRect(0, index * ROW_HEIGHT, 500, ROW_HEIGHT);
    },
  );
}

/** The visible event names, in rendered order. */
function renderedOrder() {
  return rows().map((li) => li.querySelector("p")?.textContent?.trim() ?? "");
}

/** Every grip's aria-label, in rendered order — the positional feedback screen
 *  readers rely on, which must track the order after every move. */
function gripLabels() {
  return rows().map(
    (li) =>
      li.querySelector('button[aria-describedby="reorder-hint"]')?.getAttribute("aria-label") ?? "",
  );
}

function grip(name: string) {
  return screen.getByRole("button", { name: new RegExp(`Reorder ${name}`, "i") });
}

function liveRegion() {
  return screen.getByRole("status");
}

beforeEach(() => {
  Object.defineProperty(window, "confirm", {
    configurable: true,
    value: vi.fn().mockReturnValue(true),
  });
  authFetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith("/events")) return Promise.resolve(json(EVENTS));
    if (String(url).endsWith("/guests")) return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  authFetchMock.mockReset();
  __resetGuestsCache();
  __resetEventsCache();
});

async function mounted() {
  render(() => <EventsEditor weddingId="wed_a" />);
  await waitFor(() => expect(screen.getByText("Brunch")).toBeTruthy());
  expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]);
}

describe("EventsEditor — re-ordering by keyboard", () => {
  it("moves a row down with ArrowDown from the focused grip", async () => {
    await mounted();

    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });

    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]));
    // The move is announced for screen readers.
    expect(screen.getByRole("status").textContent).toMatch(/Ceremony moved to position 2 of 3/i);
    // And it dirties the draft, so it can be saved.
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy();
  });

  it("moves a row up with ArrowUp", async () => {
    await mounted();

    fireEvent.keyDown(grip("Brunch"), { key: "ArrowUp" });

    await waitFor(() => expect(renderedOrder()).toEqual(["Ceremony", "Brunch", "Reception"]));
    expect(screen.getByRole("status").textContent).toMatch(/Brunch moved to position 2 of 3/i);
  });

  it("keeps focus on the moved row's grip so it can be moved again", async () => {
    await mounted();

    const handle = grip("Ceremony");
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]));

    // `<For>` is keyed, so this is the SAME node moved to the new slot — and the
    // handler re-focuses it, because a DOM move doesn't reliably keep focus.
    expect(grip("Ceremony")).toBe(handle);
    expect(document.activeElement).toBe(handle);
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Brunch", "Ceremony"]));
  });

  it("ignores a move off either end of the list", async () => {
    await mounted();

    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowUp" });
    fireEvent.keyDown(grip("Brunch"), { key: "ArrowDown" });

    expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]);
    // Nothing changed ⇒ the draft is still clean.
    expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();
  });

  it("leaves other keys alone", async () => {
    await mounted();

    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowLeft" });
    fireEvent.keyDown(grip("Ceremony"), { key: "Enter" });

    expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]);
  });

  it("re-labels every grip with its new position after a move", async () => {
    await mounted();
    expect(gripLabels()).toEqual([
      "Reorder Ceremony, position 1 of 3",
      "Reorder Reception, position 2 of 3",
      "Reorder Brunch, position 3 of 3",
    ]);

    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]));

    // The whole point of the position-in-label mechanism is that it TRACKS the
    // order. Hoisting the label out of the reactive JSX expression, or swapping
    // <For> for <Index>, would freeze these at their mount positions and silently
    // kill the only positional feedback a screen-reader user gets.
    expect(gripLabels()).toEqual([
      "Reorder Reception, position 1 of 3",
      "Reorder Ceremony, position 2 of 3",
      "Reorder Brunch, position 3 of 3",
    ]);
  });

  it("re-announces an identical consecutive move", async () => {
    await mounted();

    // Walking one row down repeatedly produces the SAME sentence each time. A
    // live region only speaks when its text changes, so `announceMove` has to
    // clear first — otherwise the second press is silent.
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    await waitFor(() => expect(liveRegion().textContent).toMatch(/position 2 of 3/i));

    const seen: string[] = [];
    new MutationObserver((records) => {
      for (const _ of records) seen.push(liveRegion().textContent ?? "");
    }).observe(liveRegion(), { childList: true, characterData: true, subtree: true });

    // Reception is now first; move it down so Ceremony returns to slot 2 — the
    // exact same announcement string as the first move.
    fireEvent.keyDown(grip("Reception"), { key: "ArrowDown" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]));
    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]));

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(liveRegion().textContent).toMatch(/Ceremony moved to position 2 of 3/i);
  });

  it("clears a stale announcement when the move is undone", async () => {
    await mounted();

    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    await waitFor(() => expect(liveRegion().textContent).toMatch(/position 2 of 3/i));

    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));

    // The order is back, so the region must not keep asserting a move that has
    // been reversed. Silence rather than a guess: undo may have reverted a field
    // edit rather than a re-order.
    await waitFor(() => expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]));
    expect(liveRegion().textContent).toBe("");
  });

  it("names an unnamed event the same way the row does", async () => {
    await mounted();

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    await waitFor(() => expect(rows()).toHaveLength(4));

    // The blank row, its grip label and its announcement all say the same thing,
    // and the existing rows' counts re-render to "of 4".
    expect(gripLabels()).toEqual([
      "Reorder Ceremony, position 1 of 4",
      "Reorder Reception, position 2 of 4",
      "Reorder Brunch, position 3 of 4",
      "Reorder Untitled event, position 4 of 4",
    ]);
    expect(renderedOrder()[3]).toBe("Untitled event");

    fireEvent.keyDown(grip("Untitled event"), { key: "ArrowUp" });
    await waitFor(() =>
      expect(liveRegion().textContent).toMatch(/Untitled event moved to position 3 of 4/i),
    );
  });

  it("still re-orders after the sortable id list changes", async () => {
    await mounted();

    // Deleting a row rewrites `SortableProvider`'s ids. A stale id list is the
    // classic solid-dnd sortable failure: `onDragEnd` resolves -1 and the drop is
    // swallowed by the guard with no feedback.
    fireEvent.click(screen.getAllByRole("button", { name: /^Delete$/i })[1]!);
    await waitFor(() => expect(renderedOrder()).toEqual(["Ceremony", "Brunch"]));

    fireEvent.keyDown(grip("Brunch"), { key: "ArrowUp" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Brunch", "Ceremony"]));
    expect(liveRegion().textContent).toMatch(/Brunch moved to position 1 of 2/i);
  });

  it("ignores auto-repeat so a held key is one move, not thirty", async () => {
    await mounted();

    const handle = grip("Ceremony");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]));

    // Key auto-repeat fires ~30×/s, and each move is a full draft checkpoint
    // (structuredClone) plus a revalidation. Without the guard a held key stalls
    // the list and burns the 100-slot undo stack in seconds.
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: "ArrowDown", repeat: true });

    expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]);
    // One press ⇒ one undo step: Undo returns to the loaded order in a single hop.
    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
    await waitFor(() => expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]));
    expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();
  });

  it("traps Up/Down on a focused grip even at the list ends", async () => {
    await mounted();

    // Deliberate: a focused grip owns the arrow keys unconditionally, so at
    // either end the key does nothing rather than sometimes moving the row and
    // sometimes scrolling the page out from under it.
    const top = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true, bubbles: true });
    grip("Ceremony").dispatchEvent(top);
    expect(top.defaultPrevented).toBe(true);
    expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]);
  });
});

describe("EventsEditor — re-ordering for assistive tech", () => {
  /** NVDA/JAWS browse mode consumes unmodified arrow keys for its own virtual
   *  cursor and does not forward them to a focused plain <button>, so the grip's
   *  arrow handler is unreachable for those users. These Enter/Space-activated
   *  buttons are the path that replaces the removed visible ▲/▼ pair. */
  it("moves a row via the screen-reader-only move buttons", async () => {
    await mounted();

    fireEvent.click(screen.getByRole("button", { name: /Move Brunch up/i }));

    await waitFor(() => expect(renderedOrder()).toEqual(["Ceremony", "Brunch", "Reception"]));
    expect(liveRegion().textContent).toMatch(/Brunch moved to position 2 of 3/i);

    fireEvent.click(screen.getByRole("button", { name: /Move Ceremony down/i }));
    await waitFor(() => expect(renderedOrder()).toEqual(["Brunch", "Ceremony", "Reception"]));
  });

  it("disables the move button at each end of the list", async () => {
    await mounted();

    const up = (name: string) =>
      screen.getByRole("button", { name: new RegExp(`Move ${name} up`, "i") }) as HTMLButtonElement;
    const down = (name: string) =>
      screen.getByRole("button", {
        name: new RegExp(`Move ${name} down`, "i"),
      }) as HTMLButtonElement;

    // Disabled rather than a silent no-op, so AT reports the boundary.
    expect(up("Ceremony").disabled).toBe(true);
    expect(down("Ceremony").disabled).toBe(false);
    expect(down("Brunch").disabled).toBe(true);
    expect(up("Brunch").disabled).toBe(false);

    // And the disabled edge follows the row as it moves.
    fireEvent.click(down("Ceremony"));
    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]));
    expect(up("Ceremony").disabled).toBe(false);
    expect(up("Reception").disabled).toBe(true);
  });
});

describe("EventsEditor — re-ordering by pointer drag", () => {
  /** Drive solid-dnd's pointer sensor: press the grip, move past the sensor's
   *  activation threshold onto the target row's centre, release. */
  function drag(handle: HTMLElement, toY: number) {
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    // First move activates the sensor (it has a small distance threshold).
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: 30 }));
    fireEvent(document, new PointerEvent("pointermove", { clientX: 10, clientY: toY }));
    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: toY }));
  }

  it("drops a row onto a lower slot and commits the new order", async () => {
    await mounted();
    stubRowGeometry();

    // Drag Ceremony (row 0) down over Brunch's row (row 2, centre y=250).
    drag(grip("Ceremony"), 10 + 2 * ROW_HEIGHT);

    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Brunch", "Ceremony"]));
    expect(screen.getByRole("status").textContent).toMatch(/Ceremony moved to position 3 of 3/i);
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy();
  });

  it("drops a row onto a higher slot", async () => {
    await mounted();
    stubRowGeometry();

    // Drag Brunch (row 2) up over Ceremony's row (row 0).
    drag(grip("Brunch"), 10 - 2 * ROW_HEIGHT);

    await waitFor(() => expect(renderedOrder()).toEqual(["Brunch", "Ceremony", "Reception"]));
  });

  it("a press with no movement leaves the order untouched", async () => {
    await mounted();
    stubRowGeometry();

    const handle = grip("Reception");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent(document, new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));

    expect(renderedOrder()).toEqual(["Ceremony", "Reception", "Brunch"]);
    expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();
  });
});

describe("EventsEditor — a re-order reaches the wire", () => {
  it("sends the new order as gap-free sortOrder in the preview payload", async () => {
    await mounted();

    fireEvent.keyDown(grip("Ceremony"), { key: "ArrowDown" });
    await waitFor(() => expect(renderedOrder()).toEqual(["Reception", "Ceremony", "Brunch"]));

    authFetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [{}, {}],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
        );
      }
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() =>
      expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/changes/preview"))).toBe(
        true,
      ),
    );

    // Joins the two halves that are otherwise only tested apart: the row moved in
    // the DOM, and the request carries that order as sortOrder 0..n.
    const call = authFetchMock.mock.calls.find((c) => String(c[0]).endsWith("/changes/preview"))!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as {
      desiredState: { events: { name: string; sortOrder: number }[] };
    };
    expect(body.desiredState.events.map((e) => [e.name, e.sortOrder])).toEqual([
      ["Reception", 0],
      ["Ceremony", 1],
      ["Brunch", 2],
    ]);
  });
});
