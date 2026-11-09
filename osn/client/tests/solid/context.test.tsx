import { Effect } from "effect";
import { createRoot } from "solid-js";
import { expect, it, vi } from "vitest";

import { AuthExpiredError, ProfileManagementError } from "../../src/errors";
import type { OsnAuthRuntime, SessionChange } from "../../src/runtime";
import { OsnAuth, type OsnAuthService } from "../../src/service";
import { AuthProvider, useAuth } from "../../src/solid/context";

const DEFAULT = "usr_default00001";
const OTHER = "usr_other0000001";

/**
 * F19, the provider half: an unmounted `AuthProvider` must stop listening, or
 * a later session change would write into a disposed tree.
 */
it("F19: AuthProvider unsubscribes from the runtime when it unmounts", () => {
  const listeners = new Set<(change: SessionChange) => void>();
  const unsubscribe = vi.fn();
  const runtime: OsnAuthRuntime = {
    authFetch: vi.fn(),
    run: vi.fn(() => new Promise<never>(() => {})),
    onSessionChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };

  createRoot((dispose) => {
    AuthProvider({ auth: runtime, children: null });
    expect(listeners.size).toBe(1);
    dispose();
  });

  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});

/**
 * A runtime whose service answers from memory and records each operation the
 * provider runs, so a test can see what a session change made it send.
 */
