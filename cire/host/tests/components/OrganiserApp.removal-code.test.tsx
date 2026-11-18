// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The code Musubi sends a person back with never reaches a sign-in bounce.
 * When their Cire session ended while they were on Musubi, the portal sends
 * them to sign in with the address they were on as `returnTo`, which reaches
 * cire-api's request line and the tab's history. The code is kept in the tab
 * and taken out of the address first, so `returnTo` is `/#/remove-data`.
 */

const redirected = vi.hoisted(() => [] as string[]);

vi.mock("@shared/rp-auth/solid", async () => {
  const { createContext, useContext } = await import("solid-js");
  const signedOut = {
    authFetch: () => new Promise<Response>(() => {}),
    logout: async () => {},
    session: () => null,
  };
  const AuthContext = createContext<typeof signedOut>();
  return {
    AuthContext,
    AuthProvider: (props: { children: unknown }) => props.children,
    useAuth: () => useContext(AuthContext) ?? signedOut,
  };
});
vi.mock("@shared/toast", () => ({ Toaster: () => null, toast: {} }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  // What the real redirect puts in `returnTo`: the address as it stands.
  redirectToLogin: () =>
    redirected.push(window.location.pathname + window.location.search + window.location.hash),
}));

import OrganiserApp from "../../src/components/OrganiserApp";
import { forgetRemoval, keptCode } from "../../src/lib/account-removal";

beforeEach(() => {
  redirected.length = 0;
  forgetRemoval();
});

afterEach(() => {
  cleanup();
  forgetRemoval();
  history.replaceState(null, "", "/");
});

describe("OrganiserApp, back from Musubi with the session ended", () => {
  it("keeps the code and sends no code to sign-in", () => {
    history.replaceState(null, "", "/#/remove-data?code=Zx9_confirmed_code");
    render(() => <OrganiserApp />);

    expect(redirected).toHaveLength(1);
    expect(redirected[0]).toBe("/#/remove-data");
    expect(redirected[0]).not.toContain("code=");
    expect(window.location.hash).toBe("#/remove-data");
    expect(keptCode()).toBe("Zx9_confirmed_code");
  });
});
