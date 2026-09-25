// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RegistryView from "../../src/components/RegistryView";
import {
  __resetRegistryCache,
  type GiftLogEntry,
  type GiftSummary,
  peekCachedRegistry,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
} from "../../src/lib/registry-store";
import { toastError, toastSuccess } from "../test-support/mocks";

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

const downloadBlobMock = vi.fn();
vi.mock("../../src/lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlobMock(name, blob),
  downloadCsv: vi.fn(),
}));

// Only `redirectToLogin` is replaced — it assigns `window.location.href`, which
// happy-dom cannot follow. `apiUrl` and `isAuthExpired` stay real, so the tests
// below exercise the actual expiry predicate rather than a stand-in for it.
const redirectToLoginMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api")),
  redirectToLogin: redirectToLoginMock,
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

const gift = (over: Partial<GiftLogEntry>): GiftLogEntry => ({
  kind: "claim",
  id: "clm_1",
  itemId: "itm_1",
  itemTitle: "Copper pan",
  familyId: "fam_1",
  familyName: "The Nguyens",
  displayName: null,
  quantity: 1,
  status: "reserved",
  note: null,
  amountMinor: null,
  currency: null,
  primaryAmountMinor: null,
  primaryCurrency: null,
  fxRate: null,
  thankedAt: null,
  createdAt: 1,
  ...over,
});

const snapshot = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot => ({
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
  items: [],
  gifts: [],
  giftsHasMore: false,
  giftSummary: null,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
  contributionsOtherCurrencyCount: 0,
  ...over,
});

/** A swept wedding's parting record. Dates are ISO days, as stored. */
const summary = (over: Partial<GiftSummary> = {}): GiftSummary => ({
  sweptOn: "2026-06-17",
  firstGiftOn: "2025-05-11",
  lastGiftOn: "2025-05-20",
  claims: { reserved: 4, purchased: 14 },
  contributions: { count: 3, totals: [{ currency: "AUD", amountMinor: 17_500 }] },
  ...over,
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  __resetRegistryCache();
  authFetch.mockReset();
});

