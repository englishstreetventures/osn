// @vitest-environment happy-dom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

/**
 * The window screen's code is a chunk of its own. Until it lands, the
 * window's frame holds its place: the heading over a busy card, never a blank
 * page. If it fails (offline, or a chunk a deploy renamed), the frame stays
 * and says to reload, as a shell's frame does. Its own file because a page
 * keeps a failed module for good.
 */

const chunk = vi.hoisted(() => {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<never>((_, fail) => {
    reject = fail;
  });
  return { promise, reject };
});

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
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => (
      <actual.AuthContext.Provider
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
        value={
          {
            session: resource({ accessToken: "not-a-jwt", expiresAt: Date.now() + 60_000 }),
            profiles: resource(null),
            profilesError: () => undefined,
            activeProfileId: () => "usr_alice",
            pendingDeletion: () => true,
          } as any
        }
      >
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
vi.mock("../src/components/DeletionWindow", async () => {
  await chunk.promise;
  return { default: () => null };
});

import { Layout } from "../src/App";

afterEach(() => cleanup());

it("holds the window's place while its code loads, and says to reload if it fails", async () => {
  render(() => (
    <MemoryRouter root={Layout}>
      <Route path="/" component={() => <p data-testid="page">Connections</p>} />
    </MemoryRouter>
  ));
  const heading = await screen.findByRole("heading", { name: "Your account is set to be deleted" });
  expect(heading.closest("[aria-busy='true']")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByTestId("page")).toBeNull();

  chunk.reject(new TypeError("Failed to fetch dynamically imported module"));
  const line = await screen.findByText("Musubi could not finish loading. Reload and try again.");
  expect(line.closest("[role='alert']")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "Your account is set to be deleted" })).toBeTruthy();
  expect(document.querySelector("[aria-busy='true']")).toBeNull();
});