function fakeRuntime() {
  const listeners = new Set<(change: SessionChange) => void>();
  const ran: string[] = [];
  let active = OTHER;
  let loads = 0;
  const service = {
    loadSession: () =>
      Effect.sync(() => {
        ran.push("loadSession");
        loads += 1;
        return {
          accessToken: `token-${loads}`,
          idToken: null,
          expiresAt: Date.now() + 60_000,
          scopes: [],
        };
      }),
    listProfiles: () =>
      Effect.sync(() => {
        ran.push("listProfiles");
        return [];
      }),
    getActiveProfile: () =>
      Effect.sync(() => {
        ran.push("getActiveProfile");
        return active;
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
  /** What the real runtime does: change the service's state, then tell the listeners. */
  const emit = (change: SessionChange) => {
    if (change.kind === "profile-reset") active = change.profileId;
    for (const listener of listeners) listener(change);
  };
  return { runtime, ran, emit };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(runtime: OsnAuthRuntime) {
  let auth!: ReturnType<typeof useAuth>;
  const dispose = createRoot((disposeRoot) => {
    AuthProvider({
      auth: runtime,
      get children() {
        auth = useAuth();
        return null;
      },
    });
    return disposeRoot;
  });
  return { auth: () => auth, dispose };
}

it("F32/F33: a profile reset shows the new profile, reloads the session and lists nothing", async () => {
  const { runtime, ran, emit } = fakeRuntime();
  const { auth, dispose } = mount(runtime);
  await settle();
  expect(auth().activeProfileId()).toBe(OTHER);
  const before = ran.length;

  emit({ kind: "profile-reset", profileId: DEFAULT });
  await settle();

  expect(auth().activeProfileId()).toBe(DEFAULT);
  expect(auth().session()?.accessToken).toBe("token-2");
  const after = ran.slice(before);
  expect(after).toContain("loadSession");
  expect(after).not.toContain("listProfiles");
  dispose();
});

it("F32: an ended session goes to signed out with nothing sent", async () => {
  const { runtime, ran, emit } = fakeRuntime();
  const { auth, dispose } = mount(runtime);
  await settle();
  expect(auth().session()).not.toBeNull();
  const before = ran.length;

  emit({ kind: "ended" });
  await settle();

  expect(auth().session()).toBeNull();
  expect(auth().activeProfileId()).toBeNull();
  expect(auth().profiles()).toBeNull();
  expect(ran.slice(before)).toEqual([]);
  dispose();
});

const alice = {
  id: "usr_alice0000001",
  handle: "alice",
  email: "a@b.c",
  displayName: null,
  avatarUrl: null,
};
const bob = {
  id: "usr_bob000000001",
  handle: "bob",
  email: "b@b.c",
  displayName: null,
  avatarUrl: null,
};

/**
 * A runtime whose `listProfiles` answers each call from a queue of steps, so a
 * test can fail one list, or end the session in the middle of one, the way
 * the real runtime's `authFetch` does when its renewal is refused.
 */
function listingRuntime(
  steps: Array<(emit: (change: SessionChange) => void) => Effect.Effect<unknown, unknown>>,
) {
  const listeners = new Set<(change: SessionChange) => void>();
  let signedIn = true;
  const emit = (change: SessionChange) => {
    if (change.kind === "ended") signedIn = false;
    for (const listener of listeners) listener(change);
  };
  const listProfiles = vi.fn(() => {
    const step = steps.shift();
    return step ? step(emit) : Effect.never;
  });
  const service = {
    loadSession: () =>
      Effect.sync(() =>
        signedIn
          ? { accessToken: "token", idToken: null, expiresAt: Date.now() + 60_000, scopes: [] }
          : null,
      ),
    setSession: () =>
      Effect.sync(() => {
        signedIn = true;
      }),
    listProfiles,
    getActiveProfile: () => Effect.succeed(alice.id),
  } as unknown as OsnAuthService;
  const runtime: OsnAuthRuntime = {
    authFetch: vi.fn(),
    run: (effect) => Effect.runPromise(Effect.provideService(effect, OsnAuth, service)),
    onSessionChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { runtime, emit, listProfiles };
}

const serverFailure = () =>
  new ProfileManagementError({ cause: "PLANTED", status: 500, code: "internal_error" });

it("a failed relist keeps the list it had, and says why without throwing", async () => {
  const { runtime } = listingRuntime([
    () => Effect.succeed([alice, bob]),
    () => Effect.fail(serverFailure()),
  ]);
  const { auth, dispose } = mount(runtime);
  await settle();
  expect(auth().profiles()).toEqual([alice, bob]);

  await auth().refetchProfiles();
  await settle();

  expect(() => auth().profiles()).not.toThrow();
  expect(auth().profiles()).toEqual([alice, bob]);
  expect(auth().profilesError()).toBeInstanceOf(ProfileManagementError);
  dispose();
});

it("a relist that succeeds after a failure clears the error", async () => {
  const { runtime } = listingRuntime([
    () => Effect.fail(serverFailure()),
    () => Effect.succeed([alice]),
  ]);
  const { auth, dispose } = mount(runtime);
  await settle();
  expect(auth().profilesError()).toBeInstanceOf(ProfileManagementError);
  expect(auth().profiles()).toBeNull();

  await auth().refetchProfiles();
  await settle();

  expect(auth().profiles()).toEqual([alice]);
  expect(auth().profilesError()).toBeUndefined();
  dispose();
});

it("an ended session clears a list error it outlives", async () => {
  const { runtime, emit } = listingRuntime([() => Effect.fail(serverFailure())]);
  const { auth, dispose } = mount(runtime);
  await settle();
  expect(auth().profilesError()).toBeDefined();

  emit({ kind: "ended" });
  await settle();

  expect(auth().profiles()).toBeNull();
  expect(auth().profilesError()).toBeUndefined();
  dispose();
});

// The real order: a list's own renewal is refused, so the runtime tells the
// listeners the session ended before the list call itself rejects.
it.each([
  ["a server failure", serverFailure],
  ["the session's end", () => new AuthExpiredError({})],
])(
  "a list that fails after the session ended (%s) leaves no error and no old list behind",
  async (_, failure) => {
    const { runtime } = listingRuntime([
      () => Effect.succeed([alice, bob]),
      (emit) =>
        Effect.suspend(() => {
          emit({ kind: "ended" });
          return Effect.fail(failure());
        }),
      // The next account's list has not arrived yet.
      () => Effect.never,
    ]);
    const { auth, dispose } = mount(runtime);
    await settle();
    expect(auth().profiles()).toEqual([alice, bob]);

    await auth().refetchProfiles();
    await settle();
    expect(auth().session()).toBeNull();
    expect(auth().profiles()).toBeNull();
    expect(auth().profilesError()).toBeUndefined();

    // Signed in again: neither the old list nor the old error comes back.
    void auth().adoptSession({
      accessToken: "token-2",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    } as never);
    await settle();
    expect(auth().session()).not.toBeNull();
    expect(auth().profiles() ?? null).toBeNull();
    expect(auth().profilesError()).toBeUndefined();
    dispose();
  },
);

it("an expired session while listing leaves no error to show", async () => {
  const { runtime } = listingRuntime([() => Effect.fail(new AuthExpiredError({}))]);
  const { auth, dispose } = mount(runtime);
  await settle();
  expect(auth().profiles()).toBeNull();
  expect(auth().profilesError()).toBeUndefined();
  dispose();
});

// A first session turns the list's source on, which lists by itself; listing
// again from `adoptSession` would send the same request twice on every
// sign-in, against a rate-limited route.
it("adopting a first session lists the profiles once", async () => {
  const { runtime, emit, listProfiles } = listingRuntime([
    () => Effect.succeed([alice]),
    () => Effect.succeed([alice]),
    () => Effect.succeed([alice]),
  ]);
  const { auth, dispose } = mount(runtime);
  await settle();
  emit({ kind: "ended" });
  await settle();
  const before = listProfiles.mock.calls.length;

  await auth().adoptSession({
    accessToken: "token-2",
    idToken: null,
    expiresAt: Date.now() + 60_000,
    scopes: [],
  } as never);
  await settle();

  expect(listProfiles.mock.calls.length - before).toBe(1);
  expect(auth().profiles()).toEqual([alice]);
  dispose();
});

it("adopting a session over another lists the profiles again", async () => {
  const { runtime, listProfiles } = listingRuntime([
    () => Effect.succeed([alice]),
    () => Effect.succeed([alice, bob]),
  ]);
  const { auth, dispose } = mount(runtime);
  await settle();
  const before = listProfiles.mock.calls.length;

  await auth().adoptSession({
    accessToken: "token-2",
    idToken: null,
    expiresAt: Date.now() + 60_000,
    scopes: [],
  } as never);
  await settle();

  expect(listProfiles.mock.calls.length - before).toBe(1);
  expect(auth().profiles()).toEqual([alice, bob]);
  dispose();
});
