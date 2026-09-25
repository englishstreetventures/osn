// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RegistryView from "../../src/components/RegistryView";
import {
  __resetRegistryCache,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
} from "../../src/lib/registry-store";

/**
 * Re-ordering the gift list: the keyboard path, the screen-reader path and the
 * pointer path, all through `@shared/sortable`.
 *
 * What is load-bearing: a keyboard move leaves focus on the moved row's grip so
 * the row can be walked further, every move is announced, a failed save does not
 * leave a false announcement behind, and a move rebuilds only the rows whose
 * position changed.
 */

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api")),
  redirectToLogin: vi.fn(),
}));

const item = (over: Partial<RegistryItem>): RegistryItem => ({
  id: "itm_1",
  weddingId: "wed_1",
  kind: "product",
  title: "Copper pan",
  description: null,
  imageKey: null,
  imageCrop: null,
  externalUrl: null,
  priceMinor: null,
  quantityWanted: 1,
  quantityClaimed: 0,
  allowPartial: false,
  targetMinor: null,
  category: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const ITEMS = [
  item({ id: "a", title: "Copper pan", sortOrder: 0 }),
  item({ id: "b", title: "Wine fridge", sortOrder: 1 }),
  item({ id: "c", title: "Kettle", sortOrder: 2 }),
];

const snapshot = (items: RegistryItem[] = ITEMS): RegistrySnapshot => ({
  settings: {
    weddingId: "wed_1",
    published: false,
    headline: null,
    message: null,
    cashGiftsEnabled: false,
    shippingAddress: null,
    shippingVisibleFrom: null,
    stripeConnected: false,
    stripeChargesEnabled: false,
    updatedAt: null,
  },
  items,
  gifts: [],
  giftsHasMore: false,
  giftSummary: null,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
  contributionsOtherCurrencyCount: 0,
});

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function rows(): HTMLLIElement[] {
  const list = screen.getByTestId("registry-items");
  return [...list.querySelectorAll(":scope > li")] as HTMLLIElement[];
}

function renderedOrder(): string[] {
  return rows().map((li) => li.querySelector("span.font-medium")?.textContent?.trim() ?? "");
}

function grip(title: string): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(`^Reorder ${title}`) }) as HTMLButtonElement;
}

function mount(canEdit = true) {
  return render(() => (
    <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={canEdit} />
  ));
}

/**
 * Stacked rects from each row's current DOM position plus its own drag offset,
 * as a real browser's rect would include — the same stub `@shared/sortable`'s
 * own suite uses, for the reason given there.
 */
function stubRowGeometry(height = 40) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const index = rows().indexOf(this as HTMLLIElement);
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

beforeEach(() => {
  __resetRegistryCache();
  authFetch.mockReset();
  setCachedRegistry("wed_1", snapshot());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("gift list — keyboard", () => {
  it("moves a row, saves the order, announces it and keeps focus on the moved row", async () => {
    authFetch.mockResolvedValue(ok());
    mount();
    await screen.findByText("Kettle");

    const before = grip("Copper pan");
    before.focus();
    fireEvent.keyDown(before, { key: "ArrowDown" });

    expect(renderedOrder()).toEqual(["Wine fridge", "Copper pan", "Kettle"]);
    expect(screen.getByRole("status")).toHaveTextContent("Copper pan moved to position 2 of 3.");
    // The moved row is rebuilt (its item object changed), so this is a NEW
    // grip — and focus is on it, not on <body>.
    expect(document.activeElement).toBe(grip("Copper pan"));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/items\/reorder$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ orderedIds: ["b", "a", "c"] });
  });

  it("walks a row down the list with repeated presses on the focused grip", async () => {
    authFetch.mockResolvedValue(ok());
    mount();
    await screen.findByText("Kettle");

    grip("Copper pan").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });

    expect(renderedOrder()).toEqual(["Wine fridge", "Kettle", "Copper pan"]);
    expect(screen.getByRole("status")).toHaveTextContent("Copper pan moved to position 3 of 3.");
    expect(grip("Copper pan").getAttribute("aria-label")).toMatch(/position 3 of 3/);
  });

  it("moves with the screen-reader buttons, which stop at the ends of the list", async () => {
    authFetch.mockResolvedValue(ok());
    mount();
    await screen.findByText("Kettle");

    expect(screen.getByRole("button", { name: "Move Copper pan up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Kettle down" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Move Kettle up" }));
    expect(renderedOrder()).toEqual(["Copper pan", "Kettle", "Wine fridge"]);
    expect(screen.getByRole("status")).toHaveTextContent("Kettle moved to position 2 of 3.");
  });

  it("withdraws the announcement when the save fails and the old order comes back", async () => {
    authFetch.mockResolvedValueOnce(new Response("fail", { status: 500 })).mockResolvedValueOnce(
      new Response(JSON.stringify(snapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mount();
    await screen.findByText("Kettle");

    fireEvent.keyDown(grip("Copper pan"), { key: "ArrowDown" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't save the new order/);
    await waitFor(() => expect(renderedOrder()).toEqual(["Copper pan", "Wine fridge", "Kettle"]));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("leaves an inline editor on a row that did not move exactly as it was", async () => {
    authFetch.mockResolvedValue(ok());
    const { container } = mount();
    await screen.findByText("Kettle");

    fireEvent.click(screen.getByRole("button", { name: "Edit Kettle" }));
    const editForm = container.querySelectorAll("form")[1]!;
    const title = within(editForm).getByLabelText("Gift") as HTMLInputElement;
    fireEvent.input(title, { target: { value: "Kettle, half typed" } });

    fireEvent.keyDown(grip("Copper pan"), { key: "ArrowDown" });
    expect(renderedOrder()).toEqual(["Wine fridge", "Copper pan", "Kettle"]);

    // The same node, not a rebuilt one — so a caret in it would survive.
    expect(container.querySelectorAll("form")[1]!.querySelector("input")).toBe(title);
    expect(title.value).toBe("Kettle, half typed");
  });

  it("offers no reorder controls to a viewer", async () => {
    mount(false);
    await screen.findByText("Kettle");
    expect(screen.queryByRole("button", { name: /^Reorder / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("gift list — pointer drag", () => {
  function drag(handle: HTMLElement, toY: number) {
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent(
      document,
      new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: 20 }),
    );
    fireEvent(
      document,
      new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: toY }),
    );
    fireEvent(document, new PointerEvent("pointerup", { pointerId: 1, clientX: 10, clientY: toY }));
  }

  it("drops a row two slots down and saves that order", async () => {
    authFetch.mockResolvedValue(ok());
    mount();
    await screen.findByText("Kettle");
    stubRowGeometry();

    // Row 0 dragged onto the centre of row 2.
    drag(grip("Copper pan"), 10 + 2 * 40);

    await waitFor(() => expect(renderedOrder()).toEqual(["Wine fridge", "Kettle", "Copper pan"]));
    expect(screen.getByRole("status")).toHaveTextContent("Copper pan moved to position 3 of 3.");
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toEqual({ orderedIds: ["b", "c", "a"] });
  });

  it("still drags after a keyboard move rebuilt the moved row", async () => {
    authFetch.mockResolvedValue(ok());
    mount();
    await screen.findByText("Kettle");

    fireEvent.keyDown(grip("Kettle"), { key: "ArrowUp" });
    expect(renderedOrder()).toEqual(["Copper pan", "Kettle", "Wine fridge"]);

    stubRowGeometry();
    drag(grip("Kettle"), 10 - 40);
    await waitFor(() => expect(renderedOrder()).toEqual(["Kettle", "Copper pan", "Wine fridge"]));
  });
});
