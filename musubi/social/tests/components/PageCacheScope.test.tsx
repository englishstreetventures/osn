// @vitest-environment happy-dom
import type { OsnAuthRuntime, OsnAuthService, Session, SessionChange } from "@osn/client";
import { OsnAuth } from "@osn/client";
import { AuthProvider, useAuth } from "@osn/client/solid";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { Effect } from "effect";
import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";

/**
 * No account or profile ever sees the page rows of the one before it, through
 * the real `AuthProvider`: a profile switch, a log out then a sign-in as
 * someone else, and the runtime ending the session then a sign-in. Each
 * profile's connections carry its id, so a row of the wrong one is plain.
 *
 * The runtime is a fake whose service answers from memory (the pattern of
 * `osn/client/tests/solid/context.test.tsx`), which is why this package has
 * `effect` among its dev dependencies: the provider runs Effect values on its
 * runtime. The app itself never imports it.
 */

const reads = vi.hoisted(() => ({
  out: [] as { profile: string; resolve: () => void }[],
  /** Rows each profile's connections list answers with. */
  rows: { prof_d: 3, prof_d2: 3 } as Record<string, number>,
}));

/** The account and profile the fake runtime holds; `null` while signed out. */
const world = vi.hoisted(() => ({
  account: null as string | null,
  profile: null as string | null,
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: {
    listConnections: () => {
      const profile = world.profile ?? "nobody";
      return new Promise((resolve) => {
        reads.out.push({
          profile,
          resolve: () =>
            resolve({
              connections: Array.from({ length: reads.rows[profile] ?? 1 }, (_, i) => ({
                handle: `${profile}_friend_${i}`,
                displayName: `Friend of ${profile} ${i}`,
              })),
            }),
        });
      });
    },
  },
  orgClient: {},
  recommendationClient: {},
}));
vi.mock("../../src/lib/authClients", () => ({ connectionsClient: {} }));
vi.mock("../../src/components/ShellDialogs", () => ({
  useShellDialogs: () => ({ ready: () => true, open: () => {} }),
}));

import { ShellNotices } from "../../src/components/ShellNotices";
import { placeholderRows } from "../../src/lib/page-cache";
import { connectionsList } from "../../src/lib/page-data";
import { ConnectionsPage } from "../../src/pages/ConnectionsPage";

let loads = 0;
const sessionFor = (account: string, profile: string): Session => {
  loads += 1;
  return {
    accessToken: `${account}.${profile}.${loads}`,
    idToken: null,
    expiresAt: Date.now() + 60_000,
    scopes: [],
  };
};

