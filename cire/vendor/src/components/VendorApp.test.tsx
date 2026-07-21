// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mutable session value so each test can control what useAuth() returns.
// Reset in afterEach so tests are isolated.
let mockSession: () => { profile: { id: string } } | null | undefined = () => ({
  profile: { id: "p1" },
});

// Mock @osn/client/solid so we control the session/authFetch without a real
// OSN backend — mirror the organiser app's VendorApp/OrganiserApp test harness.
vi.mock("@osn/client/solid", () => {
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
vi.mock("../lib/vendor-store", () => ({
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
}));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    redirectToLogin: vi.fn(),
  };
});

import { redirectToLogin } from "../lib/api";
import VendorApp from "./VendorApp";

afterEach(() => {
  cleanup();
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
});
