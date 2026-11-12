import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
 * Its own file because the request fails for the whole page, and the page
 * keeps the dialogs' module once a load of it succeeds: a test before this one
 * that loaded it would leave nothing to fail. A failed load is not kept, which
 * is why the later load here can succeed.
 *
 * Nothing a test can reach unloads that module, so a repeat of this test in
 * the same page (`--repeats`) finds the dialogs already in, and their chunk
 * cannot fail. A later run checks what the page holds then: with the request
 * still failing, the rail draws at once with its Sign in, and the note shows
 * its own. The failed load's alert, and a note that holds its Sign in back,
 * are checked on the first run only. From the window crossing 768px on, every
 * run makes the same checks, but only the first run's closing height check
 * shows the note kept the room its Sign in takes: on a later run the note
 * never held the button back, so that check shows only that the note is
 * steady across the round trip to 390px.
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
import { railChunks, topBarChunks } from "./test-support/shell-chunks";

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

it("keeps the rail's frame, with no Sign in, when the dialogs fail to load; a later load mounts them", async ({
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

  // The dialogs' chunk cannot arrive on the first run. A later run finds it
  // in the page already, so the rail's load needs no request.
  const railLoad = await railChunks().then(
    () => "loaded",
    () => "failed",
  );
  expect(railLoad).toBe(first ? "failed" : "loaded");
  const rail = () => within(document.querySelector("aside")!);
  const settled = await waitFor(() =>
    first ? rail().getByRole("alert") : rail().getByRole("button", { name: "Sign in" }),
  );
  expect(settled.closest("aside")!.getBoundingClientRect().width).toBe(240);
  expect(screen.queryByRole("alert")?.textContent).toBe(
    first ? "Musubi could not finish loading. Reload and try again." : undefined,
  );
  // A Sign in shows only where its dialog can open: on the first run neither
  // the shell's nor the note's, on a later run both.
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
  // The top bar's first load, and the dialogs' chunk fetched again.
  await topBarChunks();
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

  // Back at the first width, where the rail now draws its own Sign in. On the
  // first run the note's button shows in the room it held, so the note is no
  // taller. On a later run the note never held its Sign in back, so this
  // checks only that the note is steady across the round trip.
  await page.viewport(1440, 900);
  await railChunks();
  await waitFor(() => {
    const inRail = screen
      .queryAllByRole("button", { name: "Sign in" })
      .find((b) => b.closest("aside"));
    expect(inRail).toBeDefined();
  });
  expect(note.getBoundingClientRect().height).toBe(noteHeight);
});
