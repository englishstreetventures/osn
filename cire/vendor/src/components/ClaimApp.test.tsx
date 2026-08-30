// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─── Mutable mock state ────────────────────────────────────────────────────
// Each test can overwrite these before render; factories read them at call
// time so tests are fully isolated.

let mockSession: { profileId: string } | null = { profileId: "usr_1" };
let mockFetchClaimPreview: () => Promise<{ directoryVendorId: string; name: string } | null> = () =>
  Promise.resolve({ directoryVendorId: "d1", name: "Preview Co" });
let mockConsumeClaim: () => Promise<void> = () => Promise.resolve();
const signInMock = vi.fn();

// ─── Module mocks ──────────────────────────────────────────────────────────

vi.mock("@shared/rp-auth/solid", () => ({
  AuthProvider: (props: { children: JSX.Element }) => props.children,
  useAuth: () => ({
    session: () => mockSession,
    authFetch: vi.fn(),
    signIn: signInMock,
  }),
}));

vi.mock("../lib/vendor-store", () => ({
  fetchClaimPreview: (...args: any[]) => mockFetchClaimPreview(...(args as [])),
  consumeClaim: (...args: any[]) => mockConsumeClaim(...(args as [])),
  listMyOrgs: vi.fn().mockResolvedValue([]),
}));

// Mock OrgPicker — exposes a button that triggers onPick with a test org.
vi.mock("./OrgPicker", () => ({
  default: (props: {
    onPick: (org: {
      id: string;
      name: string;
      handle: string;
      description: null;
      avatarUrl: null;
      ownerId: string;
      createdAt: string;
      updatedAt: string;
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-org-picker"
      onClick={() =>
        props.onPick({
          id: "org1",
          name: "Test Org",
          handle: "test-org",
          description: null,
          avatarUrl: null,
          ownerId: "p1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        })
      }
    >
      Pick Org
    </button>
  ),
}));

// ─── Helpers ───────────────────────────────────────────────────────────────

import ClaimApp from "./ClaimApp";

/** Fresh render of ClaimApp with a given token in the URL. */
function renderClaim(token = "tok-test") {
  history.replaceState(null, "", `/claim?token=${token}`);
  return render(() => <ClaimApp />);
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/claim");
  // The token is parked in sessionStorage across the sign-in redirect, so it
  // outlives a render — clear it or the next test inherits it.
  sessionStorage.clear();
  signInMock.mockReset();
  // Reset mutable state to defaults for the next test.
  mockSession = { profileId: "usr_1" };
  mockFetchClaimPreview = () => Promise.resolve({ directoryVendorId: "d1", name: "Preview Co" });
  mockConsumeClaim = () => Promise.resolve();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("ClaimApp", () => {
  it("previews the invited listing name and strips the token from the URL", async () => {
    renderClaim("abc123");
    await waitFor(() => expect(screen.getByText(/Preview Co/)).toBeInTheDocument());
    expect(window.location.search).not.toContain("abc123");
  });

  it("null preview → shows generic 'no longer valid' message, hides listing preview", async () => {
    mockFetchClaimPreview = () => Promise.resolve(null);
    renderClaim("expired-token");

    await waitFor(() => expect(screen.getByText(/no longer valid/i)).toBeInTheDocument());

    // The listing name "Preview Co" must not appear.
    expect(screen.queryByText(/Preview Co/i)).not.toBeInTheDocument();
    // The OrgPicker must not appear.
    expect(screen.queryByTestId("mock-org-picker")).not.toBeInTheDocument();
    // The invited-listing headline must not appear.
    expect(screen.queryByText(/you've been invited to claim/i)).not.toBeInTheDocument();
  });

  it("consumeClaim error → shows generic message, does NOT leak raw error text", async () => {
    // consumeClaim rejects with a sensitive-looking error.
    mockConsumeClaim = () => Promise.reject(new Error("token abc123 already consumed"));

    renderClaim("valid-token");

    // Wait for the preview to load and OrgPicker to appear.
    await waitFor(() => expect(screen.getByTestId("mock-org-picker")).toBeInTheDocument());

    // Trigger the claim by clicking the mocked OrgPicker button.
    screen.getByTestId("mock-org-picker").click();

    // The generic message must appear.
    await waitFor(() => expect(screen.getByText(/no longer valid/i)).toBeInTheDocument());

    // The raw error detail must NOT appear anywhere in the document.
    expect(document.body.textContent).not.toContain("abc123");
    expect(document.body.textContent).not.toContain("already consumed");
  });

  it("null session → sign-in control shown, OrgPicker not shown", async () => {
    mockSession = null;
    renderClaim("valid-token");

    // Preview loads; then the auth gate offers sign-in instead of the picker.
    const button = await waitFor(() =>
      screen.getByRole("button", { name: /Continue with musubi/i }),
    );
    expect(screen.queryByTestId("mock-org-picker")).not.toBeInTheDocument();

    button.click();
    // Sign-in is a full-page redirect; the return-to brings them back to /claim,
    // where the parked token is picked up again.
    expect(signInMock).toHaveBeenCalledWith(`${window.location.origin}/claim`);
  });

  it("parks the token in sessionStorage so it survives the sign-in redirect", async () => {
    renderClaim("round-trip-token");
    await waitFor(() => expect(screen.getByText(/Preview Co/)).toBeInTheDocument());
    expect(sessionStorage.getItem("cire.vendor.claim-token")).toBe("round-trip-token");
  });

  it("recovers the parked token when returning from sign-in with no ?token", async () => {
    sessionStorage.setItem("cire.vendor.claim-token", "parked-token");
    const seen: string[] = [];
    mockFetchClaimPreview = ((token: string) => {
      seen.push(token);
      return Promise.resolve({ directoryVendorId: "d1", name: "Preview Co" });
    }) as typeof mockFetchClaimPreview;

    history.replaceState(null, "", "/claim");
    render(() => <ClaimApp />);

    await waitFor(() => expect(screen.getByText(/Preview Co/)).toBeInTheDocument());
    expect(seen).toContain("parked-token");
  });

  it("drops the parked token when the claim is rejected", async () => {
    // A spent or rejected token must not stay parked — a reload would replay it.
    mockConsumeClaim = () => Promise.reject(new Error("spent"));
    renderClaim("spend-me");
    await waitFor(() => expect(screen.getByTestId("mock-org-picker")).toBeInTheDocument());

    screen.getByTestId("mock-org-picker").click();

    await waitFor(() => expect(sessionStorage.getItem("cire.vendor.claim-token")).toBeNull());
  });
});
