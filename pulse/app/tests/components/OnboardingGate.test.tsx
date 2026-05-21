import { createMemoryHistory, MemoryRouter, Route, useLocation } from "@solidjs/router";
// @vitest-environment happy-dom
import { cleanup, render as _baseRender, waitFor } from "@solidjs/testing-library";
import { createEffect } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — useAuth + lib/onboarding (the gate's only direct dependencies)
// ---------------------------------------------------------------------------

let mockSession: () => { accessToken: string } | null = () => ({ accessToken: "tok" });
vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ session: () => mockSession() }),
}));

const mockFetchStatus = vi.fn();
const mockIsSkipped = vi.fn(() => false);
vi.mock("../../src/lib/onboarding", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/onboarding")>(
    "../../src/lib/onboarding",
  );
  return {
    ...actual,
    fetchOnboardingStatus: (...a: unknown[]) => mockFetchStatus(...a),
    isOnboardingResolvedThisSession: (...a: unknown[]) => mockIsSkipped(...a),
  };
});

import { OnboardingGate } from "../../src/components/OnboardingGate";

// ---------------------------------------------------------------------------
// Probe — captures the current pathname into a module-scoped variable so
// tests can assert post-redirect behaviour without driving a full app.
// ---------------------------------------------------------------------------

let lastPathname = "";
function PathProbe() {
  const location = useLocation();
  // Use createEffect rather than reading in the render body — the effect
  // explicitly subscribes to `location.pathname` and runs every time it
  // changes, which is what we need to observe redirects driven by the
  // gate. Render-body reads can drop the subscription when nothing in
  // the tree visually depends on the value.
  createEffect(() => {
    lastPathname = location.pathname;
  });
  return null;
}

// Mount the gate in the router root so it stays mounted across route
// changes — mirrors how `App.tsx` wires it inside `Layout`. If we put the
// gate inside a Route's component, navigating would unmount + remount it
// and obscure source-signal-driven re-fetches.
function RouterRoot(props: { children?: unknown }) {
  return (
    <>
      <OnboardingGate />
      <PathProbe />
      {props.children}
    </>
  );
}

const mountWithHistory = (history: ReturnType<typeof createMemoryHistory>) =>
  _baseRender(() => (
    <MemoryRouter history={history} root={RouterRoot}>
      <Route path="*" component={() => null} />
    </MemoryRouter>
  ));

const renderAt = (initialPath: string) => {
  const history = createMemoryHistory();
  history.set({ value: initialPath, replace: true });
  return mountWithHistory(history);
};

describe("OnboardingGate", () => {
  beforeEach(() => {
    mockSession = () => ({ accessToken: "tok" });
    mockFetchStatus.mockReset();
    mockIsSkipped.mockReset();
    mockIsSkipped.mockReturnValue(false);
    lastPathname = "";
  });

  afterEach(() => {
    cleanup();
  });

  it("does not fetch and does not navigate when there is no session", async () => {
    mockSession = () => null;
    renderAt("/");
    // Give the resource a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetchStatus).not.toHaveBeenCalled();
    expect(lastPathname).toBe("/");
  });

  it("does NOT redirect when already on /welcome even if onboarding incomplete (avoids loop)", async () => {
    mockFetchStatus.mockResolvedValue({
      completedAt: null,
      interests: [],
      notificationsOptIn: false,
      eventRemindersOptIn: false,
      notificationsPerm: "prompt",
      locationPerm: "prompt",
    });
    renderAt("/welcome");
    // The gate fetches (the source signal is the token, not the path —
    // see P-W1 fix in OnboardingGate.tsx) but the redirect effect
    // short-circuits because we're already at the destination.
    await waitFor(() => expect(mockFetchStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPathname).toBe("/welcome");
  });

  it("fetches at most once per session even when the user navigates between routes (P-W1)", async () => {
    mockFetchStatus.mockResolvedValue({
      completedAt: new Date().toISOString(),
      interests: [],
      notificationsOptIn: false,
      eventRemindersOptIn: false,
      notificationsPerm: "granted",
      locationPerm: "granted",
    });
    const history = createMemoryHistory();
    history.set({ value: "/", replace: true });
    mountWithHistory(history);
    await waitFor(() => expect(mockFetchStatus).toHaveBeenCalledTimes(1));
    history.set({ value: "/welcome" });
    await new Promise((r) => setTimeout(r, 20));
    history.set({ value: "/" });
    await new Promise((r) => setTimeout(r, 20));
    // Token didn't change, so the resource source value didn't change,
    // so the fetcher must not have re-run. This is the regression guard
    // for the P-W1 fix in OnboardingGate.tsx — historically the source
    // included `pathname`, which made the resource re-fetch every time
    // the user toggled between `/welcome` and another route.
    expect(mockFetchStatus).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when the session-skip flag is set", async () => {
    mockIsSkipped.mockReturnValue(true);
    renderAt("/");
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetchStatus).not.toHaveBeenCalled();
    expect(lastPathname).toBe("/");
  });

  it("redirects to /welcome when on a non-welcome path and onboarding is incomplete", async () => {
    mockFetchStatus.mockResolvedValue({
      completedAt: null,
      interests: [],
      notificationsOptIn: false,
      eventRemindersOptIn: false,
      notificationsPerm: "prompt",
      locationPerm: "prompt",
    });
    renderAt("/");
    await waitFor(() => expect(mockFetchStatus).toHaveBeenCalled());
    await waitFor(() => expect(lastPathname).toBe("/welcome"));
  });

  it("does NOT redirect when onboarding is already complete", async () => {
    mockFetchStatus.mockResolvedValue({
      completedAt: new Date().toISOString(),
      interests: ["music"],
      notificationsOptIn: true,
      eventRemindersOptIn: true,
      notificationsPerm: "granted",
      locationPerm: "granted",
    });
    renderAt("/");
    await waitFor(() => expect(mockFetchStatus).toHaveBeenCalled());
    // Give the redirect effect a chance to fire if it were going to.
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPathname).toBe("/");
  });

  it("does NOT redirect when fetch returns null (auth or transport error)", async () => {
    mockFetchStatus.mockResolvedValue(null);
    renderAt("/");
    await waitFor(() => expect(mockFetchStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPathname).toBe("/");
  });
});
