import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../src/App.css";

/**
 * The app's frame, in a real browser: `Layout` with a signed-out session.
 *
 * Three things only a real engine can see. The shell's chunks arrive after the
 * page, so whether the page moves when they land is a question of layout. The
 * shell switch is a media query, so crossing 768px has to be a real viewport
 * change. And where focus lands when a dialog closes depends on Kobalte's
 * focus scope and the browser's focus rules together.
 *
 * Order matters: a lazy module is cached for the rest of the file once it has
 * loaded, so the two cases that watch a shell arrive run first, each the first
 * to load its shell.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/` does not resolve in the browser project. The ceremonies are
 * stand-ins: this file tests where the dialogs mount, not the forms.
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
    // The real provider bootstraps a session over the network.
    AuthProvider: (props: { children?: unknown }) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required
      <actual.AuthContext.Provider value={signedOut as any}>
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
vi.mock("@osn/auth-ui/SignIn", () => ({
  SignIn: () => (
    <div class="flex flex-col gap-2 p-6">
      <label for="identifier">Email or handle</label>
      <input id="identifier" />
    </div>
  ),
}));
vi.mock("@osn/auth-ui/Register", () => ({
  Register: () => <p class="p-6">Create your account</p>,
}));
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

function Page() {
  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <h1 class="text-foreground text-display font-medium">Discover</h1>
    </main>
  );
}

function renderApp() {
  return render(() => (
    <MemoryRouter root={Layout}>
      <Route path="/" component={Page} />
    </MemoryRouter>
  ));
}

const main = () => document.querySelector("main")!.getBoundingClientRect();
/** The wordmark: the product name, in the rail or the top bar. */
const wordmark = () =>
  screen.getAllByText("Musubi", { selector: "span" })[0]!.getBoundingClientRect();
const dialogs = () => screen.queryAllByRole("dialog", { hidden: true });
/** Layout width: the opening zoom scales the painted box for a moment. */
const dialogWidth = () => dialogs()[0]!.offsetWidth;
const railSignIn = () =>
  screen
    .queryAllByRole("button", { name: "Sign in", hidden: true })
    .find((b) => b.closest("aside"));
const topBarSignIn = () =>
  screen
    .queryAllByRole("button", { name: "Sign in", hidden: true })
    .find((b) => b.closest("header"));

beforeAll(() => {
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
});

describe("the shell holds still while its chunk loads", () => {
  it("keeps the page column and the wordmark where they are when the rail arrives", async () => {
    await page.viewport(1440, 900);
    renderApp();

    // The first frame, before the rail's chunk can have resolved.
    const before = main();
    const aside = document.querySelector("aside");
    expect(aside, "a 240px rail frame is drawn from the first frame").not.toBeNull();
    expect(aside!.getBoundingClientRect().width).toBe(240);
    const wordmarkBefore = wordmark();

    await waitFor(() => expect(railSignIn()).toBeDefined());
    const after = main();
    expect(after.left).toBe(before.left);
    expect(after.top).toBe(before.top);
    expect(wordmark().left).toBe(wordmarkBefore.left);
    expect(wordmark().top).toBe(wordmarkBefore.top);
  });

  it("keeps the page column where it is when the phone top bar arrives", async () => {
    await page.viewport(390, 844);
    renderApp();

    const before = main();
    expect(
      document.querySelector("header"),
      "a top-bar frame is drawn from the first frame",
    ).not.toBeNull();
    const wordmarkBefore = wordmark();

    await waitFor(() => expect(topBarSignIn()).toBeDefined());
    const after = main();
    expect(after.top).toBe(before.top);
    // Below the bar's 48px row and its hairline.
    expect(after.top).toBe(document.querySelector("header")!.getBoundingClientRect().bottom);
    expect(wordmark().left).toBe(wordmarkBefore.left);
    expect(wordmark().top).toBe(wordmarkBefore.top);
  });
});

describe("one set of shell dialogs", () => {
  it("keeps an open sign-in dialog, and what was typed, across the 768px switch", async () => {
    await page.viewport(1440, 900);
    renderApp();
    await waitFor(() => expect(railSignIn()).toBeDefined());

    await userEvent.click(railSignIn()!);
    // Named for assistive technology: the view inside heads itself with a plain heading.
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Sign in" })).toBeDefined());
    const field = await waitFor(() => screen.getByLabelText("Email or handle"));
    await userEvent.fill(field, "alice");
    // A centred card, capped at 384px.
    expect(dialogs()).toHaveLength(1);
    expect(dialogWidth()).toBe(384);
    await page.screenshot({ path: `${SHOTS}/sign-in-1440.png` });

    await page.viewport(390, 844);
    await waitFor(() => expect(topBarSignIn()).toBeDefined());
    expect(dialogs()).toHaveLength(1);
    expect((screen.getByLabelText("Email or handle") as HTMLInputElement).value).toBe("alice");
    // A sheet, as wide as the phone.
    expect(dialogWidth()).toBe(window.innerWidth);
    await page.screenshot({ path: `${SHOTS}/sign-in-390.png` });

    await page.viewport(1440, 900);
    await waitFor(() => expect(railSignIn()).toBeDefined());
    expect(dialogs()).toHaveLength(1);
    expect((screen.getByLabelText("Email or handle") as HTMLInputElement).value).toBe("alice");
    expect(dialogWidth()).toBe(384);
  });

  it("gives focus back to the shell's own Sign in button when the dialog closes", async () => {
    await page.viewport(1440, 900);
    renderApp();
    await waitFor(() => expect(railSignIn()).toBeDefined());

    // Opened and closed on one shell: back to the button that opened it.
    await userEvent.click(railSignIn()!);
    await waitFor(() => expect(dialogs()).toHaveLength(1));
    await userEvent.keyboard("{Escape}");
    // Kobalte hands focus back a task after the dialog unmounts.
    await waitFor(() => expect(document.activeElement).toBe(railSignIn()));
    expect(dialogs()).toHaveLength(0);

    // Opened on the rail, closed on the phone: that button is gone, so the
    // top bar's Sign in takes focus.
    await userEvent.click(railSignIn()!);
    await waitFor(() => expect(dialogs()).toHaveLength(1));
    await page.viewport(390, 844);
    await waitFor(() => expect(topBarSignIn()).toBeDefined());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(topBarSignIn()));
    expect(dialogs()).toHaveLength(0);
  });
});

describe("the phone top bar", () => {
  it("fits its signed-out controls at 320px, each at the 40px touch floor", async () => {
    await page.viewport(320, 640);
    renderApp();
    await waitFor(() => expect(topBarSignIn()).toBeDefined());

    const header = document.querySelector("header")!;
    const row = header.firstElementChild as HTMLElement;
    expect(row.scrollWidth, "nothing overflows the bar").toBeLessThanOrEqual(row.clientWidth);
    const controls = [...header.querySelectorAll("button")];
    expect(controls.map((c) => c.getAttribute("aria-label") ?? c.textContent)).toEqual([
      "Theme: System",
      "Sign in",
      "Create account",
    ]);
    const short = controls.filter((c) => c.getBoundingClientRect().height < 40);
    expect(short.map((c) => c.getAttribute("aria-label") ?? c.textContent)).toEqual([]);
    const theme = controls[0]!.getBoundingClientRect();
    expect(theme.width).toBeGreaterThanOrEqual(40);
    expect(wordmark().right, "the wordmark clears the controls").toBeLessThan(theme.left);
    await page.screenshot({ path: `${SHOTS}/topbar-320.png` });
  });
});
