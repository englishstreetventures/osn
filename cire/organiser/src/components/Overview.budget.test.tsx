// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBudgetCache, type BudgetSnapshot, setCachedBudget } from "../lib/budget-store";
import Overview from "./Overview";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Return just enough data for the Overview to render the non-fresh grid.
const authFetch = vi.fn(async (url: string) => {
  if (String(url).includes("/settings"))
    return json({
      wedding: {
        weddingDate: null,
        guestCountEstimate: null,
        currency: "AUD",
        budgetTotalMinor: null,
      },
    });
  if (String(url).includes("/rsvps")) return json({ events: [] });
  if (String(url).includes("/events")) return json([{ id: "e1" }]); // 1 event → not fresh
  if (String(url).includes("/guests")) return json([]);
  if (String(url).includes("/tasks")) return json({ tasks: [] });
  if (String(url).includes("/budget"))
    return json({ items: [], payments: [], budgetTotalMinor: null, currency: "AUD" });
  return json({});
});
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

const snap = (over: Partial<BudgetSnapshot>): BudgetSnapshot => ({
  items: [],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
  ...over,
});

beforeEach(() => {
  __resetBudgetCache();
  authFetch.mockClear();
});

afterEach(cleanup);

describe("Overview budget widget", () => {
  it("shows the over-budget tone + note when spend exceeds the cap", async () => {
    setCachedBudget("wed_1", {
      items: [
        {
          id: "b1",
          weddingId: "wed_1",
          category: "venue",
          name: "Venue",
          estimateMinor: null,
          quotedMinor: null,
          actualMinor: 5000000,
          notes: null,
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      payments: [],
      budgetTotalMinor: 4000000,
      currency: "AUD",
    });
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    expect(await screen.findByText(/over budget/i)).toBeInTheDocument();
  });

  it("shows live spend once the budget is cached", async () => {
    setCachedBudget(
      "wed_1",
      snap({
        budgetTotalMinor: 4500000,
        items: [
          {
            id: "a",
            weddingId: "wed_1",
            category: "venue",
            name: "Venue",
            estimateMinor: null,
            quotedMinor: null,
            actualMinor: 1700000,
            notes: null,
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    // "of A$45,000.00" (AUD formatting) surfaces on the Budget card.
    // The text may be split across elements; use getAllByText with a broad regex.
    expect(await screen.findByText(/45,000/)).toBeInTheDocument();
  });
});