describe("RegistryView — the gift list", () => {
  it("orders items by sortOrder, not by the order they arrived in", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [
          item({ id: "b", title: "Wine fridge", sortOrder: 1 }),
          item({ id: "a", title: "Copper pan", sortOrder: 0 }),
        ],
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Copper pan");
    expect(rows[1]!.textContent).toContain("Wine fridge");
  });

  it("shows the price and the claimed-vs-wanted count", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [item({ priceMinor: 12_000, quantityWanted: 3, quantityClaimed: 1 })],
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    expect(await screen.findByText(/120[.,]00/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 claimed/)).toBeInTheDocument();
  });

  it("marks an item whose claims cover the wanted count as all taken", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ items: [item({ quantityWanted: 1, quantityClaimed: 1 })] }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    expect(await screen.findByText(/all taken/)).toBeInTheDocument();
  });

  it("links an https item URL only — no javascript:, no plain http (S-L2)", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [
          item({ id: "ri_ok", title: "Copper pan", externalUrl: "https://shop.example/pan" }),
          // The API schema refuses this at write time; a fixture or a migration
          // can still put it in a row, and it would run in the organiser origin.
          item({ id: "ri_bad", title: "Wine fridge", externalUrl: "javascript:alert(1)" }),
          // Not an attack, but the host clicks it out of the portal and the shop
          // page — with whatever the guest is about to type into it — travels in
          // clear. Rendered as text, not as a link.
          item({ id: "ri_http", title: "Cake stand", externalUrl: "http://shop.example/stand" }),
        ],
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    await screen.findByText("Copper pan");
    // Named by what it opens, not by "Link" — a screen-reader user hitting a
    // list of them otherwise hears the same word once per row.
    const links = screen.getAllByRole("link", { name: /^Open the shop page for/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Open the shop page for Copper pan");
    expect(links[0]).toHaveAttribute("href", "https://shop.example/pan");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("hides the add form and every row control from a viewer", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item({ title: "Copper pan" })] }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={false} />
    ));
    await screen.findByText("Copper pan");
    expect(screen.queryByRole("button", { name: /add gift/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove copper pan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /move copper pan/i })).not.toBeInTheDocument();
  });

  it("adds an item (POST) and appends it to the cached snapshot", async () => {
    setCachedRegistry("wed_1", snapshot());
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ item: item({ id: "new_1", title: "Wine fridge" }) }), {
        status: 200,
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    const title = await screen.findByPlaceholderText(/copper pan/i);
    fireEvent.input(title, { target: { value: "Wine fridge" } });
    fireEvent.click(screen.getByRole("button", { name: /add gift/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/items$/);
    expect(init.method).toBe("POST");
    expect(await screen.findByText("Wine fridge")).toBeInTheDocument();
  });

  it("parses a typed price with the wedding's currency exponent, not a fixed 100", async () => {
    // A JPY wedding: ¥1000 typed is 1000 minor units. Under the hardcoded ×100
    // the older price inputs use, this would POST 100_000 — ¥100,000.
    setCachedRegistry("wed_1", snapshot({ currency: "JPY" }));
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ item: item({ id: "new_1", title: "Kettle" }) }), {
        status: 200,
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    fireEvent.input(await screen.findByPlaceholderText(/copper pan/i), {
      target: { value: "Kettle" },
    });
    fireEvent.input(screen.getByPlaceholderText("0.00"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: /add gift/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(authFetch.mock.calls[0]![1].body) as { priceMinor: number };
    expect(body.priceMinor).toBe(1000);
  });

  it("rejects a negative price without calling the API", async () => {
    setCachedRegistry("wed_1", snapshot());
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    fireEvent.input(await screen.findByPlaceholderText(/copper pan/i), {
      target: { value: "Kettle" },
    });
    fireEvent.input(screen.getByPlaceholderText("0.00"), { target: { value: "-5" } });
    // Submitted at the form, not through the button: `min="0"` would have the
    // browser block the click, and the guard being asserted is the one that has
    // to hold WITHOUT it — the input's own constraints are advisory.
    fireEvent.submit(container.querySelector("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/positive amount/i);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("reorders with arrow buttons — optimistically, then PATCH /reorder", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [
          item({ id: "a", title: "Copper pan", sortOrder: 0 }),
          item({ id: "b", title: "Wine fridge", sortOrder: 1 }),
        ],
      }),
    );
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /move copper pan down/i }));

    const rows = screen.getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Wine fridge");
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/items\/reorder$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ orderedIds: ["b", "a"] });
  });

  it("disables the arrow that would move an item off the end of the list", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        items: [
          item({ id: "a", title: "Copper pan", sortOrder: 0 }),
          item({ id: "b", title: "Wine fridge", sortOrder: 1 }),
        ],
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    expect(await screen.findByRole("button", { name: /move copper pan up/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /move wine fridge down/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /move copper pan down/i })).not.toBeDisabled();
  });

  it("removes an item from the list before the DELETE resolves", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item({ id: "a", title: "Copper pan" })] }));
    let resolve: ((res: Response) => void) | undefined;
    authFetch.mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /remove copper pan/i }));
    await waitFor(() => expect(screen.queryByText("Copper pan")).not.toBeInTheDocument());
    expect(String(authFetch.mock.calls[0]![0])).toMatch(/\/registry\/items\/a$/);
    expect(authFetch.mock.calls[0]![1].method).toBe("DELETE");
    resolve!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it("seeds the edit form from the item and PATCHes what changed", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ items: [item({ id: "a", title: "Copper pan", priceMinor: 12_000 })] }),
    );
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ item: item({ id: "a", title: "Copper saucepan" }) }), {
        status: 200,
      }),
    );
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /edit copper pan/i }));
    // The add form carries a "Gift" field too, so scope to the inline editor —
    // the second form on the page.
    const editForm = container.querySelectorAll("form")[1]!;
    const priceInput = within(editForm).getByLabelText("Price") as HTMLInputElement;
    // Seeded through the currency's exponent, so an untouched field saves back
    // the same number it was opened with.
    expect(priceInput.value).toBe("120.00");
    fireEvent.input(within(editForm).getByLabelText("Gift"), {
      target: { value: "Copper saucepan" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/items\/a$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toMatchObject({ title: "Copper saucepan", priceMinor: 12_000 });
    expect(await screen.findByText("Copper saucepan")).toBeInTheDocument();
  });

  it("carries a picture picked in the add form into the create body", async () => {
    setCachedRegistry("wed_1", snapshot());
    // Routed rather than queued: saving a picture makes the field fetch its own
    // thumbnail back through the gated serve route, so the create call is not at
    // a fixed position in the queue.
    authFetch.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/registry/image"))
        return Promise.resolve(
          new Response(JSON.stringify({ imageKey: "assets/wed_1/registry-a1", imageUrl: "/x" }), {
            status: 200,
          }),
        );
      if (u.includes("/registry/image/")) return Promise.resolve(new Response("bytes"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            item: item({ id: "new_1", title: "Kettle", imageKey: "assets/wed_1/registry-a1" }),
          }),
          { status: 200 },
        ),
      );
    });
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    fireEvent.input(await screen.findByPlaceholderText(/copper pan/i), {
      target: { value: "Kettle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload a photo" }));
    const file = screen.getByLabelText("Photo to upload");
    Object.defineProperty(file, "files", {
      value: [new File(["png"], "kettle.png", { type: "image/png" })],
      configurable: true,
    });
    fireEvent.change(file);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove picture" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /add gift/i }));
    const isCreate = (call: unknown[]) => String(call[0]).endsWith("/registry/items");
    await waitFor(() => expect(authFetch.mock.calls.some(isCreate)).toBe(true));
    const create = authFetch.mock.calls.find(isCreate)!;
    expect(JSON.parse(create[1].body)).toMatchObject({
      title: "Kettle",
      imageKey: "assets/wed_1/registry-a1",
    });
  });

  it("PATCHes imageKey back to null when the picture is removed in the edit form", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ items: [item({ id: "a", imageKey: "assets/wed_1/registry-old" })] }),
    );
    authFetch.mockImplementation((url: string | URL) => {
      if (String(url).includes("/registry/image/")) return Promise.resolve(new Response("bytes"));
      return Promise.resolve(
        new Response(JSON.stringify({ item: item({ id: "a", imageKey: null }) }), { status: 200 }),
      );
    });
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /edit copper pan/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove picture" }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(authFetch.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(true),
    );
    const patch = authFetch.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(patch[1].body)).toMatchObject({ imageKey: null });
  });
});

