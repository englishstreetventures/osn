// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBudgetCache, type BudgetSnapshot, setCachedBudget } from "../lib/budget-store";
import BudgetView from "./BudgetView";

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

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
  it("keeps each category's rows and reorder arrows inside their own section", async () => {
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
    expect(venue.getAllByRole("button", { name: "Move up" })[0]).toBeDisabled();
    expect(catering.getAllByRole("button", { name: "Move down" })[1]).toBeDisabled();
    fireEvent.click(catering.getAllByRole("button", { name: "Move up" })[1]!);
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
});
