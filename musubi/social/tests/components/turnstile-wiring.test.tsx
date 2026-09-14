// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the musubi.social login break.
 *
 * osn-api holds `TURNSTILE_SECRET_KEY`, so `/register/begin` and the
 * identifier-bound `/login/passkey/begin` fail closed (`400 turnstile_failed`)
 * unless the caller sends a token. The token only exists if the app renders the
 * widget, and the widget only renders if a sitekey is threaded into `SignIn` /
 * `Register`. Until 2026-07-27 the only surface running those ceremonies was
 * cire/organiser (whose Astro build did read the sitekey); the musubi.social
 * move and the organiser's OIDC swap relocated them here, where nothing passed
 * the prop — so every typed-identifier sign-in on musubi.social 400'd.
 *
 * These tests assert the prop actually arrives at each of the three ceremony
 * call sites, which is the part that silently went missing.
 *
 * `productName` is asserted here for the same reason: a required prop a mock's
 * type doesn't mention compiles and passes silently at every call site, and
 * nothing type-checks this directory (`tsconfig.json` `include` is `["src"]`).
 * `captured` records both props so a dropped one fails rather than vanishes.
 */

const SITEKEY = "0x4AAAAAAAtestsitekey";
const PRODUCT_NAME = "Musubi";

interface Captured {
  turnstileSiteKey?: string;
  productName: string;
}

const captured = vi.hoisted(() => ({
  signIn: [] as Captured[],
  register: [] as Captured[],
}));

// `src/lib/auth.ts` reads import.meta.env at module-evaluation time, so the stub
// has to land before this file's static imports pull it in — hence `vi.hoisted`
// rather than `beforeEach`. Using one shared module registry (no resetModules)
// keeps the components, the router and Solid itself on the same instances.
vi.hoisted(() => {
  vi.stubEnv("VITE_TURNSTILE_SITEKEY", "0x4AAAAAAAtestsitekey");
});

// Stand-ins for the real ceremonies: they only record the props they were
// handed, so no WebAuthn feature-detection or Turnstile script load is involved.
vi.mock("@osn/ui/auth/SignIn", () => ({
  SignIn: (props: { turnstileSiteKey?: string; productName: string }) => {
    captured.signIn.push({
      turnstileSiteKey: props.turnstileSiteKey,
      productName: props.productName,
    });
    return <div data-testid="signin" />;
  },
}));
vi.mock("@osn/ui/auth/Register", () => ({
  Register: (props: { turnstileSiteKey?: string; productName: string }) => {
    captured.register.push({
      turnstileSiteKey: props.turnstileSiteKey,
      productName: props.productName,
    });
    return <div data-testid="register" />;
  },
}));
// `AuthorizeSignIn` wraps `SignIn` in a provider that bootstraps a session
// (POST /token) on mount — irrelevant here, and it would hit the network.
vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => props.children,
  };
});
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
}));

import { AuthorizeSignIn } from "../../src/components/AuthorizeSignIn";
import { Sidebar } from "../../src/components/Sidebar";
import { TURNSTILE_SITEKEY } from "../../src/lib/auth";

/** A signed-out AuthContext — the state in which the auth dialogs render. */
function signedOutAuth() {
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: null,
      refetch: () => {},
      mutate: () => {},
    });
  return {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required
  } as any;
}

beforeEach(() => {
  captured.signIn.length = 0;
  captured.register.length = 0;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("TURNSTILE_SITEKEY", () => {
  it("exposes the configured sitekey", () => {
    expect(TURNSTILE_SITEKEY).toBe(SITEKEY);
  });

  it.each([
    ["", "unset variable"],
    ["   ", "whitespace-only variable"],
  ])("normalises a blank sitekey (%j, %s) to undefined", async (blank) => {
    // An unset GitHub Actions variable expands to "", not to nothing — so the
    // blank case must collapse to `undefined` rather than reach the widget as a
    // truthy-looking empty string. Re-imported in isolation: this is the only
    // test that needs a different build-time env, and `src/lib/auth.ts` pulls in
    // no Solid context, so a private registry copy is harmless here.
    vi.resetModules();
    vi.stubEnv("VITE_TURNSTILE_SITEKEY", blank);
    const fresh = await import("../../src/lib/auth");
    expect(fresh.TURNSTILE_SITEKEY).toBeUndefined();
    vi.stubEnv("VITE_TURNSTILE_SITEKEY", SITEKEY);
  });
});

describe("Turnstile sitekey and product name reach every ceremony call site", () => {
  it("passes both to <SignIn /> on the consent screen (default, sign-in mode)", () => {
    render(() => <AuthorizeSignIn onSuccess={() => {}} />);
    expect(captured.signIn).toEqual([{ turnstileSiteKey: SITEKEY, productName: PRODUCT_NAME }]);
  });

  // AuthorizeSignIn.tsx's register-mode <Register> is its own call site, and
  // this is the only test that renders the consent screen with
  // `initialMode="register"`.
  it("passes both to <Register /> on the consent screen (register mode)", () => {
    render(() => <AuthorizeSignIn initialMode="register" onSuccess={() => {}} />);
    expect(captured.register).toEqual([{ turnstileSiteKey: SITEKEY, productName: PRODUCT_NAME }]);
  });

  it("passes both to the sidebar's <SignIn /> and <Register /> dialogs", async () => {
    const result = render(() => (
      <AuthContext.Provider value={signedOutAuth()}>
        <MemoryRouter>
          <Route path="*" component={Sidebar} />
        </MemoryRouter>
      </AuthContext.Provider>
    ));

    fireEvent.click(result.getByText("Sign in"));
    await waitFor(() => expect(captured.signIn.length).toBeGreaterThan(0));
    expect(
      captured.signIn.every(
        (c) => c.turnstileSiteKey === SITEKEY && c.productName === PRODUCT_NAME,
      ),
    ).toBe(true);

    fireEvent.click(result.getByText("Create account"));
    await waitFor(() => expect(captured.register.length).toBeGreaterThan(0));
    expect(
      captured.register.every(
        (c) => c.turnstileSiteKey === SITEKEY && c.productName === PRODUCT_NAME,
      ),
    ).toBe(true);
  });
});
