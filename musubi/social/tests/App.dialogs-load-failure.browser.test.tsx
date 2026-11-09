import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../src/App.css";

/**
 * The shell dialogs' chunk fails to load. The shell waits for it as well as
 * for its own chunk, so it never offers a Sign in that cannot open: the rail's
 * frame stays and says to reload, and the page beside it still renders. The
 * page's signed-out note holds its Sign in back too, keeping its place: the
 * note is as tall then as once the button shows.
 *
 * Then the network comes back and the window crosses 768px. The phone shell
 * loads the chunk again, and once it draws, its Sign in opens the dialog: the
 * dialogs mount on the load that succeeds, not only on the first. The note's
 * Sign in shows then, once, outside the note's `<output>`.
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

vi.mock("@osn/auth-ui/SignIn", () => ({
  SignIn: () => <p class="p-6">Sign in form</p>,
}));
vi.mock("@osn/auth-ui/Register", () => ({
  Register: () => <p class="p-6">Create your account</p>,
}));

import { Layout } from "../src/App";
import { SignedOutNote } from "../src/components/SignedOutNote";

beforeAll(async () => {
  await commands.failRequests("/src/components/ShellDialogSet.tsx");
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await commands.restoreRequests();
});

it("keeps the rail's frame, with no Sign in, when the dialogs fail to load; a later load mounts them", async () => {
  await page.viewport(1440, 900);
  render(() => (
    <MemoryRouter root={Layout}>
      <Route
        path="/"
        component={() => (
          <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
            <h1>Discover</h1>
            <SignedOutNote>Sign in to discover people.</SignedOutNote>
          </main>
        )}
      />
    </MemoryRouter>
  ));

  const alert = await waitFor(() => screen.getByRole("alert"));
  expect(alert.textContent).toBe("Musubi could not finish loading. Reload and try again.");
  expect(alert.closest("aside")!.getBoundingClientRect().width).toBe(240);
  // Neither the shell's Sign in nor the note's: the dialog it opens is not there.
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Sign in to discover people.");
  const note = screen.getByRole("status").parentElement!;
  const heldBack = note.getBoundingClientRect().height;
  expect(screen.getByRole("heading", { name: "Discover" })).toBeDefined();
  expect(document.querySelector("main")!.getBoundingClientRect().left).toBe(504);
  await page.screenshot({ path: "../../../e2e-artifacts/musubi-shell/dialogs-failed-1440.png" });

  await commands.restoreRequests();
  await page.viewport(390, 844);
  const signIn = await waitFor(() => {
    const button = screen
      .queryAllByRole("button", { name: "Sign in" })
      .find((b) => b.closest("header"));
    expect(button).toBeDefined();
    return button!;
  });
  const inNote = within(document.querySelector("main")!).getAllByRole("button", {
    name: "Sign in",
  });
  expect(inNote).toHaveLength(1);
  expect(inNote[0]!.closest("output")).toBeNull();
  await userEvent.click(signIn);
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Sign in" })).toBeDefined());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Back at the first width, where the rail now draws its own Sign in: the
  // note's button shows in the room it held, so the note is no taller.
  await page.viewport(1440, 900);
  await waitFor(() => {
    const inRail = screen
      .queryAllByRole("button", { name: "Sign in" })
      .find((b) => b.closest("aside"));
    expect(inRail).toBeDefined();
  });
  expect(note.getBoundingClientRect().height).toBe(heldBack);
});