describe("RegistryView — gifts received", () => {
  it("names the giver from the guest's own display name, falling back to the household", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [
          gift({ id: "a", displayName: "Mai & Tom", familyName: "The Nguyens" }),
          gift({ id: "b", displayName: null, familyName: "The Okonkwos" }),
        ],
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText("Mai & Tom")).toBeInTheDocument();
    expect(screen.getByText("The Okonkwos")).toBeInTheDocument();
  });

  it("renders a script-shaped note, display name and family name as literal text (S-L3)", async () => {
    // All three fields are guest-authored and reach an AUTHENTICATED organiser's
    // browser. If any renderer ever swaps `{expr}` for innerHTML, this is stored
    // XSS against the account that owns the wedding — so assert the mechanism:
    // the markup survives as text, and no element was ever built from it.
    const payload = "<script>alert('xss')</script>";
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [
          gift({
            id: "a",
            note: payload,
            displayName: "<img src=x onerror=alert(1)>",
            familyName: "<b>Bold</b>",
          }),
        ],
      }),
    );
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));

    // The note renders verbatim, as characters.
    expect(await screen.findByText(payload)).toBeInTheDocument();
    // The display name wins over the family name, and is also verbatim.
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    // Nothing was parsed as markup: no injected element exists anywhere.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("renders the family name as literal text too when there is no display name (S-L3)", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "a", displayName: null, familyName: "<b>Bold</b>" })] }),
    );
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={false} />
    ));
    expect(await screen.findByText("<b>Bold</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("shows a foreign gift as-given, with the primary-currency line underneath", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        currency: "AUD",
        gifts: [
          gift({
            id: "a",
            kind: "contribution",
            itemId: null,
            itemTitle: null,
            quantity: null,
            status: "succeeded",
            amountMinor: 5_000,
            currency: "GBP",
            primaryAmountMinor: 9_700,
            primaryCurrency: "AUD",
          }),
        ],
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    // Headline: the amount the guest actually gave.
    expect(await screen.findByText(/£\s?50[.,]00|GBP\s?50[.,]00/)).toBeInTheDocument();
    // Supporting line: the snapshotted primary equivalent, marked approximate.
    expect(screen.getByText(/≈.*97[.,]00/)).toBeInTheDocument();
  });

  it("shows one money line when the gift arrived in the primary currency", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [
          gift({
            id: "a",
            kind: "contribution",
            amountMinor: 5_000,
            currency: "AUD",
            primaryAmountMinor: null,
            primaryCurrency: null,
          }),
        ],
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findByText(/50[.,]00/);
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it("labels the cash total as approximate", async () => {
    setCachedRegistry("wed_1", snapshot({ contributionsPrimaryMinor: 250_00 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText(/Approximate/)).toBeInTheDocument();
    expect(screen.getByText(/250[.,]00/)).toBeInTheDocument();
  });

  it("says how many gifts the cash total leaves out", async () => {
    // The total is one currency's worth. Showing it alone would read as all the
    // money that arrived, which it is not.
    setCachedRegistry(
      "wed_1",
      snapshot({ contributionsPrimaryMinor: 250_00, contributionsOtherCurrencyCount: 2 }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(
      await screen.findByText(/2 more gifts are held in other currencies/),
    ).toBeInTheDocument();
  });

  it("says nothing about other currencies when every gift is in the couple's", async () => {
    setCachedRegistry("wed_1", snapshot({ contributionsPrimaryMinor: 250_00 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findByText(/Approximate/);
    expect(screen.queryByText(/other currencies/)).not.toBeInTheDocument();
  });

  it("toggles a thank-you and POSTs the new state", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({ id: "clm_9", kind: "claim" })] }));
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const toggle = await screen.findByRole("button", { name: /mark thanked/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/gifts\/claim\/clm_9\/thanked$/);
    expect(JSON.parse(init.body)).toEqual({ thanked: true });
    expect(peekCachedRegistry("wed_1")!.gifts[0]!.thankedAt).not.toBeNull();
  });

  it("gives a viewer the thanked state without a control to change it", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({ id: "a", thankedAt: 123 })] }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={false} />
    ));
    expect(await screen.findByText("Thanked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /thanked/i })).not.toBeInTheDocument();
  });

  it("pages the gift log by offset and appends the next page", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "a", familyName: "The Nguyens" })], giftsHasMore: true }),
    );
    authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          snapshot({ gifts: [gift({ id: "b", familyName: "The Okonkwos" })], giftsHasMore: false }),
        ),
        { status: 200 },
      ),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /load more gifts/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    // Offset is how many rows are already held, so the next page starts after them.
    expect(String(authFetch.mock.calls[0]![0])).toMatch(/[?&]giftsOffset=1$/);
    expect(await screen.findByText("The Okonkwos")).toBeInTheDocument();
    expect(screen.getByText("The Nguyens")).toBeInTheDocument();
    // Last page — the button goes away rather than fetching an empty one.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load more gifts/i })).not.toBeInTheDocument(),
    );
  });

  it("says what a status means rather than printing the enum value", async () => {
    // The column is raw on the wire and shared by two tables that do not share
    // its values. A couple reading their own gift log should not meet the word
    // "succeeded".
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [
          gift({ id: "a", kind: "claim", status: "reserved" }),
          gift({ id: "b", kind: "claim", status: "purchased" }),
          gift({ id: "c", kind: "claim", status: "released" }),
          gift({ id: "d", kind: "contribution", status: "pending", amountMinor: 5_000 }),
          gift({ id: "e", kind: "contribution", status: "succeeded", amountMinor: 5_000 }),
        ],
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText("Promised")).toBeInTheDocument();
    expect(screen.getByText("Bought")).toBeInTheDocument();
    expect(screen.getByText("No longer coming")).toBeInTheDocument();
    expect(screen.getByText("Not cleared yet")).toBeInTheDocument();
    expect(screen.getByText("Received")).toBeInTheDocument();
    for (const raw of ["reserved", "purchased", "released", "pending", "succeeded"]) {
      expect(screen.queryByText(raw)).not.toBeInTheDocument();
    }
  });

  it("says a refunded gift went back and is out of the total", async () => {
    // It stays in the log — it happened — and stays out of the summed total.
    // A one-word pill carries neither fact.
    setCachedRegistry(
      "wed_1",
      snapshot({
        contributionsPrimaryMinor: 0,
        gifts: [gift({ id: "r", kind: "contribution", status: "refunded", amountMinor: 5_000 })],
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText("Refunded")).toBeInTheDocument();
    expect(screen.getByText(/not counted in the total/i)).toBeInTheDocument();
  });

  it("leaves an unfamiliar status showing rather than blanking the pill", async () => {
    // A newer API than this build. Swallowing the value would leave the row
    // with no state at all. (`disputed` used to stand in for this and no longer
    // can — the build learned it. Any value this one has no word for will do.)
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "x", kind: "contribution", status: "reversed" })] }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText("reversed")).toBeInTheDocument();
  });

  it("says so when there are no gifts yet", async () => {
    setCachedRegistry("wed_1", snapshot());
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText("No gifts yet.")).toBeInTheDocument();
  });

  it("reads the parting summary as a record of detail that has been erased", async () => {
    setCachedRegistry("wed_1", snapshot({ giftSummary: summary() }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText("Your record of gifts")).toBeInTheDocument();
    // The erasure said outright — a bare total under an empty list reads as
    // "nobody gave you anything".
    expect(screen.getByText(/we deleted your guests' details/)).toBeInTheDocument();
    expect(screen.getByText(/18 gifts from your list/)).toBeInTheDocument();
    expect(screen.getByText(/14 marked bought/)).toBeInTheDocument();
    // The day of the sweep, not either end of the gift range.
    expect(screen.getByText(/we deleted your guests' details/)).toHaveTextContent("2026");
    expect(screen.getByText(/we deleted your guests' details/)).toHaveTextContent("17");
  });

  it("puts the first gift's date first and the last gift's date last", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ giftSummary: summary({ firstGiftOn: "2024-12-30", lastGiftOn: "2025-01-02" }) }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText(/Gifts arrived between .*2024.* and .*2025/)).toBeTruthy();
  });

  it("leaves out the list line when no gift from the list was counted", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ giftSummary: summary({ claims: { reserved: 0, purchased: 0 } }) }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findByText("Your record of gifts");
    expect(screen.queryByText(/from your list/)).not.toBeInTheDocument();
  });

  it("gives the range the gifts arrived over", async () => {
    setCachedRegistry("wed_1", snapshot({ giftSummary: summary() }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    // Asserted on the years, not the month names: the band formats in the
    // reader's locale. The point is that both ends are printed, and that the
    // UTC pinning has not shifted either off its stored day.
    const line = await screen.findByText(/Gifts arrived between .*2025.* and .*2025/);
    expect(line).toHaveTextContent("11");
    expect(line).toHaveTextContent("20");
  });

  it("totals each currency as it was given, never converted into one figure", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        giftSummary: summary({
          contributions: {
            count: 4,
            totals: [
              { currency: "AUD", amountMinor: 17_500 },
              { currency: "JPY", amountMinor: 3_000 },
            ],
          },
        }),
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const line = await screen.findByText(/175[.,]00/);
    expect(line).toHaveTextContent(/3.?000/);
    expect(line).toHaveTextContent("4 cash gifts");
  });

  it("stops saying there are no gifts once the detail has been swept", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [], giftSummary: summary() }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findByText("Your record of gifts");
    expect(screen.queryByText("No gifts yet.")).not.toBeInTheDocument();
  });

  it("shows no summary band while the gifts themselves are still here", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findByText("The Nguyens");
    expect(screen.queryByText("Your record of gifts")).not.toBeInTheDocument();
  });
});

