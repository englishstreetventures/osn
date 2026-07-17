// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../lib/vendors-store", () => ({ invalidateVendors: vi.fn() }));

import { invalidateVendors } from "../lib/vendors-store";
import DirectoryBrowseView from "./DirectoryBrowseView";

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
    expect(invalidateVendors).toHaveBeenCalledWith("w1");
  });

  it("hides the Add control for viewers (canEdit false)", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={false} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    expect(screen.queryByRole("button", { name: /add to wedding/i })).not.toBeInTheDocument();
  });
});
