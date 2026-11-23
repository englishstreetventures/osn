// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Overview from "../../src/components/Overview";
import {
  __resetBudgetCache,
  type BudgetSnapshot,
  setCachedBudget,
} from "../../src/lib/budget-store";

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
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

/** A local `YYYY-MM-DD`. */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
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
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
    // "of A$45,000.00" (AUD formatting) surfaces on the Budget card.
    // The text may be split across elements; use getAllByText with a broad regex.
    expect(await screen.findByText(/45,000/)).toBeInTheDocument();
  });

  it("reads the budget in the wedding's own minor unit", async () => {
    // JPY has no minor unit: 450,000 minor units are ¥450,000, not ¥4,500.
    setCachedBudget(
      "wed_1",
      snap({
        currency: "JPY",
        budgetTotalMinor: 450_000,
        items: [
          {
            id: "a",
            weddingId: "wed_1",
            category: "venue",
            name: "Venue",
            estimateMinor: null,
            quotedMinor: null,
            actualMinor: 170_000,
            notes: null,
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
    expect(await screen.findByText(/450,000/)).toBeInTheDocument();
    expect(screen.getByText(/170,000/)).toBeInTheDocument();
  });

  it("reads what is tracked before a total is set in the wedding's own minor unit", async () => {
    setCachedBudget(
      "wed_1",
      snap({
        currency: "JPY",
        budgetTotalMinor: null,
        items: [
          {
            id: "a",
            weddingId: "wed_1",
            category: "venue",
            name: "Venue",
            estimateMinor: null,
            quotedMinor: null,
            actualMinor: 170_000,
            notes: null,
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
    expect(await screen.findByText(/170,000 tracked — set a total/)).toBeInTheDocument();
  });

  // The API keeps a due date as the string it was given: a day, or a full
  // timestamp. Either way it reads as What's next prints the same payment.
  it.each([
    { form: "a day", raw: (d: Date) => dayKey(d) },
    { form: "a timestamp", raw: (d: Date) => d.toISOString() },
  ])("dates the next payment due on $form as What's next dates it", async ({ raw }) => {
    // Inside the agenda's 90 days, so the same payment is a What's next row too.
    const now = new Date();
    const dueAt = raw(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 20, 12));
    setCachedBudget(
      "wed_1",
      snap({
        budgetTotalMinor: 4_500_000,
        payments: [
          {
            id: "p1",
            budgetItemId: "b1",
            label: "Balance",
            amountMinor: 250_000,
            dueAt,
            paidAt: null,
            createdAt: 1,
          },
        ],
      }),
    );
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);

    const agendaRow = (await screen.findByText("Balance")).closest("button")!;
    const agendaDate = agendaRow.querySelector("span")!.textContent!;
    const next = await screen.findByText(/Next: Balance/);
    expect(next.textContent).toBe(`Next: Balance · due ${agendaDate}`);
  });
});