/**
 * The gift log is kept for a year and then swept into totals, so the couple need
 * a way to take the detail with them before that happens. The button hands the
 * server-built CSV straight to the shared download helper — the bytes are
 * formula-sanitised server-side, so nothing is assembled here.
 */
describe("RegistryView — gift log export", () => {
  beforeEach(() => {
    downloadBlobMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    redirectToLoginMock.mockReset();
  });

  const csvResponse = () =>
    new Response("Kind,Item\r\nCash gift,", {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8" },
    });

  it("offers no export while there is nothing to export", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [] }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findByText("No gifts yet.");
    expect(screen.queryByRole("button", { name: /Download gifts/i })).not.toBeInTheDocument();
  });

  it("downloads the server-built gift CSV under a slug-based filename", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    authFetch.mockResolvedValueOnce(csvResponse());
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));

    fireEvent.click(await screen.findByRole("button", { name: /Download gifts/i }));

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(String(authFetch.mock.calls[0]![0])).toContain(
      "/api/organiser/weddings/wed_1/gifts.csv",
    );
    expect(downloadBlobMock.mock.calls[0]![0]).toBe("cire-gifts-wed-1.csv");
    expect(downloadBlobMock.mock.calls[0]![1]).toBeInstanceOf(Blob);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("says so and downloads nothing when the export fails", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    authFetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));

    fireEvent.click(await screen.findByRole("button", { name: /Download gifts/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("sends the couple to sign in again when the export answers 401", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    authFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));

    fireEvent.click(await screen.findByRole("button", { name: /Download gifts/i }));

    // An expired session is not a failed download: bounce to login rather than
    // telling the couple to retry something that cannot succeed.
    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("sends the couple to sign in again when authFetch throws AuthExpiredError", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    // The refresh can fail before any response exists, and `authFetch` then
    // rejects instead of resolving — the second of the two expiry exits.
    authFetch.mockRejectedValueOnce({ _tag: "AuthExpiredError" });
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));

    fireEvent.click(await screen.findByRole("button", { name: /Download gifts/i }));

    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
  });

  it("builds the file once however many times the button is pressed", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    let release: ((res: Response) => void) | undefined;
    authFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));

    const button = await screen.findByRole("button", { name: /Download gifts/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // The export is the heaviest read the couple can trigger and it shares a
    // per-user rate limit with the other two, so an impatient double-click must
    // not spend three of its ten requests a minute.
    expect(authFetch).toHaveBeenCalledTimes(1);
    release?.(csvResponse());
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
  });
});
