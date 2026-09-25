// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BudgetView from "../../src/components/BudgetView";
import {
  __resetBudgetCache,
  type BudgetSnapshot,
  setCachedBudget,
} from "../../src/lib/budget-store";

/**
 * Re-ordering budget items within a category, through `@shared/sortable`: focus
 * stays on the moved item's grip, the move is announced in that category, a
 * failed save withdraws the announcement, and an open payments panel on a row
 * that did not move survives.
 */

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

type Item = BudgetSnapshot["items"][number];

const item = (id: string, category: Item["category"], name: string, sortOrder: number): Item => ({
  id,
  weddingId: "wed_1",
  category,
  name,
  estimateMinor: 100000,
  quotedMinor: null,
  actualMinor: null,
  notes: null,
  sortOrder,
  createdAt: 1,
  updatedAt: 1,
});

const SNAPSHOT: BudgetSnapshot = {
  items: [
    item("a", "venue", "Reception venue", 0),
    item("b", "venue", "Ceremony hire", 1),
    item("c", "catering", "Caterer", 0),
    item("d", "catering", "Cake", 1),
    item("e", "catering", "Late snacks", 2),
  ],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
};

function section(heading: string) {
  return within(screen.getByRole("heading", { name: heading }).closest("section")!);
}

function order(category: string): string[] {
  const list = screen.getByTestId(`budget-${category}`);
  return [...list.querySelectorAll(":scope > li")].map(
    (li) => li.querySelector("span.flex-1")?.textContent?.trim() ?? "",
  );
}

/** Stacked rects for one list's rows, plus each row's own drag offset — the
 *  stub `@shared/sortable`'s suite uses. */
function stubRowGeometry(testId: string, height = 40) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const rows = [...screen.getByTestId(testId).querySelectorAll(":scope > li")];
    const index = rows.indexOf(this);
    const offset = Number(
      /translate3d\(0px, (-?[\d.]+)px/.exec((this as HTMLElement).style?.transform ?? "")?.[1] ?? 0,
    );
    const top = (index === -1 ? 0 : index * height) + offset;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function drag(handle: HTMLElement, toY: number) {
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent(document, new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: 20 }));
  fireEvent(document, new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: toY }));
  fireEvent(document, new PointerEvent("pointerup", { pointerId: 1, clientX: 10, clientY: toY }));
}

function grip(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(`^Reorder ${name},`) }) as HTMLButtonElement;
}

beforeEach(() => {
  __resetBudgetCache();
  authFetch.mockReset();
  setCachedBudget("wed_1", SNAPSHOT);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("budget — reorder", () => {
  it("moves an item by keyboard, keeps focus on it and announces it in its own category", async () => {
    authFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Late snacks");

    grip("Caterer").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });

    expect(order("catering")).toEqual(["Cake", "Late snacks", "Caterer"]);
    expect(document.activeElement).toBe(grip("Caterer"));
    expect(section("Catering").getByRole("status")).toHaveTextContent(
      "Caterer moved to position 3 of 3.",
    );
    expect(section("Venue").getByRole("status")).toHaveTextContent("");

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    const [url, init] = authFetch.mock.calls[1]!;
    expect(String(url)).toMatch(/\/budget\/items\/reorder$/);
    expect(JSON.parse(init.body)).toEqual({ category: "catering", orderedIds: ["d", "e", "c"] });
  });

  it("moves an item with the screen-reader buttons", async () => {
    authFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Late snacks");

    fireEvent.click(screen.getByRole("button", { name: "Move Ceremony hire up" }));

    expect(order("venue")).toEqual(["Ceremony hire", "Reception venue"]);
    expect(section("Venue").getByRole("status")).toHaveTextContent(
      "Ceremony hire moved to position 1 of 2.",
    );
  });

  it("keeps an open payments panel on a row that did not move", async () => {
    authFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Late snacks");

    const lateSnacks = screen.getByTestId("budget-catering").querySelectorAll(":scope > li")[2]!;
    fireEvent.click(within(lateSnacks as HTMLElement).getByRole("button", { name: /payments/ }));
    const label = within(lateSnacks as HTMLElement).getByLabelText(
      "Payment label",
    ) as HTMLInputElement;
    fireEvent.input(label, { target: { value: "Deposit" } });

    fireEvent.keyDown(grip("Caterer"), { key: "ArrowDown" });
    expect(order("catering")).toEqual(["Cake", "Caterer", "Late snacks"]);

    // The same node, still holding what was typed.
    expect(screen.getByLabelText("Payment label")).toBe(label);
    expect(label.value).toBe("Deposit");
  });

  it("withdraws the announcement when the save fails and the old order comes back", async () => {
    authFetch.mockResolvedValueOnce(new Response("fail", { status: 500 })).mockResolvedValueOnce(
      new Response(JSON.stringify(SNAPSHOT), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Late snacks");

    fireEvent.keyDown(grip("Caterer"), { key: "ArrowDown" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't save the new order/);
    await waitFor(() => expect(order("catering")).toEqual(["Caterer", "Cake", "Late snacks"]));
    expect(section("Catering").getByRole("status")).toHaveTextContent("");
  });

  it("drops an item onto another row of its category and saves that category's order", async () => {
    authFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Late snacks");
    stubRowGeometry("budget-catering");

    drag(grip("Caterer"), 10 + 2 * 40);

    await waitFor(() => expect(order("catering")).toEqual(["Cake", "Late snacks", "Caterer"]));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toEqual({
      category: "catering",
      orderedIds: ["d", "e", "c"],
    });
  });

  it("offers a viewer no reorder controls", async () => {
    render(() => <BudgetView weddingId="wed_1" canEdit={false} canManage={false} />);
    await screen.findByText("Late snacks");
    expect(screen.queryByRole("button", { name: /^Reorder / })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
