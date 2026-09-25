// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mutable session value so each test can control what useAuth() returns.
// Reset in afterEach so tests are isolated.
let mockSession: () => { profile: { id: string } } | null | undefined = () => ({
  profile: { id: "p1" },
});

// Mock @shared/rp-auth/solid so we control the session/authFetch without a real
// OSN backend — mirror the organiser app's VendorApp/OrganiserApp test harness.
vi.mock("@shared/rp-auth/solid", () => {
  return {
    AuthProvider: (props: any) => props.children,
    useAuth: () => ({
      session: () => mockSession(),
      activeProfileId: () => "p-vendor",
      authFetch: vi.fn(),
      logout: vi.fn(),
    }),
  };
});
// Partial: the network calls are mocked, but the claim handoff
// (seed / drain / take) is the real code, so the flow test below exercises the
// same path a vendor does after claiming.
vi.mock("../../src/lib/vendor-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/vendor-store")>();
  return {
    ...actual,
    listMyOrgs: vi.fn().mockResolvedValue([
      {
        id: "o1",
        handle: "acme",
        name: "Acme",
        description: null,
        avatarUrl: null,
        ownerId: "p1",
        createdAt: "",
        updatedAt: "",
      },
    ]),
    fetchListing: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api")>();
  return {
    ...actual,
    redirectToLogin: vi.fn(),
  };
});

import VendorApp from "../../src/components/VendorApp";
import { redirectToLogin } from "../../src/lib/api";
import { fetchListing, type Listing, seedClaimedListing } from "../../src/lib/vendor-store";

const CLAIMED_LISTING_KEY = "cire.vendor.claimed-listing";

const claimedListing: Listing = {
  id: "dv1",
  ownerOrgId: "o1",
  name: "Rosewood Barn",
  description: null,
  email: "hello@rosewood.example",
  phone: "0400 000 000",
  website: null,
  instagram: null,
  locationText: "Hunter Valley",
  priceBand: "$$",
  priceMinMinor: null,
  priceMaxMinor: null,
  listed: "live",
  categories: ["venue"],
  createdAt: 1,
  updatedAt: 2,
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  // Restore to signed-in state so tests start clean
  mockSession = () => ({ profile: { id: "p1" } });
  vi.clearAllMocks();
});

describe("VendorApp", () => {
  it("shows the org picker when signed in and no org is selected", async () => {
    render(() => <VendorApp />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
  });

  it("redirects to login and does not render the org picker when unauthenticated", async () => {
    mockSession = () => null;
    render(() => <VendorApp />);
    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
  });

  describe("claim handoff", () => {
    it("moves the claim's seed out of sessionStorage as the page loads, then hands it to that org's editor", async () => {
      // Where ClaimApp leaves the vendor: the seed in storage, the org in the hash.
      seedClaimedListing("o1", claimedListing);
      history.replaceState(null, "", "/#/orgs/o1");

      render(() => <VendorApp />);

      // Gone before the vendor has picked anything, so a vendor who never opens
      // the editor leaves no copy behind.
      expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).toBeNull();

      const acme = await screen.findByRole("button", { name: /Acme/ });
      fireEvent.click(acme);

      await waitFor(() => expect(screen.getByDisplayValue("Rosewood Barn")).toBeInTheDocument());
      expect(fetchListing).not.toHaveBeenCalled();
    });

    it("moves the seed out of sessionStorage even when the vendor is signed out", async () => {
      mockSession = () => null;
      seedClaimedListing("o1", claimedListing);

      render(() => <VendorApp />);

      expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).toBeNull();
      await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    });

    it("falls back to fetching when there was no claim", async () => {
      render(() => <VendorApp />);

      fireEvent.click(await screen.findByRole("button", { name: /Acme/ }));

      await waitFor(() => expect(fetchListing).toHaveBeenCalledWith(expect.anything(), "o1"));
    });
  });
});
