import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A three-decimal amount gets through the Budget tab's forms in a real browser.
 *
 * Chromium checks a number input against its `step` before it submits the form,
 * so a hundredths step makes a valid KWD amount such as `1.234` invalid and the
 * handler never runs. happy-dom does its own, floating-point version of that
 * check, which is why the unit tier submits these forms directly and only
 * asserts the attribute. This clicks the real buttons.
 *
 * The factories are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import BudgetView from "../../src/components/BudgetView";
import { __resetBudgetCache, setCachedBudget } from "../../src/lib/budget-store";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const ITEM = {
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
};

const sent = (method: string, path: RegExp) => {
  const call = authFetch.mock.calls.find(
    ([url, init]) => init?.method === method && path.test(String(url)),
  );
  return call ? JSON.parse(String(call[1].body)) : undefined;
};

beforeEach(() => {
  setCachedBudget("wed_1", {
    items: [ITEM],
    payments: [],
    budgetTotalMinor: null,
    currency: "KWD",
  });
  authFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/payments"))
      return Promise.resolve(
        json({
          payment: {
            id: "p1",
            budgetItemId: "it",
            label: "Deposit",
            amountMinor: 1_234,
            dueAt: null,
            paidAt: null,
            createdAt: 2,
          },
        }),
      );
    if (init?.method === "POST")
      return Promise.resolve(json({ item: { ...ITEM, id: "new", name: "Band" } }));
    return Promise.resolve(json({}));
  });
});

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  __resetBudgetCache();
});

describe("BudgetView in a three-decimal currency", () => {
  it("adds an item with a KWD estimate from the Add item button", async () => {
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await userEvent.fill(await screen.findByPlaceholderText(/caterer, venue/i), "Band");
    await userEvent.fill(screen.getByLabelText("Estimate (optional)"), "1.234");
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    await waitFor(() => expect(sent("POST", /\/budget\/items$/)).toBeDefined());
    expect(sent("POST", /\/budget\/items$/)).toEqual({
      category: "venue",
      name: "Band",
      estimateMinor: 1_234,
    });
  });

  it("adds a KWD payment from the Add payment button", async () => {
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    await userEvent.click(await screen.findByRole("button", { name: "payments (0)" }));
    await userEvent.fill(screen.getByLabelText("Payment label"), "Deposit");
    await userEvent.fill(screen.getByLabelText("Amount"), "1.234");
    await userEvent.click(screen.getByRole("button", { name: "Add payment" }));
    await waitFor(() => expect(sent("POST", /\/payments$/)).toBeDefined());
    expect(sent("POST", /\/payments$/)).toEqual({
      label: "Deposit",
      amountMinor: 1_234,
      dueAt: null,
    });
  });
});
