import { AuthExpiredError } from "@osn/client";
import { toast } from "@shared/toast";
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../src/App.css";

/**
 * The account menu, signed in, in a real browser: `Layout` with a session and
 * two profiles. The menu is the profile switcher (DESIGN.md §Layout): each
 * profile a `menuitemradio`, the active one `aria-checked`, and choosing
 * another switches to it. A switch holds every row until it ends, however it
 * ends. Kobalte chooses a row on a real pointer's release or a key, which only
 * a real browser gives.
 *
 * The factories below are written literally: a `vi.mock` factory that imports
 * from `test-support/` does not resolve in the browser project. A plain import
 * from there, such as `shell-chunks`, does.
 */

// The switches asked for, and the one still running.
const control = vi.hoisted(() => ({
  calls: [] as string[],
  running: null as null | { land: () => void; fail: (err: unknown) => void },
}));

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
  const { createRoot, createSignal } = await import("solid-js");
  const [active, setActive] = createRoot(() => createSignal("usr_alice"));
  // As the real context does: the active profile changes once the switch lands.
  const switchProfile = (id: string) => {
    control.calls.push(id);
    return new Promise((resolve, reject) => {
      control.running = {
        land: () => {
          setActive(id);
          resolve({ session: {}, profile: profiles.find((p) => p.id === id) });
        },
        fail: reject,
      };
    });
  };
  // Only its claims are read, for display: alice's handle.
  const claims = btoa(JSON.stringify({ sub: "usr_alice", handle: "alice" }));
  const signedIn = {
    session: resource({ accessToken: `e30.${claims}.sig`, expiresAt: Date.now() + 300_000 }),
    profiles: resource(profiles),
    activeProfileId: active,
    pendingDeletion: () => false,
    login: () => undefined,
    logout: () => Promise.resolve(),
    handleCallback: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile,
    createProfile: () => Promise.reject(new Error("not in this test")),
    deleteProfile: () => Promise.resolve(),
    profilesError: () => undefined,
    refetchProfiles: () => Promise.resolve(),
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
// The banners fetch account state; this file tests the account menu.
vi.mock("../src/components/AccountBanners", () => ({ AccountBanners: () => null }));
vi.mock("../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
}));

import { Layout } from "../src/App";
import { railChunks, topBarChunks } from "./test-support/shell-chunks";

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

/** The account-menu trigger in the rail (`aside`) or the top bar (`header`). */
const accountTrigger = (shell: "aside" | "header") =>
  document.querySelector<HTMLElement>(`${shell} [data-account-menu]`);
const rows = () => screen.queryAllByRole("menuitemradio");
const checkedRows = () => rows().map((row) => row.getAttribute("aria-checked"));
const held = () => rows().map((row) => row.getAttribute("aria-disabled") === "true");

async function openMenu(shell: "aside" | "header") {
  await waitFor(() => expect(accountTrigger(shell)).not.toBeNull());
  await userEvent.click(accountTrigger(shell)!);
  await waitFor(() => expect(rows()).toHaveLength(2));
}

async function closed() {
  await waitFor(() => expect(screen.queryAllByRole("menu")).toHaveLength(0));
}

beforeAll(() => {
  document.documentElement.classList.remove("dark");
});

beforeEach(() => {
  control.calls.length = 0;
  control.running = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
});

/** Beside this file, for the account menu's look with two profiles. */
const MENU_SHOTS = "__screenshots__/App.signed-in.browser.test.tsx";

