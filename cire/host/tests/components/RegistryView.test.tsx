// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RegistryView from "../../src/components/RegistryView";
import { apiUrl } from "../../src/lib/api";
import { formatMinor } from "../../src/lib/money";
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
  noteHidden: false,
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
  takesPayments: true,
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
    fireEvent.input(screen.getByLabelText("How many"), { target: { value: "2" } });
    fireEvent.input(screen.getByLabelText("Link (optional)"), {
      target: { value: "https://shop.example/fridge" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add gift/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/items$/);
    expect(init.method).toBe("POST");
    // A gift sends a gift's fields and no fund's.
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ quantityWanted: 2, externalUrl: "https://shop.example/fridge" });
    expect(sent).not.toHaveProperty("kind");
    expect(sent).not.toHaveProperty("targetMinor");
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

  it("rejects a price below the currency's smallest unit, naming it", async () => {
    setCachedRegistry("wed_1", snapshot({ currency: "KWD" }));
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    fireEvent.input(await screen.findByPlaceholderText(/copper pan/i), {
      target: { value: "Kettle" },
    });
    fireEvent.input(screen.getByPlaceholderText("0.00"), { target: { value: "0.0004" } });
    fireEvent.submit(container.querySelector("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Amounts between 0 and .*0\.001.* are not allowed\./);
    expect(alert).toHaveTextContent(/KWD/);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("rejects an edited price below the currency's smallest unit, naming it", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ currency: "KWD", items: [item({ id: "a", title: "Copper pan" })] }),
    );
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /edit copper pan/i }));
    const editForm = container.querySelectorAll("form")[1]!;
    fireEvent.input(within(editForm).getByLabelText("Price"), { target: { value: "0.0004" } });
    fireEvent.submit(editForm);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Amounts between 0 and .*0\.001.* are not allowed\./);
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
    // A gift's editor carries a gift's fields and no fund's goal.
    expect(within(editForm).queryByLabelText("Goal")).toBeNull();
    fireEvent.input(within(editForm).getByLabelText("How many"), { target: { value: "2" } });
    fireEvent.input(within(editForm).getByLabelText("Category"), { target: { value: "Kitchen" } });
    fireEvent.input(within(editForm).getByLabelText("Link"), {
      target: { value: "https://shop.example/pan" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/items\/a$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toMatchObject({
      title: "Copper saucepan",
      priceMinor: 12_000,
      quantityWanted: 2,
      category: "Kitchen",
      externalUrl: "https://shop.example/pan",
    });
    expect(JSON.parse(init.body)).not.toHaveProperty("targetMinor");
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

  it("states the cash total as given, never as an approximation", async () => {
    // Every gift is charged in the wedding's currency and nothing is converted,
    // so the figure is exact; calling it approximate would invent a doubt.
    setCachedRegistry("wed_1", snapshot({ contributionsPrimaryMinor: 250_00 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText(/250[.,]00/)).toBeInTheDocument();
    expect(screen.queryByText(/Approximate/)).not.toBeInTheDocument();
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
      await screen.findByText(/2 more gifts were given in other currencies/),
    ).toBeInTheDocument();
  });

  it("says nothing about other currencies when every gift is in the couple's", async () => {
    setCachedRegistry("wed_1", snapshot({ contributionsPrimaryMinor: 250_00 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findByText(/250[.,]00/);
    expect(screen.queryByText(/other currenc/)).not.toBeInTheDocument();
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

  it("hides a note at once, POSTs the hide and keeps the words out of the cache", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "clm_9", kind: "claim", note: "Something rude" })] }),
    );
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, note: null, noteHidden: true }), { status: 200 }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Hide note from The Nguyens" }));
    // Off the screen before the server answers.
    expect(screen.queryByText("Something rude")).not.toBeInTheDocument();
    expect(screen.getByText("Note hidden")).toBeInTheDocument();
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/gifts\/claim\/clm_9\/note-hidden$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ hidden: true });
    await waitFor(() =>
      expect(peekCachedRegistry("wed_1")!.gifts[0]).toMatchObject({ note: null, noteHidden: true }),
    );
    expect(screen.getByRole("button", { name: "Unhide note from The Nguyens" })).toHaveTextContent(
      "Unhide",
    );
  });

  it("shows a hidden note again with the words the server sends back", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [gift({ id: "rct_4", kind: "contribution", note: null, noteHidden: true })],
      }),
    );
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, note: "Welcome back", noteHidden: false }), {
        status: 200,
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Unhide note from The Nguyens" }));
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    expect(screen.queryByText("Note hidden")).not.toBeInTheDocument();
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/gifts\/contribution\/rct_4\/note-hidden$/);
    expect(JSON.parse(init.body)).toEqual({ hidden: false });
  });

  it("takes the server's word on a hide when the guest has since cleared the note", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({ id: "clm_9", note: "Stale words" })] }));
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, note: null, noteHidden: false }), { status: 200 }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Hide note from The Nguyens" }));
    await waitFor(() => expect(screen.queryByText("Note hidden")).not.toBeInTheDocument());
    expect(peekCachedRegistry("wed_1")!.gifts[0]).toMatchObject({ note: null, noteHidden: false });
  });

  it("tells a viewer a note is hidden and gives them no control over notes", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [
          gift({ id: "a", note: null, noteHidden: true }),
          gift({ id: "b", familyName: "The Okafors", note: "Lovely day" }),
        ],
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={false} />
    ));
    expect(await screen.findByText("Note hidden")).toBeInTheDocument();
    expect(screen.getByText("Lovely day")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /hide note/i })).not.toBeInTheDocument();
  });

  it("offers no hide on a gift without a note, and reads a missing flag as shown", async () => {
    // An API older than the hide sends no `noteHidden` at all.
    const { noteHidden: _, ...legacy } = gift({ id: "a", note: "Old API note" });
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [legacy as GiftLogEntry, gift({ id: "b", note: null })] }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(await screen.findByText("Old API note")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /hide note from/i })).toHaveLength(1);
    expect(screen.queryByText("Note hidden")).not.toBeInTheDocument();
  });

  it("puts the note back and says so when a hide fails", async () => {
    const shown = gift({ id: "clm_9", note: "Something rude" });
    setCachedRegistry("wed_1", snapshot({ gifts: [shown] }));
    authFetch
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot({ gifts: [shown] })), { status: 200 }),
      );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Hide note from The Nguyens" }));
    expect(await screen.findByText("Couldn't hide that note.")).toBeInTheDocument();
    expect(await screen.findByText("Something rude")).toBeInTheDocument();
  });

  it("keeps keyboard focus on the row's note control through a hide and an unhide", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [
          gift({ id: "clm_1", note: "First note" }),
          gift({ id: "clm_2", familyName: "The Okafors", note: "Second note" }),
        ],
      }),
    );
    authFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, note: null, noteHidden: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, note: "Second note", noteHidden: false }), {
          status: 200,
        }),
      );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const hide = await screen.findByRole("button", { name: "Hide note from The Okafors" });
    hide.focus();
    fireEvent.click(hide);
    // The row is rebuilt by the patch; focus follows to its new control
    // rather than falling to the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Unhide note from The Okafors" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unhide note from The Okafors" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Hide note from The Okafors" }),
      ),
    );
  });

  it("keeps keyboard focus on the thank-you toggle it just pressed", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        gifts: [gift({ id: "clm_1" }), gift({ id: "clm_2", familyName: "The Okafors" })],
      }),
    );
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const toggle = await screen.findByRole("button", { name: "Mark thanked: The Okafors" });
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Mark thanked: The Okafors" }),
      ),
    );
    expect(document.activeElement).toHaveAttribute("aria-pressed", "true");
  });

  it("sends the couple to sign in again when a hide answers 401", async () => {
    redirectToLoginMock.mockClear();
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "clm_9", note: "Something rude" })] }),
    );
    authFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Hide note from The Nguyens" }));
    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
    expect(screen.queryByText("Couldn't hide that note.")).not.toBeInTheDocument();
  });

  it("keeps a note hidden and says so when an unhide fails", async () => {
    const hidden = gift({ id: "rct_4", kind: "contribution", note: null, noteHidden: true });
    setCachedRegistry("wed_1", snapshot({ gifts: [hidden] }));
    authFetch
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot({ gifts: [hidden] })), { status: 200 }),
      );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Unhide note from The Nguyens" }));
    expect(await screen.findByText("Couldn't show that note again.")).toBeInTheDocument();
    expect(await screen.findByText("Note hidden")).toBeInTheDocument();
  });

  it("pages the gift log by offset from the gifts-only route and appends the next page", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "a", familyName: "The Nguyens" })], giftsHasMore: true }),
    );
    const before = peekCachedRegistry("wed_1")!;
    // A further page is the gift log alone — no settings, items or totals ride
    // along, because the view already holds them.
    authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          gifts: [gift({ id: "b", familyName: "The Okonkwos" })],
          giftsHasMore: false,
        }),
        { status: 200 },
      ),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /load more gifts/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    // Offset is how many rows are already held, so the next page starts after them.
    expect(String(authFetch.mock.calls[0]![0])).toBe(
      apiUrl("/api/organiser/weddings/wed_1/registry/gifts?offset=1"),
    );
    expect(await screen.findByText("The Okonkwos")).toBeInTheDocument();
    // Everything but the log is the snapshot the view already held.
    const after = peekCachedRegistry("wed_1")!;
    expect(after.items).toBe(before.items);
    expect(after.settings).toBe(before.settings);
    expect(screen.getByText("The Nguyens")).toBeInTheDocument();
    // Last page — the button goes away rather than fetching an empty one.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load more gifts/i })).not.toBeInTheDocument(),
    );
  });

  it("keeps what it has and says so when a further page fails", async () => {
    // A refused page — a 404 from an API older than this portal included —
    // must leave the rows already shown, and the button, where they were.
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "a", familyName: "The Nguyens" })], giftsHasMore: true }),
    );
    authFetch.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /load more gifts/i }));
    expect(await screen.findByText("Couldn't load more gifts.")).toBeInTheDocument();
    expect(screen.getByText("The Nguyens")).toBeInTheDocument();
    expect(peekCachedRegistry("wed_1")!.gifts).toHaveLength(1);
    expect(screen.getByRole("button", { name: /load more gifts/i })).toBeEnabled();
  });

  it("sends an expired session to sign in rather than appending anything", async () => {
    redirectToLoginMock.mockReset();
    setCachedRegistry(
      "wed_1",
      snapshot({ gifts: [gift({ id: "a", familyName: "The Nguyens" })], giftsHasMore: true }),
    );
    authFetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /load more gifts/i }));
    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalledTimes(1));
    expect(peekCachedRegistry("wed_1")!.gifts).toHaveLength(1);
    expect(screen.queryByText("Couldn't load more gifts.")).not.toBeInTheDocument();
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

  it("totals the couple's currency with the gifts it adds", async () => {
    setCachedRegistry("wed_1", snapshot({ giftSummary: summary() }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const line = await screen.findByText(/175[.,]00/);
    expect(line).toHaveTextContent("3 cash gifts");
  });

  it("names each other currency as outside the couple's total, never adding them up", async () => {
    // A gift given before the couple changed their currency stays in its own:
    // nothing is converted, and two currencies summed is not an amount.
    setCachedRegistry(
      "wed_1",
      snapshot({
        giftSummary: summary({
          contributions: {
            count: 4,
            totals: [
              { currency: "AUD", amountMinor: 17_500, count: 3 },
              { currency: "JPY", amountMinor: 3_000, count: 1 },
            ],
            gifts: [],
          },
        }),
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const ours = await screen.findByText(/175[.,]00/);
    expect(ours).toHaveTextContent("3 cash gifts in AUD");
    const theirs = screen.getByText(/1 cash gift in JPY/);
    expect(theirs).toHaveTextContent(/3.?000/);
    expect(theirs).toHaveTextContent("not in the AUD total");
  });

  it("lists each cash gift as given, by its day, and marks one in another currency", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        giftSummary: summary({
          contributions: {
            count: 2,
            totals: [
              { currency: "AUD", amountMinor: 12_500, count: 1 },
              { currency: "USD", amountMinor: 5_000, count: 1 },
            ],
            gifts: [
              { on: "2025-03-02", amountMinor: 5_000, currency: "USD" },
              { on: "2025-05-11", amountMinor: 12_500, currency: "AUD" },
            ],
          },
        }),
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const list = await screen.findByRole("list", { name: "Each cash gift" });
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    // Oldest first; the day pinned to UTC so it is the stored one.
    expect(rows[0]).toHaveTextContent("2025");
    expect(rows[0]).toHaveTextContent(/50[.,]00/);
    expect(rows[0]).toHaveTextContent("Given in USD — not in the AUD total");
    expect(rows[1]).toHaveTextContent(/125[.,]00/);
    expect(rows[1]).not.toHaveTextContent("Given in");
  });

  it("says how many gifts the record counts but does not list", async () => {
    // A record kept before gifts were listed holds a count and totals only.
    setCachedRegistry("wed_1", snapshot({ giftSummary: summary() }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(
      await screen.findByText("3 cash gifts are counted above but not listed one by one."),
    ).toBeInTheDocument();
  });

  it("counts one gift past the list as one more", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        giftSummary: summary({
          contributions: {
            count: 2,
            totals: [{ currency: "AUD", amountMinor: 17_500, count: 2 }],
            gifts: [{ on: "2025-05-11", amountMinor: 12_500, currency: "AUD" }],
          },
        }),
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(
      await screen.findByText("1 more cash gift is counted above but not listed one by one."),
    ).toBeInTheDocument();
  });

  it("shows each currency as its own total when none came in the couple's", async () => {
    // A wedding that changed currency after every gift: no couple-currency
    // total to sit beside, so no "Plus" and no "not in the AUD total".
    setCachedRegistry(
      "wed_1",
      snapshot({
        giftSummary: summary({
          contributions: {
            count: 1,
            totals: [{ currency: "USD", amountMinor: 5_000, count: 1 }],
            gifts: [{ on: "2025-03-02", amountMinor: 5_000, currency: "USD" }],
          },
        }),
      }),
    );
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    const total = await screen.findByText(/1 cash gift in USD/);
    expect(total).toHaveTextContent(/50[.,]00/);
    expect(total).not.toHaveTextContent("Plus");
    expect(screen.getByText("Given in USD")).toBeInTheDocument();
    expect(screen.queryByText(/not in the AUD total/)).not.toBeInTheDocument();
  });

  it("names a currency by itself where the record kept no count for it", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({
        giftSummary: summary({
          contributions: {
            count: 3,
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
    expect(await screen.findByText(/175[.,]00/)).toHaveTextContent("in AUD");
    expect(screen.getByText(/3.?000/)).toHaveTextContent("in JPY, not in the AUD total");
  });

  it("says the amount and day of each cash gift were kept", async () => {
    setCachedRegistry("wed_1", snapshot({ giftSummary: summary() }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    expect(
      await screen.findByText(/We kept the amount and the day of each\s+cash gift/),
    ).toBeInTheDocument();
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

  it("offers the export to an owner only: the gift-log CSV is owner-only", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} />
    ));
    await screen.findAllByText(/Copper pan/);
    expect(screen.queryByRole("button", { name: /Download gifts/i })).not.toBeInTheDocument();
  });

  it("offers no export while there is nothing to export", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [] }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} canManage />
    ));
    await screen.findByText("No gifts yet.");
    expect(screen.queryByRole("button", { name: /Download gifts/i })).not.toBeInTheDocument();
  });

  it("downloads the server-built gift CSV under a slug-based filename", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    authFetch.mockResolvedValueOnce(csvResponse());
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} canManage />
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
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} canManage />
    ));

    fireEvent.click(await screen.findByRole("button", { name: /Download gifts/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("sends the couple to sign in again when the export answers 401", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({})] }));
    authFetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} canManage />
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
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} canManage />
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
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="gifts" canEdit={true} canManage />
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

