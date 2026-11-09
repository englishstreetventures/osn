import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../src/App.css";

/**
 * The phone shell's chunk fails to load. The top bar's frame stays, with the
 * failed-load line inside its 48px row, and the page below it neither moves
 * nor goes blank. At 320px the line wraps to two lines and must still sit
 * inside the bar, above its hairline.
 *
 * Its own file because a page keeps a failed module for the rest of the file.
 */

vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: null,
      refetch: () => {},
      mutate: () => {},
    });
  const signedOut = {
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
    profilesError: () => undefined,
    refetchProfiles: () => Promise.resolve(),
  };
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required
      <actual.AuthContext.Provider value={signedOut as any}>
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
vi.mock("../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
}));

import { Layout } from "../src/App";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../e2e-artifacts/musubi-shell";

beforeAll(async () => {
  await commands.failRequests("/src/components/MobileChrome.tsx");
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await commands.restoreRequests();
});

describe("the phone shell fails to load", () => {
  it.each([
    [390, 844],
    [320, 640],
  ])(
    "keeps the top bar's frame and the page at %ipx, and says to reload",
    async (width, height) => {
      await page.viewport(width, height);
      render(() => (
        <MemoryRouter root={Layout}>
          <Route
            path="/"
            component={() => (
              <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
                <h1>Discover</h1>
              </main>
            )}
          />
        </MemoryRouter>
      ));

      const alert = await waitFor(() => screen.getByRole("alert"));
      expect(alert.textContent).toBe("Musubi could not finish loading. Reload and try again.");
      const header = alert.closest("header")!;
      expect(header, "the line sits in the top bar").not.toBeNull();
      const bar = header.getBoundingClientRect();
      expect(alert.getBoundingClientRect().bottom).toBeLessThanOrEqual(bar.bottom);
      expect(alert.getBoundingClientRect().right).toBeLessThanOrEqual(bar.right);
      expect(screen.getByRole("heading", { name: "Discover" })).toBeDefined();
      expect(document.querySelector("main")!.getBoundingClientRect().top).toBe(bar.bottom);
      await page.screenshot({ path: `${SHOTS}/topbar-failed-${width}.png` });
    },
  );
});