describe("the account menu's triggers", () => {
  it("are named by what they say: the rail's by the name and handle alone, the top bar's by what it opens and whose", async () => {
    await page.viewport(1440, 900);
    renderApp();
    await railChunks();
    await waitFor(() => expect(accountTrigger("aside")).not.toBeNull());
    // The avatar beside the name is hidden, so its initials ("AL") are not
    // read before the name.
    expect(screen.getByRole("button", { name: /^Alice\s*@alice$/ })).toBe(accountTrigger("aside"));

    // The top bar's avatar says nothing a screen reader can use; the trigger
    // carries its own name.
    await page.viewport(390, 844);
    await topBarChunks();
    await waitFor(() => expect(accountTrigger("header")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Account menu, @alice" })).toBe(
      accountTrigger("header"),
    );
  }, 30_000);
});

describe("the account menu's profiles", () => {
  it("are radio rows, the active one checked, at both widths", async () => {
    await page.viewport(1440, 900);
    renderApp();
    // Signed in, the rail's chunk reaches the search and its result rows too,
    // all transformed on first request: wait for the chunks, then the render.
    await railChunks();
    await openMenu("aside");
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Alice@alice"),
      expect.stringContaining("@alice_work"),
    ]);
    expect(checkedRows()).toEqual(["true", "false"]);
    // The rows are the switcher: no item opens another.
    expect(screen.queryByRole("menuitem", { name: "Switch profile" })).toBeNull();
    await page.screenshot({ path: `${SHOTS}/account-menu-1440.png` });
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.screenshot({ path: `${MENU_SHOTS}/account-menu-1440-${theme}.png` });
    }
    document.documentElement.classList.remove("dark");
    await userEvent.keyboard("{Escape}");
    await closed();

    await page.viewport(390, 844);
    await topBarChunks();
    document.documentElement.classList.add("dark");
    await openMenu("header");
    expect(checkedRows()).toEqual(["true", "false"]);
    await page.screenshot({ path: `${SHOTS}/account-menu-390-dark.png` });
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.screenshot({ path: `${MENU_SHOTS}/account-menu-390-${theme}.png` });
    }
  }, 30_000);

  it("switch on a choice, hold every row while the switch runs, and let go however it ends", async () => {
    const failed = vi.spyOn(toast, "error");
    const switched = vi.spyOn(toast, "success");
    await page.viewport(1440, 900);
    renderApp();
    await railChunks();

    // The active row: nothing to switch to.
    await openMenu("aside");
    await userEvent.click(rows()[0]!);
    await closed();
    expect(control.calls).toEqual([]);

    // Another row: the switch starts and the menu closes.
    await openMenu("aside");
    await userEvent.click(rows()[1]!);
    await closed();
    expect(control.calls).toEqual(["usr_alice_work"]);

    // While it runs, the menu shows the wait: every row held, the old one
    // still checked.
    await openMenu("aside");
    expect(held()).toEqual([true, true]);
    expect(checkedRows()).toEqual(["true", "false"]);
    await userEvent.keyboard("{Escape}");
    await closed();

    // The window crosses 768px while it runs: the top bar's menu, drawn
    // after the switch began, holds its rows too, and a press on one starts
    // nothing.
    await page.viewport(390, 844);
    await topBarChunks();
    await openMenu("header");
    expect(held()).toEqual([true, true]);
    rows()[1]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(control.calls).toEqual(["usr_alice_work"]);
    await userEvent.keyboard("{Escape}");
    await closed();
    await page.viewport(1440, 900);
    await railChunks();

    // It fails: the copy map's sentence, and the rows let go.
    control.running!.fail(new AuthExpiredError({}));
    await waitFor(() =>
      expect(failed).toHaveBeenCalledWith("Your session has ended. Sign in again."),
    );
    await openMenu("aside");
    expect(held()).toEqual([false, false]);

    // It fails with no message of its own: the fixed sentence.
    await userEvent.click(rows()[1]!);
    await closed();
    expect(control.calls).toEqual(["usr_alice_work", "usr_alice_work"]);
    control.running!.fail(new Error(""));
    await waitFor(() => expect(failed).toHaveBeenCalledWith("Failed to switch profile"));

    // A new choice switches, and lands.
    await openMenu("aside");
    await userEvent.click(rows()[1]!);
    await closed();
    expect(control.calls).toEqual(["usr_alice_work", "usr_alice_work", "usr_alice_work"]);
    control.running!.land();
    await waitFor(() => expect(switched).toHaveBeenCalledWith("Switched to @alice_work"));
    await openMenu("aside");
    expect(checkedRows()).toEqual(["false", "true"]);
  }, 30_000);
});
