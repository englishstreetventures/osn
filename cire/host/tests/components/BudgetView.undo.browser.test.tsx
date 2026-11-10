import { resetToasts, toast, Toaster, toasts } from "@shared/toast";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A budget line's ✕, painted: the line and its payments leave at once, a toast
 * offers Undo, Undo puts both back where they stood, and only a toast that goes
 * without Undo sends the `DELETE`. A reload of the budget in the meantime must
 * not bring the line back.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch, redirectToLogin } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  redirectToLogin: vi.fn(),
}));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/touch-feedback", () => ({
  haptic: () => {},
  hapticsAvailable: () => false,
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  redirectToLogin,
}));

import { AuthExpiredError } from "@shared/rp-auth";

import BudgetView from "../../src/components/BudgetView";
import {
  __resetBudgetCache,
  type BudgetItemRow,
  type BudgetSnapshot,
  type PaymentRow,
  setCachedBudget,
} from "../../src/lib/budget-store";

const item = (id: string, name: string, sortOrder: number): BudgetItemRow => ({
  id,
  weddingId: "wed_1",
  category: "venue",
  name,
  estimateMinor: 100_000,
  quotedMinor: null,
  actualMinor: null,
  notes: null,
  sortOrder,
  createdAt: 1,
  updatedAt: 1,
});

const payment = (id: string, budgetItemId: string): PaymentRow => ({
  id,
  budgetItemId,
  label: "Deposit",
  amountMinor: 20_000,
  dueAt: null,
  paidAt: null,
  createdAt: 1,
});

const snapshot = (): BudgetSnapshot => ({
  items: [item("a", "Reception venue", 0), item("b", "Ceremony hire", 1), item("c", "Marquee", 2)],
  payments: [payment("p0", "a"), payment("p1", "b")],
  budgetTotalMinor: null,
  currency: "AUD",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The server's budget: a `DELETE` takes a line off unless its id is in
 * `refuse`, or meets an expired session if it is in `expired`.
 */
let server: BudgetSnapshot;
let refuse: Set<string>;
let expired: Set<string>;
const deleteCalls = () =>
  authFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
const deletes = () => deleteCalls().map(([url]) => String(url));
const ITEM_URL = "https://api.test/api/organiser/weddings/wed_1/budget/items/";

beforeEach(() => {
  __resetBudgetCache();
  server = snapshot();
  refuse = new Set();
  expired = new Set();
  redirectToLogin.mockReset();
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const one = /\/budget\/items\/([^/]+)$/.exec(url);
    if (init?.method === "DELETE" && one) {
      if (expired.has(one[1]!)) throw new AuthExpiredError();
      if (refuse.has(one[1]!)) return json({ error: "nope" }, 500);
      server = {
        ...server,
        items: server.items.filter((line) => line.id !== one[1]),
        payments: server.payments.filter((p) => p.budgetItemId !== one[1]),
      };
      return json({ ok: true });
    }
    if (init?.method === "PATCH" && url.endsWith("/budget/items/reorder"))
      return json({ ok: true });
    if (!init?.method && url.endsWith("/budget")) return json(server);
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
  setCachedBudget("wed_1", snapshot());
});

afterEach(() => {
  resetToasts();
  cleanup();
});

function mount() {
  render(() => (
    <>
      <div style={{ padding: "16px" }}>
        <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />
      </div>
      <Toaster position="bottom-right" topLayer />
    </>
  ));
}

const names = () =>
  [...(screen.queryByTestId("budget-venue")?.querySelectorAll(":scope > li") ?? [])].map(
    (li) => li.querySelector("span.flex-1")?.textContent?.trim() ?? "",
  );
const rowOf = (name: string) => screen.getByText(name).closest("li")!;
const deleteLine = (name: string) =>
  userEvent.click(within(rowOf(name)).getByRole("button", { name: "Delete item" }));
const toastOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".ui-toast")].find(
    (el) => el.querySelector(".ui-toast__message")?.textContent === `Deleted “${name}”`,
  )!;
const expire = (name: string) =>
  toast.dismiss(toasts().find((t) => t.message === `Deleted “${name}”`)!.id);

describe("deleting a budget line", () => {
  it("Undo puts the line and its payments back where they stood, and nothing is deleted", async () => {
    mount();
    await screen.findByText("Ceremony hire");
    // A move first: the row keeps its object across an order-only change, so
    // the copy put back must be the budget's, not the row's.
    // The screen reader\'s move button: the grip covers it from the pointer.
    fireEvent.click(screen.getByRole("button", { name: "Move Ceremony hire up" }));
    await waitFor(() => expect(names()).toEqual(["Ceremony hire", "Reception venue", "Marquee"]));
    expect(within(rowOf("Ceremony hire")).getByText("payments (1)")).toBeTruthy();

    await deleteLine("Ceremony hire");

    expect(names()).toEqual(["Reception venue", "Marquee"]);
    await userEvent.click(
      within(toastOf("Ceremony hire")).getByRole("button", {
        name: "Undo deleting “Ceremony hire”",
      }),
    );

    await waitFor(() => expect(names()).toEqual(["Ceremony hire", "Reception venue", "Marquee"]));
    expect(within(rowOf("Ceremony hire")).getByText("payments (1)")).toBeTruthy();
    expect(await screen.findByText("Restored “Ceremony hire”")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 300));
    expect(deletes()).toEqual([]);
  });

  it("sends the DELETE once its toast has gone, and a reload meanwhile does not bring it back", async () => {
    mount();
    await screen.findByText("Ceremony hire");
    refuse.add("c");

    await deleteLine("Ceremony hire");
    await deleteLine("Marquee");
    // The marquee's delete is refused, and the view reloads the budget while
    // the hire's toast is still up: the server still holds both lines.
    expire("Marquee");
    expect(await screen.findByText("Couldn't delete that item.")).toBeTruthy();
    await waitFor(() => expect(names()).toEqual(["Reception venue", "Marquee"]));
    expect(deletes()).toEqual([`${ITEM_URL}c`]);
    // The reload keeps the payments of a line that stays.
    expect(within(rowOf("Reception venue")).getByText("payments (1)")).toBeTruthy();

    expire("Ceremony hire");

    await waitFor(() => expect(deletes()).toEqual([`${ITEM_URL}c`, `${ITEM_URL}b`]));
    await new Promise((done) => setTimeout(done, 300));
    expect(names()).toEqual(["Reception venue", "Marquee"]);
  });

  it("sends the page-exit DELETE kept alive", async () => {
    mount();
    await screen.findByText("Ceremony hire");
    await deleteLine("Ceremony hire");

    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));

    await waitFor(() => expect(deletes()).toEqual([`${ITEM_URL}b`]));
    expect((deleteCalls()[0]![1] as RequestInit).keepalive).toBe(true);
  });

  it("sends the organiser to sign in when the delete meets an expired session", async () => {
    mount();
    await screen.findByText("Ceremony hire");
    expired.add("b");

    await deleteLine("Ceremony hire");
    expire("Ceremony hire");

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Couldn't delete that item.")).toBeNull();
  });
});
