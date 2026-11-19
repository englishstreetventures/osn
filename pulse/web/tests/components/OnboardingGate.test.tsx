import { createMemoryHistory, MemoryRouter, Route, useLocation } from "@solidjs/router";
// @vitest-environment happy-dom
import { cleanup, render as _baseRender } from "@solidjs/testing-library";
import { createEffect } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// ---------------------------------------------------------------------------
// Mocks — useAuth + lib/onboarding (the gate's only direct dependencies)
// ---------------------------------------------------------------------------

import { authState, fakeSession } from "../helpers/auth";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../helpers/auth");
  return rpAuthSolidMock();
});

const mockFetchStatus = vi.fn();
const mockIsSkipped = vi.fn((..._a: unknown[]) => false);
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

/**
 * Runs every timer and promise callback due in the next `ms` of fake time, so
 * a "does not" check reads the gate after it has had its chance to act. The
 * calling test turns fake timers on before it mounts.
 */
const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/**
 * Fake time a test lets pass once the gate has called its fetch, before it
 * reads what the gate did. Each check keeps its own window after this one;
 * the two together are the margin the checks are sized for.
 */
const FETCH_SETTLE_MS = 50;

/**
 * Answers the status fetch with `status`, and returns a promise that settles
 * when the gate calls it — the signal a test waits on instead of polling the
 * mock.
 */
function answerWith(status: unknown): Promise<void> {
  const called = Promise.withResolvers<void>();
  mockFetchStatus.mockImplementation(async () => {
    called.resolve();
    return status;
  });
  return called.promise;
}

describe("OnboardingGate", () => {
  beforeEach(() => {
    authState.session = fakeSession();
    mockFetchStatus.mockReset();
    mockIsSkipped.mockReset();
    mockIsSkipped.mockReturnValue(false);
    lastPathname = "";
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not fetch and does not navigate when there is no session", async () => {
    vi.useFakeTimers();
    authState.session = null;
    renderAt("/");
    await settle(10);
    expect(mockFetchStatus).not.toHaveBeenCalled();
    expect(lastPathname).toBe("/");
  });

  it("does NOT redirect when already on /welcome even if onboarding incomplete (avoids loop)", async () => {
    vi.useFakeTimers();
    const fetched = answerWith({
      completedAt: null,
      interests: [],
      notificationsOptIn: false,
      eventRemindersOptIn: false,
      notificationsPerm: "prompt",
      locationPerm: "prompt",
    });
    renderAt("/welcome");
    // The gate's fetch resource is keyed on the token, not the path, but
    // the redirect effect short-circuits because we're already at the
    // destination.
    await fetched;
    await settle(FETCH_SETTLE_MS);
    await settle(20);
    expect(lastPathname).toBe("/welcome");
  });

  it("fetches at most once per session even when the user navigates between routes", async () => {
    vi.useFakeTimers();
    const fetched = answerWith({
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
    await fetched;
    expect(mockFetchStatus).toHaveBeenCalledTimes(1);
    await settle(FETCH_SETTLE_MS);
    history.set({ value: "/welcome" });
    await settle(20);
    history.set({ value: "/" });
    await settle(20);
    // Token didn't change, so the resource source value didn't change,
    // so the fetcher must not have re-run. The resource source must not
    // include `pathname`, or it would re-fetch every time the user
    // toggled between `/welcome` and another route.
    expect(mockFetchStatus).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when the session-skip flag is set", async () => {
    vi.useFakeTimers();
    mockIsSkipped.mockReturnValue(true);
    renderAt("/");
    await settle(10);
    expect(mockFetchStatus).not.toHaveBeenCalled();
    expect(lastPathname).toBe("/");
  });

  it("does NOT redirect when onboarding is already complete", async () => {
    vi.useFakeTimers();
    const fetched = answerWith({
      completedAt: new Date().toISOString(),
      interests: ["music"],
      notificationsOptIn: true,
      eventRemindersOptIn: true,
      notificationsPerm: "granted",
      locationPerm: "granted",
    });
    renderAt("/");
    await fetched;
    // Give the redirect effect a chance to fire if it were going to.
    await settle(FETCH_SETTLE_MS);
    await settle(20);
    expect(lastPathname).toBe("/");
  });

  it("does NOT redirect when fetch returns null (auth or transport error)", async () => {
    vi.useFakeTimers();
    const fetched = answerWith(null);
    renderAt("/");
    await fetched;
    await settle(FETCH_SETTLE_MS);
    await settle(20);
    expect(lastPathname).toBe("/");
  });
});
