// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─── Mutable mock state ────────────────────────────────────────────────────
// Each test can overwrite these before render; factories read them at call
// time so tests are fully isolated.

let mockSession: { profile: { id: string } } | null = { profile: { id: "p1" } };
let mockFetchClaimPreview: () => Promise<{ directoryVendorId: string; name: string } | null> = () =>
  Promise.resolve({ directoryVendorId: "d1", name: "Preview Co" });
let mockConsumeClaim: () => Promise<void> = () => Promise.resolve();

// ─── Module mocks ──────────────────────────────────────────────────────────

vi.mock("@osn/client/solid", () => ({
  AuthProvider: (props: { children: JSX.Element }) => props.children,
  useAuth: () => ({
    session: () => mockSession,
    authFetch: vi.fn(),
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

// Mock SignIn so we don't pull in WebAuthn / WASM in tests.
vi.mock("@osn/ui/auth", () => ({
  SignIn: () => <div data-testid="sign-in-widget">Sign in</div>,
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
  // Reset mutable state to defaults for the next test.
  mockSession = { profile: { id: "p1" } };
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

  it("null session → sign-in widget shown, OrgPicker not shown", async () => {
    mockSession = null;
    renderClaim("valid-token");

    // Preview loads; then the auth gate shows sign-in instead of OrgPicker.
    await waitFor(() => expect(screen.getByTestId("sign-in-widget")).toBeInTheDocument());

    expect(screen.queryByTestId("mock-org-picker")).not.toBeInTheDocument();
  });
});
