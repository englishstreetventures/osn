// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetVendorsCache, setCachedVendors, type VendorRow } from "../lib/vendors-store";
import VendorsView from "./VendorsView";

const authFetch = vi.fn();
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

const vendor = (over: Partial<VendorRow>): VendorRow => ({
  id: "ven_1",
  weddingId: "wed_1",
  directoryVendorId: null,
  name: "Florist",
  category: "florals",
  status: "researching",
  contactName: null,
  email: null,
  phone: null,
  notes: null,
  quotedMinor: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  __resetVendorsCache();
  authFetch.mockReset();
});

describe("VendorsView", () => {
  it("renders vendors grouped by status", async () => {
    setCachedVendors("wed_1", [
      vendor({ id: "a", name: "Florist Co", status: "researching" }),
      vendor({ id: "b", name: "Photo Studio", status: "booked", category: "photography" }),
    ]);
    render(() => <VendorsView weddingId="wed_1" canEdit={true} canManage={true} />);
    expect(await screen.findByText("Florist Co")).toBeInTheDocument();
    expect(screen.getByText("Photo Studio")).toBeInTheDocument();
    // Status group headings.
    expect(screen.getByRole("heading", { name: "Researching" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Booked" })).toBeInTheDocument();
    // No "Contacted" heading since there are no vendors in that status.
    expect(screen.queryByRole("heading", { name: "Contacted" })).not.toBeInTheDocument();
  });

  it("shows category chip on vendor card", async () => {
    setCachedVendors("wed_1", [vendor({ id: "a", name: "Flower Farm", category: "florals" })]);
    render(() => <VendorsView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Flower Farm");
    // Multiple matches expected: one chip <span> and one <option> in the add-form select.
    const floralsEls = screen.getAllByText("Florals");
    expect(floralsEls.length).toBeGreaterThanOrEqual(1);
    // At least one should be a span (the chip), not an option.
    expect(floralsEls.some((el) => el.tagName.toLowerCase() === "span")).toBe(true);
  });

  it("hides the add-vendor form for a viewer (read-only)", async () => {
    setCachedVendors("wed_1", [vendor({ id: "a", name: "Caterer" })]);
    render(() => <VendorsView weddingId="wed_1" canEdit={false} canManage={false} />);
    await screen.findByText("Caterer");
    expect(screen.queryByRole("button", { name: /add vendor/i })).not.toBeInTheDocument();
  });

  it("hides delete and status controls for a viewer", async () => {
    setCachedVendors("wed_1", [vendor({ id: "a", name: "Band" })]);
    render(() => <VendorsView weddingId="wed_1" canEdit={false} canManage={false} />);
    await screen.findByText("Band");
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /list in directory/i })).not.toBeInTheDocument();
  });

  it("editor sees add form and 'list in directory' action", async () => {
    setCachedVendors("wed_1", [vendor({ id: "a", name: "Venue Hall" })]);
    render(() => <VendorsView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Venue Hall");
    expect(screen.getByRole("button", { name: /add vendor/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /list.*directory/i })).toBeInTheDocument();
  });

  it("adds a vendor (POST) and appends it to the cache", async () => {
    setCachedVendors("wed_1", []);
    authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vendor: vendor({
            id: "new_1",
            name: "DJ Beats",
            category: "music_entertainment",
            status: "contacted",
          }),
        }),
        { status: 200 },
      ),
    );
    render(() => <VendorsView weddingId="wed_1" canEdit={true} canManage={true} />);
    const nameInput = await screen.findByPlaceholderText(/florist, photographer/i);
    fireEvent.input(nameInput, { target: { value: "DJ Beats" } });
    fireEvent.click(screen.getByRole("button", { name: /add vendor/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/vendors$/);
    expect(init.method).toBe("POST");
    expect(await screen.findByText("DJ Beats")).toBeInTheDocument();
  });

  it("opens the list-in-directory form when clicking 'List in directory'", async () => {
    setCachedVendors("wed_1", [vendor({ id: "a", name: "Cake Shop", email: "cake@example.com" })]);
    render(() => <VendorsView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Cake Shop");
    fireEvent.click(screen.getByRole("button", { name: /list.*directory/i }));
    // The "List + invite" submit button appears in the listing sub-form.
    expect(screen.getByRole("button", { name: /list \+ invite/i })).toBeInTheDocument();
    // The claim-invite label text appears.
    expect(screen.getByText(/vendor email.*claim invite/i)).toBeInTheDocument();
  });

  it("surfaces the claimUrl returned by list-in-directory POST", async () => {
    setCachedVendors("wed_1", [vendor({ id: "a", name: "Photo Studio" })]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ claimUrl: "https://host.cireweddings.com/claim/abc123" }), {
        status: 200,
      }),
    );
    render(() => <VendorsView weddingId="wed_1" canEdit={true} canManage={true} />);
    await screen.findByText("Photo Studio");
    fireEvent.click(screen.getByRole("button", { name: /list.*directory/i }));
    fireEvent.click(screen.getByRole("button", { name: /list \+ invite/i }));
    await waitFor(() =>
      expect(screen.getByText("https://host.cireweddings.com/claim/abc123")).toBeInTheDocument(),
    );
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/list-in-directory$/);
    expect(init.method).toBe("POST");
  });
});
