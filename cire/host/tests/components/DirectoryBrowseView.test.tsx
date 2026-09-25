// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/vendors-store", () => ({
  invalidateVendors: vi.fn(),
  upsertCachedVendor: vi.fn(),
}));

import DirectoryBrowseView from "../../src/components/DirectoryBrowseView";
import { invalidateVendors, upsertCachedVendor } from "../../src/lib/vendors-store";

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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("DirectoryBrowseView", () => {
  it("renders live listings from the browse endpoint", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => expect(screen.getByText("Acme Venue")).toBeInTheDocument());
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/organiser/weddings/w1/directory");
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

  it("hides the Add control for viewers (canEdit false)", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={false} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    expect(screen.queryByRole("button", { name: /add to wedding/i })).not.toBeInTheDocument();
  });
});
