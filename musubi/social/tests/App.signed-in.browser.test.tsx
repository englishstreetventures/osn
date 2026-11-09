import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../src/App.css";

/**
 * The profile switcher, signed in, in a real browser: `Layout` with a session
 * and two profiles.
 *
 * The switcher is one of the shell dialogs mounted once above the 768px
 * switch, opened from the account menu in either shell. Whether it stays open
 * across a crossing, and where focus lands when it closes, take a real
 * viewport and Kobalte's focus scope.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/` does not resolve in the browser project.
 */

vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  const profiles = [
    { id: "usr_alice", handle: "alice", displayName: "Alice", avatarUrl: null },
    { id: "usr_alice_work", handle: "alice_work", displayName: null, avatarUrl: null },
  ];
  const signedIn = {
    session: resource({ accessToken: "not-a-jwt", expiresAt: Date.now() + 300_000 }),
    profiles: resource(profiles),
    activeProfileId: () => "usr_alice",
    login: () => undefined,
    logout: () => Promise.resolve(),
    handleCallback: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => new Promise(() => {}),
    createProfile: () => Promise.reject(new Error("not in this test")),
    deleteProfile: () => Promise.resolve(),
  };
  return {
    ...actual,
    // The real provider bootstraps a session over the network.
    AuthProvider: (props: { children?: unknown }) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required
      <actual.AuthContext.Provider value={signedIn as any}>
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
// The banners fetch account state; this file tests the shell's dialogs.
vi.mock("../src/components/AccountBanners", () => ({ AccountBanners: () => null }));
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

function renderApp() {
  return render(() => (
    <MemoryRouter root={Layout}>
      <Route
        path="/"
        component={() => (
          <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
            <h1 class="text-foreground text-display font-medium">Discover</h1>
          </main>
        )}
      />
    </MemoryRouter>
  ));
}

/**
 * How long a shell may take to arrive. Signed in, the rail's chunk reaches the
 * search and its result rows as well, and the dev server compiles every module
 * on first request, so a cold run on CI takes more than `waitFor`'s second.
 */
const SHELL_LOAD = { timeout: 10_000 };

/** The account-menu trigger in the rail (`aside`) or the top bar (`header`). */
const accountTrigger = (shell: "aside" | "header") =>
  document.querySelector<HTMLElement>(`${shell} [data-dialog-return="switcher"]`);
const dialogs = () => screen.queryAllByRole("dialog", { hidden: true });

beforeAll(() => {
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("the profile switcher", () => {
  it("opens from the account menu, stays open across 768px, and gives focus back to the shell's trigger", async () => {
    await page.viewport(1440, 900);
    renderApp();
    await waitFor(() => expect(accountTrigger("aside")).not.toBeNull(), SHELL_LOAD);

    await userEvent.click(accountTrigger("aside")!);
    await userEvent.click(
      await waitFor(() => screen.getByRole("menuitem", { name: "Switch profile" })),
    );

    const switcher = await waitFor(() => screen.getByRole("dialog", { name: "Switch profile" }));
    expect(dialogs()).toHaveLength(1);
    const rows = within(switcher).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("@alice(Alice)"),
      expect.stringContaining("@alice_work"),
    ]);
    // The active profile says so in words, not only in its fill and tick.
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(switcher.offsetWidth).toBe(320);
    await page.screenshot({ path: `${SHOTS}/switcher-1440.png` });

    await page.viewport(390, 844);
    await waitFor(() => expect(accountTrigger("header")).not.toBeNull(), SHELL_LOAD);
    expect(dialogs()).toHaveLength(1);
    const sheet = screen.getByRole("dialog", { name: "Switch profile" });
    expect(within(sheet).getAllByRole("button")).toHaveLength(2);
    expect(sheet.offsetWidth).toBe(390);
    document.documentElement.classList.add("dark");
    await page.screenshot({ path: `${SHOTS}/switcher-390-dark.png` });

    // Opened from the rail's trigger, which has gone: the top bar's takes focus.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialogs()).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(accountTrigger("header")));
  }, 30_000);
});
