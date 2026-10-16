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
    logout: () => Promise.resolve(),
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
  it("carries the shell search field, and no redundant Search nav link", () => {
    const result = renderSidebar();
    expect(result.getByRole("combobox")).toBeDefined();
    // Search is a mobile-only tab: on desktop the rail's own field is the
    // surface, so a nav link pointing at /search would be a second door.
    expect(result.queryByText("Search")).toBeNull();
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
    // No search field without a session: /recommendations/search is
    // authenticated, so an input that could only 401 is worse than no input.
    expect(result.queryByRole("combobox")).toBeNull();
  });
});
