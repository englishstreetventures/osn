// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which tab Settings opens on is decided by the URL fragment, and the router's
 * location is the only thing that reads it.
 *
 * The case that forced this: a link elsewhere in the app to
 * `/settings#security` — the recovery-code prompt's — fired while Settings was
 * already open. The page used to track the fragment with a `hashchange`
 * listener, and neither `pushState` nor `replaceState` fires that event, so
 * the address bar changed and the tab did not. The last test here is that
 * link; the rest are the paths that already worked and must keep working.
 */

vi.mock("@osn/auth-ui/ProfileOnboarding", () => ({ ProfileOnboarding: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  registrationClient: { checkHandle: vi.fn() },
}));
vi.mock("../../src/components/SecuritySection", () => ({
  default: () => <div data-testid="security-section" />,
}));
vi.mock("../../src/components/ConnectedAppsSection", () => ({
  ConnectedAppsSection: () => <div data-testid="apps-section" />,
}));

import { SettingsPage } from "../../src/pages/SettingsPage";

/** An unsigned access token carrying the `sub` claim the page reads. */
const ACCESS_TOKEN = `header.${btoa(JSON.stringify({ sub: "prof_1" }))}.signature`;

/** A signed-in `AuthContext`, enough for the page to render its tabs. */
function authValue() {
  const session = { accessToken: ACCESS_TOKEN, idToken: null, expiresAt: 0, scopes: [] };
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  return {
    session: resource(session),
    profiles: resource([]),
    activeProfileId: () => null,
  };
}

function renderSettings(initialPath: string) {
  const history = createMemoryHistory();
  history.set({ value: initialPath });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/settings" component={SettingsPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
  return history;
}

afterEach(() => cleanup());

describe("<SettingsPage /> tabs", () => {
  it("opens Profile when the URL names no tab", () => {
    renderSettings("/settings");
    expect(screen.getByText("Handles cannot be changed.")).toBeTruthy();
    expect(screen.queryByTestId("security-section")).toBeNull();
  });

  it("opens the tab a deep link names", async () => {
    // The cire organiser portal links straight here, because passkeys are
    // bound to this origin and can only be managed on it.
    renderSettings("/settings#security");
    expect(await screen.findByTestId("security-section")).toBeTruthy();
  });

  it("falls back to Profile for a fragment that names no tab", () => {
    renderSettings("/settings#nonsense");
    expect(screen.getByText("Handles cannot be changed.")).toBeTruthy();
  });

  it("switches tab on a click, and writes the fragment", async () => {
    const history = renderSettings("/settings");
    screen.getByRole("button", { name: "Security" }).click();

    expect(await screen.findByTestId("security-section")).toBeTruthy();
    expect(history.get()).toContain("#security");
  });

  it("switches tab when a link lands on /settings#security while Settings is open", async () => {
    const history = renderSettings("/settings#profile");
    expect(screen.getByText("Handles cannot be changed.")).toBeTruthy();

    // Exactly what the recovery-code prompt's link does: same route, new
    // fragment, no remount.
    history.set({ value: "/settings#security" });

    expect(await screen.findByTestId("security-section")).toBeTruthy();
  });
});
