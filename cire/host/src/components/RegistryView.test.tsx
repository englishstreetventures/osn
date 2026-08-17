// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRegistryCache,
  type GiftLogEntry,
  peekCachedRegistry,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
} from "../lib/registry-store";
import RegistryView from "./RegistryView";

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

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
    stripeAccountId: null,
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    updatedAt: null,
  },
  items: [],
  gifts: [],
  giftsHasMore: false,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
    expect(await screen.findByText(/120[.,]00/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 claimed/)).toBeInTheDocument();
  });

  it("marks an item whose claims cover the wanted count as all taken", async () => {
    setCachedRegistry(
      "wed_1",
      snapshot({ items: [item({ quantityWanted: 1, quantityClaimed: 1 })] }),
    );
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
    await screen.findByText("Copper pan");
    // Named by what it opens, not by "Link" — a screen-reader user hitting a
    // list of them otherwise hears the same word once per row (C-L2).
    const links = screen.getAllByRole("link", { name: /^Open the shop page for/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Open the shop page for Copper pan");
    expect(links[0]).toHaveAttribute("href", "https://shop.example/pan");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("hides the add form and every row control from a viewer", async () => {
    setCachedRegistry("wed_1", snapshot({ items: [item({ title: "Copper pan" })] }));
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={false} />);
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
      <RegistryView weddingId="wed_1" view="list" canEdit={true} />
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
      <RegistryView weddingId="wed_1" view="list" canEdit={true} />
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="list" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />);
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
      <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />
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
      <RegistryView weddingId="wed_1" view="gifts" canEdit={false} />
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
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />);
    await screen.findByText(/50[.,]00/);
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it("labels the cash total as approximate", async () => {
    setCachedRegistry("wed_1", snapshot({ contributionsPrimaryMinor: 250_00 }));
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />);
    expect(await screen.findByText(/Approximate/)).toBeInTheDocument();
    expect(screen.getByText(/250[.,]00/)).toBeInTheDocument();
  });

  it("toggles a thank-you and POSTs the new state", async () => {
    setCachedRegistry("wed_1", snapshot({ gifts: [gift({ id: "clm_9", kind: "claim" })] }));
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />);
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
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={false} />);
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
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />);
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

  it("says so when there are no gifts yet", async () => {
    setCachedRegistry("wed_1", snapshot());
    render(() => <RegistryView weddingId="wed_1" view="gifts" canEdit={true} />);
    expect(await screen.findByText("No gifts yet.")).toBeInTheDocument();
  });
});
