// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { MobileTopBar } from "../../src/components/MobileTopBar";

/** Mocked AuthContext resource helper — same fixture shape as Sidebar.test.tsx. */
function resource<T>(value: T) {
  return Object.assign(() => value, {
    state: "ready",
    loading: false,
    error: undefined,
    latest: null,
    refetch: () => {},
    mutate: () => {},
  });
}

const profile = {
  id: "usr_1",
  handle: "alice",
  displayName: "Alice",
  email: "a@b.com",
  avatarUrl: null,
};

function signedInAuth() {
  const authValue = {
    session: resource({
      accessToken: "tkn",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    }),
    profiles: resource([profile]),
    activeProfileId: () => "usr_1",
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => Promise.resolve({ session: null, profile }),
    createProfile: () => Promise.resolve(profile),
    deleteProfile: () => Promise.resolve(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required
  return authValue as any;
}

function signedOutAuth() {
  const authValue = {
    session: resource(null),
    profiles: resource(null),
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
  return authValue as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext value
function renderTopBar(value: any) {
  return render(() => (
    <AuthContext.Provider value={value}>
      <MemoryRouter>
        <Route path="*" component={MobileTopBar} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

afterEach(() => {
  cleanup();
});

describe("<MobileTopBar /> — authenticated", () => {
  it("renders the avatar account-menu trigger with the profile initials", () => {
    const result = renderTopBar(signedInAuth());
    // The trigger shows only the avatar (initials for a null avatarUrl); the
    // full open-and-click interaction is not asserted (Kobalte pointer capture
    // is not reproduced by happy-dom — same caveat as Sidebar.test.tsx).
    const trigger = result
      .getAllByRole("button", { expanded: false })
      .find((b) => b.textContent?.includes("AL"));
    expect(trigger).toBeDefined();
    // No signed-out CTAs while a session exists.
    expect(result.queryByText("Sign in")).toBeNull();
    expect(result.queryByText("Create account")).toBeNull();
  });
});

describe("<MobileTopBar /> — unauthenticated", () => {
  it("shows the Sign in and Create account CTAs", () => {
    const result = renderTopBar(signedOutAuth());
    expect(result.getByText("Sign in")).toBeDefined();
    expect(result.getByText("Create account")).toBeDefined();
  });
});

describe("<MobileTopBar /> — mobile shell contract", () => {
  it("is hidden at md and up", () => {
    const result = renderTopBar(signedOutAuth());
    const header = result.container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header!.className).toContain("md:hidden");
  });
});
