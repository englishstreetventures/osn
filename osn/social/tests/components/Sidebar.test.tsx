// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { Sidebar } from "../../src/components/Sidebar";

/**
 * Mount <Sidebar /> inside a MemoryRouter + a mocked AuthContext with a
 * signed-in session, so the avatar dropdown renders (rather than the
 * "Create account / Sign in" fallback).
 */
function renderSidebar() {
  const authValue = {
    session: Object.assign(
      () => ({
        accessToken: "tkn",
        idToken: null,
        expiresAt: Date.now() + 60_000,
        scopes: [],
      }),
      {
        state: "ready",
        loading: false,
        error: undefined,
        latest: null,
        refetch: () => {},
        mutate: () => {},
      },
    ),
    profiles: Object.assign(
      () => [
        {
          id: "usr_1",
          handle: "alice",
          displayName: "Alice",
          email: "a@b.com",
          avatarUrl: null,
        },
      ],
      {
        state: "ready",
        loading: false,
        error: undefined,
        latest: null,
        refetch: () => {},
        mutate: () => {},
      },
    ),
    activeProfileId: () => "usr_1",
    login: () => undefined,
    logout: () => Promise.resolve(),
    handleCallback: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () =>
      Promise.resolve({
        session: {
          accessToken: "t",
          idToken: null,
          expiresAt: 0,
          scopes: [],
        },
        profile: {
          id: "usr_1",
          handle: "alice",
          displayName: "Alice",
          email: "a@b.com",
          avatarUrl: null,
        },
      }),
    createProfile: () =>
      Promise.resolve({
        id: "usr_1",
        handle: "alice",
        displayName: "Alice",
        email: "a@b.com",
        avatarUrl: null,
      }),
    deleteProfile: () => Promise.resolve(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required for this test
  const value = authValue as any;

  return render(() => (
    <AuthContext.Provider value={value}>
      <MemoryRouter>
        <Route path="*" component={Sidebar} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

afterEach(() => {
  cleanup();
});

describe("<Sidebar /> — authenticated avatar menu", () => {
  it("renders the avatar dropdown trigger without throwing", () => {
    // Sanity-mount the authenticated sidebar end-to-end (AuthContext +
    // MemoryRouter + Kobalte dropdown). Validates that the auth
    // integration and nav scaffolding don't regress at render time. The
    // full open-and-click interaction is not asserted here — Kobalte's
    // trigger relies on pointer-capture semantics that happy-dom does
    // not reproduce faithfully.
    const result = renderSidebar();
    const trigger = result.getByRole("button", { expanded: false });
    expect(trigger).toBeDefined();
    // The active profile's display name is rendered inside the trigger.
    expect(trigger.textContent).toContain("Alice");
  });

  it("renders the four primary nav links", () => {
    const result = renderSidebar();
    expect(result.getByText("Connections")).toBeDefined();
    expect(result.getByText("Discover")).toBeDefined();
    expect(result.getByText("Organisations")).toBeDefined();
    expect(result.getByText("Settings")).toBeDefined();
  });
});

describe("<Sidebar /> — unauthenticated", () => {
  it("shows Create account and Sign in buttons when no session", () => {
    const authValue = {
      session: Object.assign(() => null, {
        state: "ready",
        loading: false,
        error: undefined,
        latest: null,
        refetch: () => {},
        mutate: () => {},
      }),
      profiles: Object.assign(() => null, {
        state: "ready",
        loading: false,
        error: undefined,
        latest: null,
        refetch: () => {},
        mutate: () => {},
      }),
      activeProfileId: () => null,
      login: () => undefined,
      logout: () => Promise.resolve(),
      handleCallback: () => Promise.resolve(),
      adoptSession: () => Promise.resolve(),
      switchProfile: () => Promise.reject(new Error("no session")),
      createProfile: () => Promise.reject(new Error("no session")),
      deleteProfile: () => Promise.resolve(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    const value = authValue as any;

    const result = render(() => (
      <AuthContext.Provider value={value}>
        <MemoryRouter>
          <Route path="*" component={Sidebar} />
        </MemoryRouter>
      </AuthContext.Provider>
    ));

    expect(result.getByText("Create account")).toBeDefined();
    expect(result.getByText("Sign in")).toBeDefined();
  });
});
