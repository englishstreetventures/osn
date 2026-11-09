import { Effect } from "effect";
import { createRoot } from "solid-js";
import { expect, it, vi } from "vitest";

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
  const dispose = createRoot((dispose) => {
    AuthProvider({
      auth: runtime,
      get children() {
        auth = useAuth();
        return null;
      },
    });
    return dispose;
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
