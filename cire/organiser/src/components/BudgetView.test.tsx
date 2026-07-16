// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBudgetCache, type BudgetSnapshot, setCachedBudget } from "../lib/budget-store";
import BudgetView from "./BudgetView";

const authFetch = vi.fn();
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

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
