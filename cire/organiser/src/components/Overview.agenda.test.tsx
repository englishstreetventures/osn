// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBudgetCache, setCachedBudget } from "../lib/budget-store";
import { setCachedEvents } from "../lib/events-store";
import { setCachedGuests } from "../lib/guests-store";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../lib/tasks-store";
import Overview from "./Overview";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const authFetch = vi.fn(async (url: string) => {
  if (url.endsWith("/settings"))
    return json({ wedding: { weddingDate: null, currency: "AUD", budgetTotalMinor: null } });
  if (url.endsWith("/rsvps")) return json({ events: [] });
  if (url.endsWith("/tasks")) return json({ tasks: [] });
  if (url.endsWith("/events")) return json([]);
  if (url.endsWith("/guests")) return json([]);
  if (url.endsWith("/budget"))
    return json({ items: [], payments: [], budgetTotalMinor: null, currency: "AUD" });
  return json({}, 404);
});
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("./GettingStarted", () => ({
  default: (p: { weddingId: string }) => <div data-testid="getting-started">{p.weddingId}</div>,
}));

const task = (over: Partial<TaskRow>): TaskRow => ({
  id: "t",
  weddingId: "wed_1",
  title: "T",
  notes: null,
  timeframeBucket: "6m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  ...over,
});

// Dates relative to real now so the 90-day horizon always includes them.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

beforeEach(() => {
  __resetBudgetCache();
  __resetTasksCache();
  authFetch.mockClear();
  // Non-fresh wedding: at least one event + household.
  setCachedGuests("wed_1", [{ familyId: "fam_a", firstName: "Al" } as never]);
});

describe("Overview what's-next band", () => {
  it("renders merged agenda rows and navigates on click", async () => {
    setCachedEvents("wed_1", [
      { id: "e1", name: "Ceremony rehearsal", startAt: inDays(12).toISOString() } as never,
    ]);
    setCachedTasks("wed_1", [
      task({ id: "t1", title: "Confirm florist", status: "open", dueAt: dateKey(inDays(9)) }),
    ]);
    setCachedBudget("wed_1", {
      items: [],
      payments: [
        {
          id: "p1",
          budgetItemId: "b1",
          label: "Venue balance",
          amountMinor: 800000,
          dueAt: dateKey(inDays(3)),
          paidAt: null,
          createdAt: 1,
        },
      ],
      budgetTotalMinor: null,
      currency: "AUD",
    });

    const onNavigate = vi.fn();
    render(() => <Overview weddingId="wed_1" onNavigate={onNavigate} />);

    // The three labels appear under the "What's next" heading.
    const payment = await screen.findByText("Venue balance");
    expect(screen.getByText("Confirm florist")).toBeInTheDocument();
    expect(screen.getByText("Ceremony rehearsal")).toBeInTheDocument();

    // Clicking the payment row jumps to the Budget module.
    fireEvent.click(payment.closest("button")!);
    expect(onNavigate).toHaveBeenCalledWith("budget");
  });

  it("shows the empty-state line when there is nothing scheduled", async () => {
    setCachedEvents("wed_1", [{ id: "e1", name: "Ceremony" } as never]); // no startAt/date → not on agenda
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    expect(await screen.findByText(/nothing scheduled yet/i)).toBeInTheDocument();
  });
});