describe("RegistryView — cash funds", () => {
  const fund = (over: Partial<RegistryItem> = {}): RegistryItem =>
    item({
      id: "fund_1",
      kind: "cash_fund",
      title: "Honeymoon in Kyoto",
      description: "Trains, temples and a very good dinner.",
      targetMinor: 500_000,
      ...over,
    });
  /** Settings under which guests can give money, so funds reach them. */
  const takingMoney = {
    ...snapshot().settings,
    cashGiftsEnabled: true,
    stripeConnected: true,
    stripeChargesEnabled: true,
  };

  it("adds a cash fund with its goal in the wedding's own currency, and no gift fields", async () => {
    // A yen wedding: ¥50,000 typed is 50,000 minor units, not 5,000,000.
    setCachedRegistry("wed_1", snapshot({ currency: "JPY" }));
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ item: fund({ id: "new_fund", targetMinor: 50_000 }) }), {
        status: 200,
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon in Kyoto" } });
    fireEvent.input(screen.getByLabelText("Goal (optional)"), { target: { value: "50000" } });
    fireEvent.input(screen.getByLabelText("What it’s for (optional)"), {
      target: { value: "  Trains, temples and a very good dinner.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/registry\/items$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({
      kind: "cash_fund",
      title: "Honeymoon in Kyoto",
      description: "Trains, temples and a very good dinner.",
      targetMinor: 50_000,
      imageKey: null,
    });
    expect(await screen.findByText("Honeymoon in Kyoto")).toBeInTheDocument();
    // The form is cleared for the next fund.
    expect((screen.getByLabelText("Fund") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Goal (optional)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("What it’s for (optional)") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("clears the picture once a fund is added, so the next one starts without it", async () => {
    setCachedRegistry("wed_1", snapshot());
    authFetch.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/registry/image"))
        return Promise.resolve(
          new Response(JSON.stringify({ imageKey: "assets/wed_1/registry-f1", imageUrl: "/x" }), {
            status: 200,
          }),
        );
      if (u.includes("/registry/image/")) return Promise.resolve(new Response("bytes"));
      return Promise.resolve(
        new Response(JSON.stringify({ item: fund({ imageKey: "assets/wed_1/registry-f1" }) }), {
          status: 200,
        }),
      );
    });
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon in Kyoto" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload a photo" }));
    const file = screen.getByLabelText("Photo to upload");
    Object.defineProperty(file, "files", {
      value: [new File(["png"], "kyoto.png", { type: "image/png" })],
      configurable: true,
    });
    fireEvent.change(file);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove picture" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));
    const isCreate = (call: unknown[]) => String(call[0]).endsWith("/registry/items");
    await waitFor(() => expect(authFetch.mock.calls.some(isCreate)).toBe(true));
    expect(JSON.parse(authFetch.mock.calls.find(isCreate)![1].body).imageKey).toBe(
      "assets/wed_1/registry-f1",
    );
    // The add form is empty again, picture included.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove picture" })).toBeNull(),
    );
  });

  it("starts on a gift, and switching to a fund and back shows each kind's own fields", async () => {
    setCachedRegistry("wed_1", snapshot());
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ item: fund({ targetMinor: null, description: null }) }), {
        status: 200,
      }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    const giftChoice = (await screen.findByRole("radio", {
      name: "A gift to reserve",
    })) as HTMLInputElement;
    const fundChoice = screen.getByRole("radio", { name: "A cash fund" }) as HTMLInputElement;
    expect(giftChoice.checked).toBe(true);
    expect(fundChoice.checked).toBe(false);
    expect(screen.getByPlaceholderText(/copper pan/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Fund")).toBeNull();

    fireEvent.click(fundChoice);
    expect(screen.queryByPlaceholderText(/copper pan/i)).toBeNull();
    expect(screen.queryByLabelText("Price (optional)")).toBeNull();
    fireEvent.click(giftChoice);
    expect(screen.getByPlaceholderText(/copper pan/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Goal (optional)")).toBeNull();

    // A fund with nothing but a name sends no words and no goal.
    fireEvent.click(fundChoice);
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
    fireEvent.input(screen.getByLabelText("Goal (optional)"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toMatchObject({
      description: null,
      targetMinor: null,
    });
  });

  it("refuses a goal below the currency's smallest unit, naming it", async () => {
    setCachedRegistry("wed_1", snapshot());
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
    fireEvent.input(screen.getByLabelText("Goal (optional)"), { target: { value: "0.004" } });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not allowed/);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("says the list is full, or that the fund could not be added, without adding it", async () => {
    for (const [answer, words] of [
      [new Response("{}", { status: 409 }), "Your gift list is full"],
      [new Response("{}", { status: 500 }), "Couldn't add that fund."],
    ] as const) {
      __resetRegistryCache();
      authFetch.mockReset();
      setCachedRegistry("wed_1", snapshot());
      authFetch
        .mockResolvedValueOnce(answer)
        .mockResolvedValue(new Response(JSON.stringify(snapshot()), { status: 200 }));
      const view = render(() => (
        <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
      ));
      fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
      fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
      fireEvent.click(screen.getByRole("button", { name: /add fund/i }));
      expect(await screen.findByRole("alert")).toHaveTextContent(words);
      expect(screen.queryByText("Honeymoon")).toBeNull();
      view.unmount();
    }
  });

  it("shows the couple a fund's goal, and no count of anything claimed", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ settings: takingMoney, items: [fund(), item({ id: "pan", sortOrder: 1 })] }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    const rows = await screen.findAllByRole("listitem");
    const fundRow = rows.find((r) => r.textContent?.includes("Honeymoon in Kyoto"))!;
    expect(fundRow).toHaveTextContent("Cash fund");
    expect(fundRow).toHaveTextContent(`Goal ${formatMinor(500_000, "AUD")}`);
    expect(fundRow.textContent).not.toMatch(/claimed/i);
    // A gift beside it keeps its claimed count.
    const panRow = rows.find((r) => r.textContent?.includes("Copper pan"))!;
    const claimed = [...panRow.querySelectorAll("span")].find((span) =>
      span.textContent?.includes("claimed"),
    );
    expect(claimed?.textContent?.trim()).toBe("0 of 1 claimed");
  });

  it("edits a fund's goal through the currency's exponent and sends no gift fields", async () => {
    setCachedRegistry("wed_1", snapshot({ settings: takingMoney, items: [fund()] }));
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ item: fund({ targetMinor: 650_000 }) }), { status: 200 }),
    );
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));

    fireEvent.click(await screen.findByRole("button", { name: /edit honeymoon in kyoto/i }));
    const editForm = container.querySelectorAll("form")[1]!;
    const goal = within(editForm).getByLabelText("Goal") as HTMLInputElement;
    expect(goal.value).toBe("5000.00");
    expect(within(editForm).queryByLabelText("Price")).toBeNull();
    fireEvent.input(goal, { target: { value: "6500" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toEqual({
      title: "Honeymoon in Kyoto",
      description: "Trains, temples and a very good dinner.",
      targetMinor: 650_000,
      imageKey: null,
    });
  });

  it("says a field did not fit, rather than blaming a link nobody typed", async () => {
    setCachedRegistry("wed_1", snapshot());
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_item_fields" }), { status: 400 }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "A cash fund takes a name, a goal, a description and a picture, and nothing else.",
    );
  });

  it("answers each refused write in the words for its kind and its code", async () => {
    // A fund refused for some other reason (a name too long, a goal too big),
    // here with a body that is not even JSON.
    setCachedRegistry("wed_1", snapshot());
    authFetch.mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));
    const first = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the fund’s name and goal.");
    first.unmount();

    // A gift refused with no code: the one field a gift can get wrong is its link.
    __resetRegistryCache();
    authFetch.mockReset();
    setCachedRegistry("wed_1", snapshot());
    authFetch.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    const second = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    fireEvent.input(await screen.findByPlaceholderText(/copper pan/i), {
      target: { value: "Wine fridge" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add gift/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A link must be a full https:// address.",
    );
    second.unmount();

    // A gift edit refused as a field of the other kind.
    __resetRegistryCache();
    authFetch.mockReset();
    setCachedRegistry("wed_1", snapshot({ items: [item({ id: "a" })] }));
    authFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_item_fields" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot({ items: [item({ id: "a" })] })), { status: 200 }),
      );
    const third = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /edit copper pan/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A gift to reserve has no goal. Refresh and try again.",
    );
    third.unmount();
  });

  it("takes back a fund that a server not yet taking funds saved as a gift", async () => {
    // The portal can reach production before the API that knows funds. That
    // API drops `kind`, and would put "Honeymoon" on the guest list as a gift
    // to reserve. The portal deletes it at once and says so.
    setCachedRegistry("wed_1", snapshot());
    authFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ item: item({ id: "oops", title: "Honeymoon" }) }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    const [url, init] = authFetch.mock.calls[1]!;
    expect(String(url)).toMatch(/\/registry\/items\/oops$/);
    expect(init.method).toBe("DELETE");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cash funds aren’t available yet. Try again in a few minutes.",
    );
    expect(screen.queryByText("Honeymoon")).toBeNull();
    // Taken back, so nothing to re-read.
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it("shows the couple a gift it could not take back, so they can remove it", async () => {
    // The take-back failed, so a gift guests can reserve is on the list. The
    // couple are told, and the list is read again so it is there to remove.
    const saved = item({ id: "oops", title: "Honeymoon" });
    for (const failure of [
      () => Promise.resolve(new Response("{}", { status: 500 })),
      () => Promise.reject(new Error("offline")),
    ]) {
      __resetRegistryCache();
      authFetch.mockReset();
      setCachedRegistry("wed_1", snapshot());
      authFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ item: saved }), { status: 200 }))
        .mockImplementationOnce(failure)
        .mockResolvedValueOnce(
          new Response(JSON.stringify(snapshot({ items: [saved] })), { status: 200 }),
        );
      const view = render(() => (
        <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
      ));

      fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
      fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
      fireEvent.click(screen.getByRole("button", { name: /add fund/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/Remove it from your list/);
      await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(3));
      expect(String(authFetch.mock.calls[2]![0])).toMatch(/\/registry$/);
      expect(await screen.findByText("Honeymoon")).toBeInTheDocument();
      view.unmount();
    }
  });

  it("shows a fund with no goal without one, and edits it without inventing one", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [fund({ targetMinor: null })] }));
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ item: fund({ targetMinor: null }) }), { status: 200 }),
    );
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));

    const [row] = await screen.findAllByRole("listitem");
    expect(row!.textContent).not.toMatch(/Goal/);

    fireEvent.click(screen.getByRole("button", { name: /edit honeymoon in kyoto/i }));
    const editForm = container.querySelectorAll("form")[1]!;
    expect(within(editForm).getByLabelText("Fund")).toBeInTheDocument();
    expect((within(editForm).getByLabelText("Goal") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(authFetch.mock.calls[0]![1].body).targetMinor).toBeNull();
  });

  it("edits a fund only with a name and a real goal, and trims what was typed", async () => {
    setCachedRegistry("wed_1", snapshot({ settings: takingMoney, items: [fund()] }));
    authFetch.mockResolvedValue(new Response(JSON.stringify({ item: fund() }), { status: 200 }));
    const { container } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    const openEditor = async () => {
      fireEvent.click(await screen.findByRole("button", { name: /edit honeymoon in kyoto/i }));
      return container.querySelectorAll("form")[1]!;
    };

    const editForm = await openEditor();
    fireEvent.input(within(editForm).getByLabelText("Goal"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A goal must be a positive amount.");

    fireEvent.input(within(editForm).getByLabelText("Fund"), { target: { value: "   " } });
    fireEvent.input(within(editForm).getByLabelText("Goal"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(authFetch).not.toHaveBeenCalled();

    fireEvent.input(within(editForm).getByLabelText("Fund"), {
      target: { value: "  Honeymoon  " },
    });
    fireEvent.input(within(editForm).getByLabelText("Description"), {
      target: { value: "  Somewhere warm  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toMatchObject({
      title: "Honeymoon",
      description: "Somewhere warm",
      targetMinor: 10_000,
    });
    // The error from the refused goal does not outlive a save that worked.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("refuses a goal of nothing without asking the server", async () => {
    setCachedRegistry("wed_1", snapshot());
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
    fireEvent.input(screen.getByLabelText("Goal (optional)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A goal must be a positive amount.");
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("sends the couple to sign in again when adding a fund answers 401", async () => {
    setCachedRegistry("wed_1", snapshot());
    redirectToLoginMock.mockClear();
    authFetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);

    fireEvent.click(await screen.findByRole("radio", { name: "A cash fund" }));
    fireEvent.input(screen.getByLabelText("Fund"), { target: { value: "Honeymoon" } });
    fireEvent.click(screen.getByRole("button", { name: /add fund/i }));

    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalledTimes(1));
  });

  it("loads the list when nothing is cached yet, funds and all", async () => {
    // The first visit to the module: no snapshot until the read answers.
    authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify(snapshot({ items: [fund(), item({ id: "pan", sortOrder: 1 })] })),
        {
          status: 200,
        },
      ),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    expect(await screen.findByText("Honeymoon in Kyoto")).toBeInTheDocument();
    // A fund among gifts, with money off, still says guests cannot see it.
    expect(screen.getByText(/only while money gifts are on/i)).toBeInTheDocument();
  });

  it("says when guests cannot see the funds, and not when they can", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [fund()] }));
    const { unmount } = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    expect(await screen.findByText(/only while money gifts are on/i)).toBeInTheDocument();
    unmount();

    // Money gifts switched off with Stripe still charging is the ordinary way
    // they are off; the funds are just as hidden.
    setCachedRegistry(
      "wed_1",
      snapshot({ settings: { ...takingMoney, cashGiftsEnabled: false }, items: [fund()] }),
    );
    const halfOn = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    expect(await screen.findByText(/only while money gifts are on/i)).toBeInTheDocument();
    halfOn.unmount();

    // No fund, nothing to say, whatever the money settings.
    setCachedRegistry("wed_1", snapshot({ items: [item({})] }));
    const giftsOnly = render(() => (
      <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />
    ));
    await screen.findByText("Copper pan");
    expect(screen.queryByText(/only while money gifts are on/i)).toBeNull();
    giftsOnly.unmount();

    setCachedRegistry("wed_1", snapshot({ settings: takingMoney, items: [fund()] }));
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    await screen.findByText("Honeymoon in Kyoto");
    expect(screen.queryByText(/only while money gifts are on/i)).toBeNull();
  });

  it("says guests cannot see the funds where this site cannot take a money gift", async () => {
    // The couple and Stripe are both ready; the deployment is not. The notice
    // names the real reason, and does not send them to a switch that would
    // change nothing.
    setCachedRegistry(
      "wed_1",
      snapshot({ settings: takingMoney, items: [fund()], takesPayments: false }),
    );
    render(() => <RegistryView weddingId="wed_1" weddingSlug="wed-1" view="list" canEdit={true} />);
    await screen.findByText("Honeymoon in Kyoto");
    expect(
      screen.getByText(
        /guests can’t see your cash funds: money gifts aren’t available on this site yet/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/only while money gifts are on/i)).toBeNull();
  });
});
