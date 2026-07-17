// @vitest-environment happy-dom
import { AuthProvider } from "@osn/client/solid";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as store from "../lib/vendor-store";
import ListingEditor from "./ListingEditor";

vi.mock("@osn/client/solid", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AuthProvider: (props: { children: JSX.Element | any }) => props.children,
  useAuth: () => ({ authFetch: vi.fn() }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const listing = (over = {}) => ({
  id: "l1",
  ownerOrgId: "o1",
  name: "Acme Venues",
  description: "Nice",
  email: null,
  phone: null,
  website: null,
  instagram: null,
  locationText: "Sydney",
  priceBand: "$$",
  priceMinMinor: null,
  priceMaxMinor: null,
  listed: "live",
  categories: ["venue"],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderEditor = () =>
  render(() => (
    <AuthProvider config={{ issuerUrl: "http://localhost:4000" }}>
      <ListingEditor orgId="o1" orgName="Acme" />
    </AuthProvider>
  ));

describe("ListingEditor", () => {
  it("loads the existing listing into the form", async () => {
    vi.spyOn(store, "fetchListing").mockResolvedValue(listing());
    renderEditor();
    await waitFor(() => expect(screen.getByDisplayValue("Acme Venues")).toBeInTheDocument());
    expect((screen.getByLabelText("Venue") as HTMLInputElement).checked).toBe(true);
  });

  it("saves edits via putListing", async () => {
    vi.spyOn(store, "fetchListing").mockResolvedValue(listing());
    const put = vi.spyOn(store, "putListing").mockResolvedValue(listing({ name: "Acme Weddings" }));
    renderEditor();
    await waitFor(() => expect(screen.getByDisplayValue("Acme Venues")).toBeInTheDocument());
    fireEvent.input(screen.getByLabelText(/^name/i), { target: { value: "Acme Weddings" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        expect.anything(),
        "o1",
        expect.objectContaining({ name: "Acme Weddings", categories: ["venue"] }),
      ),
    );
  });

  it("renders an empty form when the org has no listing yet", async () => {
    vi.spyOn(store, "fetchListing").mockResolvedValue(null);
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText(/^name/i)).toHaveValue(""));
  });

  it("money round-trip: loads major units from minor, saves back to minor, blank → null", async () => {
    vi.spyOn(store, "fetchListing").mockResolvedValue(
      listing({ priceMinMinor: 125000, priceMaxMinor: 500000 }),
    );
    const put = vi
      .spyOn(store, "putListing")
      .mockResolvedValue(listing({ priceMinMinor: 150000, priceMaxMinor: 500000 }));
    renderEditor();

    // Wait for load — minor→major conversion: 125000/100 = 1250, 500000/100 = 5000
    const minInput = await waitFor(() => screen.getByLabelText(/price min/i) as HTMLInputElement);
    expect(minInput.value).toBe("1250");
    expect((screen.getByLabelText(/price max/i) as HTMLInputElement).value).toBe("5000");

    // Change min to 1500 (major) → putListing should receive priceMinMinor: 150000
    fireEvent.input(minInput, { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        expect.anything(),
        "o1",
        expect.objectContaining({ priceMinMinor: 150000 }),
      ),
    );

    put.mockClear();
    put.mockResolvedValue(listing({ priceMinMinor: null, priceMaxMinor: 500000 }));

    // Clear min to empty → putListing should receive priceMinMinor: null (not 0 or NaN)
    fireEvent.input(minInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        expect.anything(),
        "o1",
        expect.objectContaining({ priceMinMinor: null }),
      ),
    );
  });
});