function fakeRuntime() {
  const listeners = new Set<(change: SessionChange) => void>();
  const service = {
    loadSession: () =>
      Effect.sync(() => (world.account ? sessionFor(world.account, world.profile!) : null)),
    listProfiles: () => Effect.sync(() => []),
    getActiveProfile: () => Effect.sync(() => world.profile),
    logout: () =>
      Effect.sync(() => {
        world.account = null;
        world.profile = null;
      }),
    switchProfile: (profileId: string) =>
      Effect.sync(() => {
        world.profile = profileId;
        return {
          session: sessionFor(world.account!, profileId),
          profile: {
            id: profileId,
            handle: profileId,
            email: "",
            displayName: null,
            avatarUrl: null,
          },
        };
      }),
    setSession: (next: Session) =>
      Effect.sync(() => {
        const [account, profile] = next.accessToken.split(".");
        world.account = account!;
        world.profile = profile!;
      }),
  } as unknown as OsnAuthService;
  const runtime: OsnAuthRuntime = {
    authFetch: vi.fn(),
    run: (effect) => Effect.runPromise(Effect.provideService(effect, OsnAuth, service)),
    onSessionChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  /** What the real runtime does when it ends a session: forget it, then tell the listeners. */
  const end = () => {
    world.account = null;
    world.profile = null;
    for (const listener of listeners) listener({ kind: "ended" });
  };
  /** What it does when the account no longer owns the active profile: fall back, then tell. */
  const reset = (profileId: string) => {
    world.profile = profileId;
    for (const listener of listeners) listener({ kind: "profile-reset", profileId });
  };
  return { runtime, end, reset };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Answers the read out for `profile`. */
async function answer(profile: string) {
  await waitFor(() => expect(reads.out.some((r) => r.profile === profile)).toBe(true));
  const index = reads.out.findIndex((r) => r.profile === profile);
  const [read] = reads.out.splice(index, 1);
  read!.resolve();
  await settle();
}

afterEach(() => {
  cleanup();
  reads.out.length = 0;
  world.account = null;
  world.profile = null;
});

it("F6: no profile or account is ever shown the rows of the one before it", async () => {
  world.account = "acc_a";
  world.profile = "prof_a";
  const { runtime, end, reset } = fakeRuntime();
  let auth!: ReturnType<typeof useAuth>;
  const [pageShown, setPageShown] = createSignal(true);
  const [shellShown, setShellShown] = createSignal(true);
  render(() => (
    <AuthProvider auth={runtime}>
      {(() => {
        auth = useAuth();
        return null;
      })()}
      {/* The shell's own binder: `ShellNotices` mounts `PageCacheScope`. */}
      <Show when={shellShown()}>
        <ShellNotices />
      </Show>
      <Show when={pageShown()}>
        <ConnectionsPage />
      </Show>
    </AuthProvider>
  ));

  // Which profiles' rows were drawn while each step ran. The observer reports
  // late, so each step first files what the last one drew.
  let step = "a";
  const drawn = new Map<string, Set<string>>();
  const file = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        for (const match of (node.textContent ?? "").matchAll(/Friend of (prof_\w+?) \d/g)) {
          drawn.set(step, (drawn.get(step) ?? new Set()).add(match[1]!));
        }
      }
    }
  };
  const observer = new MutationObserver(file);
  observer.observe(document.body, { childList: true, subtree: true });
  const begin = (next: string) => {
    file(observer.takeRecords());
    step = next;
  };

  await answer("prof_a");
  await screen.findByText("Friend of prof_a 0");

  begin("switch");
  await auth.switchProfile("prof_b");
  await settle();
  expect(screen.queryByText("Friend of prof_a 0")).toBeNull();
  await answer("prof_b");
  await screen.findByText("Friend of prof_b 0");

  // Shown again: B's rows at once, a read for B held behind them, which
  // answers only after B has signed out.
  begin("shown again");
  setPageShown(false);
  setPageShown(true);
  expect(screen.getByText("Friend of prof_b 0")).toBeTruthy();
  begin("sign out");
  await auth.logout();
  await settle();
  expect(screen.queryByText("Friend of prof_b 0")).toBeNull();
  await answer("prof_b");

  begin("another account");
  await auth.adoptSession(sessionFor("acc_c", "prof_c"));
  await settle();
  expect(document.body.textContent).not.toMatch(/Friend of prof_[ab]/);
  await answer("prof_c");
  await screen.findByText("Friend of prof_c 0");

  begin("ended");
  end();
  await settle();
  expect(screen.queryByText("Friend of prof_c 0")).toBeNull();
  await auth.adoptSession(sessionFor("acc_d", "prof_d"));
  await settle();
  expect(document.body.textContent).not.toMatch(/Friend of prof_c/);
  await answer("prof_d");
  await screen.findByText("Friend of prof_d 2");

  begin("profile reset");
  reset("prof_d2");
  await settle();
  expect(screen.queryByText("Friend of prof_d 0")).toBeNull();
  await answer("prof_d2");
  await screen.findByText("Friend of prof_d2 2");
  begin("done");
  observer.disconnect();

  expect(Object.fromEntries([...drawn].map(([k, v]) => [k, [...v].toSorted()]))).toEqual({
    a: ["prof_a"],
    switch: ["prof_b"],
    "shown again": ["prof_b"],
    "another account": ["prof_c"],
    ended: ["prof_d"],
    "profile reset": ["prof_d2"],
  });

  // With no page mounted, the shell alone still clears: the count the page
  // last saw goes with the session that saw it.
  expect(placeholderRows("connections.all")).toBe(3);
  setPageShown(false);
  await auth.logout();
  await settle();
  expect(placeholderRows("connections.all")).toBe(1);

  // The shell gone (a bare route) unbinds the cache: signed in or not,
  // nothing reads.
  await auth.adoptSession(sessionFor("acc_e", "prof_e"));
  await settle();
  setShellShown(false);
  const out = reads.out.length;
  connectionsList.preload();
  expect(reads.out.length).toBe(out);
});
