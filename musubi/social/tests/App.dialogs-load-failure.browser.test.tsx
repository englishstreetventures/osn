import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../src/App.css";

/**
 * The shell dialogs' chunk fails to load. The shell does not wait for it: the
 * rail draws on its own chunk, with its Sign in and Create account held
 * `invisible` in the place they take, so it never offers a Sign in that cannot
 * open. The page's signed-out note holds its Sign in back too, keeping its
 * place: the note is as tall then as once the button shows. Above the page the
 * shell says to reload.
 *
 * Then the network comes back and the window crosses 768px. The phone shell,
 * drawn after the failure, loads the chunk again, and its Sign in opens the
 * dialog: the dialogs mount on the load that succeeds, not only on the first.
 * The note's Sign in shows then, once, outside the note's `<output>`, and the
 * reload line goes. Back at 1440px the rail's Sign in shows in the room it
 * held.
 *
 * Its own file because the request fails for the whole page, and the page
 * keeps the dialogs' module once a load of it succeeds: a test before this one
 * that loaded it would leave nothing to fail. A failed load is not kept, which
 * is why the later load here can succeed.
 *
 * Nothing a test can reach unloads that module, so a repeat of this test in
 * the same page (`--repeats`) finds the dialogs already in, and their chunk
 * cannot fail. A later run checks what the page holds then: with the request
 * still failing, the rail draws its Sign in at once, the note shows its own,
 * and nothing says to reload. The failed load's line, and buttons held back,
 * are checked on the first run only. From the window crossing 768px on, every
 * run makes the same checks, but only the first run's closing height checks
 * show the rail's buttons and the note's kept the room they take: on a later
 * run nothing was held back, so those checks show only that both are steady
 * across the round trip to 390px.
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
    pendingDeletion: () => false,
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

// Each view names its dialog through its own `DialogTitle`, as the real ones
// do through `AuthHeader`.
vi.mock("@osn/auth-ui/SignIn", async () => {
  const { DialogTitle } = await import("@shared/ui/ui/dialog");
  return {
    SignIn: () => (
      <div class="p-6">
        <DialogTitle>Sign in to Musubi</DialogTitle>
        <p>Sign in form</p>
      </div>
    ),
  };
});
vi.mock("@osn/auth-ui/Register", async () => {
  const { DialogTitle } = await import("@shared/ui/ui/dialog");
  return {
    Register: () => (
      <div class="p-6">
        <DialogTitle>Create your Musubi account</DialogTitle>
      </div>
    ),
  };
});

import { Layout } from "../src/App";
import { SignedOutNote } from "../src/components/SignedOutNote";
import { dialogChunk, railChunks, topBarChunks } from "./test-support/shell-chunks";

// Set before each run, not once for the file: the test lifts the route part-way
// through.
beforeEach(async () => {
  await commands.failRequests("/src/components/ShellDialogSet.tsx");
});

afterEach(async () => {
  try {
    cleanup();
  } finally {
    // Lifted even when cleanup throws: the route holds for the whole page, so
    // left standing it would fail the files that run after this one.
    await commands.restoreRequests();
  }
});

/**
 * The shell's Sign in, drawn or held back, in the rail (`aside`) or the top
 * bar (`header`). By its words: held back, it has no accessible name.
 */
const shellSignIn = (shell: "aside" | "header") =>
  [...document.querySelectorAll<HTMLElement>(`${shell} button`)].find(
    (b) => b.textContent === "Sign in",
  );
const shown = (element: Element) => getComputedStyle(element).visibility === "visible";

it("draws the rail with its Sign in held back when the dialogs fail to load; a later load mounts them", async ({
  task,
}) => {
  // Vitest's index of this repeat. A retry keeps its run's index, so a retry
  // of the first run makes the first run's checks.
  const first = !task.result?.repeatCount;
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

  // The rail waits for its own chunk alone, so it loads either way. The
  // dialogs' chunk cannot arrive on the first run; a later run finds it in
  // the page already.
  await railChunks();
  const dialogsLoad = await dialogChunk().then(
    () => "loaded",
    () => "failed",
  );
  expect(dialogsLoad).toBe(first ? "failed" : "loaded");
  const railSignIn = await waitFor(() => {
    const button = shellSignIn("aside");
    expect(button).toBeDefined();
    return button!;
  });
  expect(railSignIn.closest("aside")!.getBoundingClientRect().width).toBe(240);
  // The rail's two buttons, held back or shown, in one slot.
  const slot = railSignIn.parentElement!;
  const slotHeight = slot.getBoundingClientRect().height;
  expect(slotHeight).toBeGreaterThan(0);
  await waitFor(() =>
    expect(screen.queryByRole("alert")?.textContent).toBe(
      first ? "Error: Musubi could not finish loading. Reload and try again." : undefined,
    ),
  );
  // A Sign in shows only where its dialog can open: on the first run neither
  // the shell's nor the note's, on a later run both.
  expect(shown(railSignIn)).toBe(!first);
  expect(screen.queryAllByRole("button", { name: "Sign in" })).toHaveLength(first ? 0 : 2);
  expect(screen.getByRole("status").textContent).toBe("Sign in to discover people.");
  const note = screen.getByRole("status").parentElement!;
  const noteHeight = note.getBoundingClientRect().height;
  expect(screen.getByRole("heading", { name: "Discover" })).toBeDefined();
  expect(document.querySelector("main")!.getBoundingClientRect().left).toBe(504);
  await page.screenshot({
    path: `../../../e2e-artifacts/musubi-shell/dialogs-${first ? "failed" : "loaded"}-1440.png`,
  });

  await commands.restoreRequests();
  await page.viewport(390, 844);
  // The top bar's first load; drawn after the failure, it fetches the
  // dialogs' chunk again.
  await topBarChunks();
  await dialogChunk();
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
  expect(screen.queryByRole("alert")).toBeNull();
  await userEvent.click(signIn);
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "Sign in to Musubi" })).toBeDefined(),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Back at the first width, where the rail now shows its own Sign in. On
  // the first run the rail's buttons and the note's show in the room they
  // held, so neither is taller. On a later run nothing was held back, so this
  // checks only that both are steady across the round trip.
  await page.viewport(1440, 900);
  await railChunks();
  const railShown = await waitFor(() => {
    const button = screen
      .queryAllByRole("button", { name: "Sign in" })
      .find((b) => b.closest("aside"));
    expect(button).toBeDefined();
    return button!;
  });
  expect(railShown.parentElement!.getBoundingClientRect().height).toBe(slotHeight);
  expect(note.getBoundingClientRect().height).toBe(noteHeight);
});
