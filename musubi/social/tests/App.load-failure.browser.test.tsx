import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../src/App.css";

/**
 * The desktop rail's chunk fails to load — offline, or a stale chunk name
 * after a deploy. The frame that held the rail's place stays, says the app
 * could not finish loading, and the page beside it still renders: the
 * rejection is handled, so nothing blanks the app.
 *
 * The rail's module request is failed at the network, so the dynamic import
 * rejects the way a missing chunk does. Its own file because a page keeps a
 * failed module for good, and the other shell tests need the rail to load.
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

beforeAll(async () => {
  await commands.failRequests("/src/components/Sidebar.tsx");
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await commands.restoreRequests();
});

it("keeps the rail's frame and the page, and says to reload, when the rail fails to load", async () => {
  await page.viewport(1440, 900);
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
  expect(alert.closest("aside")!.getBoundingClientRect().width).toBe(240);
  expect(screen.getByRole("heading", { name: "Discover" })).toBeDefined();
  expect(document.querySelector("main")!.getBoundingClientRect().left).toBe(504);
  await page.screenshot({ path: "../../../e2e-artifacts/musubi-shell/rail-failed-1440.png" });
});
