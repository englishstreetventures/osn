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

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

const redirectToLoginMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, redirectToLogin: redirectToLoginMock };
});

const snap = (over: Partial<BudgetSnapshot>): BudgetSnapshot => ({
  items: [],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
  ...over,
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  __resetBudgetCache();
  authFetch.mockReset();
  redirectToLoginMock.mockReset();
});

describe("BudgetView", () => {
  it("groups items under their category headings with a subtotal", async () => {
    setCachedBudget(
      "wed_1",
      snap({
        items: [
          {
            id: "a",
            weddingId: "wed_1",
            category: "venue",
            name: "Reception venue",
            estimateMinor: 1200000,
            quotedMinor: null,
            actualMinor: null,
            notes: null,
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    expect(await screen.findByText("Reception venue")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Venue" })).toBeInTheDocument();
  });

  it("totals each category on its own, and shows no section for an empty one", async () => {
    const item = (id: string, category: "venue" | "catering", estimateMinor: number) => ({
      id,
      weddingId: "wed_1",
      category,
      name: `Item ${id}`,
      estimateMinor,
      quotedMinor: null,
      actualMinor: null,
      notes: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    setCachedBudget(
      "wed_1",
      snap({ items: [item("a", "venue", 120_000), item("b", "catering", 30_000)] }),
    );
    authFetch.mockReturnValue(new Promise(() => {}));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Item a");

    const venue = screen.getByRole("heading", { name: "Venue" }).closest("section")!;
    const catering = screen.getByRole("heading", { name: "Catering" }).closest("section")!;
    expect(venue).toHaveTextContent(/est \S*1,200\.00 · spent \S*0\.00/);
    expect(catering).toHaveTextContent(/est \S*300\.00 · spent \S*0\.00/);
    expect(screen.queryByRole("heading", { name: "Photography" })).not.toBeInTheDocument();

    // Removing a category's last item removes its section, not just its rows.
    fireEvent.click(within(catering as HTMLElement).getByRole("button", { name: "Delete item" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Catering" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Venue" })).toBeInTheDocument();
  });

  it("says there are no items when the budget is empty", async () => {
    setCachedBudget("wed_1", snap({ items: [] }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    expect(await screen.findByText("No budget items yet.")).toBeInTheDocument();
  });

  it("hides the add-item form for a viewer (read-only)", async () => {
    setCachedBudget(
      "wed_1",
      snap({
        items: [
          {
            id: "a",
            weddingId: "wed_1",
            category: "venue",
            name: "Reception venue",
            estimateMinor: null,
            quotedMinor: null,
            actualMinor: null,
            notes: null,
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={false} canManage={false} />);
    await screen.findByText("Reception venue");
    expect(screen.queryByRole("button", { name: /add item/i })).not.toBeInTheDocument();
  });

  // Categories are grid siblings now, so a row escaping its own <section> — or
  // reorder arrows resolving indices against the flattened item list rather than
  // their own category — would be invisible to a single-category test. DOM
  // containment, so it holds with or without the grid applied.
  it("keeps each category's rows and reorder controls inside their own section", async () => {
    const item = (
      id: string,
      category: BudgetSnapshot["items"][number]["category"],
      name: string,
      sortOrder: number,
    ): BudgetSnapshot["items"][number] => ({
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
    setCachedBudget(
      "wed_1",
      snap({
        items: [
          item("a", "venue", "Reception venue", 0),
          item("b", "venue", "Ceremony hire", 1),
          item("c", "catering", "Caterer", 0),
          item("d", "catering", "Cake", 1),
        ],
      }),
    );
    authFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Reception venue");

    const sectionFor = (heading: string) =>
      screen.getByRole("heading", { name: heading }).closest("section")!;
    const venue = within(sectionFor("Venue"));
    const catering = within(sectionFor("Catering"));

    expect(venue.getByText("Ceremony hire")).toBeInTheDocument();
    expect(venue.queryByText("Caterer")).not.toBeInTheDocument();
    expect(catering.getByText("Caterer")).toBeInTheDocument();
    expect(catering.queryByText("Reception venue")).not.toBeInTheDocument();

    // Per-category edges, and a reorder that names only that category's ids.
    expect(venue.getByRole("button", { name: "Move Reception venue up" })).toBeDisabled();
    expect(catering.getByRole("button", { name: "Move Cake down" })).toBeDisabled();
    fireEvent.click(catering.getByRole("button", { name: "Move Cake up" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/budget\/items\/reorder$/);
    expect(JSON.parse(init.body)).toEqual({ category: "catering", orderedIds: ["d", "c"] });
  });

  it("adds an item (POST) and appends it to the cache", async () => {
    setCachedBudget("wed_1", snap({ items: [] }));
    authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          item: {
            id: "new",
            weddingId: "wed_1",
            category: "catering",
            name: "Caterer",
            estimateMinor: null,
            quotedMinor: null,
            actualMinor: null,
            notes: null,
            sortOrder: 0,
            createdAt: 2,
            updatedAt: 2,
          },
        }),
        { status: 200 },
      ),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    const nameInput = await screen.findByPlaceholderText(/caterer, venue/i);
    fireEvent.input(nameInput, { target: { value: "Caterer" } });
    fireEvent.click(screen.getByRole("button", { name: /add item/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/budget\/items$/);
    expect(init.method).toBe("POST");
    expect(await screen.findByText("Caterer")).toBeInTheDocument();
  });

  /**
   * `reload()` (BudgetView.tsx) now routes through `invalidateBudget` +
   * `ensureBudgetLoaded` instead of a bare `setCachedBudget(id, await load())`.
   * A store-level test proves the signal goes null when a refetch is refused;
   * it does not prove the view stops rendering the rows it already captured.
   * This drives that end to end: a failed mutation triggers `reload()`, whose
   * own refetch is refused too, and the previously rendered row must
   * disappear along with the refresh error appearing.
   */
  it("a refused reload after a failed mutation clears the rows and shows the refresh error", async () => {
    setCachedBudget(
      "wed_1",
      snap({
        items: [
          {
            id: "a",
            weddingId: "wed_1",
            category: "venue",
            name: "Reception venue",
            estimateMinor: null,
            quotedMinor: null,
            actualMinor: null,
            notes: null,
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    authFetch
      .mockResolvedValueOnce(new Response("fail", { status: 500 })) // the add-item POST fails
      .mockResolvedValueOnce(new Response("fail", { status: 500 })); // reload()'s own GET is refused too
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Reception venue");

    const nameInput = screen.getByPlaceholderText(/caterer, venue/i);
    fireEvent.input(nameInput, { target: { value: "Cake" } });
    fireEvent.click(screen.getByRole("button", { name: /add item/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh your budget."),
    );
    expect(screen.queryByText("Reception venue")).not.toBeInTheDocument();
  });
});

describe("BudgetView — per-head lines", () => {
  const EVENTS = [
    { id: "evt_ceremony", name: "Ceremony" },
    { id: "evt_reception", name: "Reception" },
  ];
  const row = (over: Partial<BudgetSnapshot["items"][number]> = {}) => ({
    id: "ph",
    weddingId: "wed_1",
    category: "catering",
    name: "Dinner",
    estimateMinor: null,
    quotedMinor: null,
    actualMinor: null,
    notes: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    unitPriceMinor: 5_000,
    eventIds: null,
    headcount: { expected: 120, confirmed: 80 },
    ...over,
  });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("offers no per-head control against an API that does not send the event list", async () => {
    setCachedBudget(
      "wed_1",
      snap({
        items: [
          row({
            unitPriceMinor: undefined,
            headcount: undefined,
            eventIds: undefined,
            estimateMinor: 1_000,
          }),
        ],
      }),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Dinner");
    expect(screen.queryByLabelText("Priced per head")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "per head" })).not.toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("shows a per-head line's computed estimate read-only, and counts it in the totals", async () => {
    setCachedBudget("wed_1", snap({ items: [row()], events: EVENTS, rsvpsClosed: false }));
    authFetch.mockReturnValue(new Promise(() => {}));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Dinner");
    expect(screen.getByTestId("per-head-summary")).toHaveTextContent(/120 expected/);
    const section = screen.getByRole("heading", { name: "Catering" }).closest("section")!;
    expect(section).toHaveTextContent(/est \S*6,000\.00 · spent \S*6,000\.00/);
    // The Est cell is text, not an input: only the Quote and Actual cells edit.
    expect(within(section as HTMLElement).getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.getByText(/Spent so far/).parentElement).toHaveTextContent(/6,000\.00/);
  });

  it("refetches on open when the cached budget holds a per-head line", async () => {
    setCachedBudget("wed_1", snap({ items: [row()], events: EVENTS }));
    authFetch.mockResolvedValueOnce(
      json(
        snap({
          items: [row({ headcount: { expected: 130, confirmed: 90 } })],
          events: EVENTS,
          rsvpsClosed: false,
        }),
      ),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={false} canManage={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("per-head-summary")).toHaveTextContent(/130 expected/),
    );
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("saves the price and events from the per-head panel and folds the returned row", async () => {
    setCachedBudget(
      "wed_1",
      snap({
        items: [row({ unitPriceMinor: null, headcount: null, estimateMinor: 900 })],
        events: EVENTS,
      }),
    );
    // The fixed-only cache does not refetch on open, so the PATCH is the first call.
    authFetch.mockResolvedValueOnce(
      json({
        item: row({
          unitPriceMinor: 2_000,
          eventIds: ["evt_reception"],
          headcount: { expected: 40, confirmed: 10 },
        }),
      }),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Dinner");
    fireEvent.click(screen.getByRole("button", { name: "per head" }));
    fireEvent.input(screen.getByLabelText(/Price per head \(AUD\)/), { target: { value: "20" } });
    fireEvent.click(screen.getByLabelText("Only these events"));
    fireEvent.click(screen.getByLabelText("Reception"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/budget\/items\/ph$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      perHead: { unitPriceMinor: 2_000, eventIds: ["evt_reception"] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("per-head-summary")).toHaveTextContent(/per head at Reception/),
    );
    expect(screen.queryByTestId("per-head-panel")).not.toBeInTheDocument();
  });

  it("turns a line back to a fixed amount, keeping what it came to", async () => {
    setCachedBudget("wed_1", snap({ items: [row()], events: EVENTS, rsvpsClosed: true }));
    authFetch
      .mockResolvedValueOnce(json(snap({ items: [row()], events: EVENTS, rsvpsClosed: true })))
      .mockResolvedValueOnce(
        json({ item: row({ unitPriceMinor: null, headcount: null, estimateMinor: 400_000 }) }),
      );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Dinner");
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "per head" }));
    fireEvent.click(screen.getByRole("button", { name: "Use a fixed amount" }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    // RSVPs are closed, so the line came to 80 confirmed × 5,000.
    expect(JSON.parse(authFetch.mock.calls[1]![1].body)).toEqual({
      perHead: null,
      estimateMinor: 400_000,
    });
    await waitFor(() => expect(screen.queryByTestId("per-head-summary")).not.toBeInTheDocument());
  });

  it("adds a per-head line with its price instead of an estimate", async () => {
    setCachedBudget("wed_1", snap({ items: [], events: EVENTS }));
    authFetch.mockResolvedValueOnce(json({ item: row() }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    fireEvent.input(await screen.findByPlaceholderText(/caterer, venue/i), {
      target: { value: "Dinner" },
    });
    fireEvent.click(screen.getByLabelText("Priced per head"));
    fireEvent.input(screen.getByLabelText("Price per head"), { target: { value: "50" } });
    // Submitted directly, so the handler decides rather than happy-dom's
    // constraint validation of the field.
    fireEvent.submit(screen.getByRole("button", { name: /add item/i }).closest("form")!);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toEqual({
      category: "venue",
      name: "Dinner",
      perHead: { unitPriceMinor: 5_000 },
    });
  });

  it("gives a viewer the summary but no per-head editor", async () => {
    setCachedBudget("wed_1", snap({ items: [row()], events: EVENTS }));
    authFetch.mockReturnValue(new Promise(() => {}));
    render(() => <BudgetView weddingId="wed_1" canEdit={false} canManage={false} />);
    await screen.findByText("Dinner");
    expect(screen.getByTestId("per-head-summary")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "per head" })).not.toBeInTheDocument();
  });

  it("keeps the panel open with an error when a per-head save is refused, and reloads", async () => {
    const fixed = row({ unitPriceMinor: null, headcount: null, estimateMinor: 900 });
    setCachedBudget("wed_1", snap({ items: [fixed], events: EVENTS }));
    authFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unknown_event" }), { status: 400 }),
      )
      .mockResolvedValueOnce(json(snap({ items: [fixed], events: EVENTS })));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Dinner");
    fireEvent.click(screen.getByRole("button", { name: "per head" }));
    fireEvent.input(screen.getByLabelText(/Price per head \(AUD\)/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    expect(String(authFetch.mock.calls[1]![0])).toMatch(/\/budget$/);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save the price per head.");
    expect(screen.getByTestId("per-head-panel")).toBeInTheDocument();
  });

  it("sends the organiser to sign in when a per-head save answers 401", async () => {
    setCachedBudget("wed_1", snap({ items: [row()], events: EVENTS }));
    authFetch
      .mockResolvedValueOnce(json(snap({ items: [row()], events: EVENTS })))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Dinner");
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "per head" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
  });

  it("clears a cached per-head budget when the refetch on open is refused", async () => {
    setCachedBudget("wed_1", snap({ items: [row()], events: EVENTS }));
    authFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    render(() => <BudgetView weddingId="wed_1" canEdit={false} canManage={false} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your budget."),
    );
    expect(screen.queryByText("Dinner")).not.toBeInTheDocument();
  });

  it("refuses a per-head line with no price and sends nothing", async () => {
    setCachedBudget("wed_1", snap({ items: [], events: EVENTS }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    fireEvent.input(await screen.findByPlaceholderText(/caterer, venue/i), {
      target: { value: "Dinner" },
    });
    fireEvent.click(screen.getByLabelText("Priced per head"));
    const form = screen.getByRole("button", { name: /add item/i }).closest("form")!;
    for (const price of ["", "-5"]) {
      fireEvent.input(screen.getByLabelText("Price per head"), { target: { value: price } });
      fireEvent.submit(form);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "A per-head line needs a price per head.",
      );
    }
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("opens and closes the per-head panel from its toggle and from Cancel", async () => {
    setCachedBudget("wed_1", snap({ items: [row()], events: EVENTS }));
    authFetch.mockReturnValue(new Promise(() => {}));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Dinner");
    const toggle = screen.getByRole("button", { name: "per head" });
    fireEvent.click(toggle);
    expect(screen.getByTestId("per-head-panel")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("per-head-panel")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByTestId("per-head-panel")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

/**
 * Every amount the Budget tab reads or writes is in minor units of the
 * wedding's currency, and a currency's minor unit is not always a hundredth:
 * JPY has none and KWD has three. Each row types the major amount a host would
 * and expects the minor units the API stores. The AUD row passes with a fixed
 * factor of 100 too; the JPY and KWD rows are the ones that catch it.
 */
describe("BudgetView — amounts in the wedding's currency", () => {
  const CURRENCIES = [
    { currency: "JPY", typed: "50000", minor: 50_000 },
    { currency: "AUD", typed: "12.34", minor: 1_234 },
    { currency: "KWD", typed: "1.234", minor: 1_234 },
  ] as const;

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const line = (over: Partial<BudgetSnapshot["items"][number]> = {}) => ({
    id: "it",
    weddingId: "wed_1",
    category: "venue",
    name: "Reception venue",
    estimateMinor: null,
    quotedMinor: null,
    actualMinor: null,
    notes: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
  /** The form holding a control: every form here is submitted directly, so the
   *  handler decides, not happy-dom's constraint validation of `min`/`step`. */
  const formOf = (el: HTMLElement) => el.closest("form")!;
  const sentBody = (call: number) => JSON.parse(authFetch.mock.calls[call]![1].body);

  describe.each(CURRENCIES)("in $currency", ({ currency, typed, minor }) => {
    it("adds a fixed line's estimate", async () => {
      setCachedBudget("wed_1", snap({ currency, items: [] }));
      authFetch.mockResolvedValueOnce(json({ item: line({ estimateMinor: minor }) }));
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      fireEvent.input(await screen.findByPlaceholderText(/caterer, venue/i), {
        target: { value: "Reception venue" },
      });
      const estimate = screen.getByLabelText("Estimate (optional)");
      fireEvent.input(estimate, { target: { value: typed } });
      fireEvent.submit(formOf(estimate));
      await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
      expect(sentBody(0)).toEqual({
        category: "venue",
        name: "Reception venue",
        estimateMinor: minor,
      });
    });

    it("adds a per-head line's price", async () => {
      const events = [{ id: "evt_1", name: "Reception" }];
      setCachedBudget("wed_1", snap({ currency, items: [], events }));
      authFetch.mockResolvedValueOnce(
        json({ item: line({ unitPriceMinor: minor, eventIds: null, headcount: null }) }),
      );
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      fireEvent.input(await screen.findByPlaceholderText(/caterer, venue/i), {
        target: { value: "Dinner" },
      });
      fireEvent.click(screen.getByLabelText("Priced per head"));
      const price = screen.getByLabelText("Price per head");
      fireEvent.input(price, { target: { value: typed } });
      fireEvent.submit(formOf(price));
      await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
      expect(sentBody(0)).toEqual({
        category: "venue",
        name: "Dinner",
        perHead: { unitPriceMinor: minor },
      });
    });

    it("shows each stored figure in its cell and saves what is typed there", async () => {
      const stored = line({ estimateMinor: minor, quotedMinor: minor, actualMinor: minor });
      setCachedBudget("wed_1", snap({ currency, items: [stored] }));
      authFetch.mockImplementation(async (_url: string, init: RequestInit) =>
        json({ item: { ...stored, ...JSON.parse(String(init.body)) } }),
      );
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      await screen.findByText("Reception venue");

      const cells = [
        ["Est", "estimateMinor"],
        ["Quote", "quotedMinor"],
        ["Actual", "actualMinor"],
      ] as const;
      for (const [label] of cells) {
        expect(screen.getByLabelText(label)).toHaveValue(Number(typed));
      }
      for (const [k, [label, field]] of cells.entries()) {
        fireEvent.change(screen.getByLabelText(label), { target: { value: typed } });
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(k + 1));
        expect(sentBody(k)).toEqual({ [field]: minor });
      }
    });

    it("adds a payment", async () => {
      setCachedBudget("wed_1", snap({ currency, items: [line()] }));
      authFetch.mockResolvedValueOnce(
        json({
          payment: {
            id: "p1",
            budgetItemId: "it",
            label: "Deposit",
            amountMinor: minor,
            dueAt: null,
            paidAt: null,
            createdAt: 2,
          },
        }),
      );
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      fireEvent.click(await screen.findByRole("button", { name: "payments (0)" }));
      fireEvent.input(screen.getByLabelText("Payment label"), { target: { value: "Deposit" } });
      const amount = screen.getByLabelText("Amount");
      fireEvent.input(amount, { target: { value: typed } });
      fireEvent.submit(formOf(amount));
      await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
      expect(sentBody(0)).toEqual({ label: "Deposit", amountMinor: minor, dueAt: null });
    });

    it("opens the budget total at its stored figure and saves what is typed", async () => {
      setCachedBudget("wed_1", snap({ currency, budgetTotalMinor: minor }));
      authFetch.mockResolvedValueOnce(json({}));
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit budget" }));
      const total = screen.getByLabelText(`Total budget (${currency})`);
      expect(total).toHaveValue(Number(typed));
      fireEvent.input(total, { target: { value: "" } });
      fireEvent.input(total, { target: { value: typed } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
      expect(sentBody(0)).toEqual({ budgetTotalMinor: minor });
    });
  });

  it("lets every money input take as many decimals as the currency has", async () => {
    setCachedBudget(
      "wed_1",
      snap({ currency: "KWD", items: [line({ estimateMinor: 1_234 })], budgetTotalMinor: 5_000 }),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit budget" }));
    fireEvent.click(screen.getByRole("button", { name: "payments (0)" }));
    // Budget total, add-item estimate, Est, Quote, Actual, payment amount.
    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs).toHaveLength(6);
    for (const input of inputs) expect(input).toHaveAttribute("step", "any");
  });

  // Regression guards: the same in every currency, so AUD is enough.
  describe("cleared and refused amounts", () => {
    it("saves a cleared cell as no amount, and refuses a negative one", async () => {
      const stored = line({ quotedMinor: 1_000 });
      setCachedBudget("wed_1", snap({ items: [stored] }));
      authFetch.mockResolvedValueOnce(json({ item: { ...stored, quotedMinor: null } }));
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      await screen.findByText("Reception venue");

      fireEvent.change(screen.getByLabelText("Actual"), { target: { value: "-5" } });
      expect(screen.getByRole("alert")).toHaveTextContent("Amounts must be positive.");
      expect(authFetch).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText("Quote"), { target: { value: "" } });
      await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
      expect(sentBody(0)).toEqual({ quotedMinor: null });
    });

    it("clears the budget total, and refuses a negative one", async () => {
      setCachedBudget("wed_1", snap({ budgetTotalMinor: 500_000 }));
      authFetch.mockResolvedValueOnce(json({}));
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit budget" }));
      const total = screen.getByLabelText("Total budget (AUD)");

      fireEvent.input(total, { target: { value: "-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Budget must be a positive amount.");
      expect(authFetch).not.toHaveBeenCalled();

      fireEvent.input(total, { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
      expect(sentBody(0)).toEqual({ budgetTotalMinor: null });
    });

    it("refuses a negative estimate and sends nothing", async () => {
      setCachedBudget("wed_1", snap({ items: [] }));
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      fireEvent.input(await screen.findByPlaceholderText(/caterer, venue/i), {
        target: { value: "Reception venue" },
      });
      const estimate = screen.getByLabelText("Estimate (optional)");
      fireEvent.input(estimate, { target: { value: "-5" } });
      fireEvent.submit(formOf(estimate));
      expect(screen.getByRole("alert")).toHaveTextContent("Estimate must be a positive amount.");
      expect(authFetch).not.toHaveBeenCalled();
    });

    it("refuses a payment with no amount, keeping what was typed", async () => {
      setCachedBudget("wed_1", snap({ items: [line()] }));
      render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
      fireEvent.click(await screen.findByRole("button", { name: "payments (0)" }));
      const label = screen.getByLabelText("Payment label");
      fireEvent.input(label, { target: { value: "Deposit" } });
      fireEvent.submit(formOf(label));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "A payment needs a label and a positive amount.",
      );
      expect(authFetch).not.toHaveBeenCalled();
      expect(label).toHaveValue("Deposit");
    });
  });
});
