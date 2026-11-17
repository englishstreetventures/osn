// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/vendors-store", () => ({
  invalidateVendors: vi.fn(),
  upsertCachedVendor: vi.fn(),
}));

import DirectoryBrowseView from "../../src/components/DirectoryBrowseView";
import { __resetDirectoryCache } from "../../src/lib/directory-store";
import { invalidateVendors, upsertCachedVendor } from "../../src/lib/vendors-store";
import { chipLook } from "../test-support/chip-look";

const listing = (over = {}) => ({
  id: "LA",
  name: "Acme Venue",
  description: "garden venue",
  categories: ["venue", "catering"],
  locationText: "Sydney",
  priceBand: "$$",
  priceMinMinor: null,
  priceMaxMinor: null,
  website: null,
  instagram: null,
  email: "a@x.com",
  phone: null,
  inWedding: false,
  ...over,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  cleanup();
  __resetDirectoryCache();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("DirectoryBrowseView", () => {
  it("reopens on the unfiltered first page without asking again", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    const first = render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    expect(await screen.findByText("Acme Venue")).toBeInTheDocument();
    first.unmount();
    authFetch.mockClear();

    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    expect(screen.getByText("Acme Venue")).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a category",
      () => fireEvent.change(screen.getByLabelText("Category"), { target: { value: "florals" } }),
    ],
    [
      "a keyword",
      () => fireEvent.input(screen.getByLabelText("Keyword"), { target: { value: "garden" } }),
    ],
    [
      "a location",
      () => fireEvent.input(screen.getByLabelText("Location"), { target: { value: "Perth" } }),
    ],
  ])(
    "keeps the unfiltered first page, not one filtered by %s, for the next opening",
    async (_l, filter) => {
      authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
      authFetch.mockResolvedValueOnce(
        json({ listings: [listing({ id: "LB", name: "Bloom Florals" })], total: 1 }),
      );
      const first = render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
      expect(await screen.findByText("Acme Venue")).toBeInTheDocument();
      filter();
      expect(await screen.findByText("Bloom Florals")).toBeInTheDocument();
      first.unmount();
      authFetch.mockClear();

      render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
      expect(screen.getByText("Acme Venue")).toBeInTheDocument();
      expect(screen.queryByText("Bloom Florals")).toBeNull();
      expect(authFetch).not.toHaveBeenCalled();
    },
  );

  it("reopens on a listing it added as already in the wedding", async () => {
    authFetch.mockResolvedValueOnce(
      json({ listings: [listing({ categories: ["venue"] })], total: 1 }),
    );
    authFetch.mockResolvedValueOnce(json({ vendor: { id: "v1" } }, 201));
    const first = render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    fireEvent.click((await screen.findAllByRole("button", { name: /add to wedding/i }))[0]!);
    await waitFor(() => expect(upsertCachedVendor).toHaveBeenCalled());
    first.unmount();
    authFetch.mockClear();

    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    expect(screen.getByLabelText("Already added to this wedding")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add to wedding/i })).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("reopens with the cached page's full count, offering the rest", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 25 }));
    const first = render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    expect(await screen.findByText("Acme Venue")).toBeInTheDocument();
    first.unmount();
    authFetch.mockClear();

    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    expect(
      screen.getByRole("button", { name: "Load more vendors, showing 1 of 25" }),
    ).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("reads again on the next opening once a directory read is refused", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    authFetch.mockResolvedValueOnce(json({ error: "Forbidden" }, 403));
    const first = render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    expect(await screen.findByText("Acme Venue")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "florals" } });
    expect(await screen.findByText(/Couldn't load the vendor directory/)).toBeInTheDocument();
    first.unmount();
    authFetch.mockClear();

    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
  });

  it("renders live listings from the browse endpoint", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => expect(screen.getByText("Acme Venue")).toBeInTheDocument());
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/organiser/weddings/w1/directory");
  });

  it("tags each listing with its categories' names, on the card and in its detail", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    // The card, not the category filter, whose options carry the same words.
    const card = (await screen.findByText("Acme Venue")).closest("li")!;
    // The label as written, never the stored key: sentence case, no small caps.
    const tags = (root: HTMLElement) =>
      ["Venue", "Catering"].map((word) => chipLook(within(root).getByText(word)));
    const tag = { tone: "neutral", variant: "filled", treatment: "tag" };
    const asTags = [tag, tag];
    expect(tags(card)).toEqual(asTags);

    fireEvent.click(within(card).getByRole("button", { name: "View" }));
    expect(tags(await screen.findByRole("dialog"))).toEqual(asTags);
  });

  it("prompts for a category in the listing's detail too, as one named group", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    const card = (await screen.findByText("Acme Venue")).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to wedding" }));
    const picker = within(dialog).getByRole("radiogroup", { name: "Pick a category" });
    const radios = within(picker).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.name])).toEqual([
      ["venue", "modal-add-cat-LA"],
      ["catering", "modal-add-cat-LA"],
    ]);
  });

  it("shows 'Added ✓' for a listing already in the wedding", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing({ inWedding: true })], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => expect(screen.getByText(/added/i)).toBeInTheDocument());
  });

  it("prompts for a category when the listing has several, then POSTs the add", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 })); // browse
    authFetch.mockResolvedValueOnce(json({ vendor: { id: "v1" } }, 201)); // add
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    fireEvent.click(screen.getAllByRole("button", { name: /add to wedding/i })[0]!);
    // multi-category → pick one, then confirm
    await waitFor(() => screen.getByLabelText(/venue/i));
    // One named group, its radios sharing one name of their own.
    const picker = screen.getByRole("radiogroup", { name: "Pick a category" });
    const names = within(picker)
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).name);
    expect(names).toEqual(["add-cat-LA", "add-cat-LA"]);
    fireEvent.click(screen.getByLabelText(/venue/i));
    fireEvent.click(screen.getByRole("button", { name: /confirm|add/i }));
    await waitFor(() => {
      const addCall = authFetch.mock.calls.find((c) => String(c[0]).includes("/directory/LA/add"));
      expect(addCall).toBeTruthy();
      expect(JSON.parse((addCall![1] as RequestInit).body as string)).toEqual({
        category: "venue",
      });
    });
    // The 201 hands back the row it created, so it goes into the vendors list
    // directly: no list read is queued for it.
    await waitFor(() => expect(upsertCachedVendor).toHaveBeenCalledWith("w1", { id: "v1" }));
    expect(invalidateVendors).not.toHaveBeenCalled();
  });

  it.each([
    ["no row", () => json({}, 201)],
    ["a body that will not parse", () => new Response("not json", { status: 201 })],
  ])("marks the vendors list stale when a 201 carries %s", async (_label, created) => {
    authFetch.mockResolvedValueOnce(
      json({ listings: [listing({ categories: ["venue"] })], total: 1 }),
    );
    authFetch.mockResolvedValueOnce(created());
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    fireEvent.click(screen.getAllByRole("button", { name: /add to wedding/i })[0]!);

    await waitFor(() => expect(invalidateVendors).toHaveBeenCalledWith("w1"));
    expect(upsertCachedVendor).not.toHaveBeenCalled();
  });

  it("marks the vendors list stale when the vendor was already on it (409)", async () => {
    authFetch.mockResolvedValueOnce(
      json({ listings: [listing({ categories: ["venue"] })], total: 1 }),
    );
    authFetch.mockResolvedValueOnce(json({ error: "conflict" }, 409));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    fireEvent.click(screen.getAllByRole("button", { name: /add to wedding/i })[0]!);

    // A 409 carries no row, so the list is left for the next load to fill.
    await waitFor(() => expect(invalidateVendors).toHaveBeenCalledWith("w1"));
    expect(upsertCachedVendor).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a website and an Instagram handle",
      "https://acme.example",
      "@acme.venue",
      ["Website", "Instagram"],
    ],
    ["a website alone", "https://acme.example", null, ["Website"]],
    ["an Instagram handle alone", null, "acme.venue", ["Instagram"]],
    ["neither", null, null, []],
    // A vendor writes these, so an address that is not http(s) and a handle
    // with characters a handle cannot have are refused, not linked.
    ["a refused website and handle", "javascript:alert(1)", "acme venue!", []],
  ])("links %s as pills that open a new tab and say so", async (_l, website, instagram, words) => {
    authFetch.mockResolvedValueOnce(
      json({ listings: [listing({ website, instagram })], total: 1 }),
    );
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    const card = (await screen.findByText("Acme Venue")).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog");
    const href = { Website: "https://acme.example", Instagram: "https://instagram.com/acme.venue" };
    const links = within(dialog).queryAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      words.map((w) => href[w as keyof typeof href]),
    );
    for (const [i, word] of words.entries()) {
      // The word first, then whose it is and that it leaves the portal.
      expect(links[i]!.textContent).toBe(`${word} for Acme Venue (opens in a new tab)`);
      expect(links[i]!.getAttribute("target")).toBe("_blank");
      expect(links[i]!.getAttribute("rel")).toBe("noopener noreferrer");
      // Each leads with its mark, hidden from assistive tech.
      expect(links[i]!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("hides the Add control for viewers (canEdit false)", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={false} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    expect(screen.queryByRole("button", { name: /add to wedding/i })).not.toBeInTheDocument();
  });
});
