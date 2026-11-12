import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * `/authorize`'s sign-in panel holds its place while its code loads, in a real
 * browser: the frame around it is as tall with the placeholder in it as with
 * the panel that replaces it, for the half that leads, so the client card
 * above it does not move when the panel lands (`DESIGN.md` §Empty states and
 * failed loads). The panel's code is held by a wrapper that suspends on its own
 * read until the test lets it go; the panel itself is the real one. Each case
 * shoots the page before and after the panel lands, into
 * `e2e-artifacts/musubi-loading/`.
 */

const chunk = vi.hoisted(() => {
  let release: ((value: boolean) => void) | undefined;
  return {
    hold(): Promise<boolean> {
      return new Promise<boolean>((resolve) => (release = resolve));
    },
    held(): boolean {
      return release !== undefined;
    },
    release(): void {
      if (!release) throw new Error("the panel's code is not held");
      release(true);
      release = undefined;
    },
    clear(): void {
      release = undefined;
    },
  };
});

vi.mock("../../src/lib/authorize", () => ({
  authorizeClient: {
    getContext: () =>
      Promise.resolve({
        client: { clientId: "cli_abc", name: "Cire", logoUrl: null, firstParty: false },
        scopes: ["openid", "profile", "email"],
        signedIn: false,
        profiles: [],
        linkedProfileId: null,
      }),
    submitDecision: () => new Promise(() => {}),
  },
}));
vi.mock("../../src/lib/auth", () => ({
  osnAuth: {},
  PRODUCT_NAME: "Musubi",
  TURNSTILE_SITEKEY: undefined,
}));
// The panel's provider bootstraps a session over the network; the page's own
// context below stands in for it.
vi.mock("@osn/client/solid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@osn/client/solid")>()),
  AuthProvider: (props: { children: unknown }) => props.children,
}));
vi.mock("../../src/lib/authClients", () => ({
  // Sign-in starts the autofill ceremony on mount; it waits here for ever.
  loginClient: { passkeyBegin: () => new Promise(() => {}) },
  recoveryClient: {},
  registrationClient: { checkHandle: () => Promise.resolve({ available: true }) },
}));
vi.mock("../../src/lib/webauthn-registration-deferred", () => ({
  runPasskeyRegistrationDeferred: () => {},
}));
vi.mock("../../src/components/AuthorizeSignIn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/components/AuthorizeSignIn")>();
  const { createResource, Show } = await import("solid-js");
  return {
    AuthorizeSignIn: (props: Parameters<typeof actual.AuthorizeSignIn>[0]) => {
      const [arrived] = createResource(() => chunk.hold());
      return (
        <Show when={arrived()}>
          <actual.AuthorizeSignIn {...props} />
        </Show>
      );
    },
  };
});

import { AuthorizePage } from "../../src/pages/AuthorizePage";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-loading";

function authValue() {
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
    session: resource(null),
    profiles: resource([]),
    activeProfileId: () => null,
    adoptSession: () => Promise.resolve(),
  };
}

function renderPage(search: string) {
  const history = createMemoryHistory();
  history.set({ value: `/authorize${search}` });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/authorize" component={AuthorizePage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

beforeEach(() => chunk.clear());

afterEach(() => {
  cleanup();
  chunk.clear();
});

describe.each([320, 390, 1440])("the sign-in panel's placeholder at %ipx", (width) => {
  beforeEach(async () => {
    await page.viewport(width, 2400);
  });

  it.each([
    ["", "Sign in to Musubi"],
    ["&reason=create", "Create your Musubi account"],
  ])("holds the frame's height for request%s", async (reason, heading) => {
    renderPage(`?request=oar_0123456789ab${reason}`);
    const placeholder = await waitFor(() => {
      const busy = document.querySelectorAll<HTMLElement>("[aria-busy]");
      expect(busy).toHaveLength(1);
      expect(busy[0]!.querySelector('[aria-hidden="true"]')).not.toBeNull();
      return busy[0]!;
    });
    const frame = placeholder.parentElement!;
    const held = frame.getBoundingClientRect().height;
    const shot = `${SHOTS}/authorize-${reason ? "create" : "signin"}-${width}`;
    await page.screenshot({ path: `${shot}-loading.png` });
    await waitFor(() => expect(chunk.held()).toBe(true));
    chunk.release();
    // The placeholder draws the heading's words too, so wait for it to go.
    await waitFor(() => expect(placeholder.isConnected).toBe(false));
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(document.querySelector("[aria-busy]")).toBeNull();
    expect(frame.getBoundingClientRect().height).toBeCloseTo(held, 0);
    await page.screenshot({ path: `${shot}-panel.png` });
  });
});
