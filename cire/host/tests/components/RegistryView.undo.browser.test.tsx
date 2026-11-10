import { resetToasts, toast, Toaster, toasts } from "@shared/toast";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A gift's ✕, painted: the gift leaves the list at once, a toast offers Undo,
 * Undo puts it back where it stood, and only a toast that goes without Undo
 * sends the `DELETE` — which also reaps the gift's picture, so nothing a guest
 * claimed and no picture is lost to a mis-click. A reload of the registry in
 * the meantime must not bring the gift back.
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

import RegistryView from "../../src/components/RegistryView";
import {
  __resetRegistryCache,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
} from "../../src/lib/registry-store";

const item = (over: Partial<RegistryItem>): RegistryItem => ({
  id: "a",
  weddingId: "wed_1",
  kind: "product",
  title: "Copper pan",
  description: null,
  imageKey: null,
  imageCrop: null,
  externalUrl: null,
  priceMinor: null,
  quantityWanted: 2,
  quantityClaimed: 1,
  allowPartial: false,
  targetMinor: null,
  category: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const snapshot = (): RegistrySnapshot => ({
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
    stripeConnectedByOsnProfileId: null,
    moneyGiftsBlockedBy: "stripe_not_ready",
    updatedAt: null,
  },
  items: [
    item({ id: "a", title: "Copper pan", sortOrder: 0 }),
    item({ id: "b", title: "Wine fridge", sortOrder: 1 }),
    item({ id: "c", title: "Kettle", sortOrder: 2 }),
  ],
  gifts: [],
  giftsHasMore: false,
  giftSummary: null,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
  contributionsOtherCurrencyCount: 0,
  takesPayments: true,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The server's registry: a `DELETE` takes a gift off unless its id is in
 * `refuse`, or meets an expired session if it is in `expired`.
 */
let server: RegistrySnapshot;
let refuse: Set<string>;
let expired: Set<string>;
const deleteCalls = () =>
  authFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
const deletes = () => deleteCalls().map(([url]) => String(url));
const ITEM_URL = "https://api.test/api/organiser/weddings/wed_1/registry/items/";

beforeEach(() => {
  __resetRegistryCache();
  server = snapshot();
  refuse = new Set();
  expired = new Set();
  redirectToLogin.mockReset();
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const one = /\/registry\/items\/([^/]+)$/.exec(url);
    if (init?.method === "DELETE" && one) {
      if (expired.has(one[1]!)) throw new AuthExpiredError();
      if (refuse.has(one[1]!)) return json({ error: "nope" }, 500);
      server = { ...server, items: server.items.filter((gift) => gift.id !== one[1]) };
      return json({ ok: true });
    }
    if (init?.method === "PATCH" && url.endsWith("/registry/items/reorder")) {
      return json({ ok: true });
    }
    if (!init?.method && url.endsWith("/registry")) return json(server);
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
  setCachedRegistry("wed_1", snapshot());
});

afterEach(() => {
  resetToasts();
  cleanup();
});

function mount() {
  render(() => (
    <>
      <div style={{ padding: "16px" }}>
        <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
      </div>
      <Toaster position="bottom-right" topLayer />
    </>
  ));
}

const titles = () =>
  [...screen.getByTestId("registry-items").querySelectorAll(":scope > li")].map(
    (li) => li.querySelector("span.font-medium")?.textContent?.trim() ?? "",
  );
const removeGift = (title: string) =>
  userEvent.click(screen.getByRole("button", { name: `Remove ${title}` }));
const toastOf = (title: string) =>
  [...document.querySelectorAll<HTMLElement>(".ui-toast")].find(
    (el) => el.querySelector(".ui-toast__message")?.textContent === `Removed “${title}”`,
  )!;
const expire = (title: string) =>
  toast.dismiss(toasts().find((t) => t.message === `Removed “${title}”`)!.id);

describe("removing a gift", () => {
  it("Undo puts the gift back where it stood, and nothing is deleted", async () => {
    mount();
    await screen.findByText("Wine fridge");
    // A move first: the row keeps its object across an order-only change, so
    // the copy put back must be the list's, not the row's.
    // The screen reader\'s move button: the grip covers it from the pointer.
    fireEvent.click(screen.getByRole("button", { name: "Move Wine fridge up" }));
    await waitFor(() => expect(titles()).toEqual(["Wine fridge", "Copper pan", "Kettle"]));

    await removeGift("Wine fridge");

    expect(titles()).toEqual(["Copper pan", "Kettle"]);
    await userEvent.click(
      within(toastOf("Wine fridge")).getByRole("button", { name: "Undo removing “Wine fridge”" }),
    );

    await waitFor(() => expect(titles()).toEqual(["Wine fridge", "Copper pan", "Kettle"]));
    expect(await screen.findByText("Restored “Wine fridge”")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 300));
    expect(deletes()).toEqual([]);
  });

  it("sends the DELETE once its toast has gone, and a reload meanwhile does not bring it back", async () => {
    mount();
    await screen.findByText("Wine fridge");
    refuse.add("c");

    await removeGift("Wine fridge");
    await removeGift("Kettle");
    // The kettle's delete is refused, and the view reloads the registry while
    // the fridge's toast is still up: the server still holds both gifts.
    expire("Kettle");
    expect(await screen.findByText("Couldn't remove that gift.")).toBeTruthy();
    await waitFor(() => expect(titles()).toEqual(["Copper pan", "Kettle"]));
    expect(deletes()).toEqual([`${ITEM_URL}c`]);

    expire("Wine fridge");

    await waitFor(() => expect(deletes()).toEqual([`${ITEM_URL}c`, `${ITEM_URL}b`]));
    await new Promise((done) => setTimeout(done, 300));
    expect(titles()).toEqual(["Copper pan", "Kettle"]);
  });

  it("hides the gift again once its DELETE lands, after a read that does not filter brought it back", async () => {
    mount();
    await screen.findByText("Wine fridge");
    await removeGift("Wine fridge");
    expect(titles()).toEqual(["Copper pan", "Kettle"]);

    // The settings tab's read writes the server's whole list into the cache.
    setCachedRegistry("wed_1", structuredClone(server));
    await waitFor(() => expect(titles()).toEqual(["Copper pan", "Wine fridge", "Kettle"]));

    expire("Wine fridge");

    await waitFor(() => expect(deletes()).toEqual([`${ITEM_URL}b`]));
    await waitFor(() => expect(titles()).toEqual(["Copper pan", "Kettle"]));
  });

  it("sends the page-exit DELETE kept alive", async () => {
    mount();
    await screen.findByText("Wine fridge");
    await removeGift("Wine fridge");

    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));

    await waitFor(() => expect(deletes()).toEqual([`${ITEM_URL}b`]));
    expect((deleteCalls()[0]![1] as RequestInit).keepalive).toBe(true);
  });

  it("sends the organiser to sign in when the removal meets an expired session", async () => {
    mount();
    await screen.findByText("Wine fridge");
    expired.add("b");

    await removeGift("Wine fridge");
    expire("Wine fridge");

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Couldn't remove that gift.")).toBeNull();
  });
});
