import type { OsnAuthRuntime, OsnAuthService, Session, SessionChange } from "@osn/client";
import { OsnAuth } from "@osn/client";
import { AuthProvider, useAuth } from "@osn/client/solid";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { Effect } from "effect";
import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";

/**
 * No account or profile is ever shown the Security rows of the session before
 * it, through the real `AuthProvider`, in a real browser: a profile switch, a
 * sign-out then another account, the session ending then another account, and
 * a profile reset. The section stays mounted throughout, as `SettingsPage`
 * keeps it across a profile switch, so this fails if anything outside the page
 * cache's entries holds rows. And a delete that answers after its account has
 * gone writes nothing, and reads nothing, for the account after it (F14–F16 in
 * the branch's plan).
 *
 * Each profile's passkey and authenticator carry its id, and its recovery
 * count its number, so a row of the wrong one is plain. The runtime is a fake
 * whose service answers from memory, as `PageCacheScope.test.tsx`'s. The
 * factories are written literally: the shared-factory idiom in
 * `test-support/` does not resolve in the browser project.
 */

const reads = vi.hoisted(() => ({
  /** Reads held until the test answers them. */
  out: [] as { profile: string; name: string; resolve: () => void }[],
  sent: {} as Record<string, number>,
  deletes: [] as (() => void)[],
}));

const world = vi.hoisted(() => ({
  account: null as string | null,
  profile: null as string | null,
}));

vi.mock("../../src/lib/authClients", () => {
  function held<T>(name: string, value: (profile: string) => T): Promise<T> {
    const profile = world.profile ?? "nobody";
    reads.sent[profile] = (reads.sent[profile] ?? 0) + 1;
    const rows = value(profile);
    return new Promise((resolve) => {
      reads.out.push({ profile, name, resolve: () => resolve(rows) });
    });
  }
  const unused = () => new Promise(() => {});
  return {
    passkeysClient: {
      list: () =>
        held("passkeys", (profile) => ({
          passkeys: [
            { id: `pk_${profile}`, label: `Key of ${profile}` },
            // One profile's list holds a passkey under another's id, so an
            // outcome written into the wrong list would show.
            ...(profile === "prof_7" ? [{ id: "pk_prof_6", label: "Same id as prof_6's" }] : []),
          ].map((row) => ({
            ...row,
            aaguid: null,
            transports: null,
            backupEligible: false,
            backupState: false,
            createdAt: 1_700_000_000,
            lastUsedAt: null,
          })),
        })),
      delete: () =>
        new Promise((resolve) => {
          reads.deletes.push(() => resolve({ success: true, remaining: 0 }));
        }),
      rename: unused,
      registerBegin: unused,
      registerComplete: unused,
    },
    totpClient: {
      status: () =>
        held("totp", (profile) => ({
          enrolled: true,
          label: `App of ${profile}`,
          lastUsedAt: null,
          createdAt: 1_700_000_000,
        })),
      enrollBegin: unused,
      enrollComplete: unused,
      disable: unused,
    },
    recoveryClient: {
      getRecoveryCodesStatus: () =>
        held("recovery", (profile) => {
          const n = Number(/\d+/.exec(profile)?.[0] ?? 0);
          return { active: n, total: 10, generatedAt: null };
        }),
      generateRecoveryCodes: unused,
    },
    stepUpClient: {
      passkeyBegin: () => Promise.resolve({ options: { challenge: "abc" } }),
      passkeyComplete: () => Promise.resolve({ token: "stpup_x", expiresIn: 300 }),
      emailBegin: unused,
      emailStatus: unused,
      emailResend: unused,
      totpComplete: unused,
    },
  };
});
vi.mock("../../src/lib/webauthn-ceremony", () => ({
  runPasskeyCeremony: () => Promise.resolve({ id: "cred", rawId: "cred" }),
}));
vi.mock("../../src/lib/webauthn-registration", () => ({ runPasskeyRegistration: () => {} }));

import SecuritySection from "../../src/components/SecuritySection";

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
  const end = () => {
    world.account = null;
    world.profile = null;
    for (const listener of listeners) listener({ kind: "ended" });
  };
  const reset = (profileId: string) => {
    world.profile = profileId;
    for (const listener of listeners) listener({ kind: "profile-reset", profileId });
  };
  return { runtime, end, reset };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Answers every read out for `profile`, once the tab's three are out. */
async function answer(profile: string) {
  await waitFor(() =>
    expect(reads.out.filter((r) => r.profile === profile).length).toBeGreaterThanOrEqual(3),
  );
  await flush(profile);
}

/** Answers whatever reads are out for `profile`, the step-up sheet's among them. */
async function flush(profile: string) {
  for (const read of reads.out.filter((r) => r.profile === profile)) {
    reads.out.splice(reads.out.indexOf(read), 1);
    read.resolve();
  }
  await settle();
}

/** Every profile id the tab draws: its passkey, its authenticator, its recovery count. */
const DRAWN = /(?:Key|App) of prof_(\d+)|(\d+) of 10 codes unused/g;

afterEach(() => {
  cleanup();
  reads.out.length = 0;
  reads.deletes.length = 0;
  world.account = null;
  world.profile = null;
});

it("F14, F15: no session is shown the Security rows of the one before it", async () => {
  world.account = "acc_a";
  world.profile = "prof_1";
  const { runtime, end, reset } = fakeRuntime();
  let auth!: ReturnType<typeof useAuth>;
  const [shown, setShown] = createSignal(true);
  render(() => (
    <AuthProvider auth={runtime}>
      {(() => {
        auth = useAuth();
        return null;
      })()}
      <Show when={shown()}>
        <SecuritySection profileId="prof_1" />
      </Show>
    </AuthProvider>
  ));

  let step = "a";
  const drawn = new Map<string, Set<string>>();
  const file = (records: MutationRecord[]) => {
    for (const record of records) {
      const texts =
        record.type === "characterData"
          ? [record.target.textContent ?? ""]
          : [...record.addedNodes].map((node) => node.textContent ?? "");
      for (const text of texts) {
        for (const match of text.matchAll(DRAWN)) {
          const who = `prof_${match[1] ?? match[2]}`;
          drawn.set(step, (drawn.get(step) ?? new Set()).add(who));
        }
      }
    }
  };
  const observer = new MutationObserver(file);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const begin = (next: string) => {
    file(observer.takeRecords());
    step = next;
  };

  await answer("prof_1");
  await screen.findByText("Key of prof_1");

  begin("shown again");
  setShown(false);
  setShown(true);
  expect(screen.getByText("Key of prof_1")).toBeTruthy();
  await answer("prof_1");

  begin("switch");
  await auth.switchProfile("prof_2");
  await settle();
  expect(screen.queryByText("Key of prof_1")).toBeNull();
  await answer("prof_2");
  await screen.findByText("Key of prof_2");

  begin("sign out");
  await auth.logout();
  await settle();
  expect(screen.queryByText("Key of prof_2")).toBeNull();

  begin("another account");
  await auth.adoptSession(sessionFor("acc_c", "prof_3"));
  await settle();
  expect(document.body.textContent).not.toMatch(/of prof_[12](?!\d)/);
  await answer("prof_3");
  await screen.findByText("Key of prof_3");

  begin("ended");
  end();
  await settle();
  expect(screen.queryByText("Key of prof_3")).toBeNull();
  await auth.adoptSession(sessionFor("acc_d", "prof_4"));
  await settle();
  expect(document.body.textContent).not.toMatch(/of prof_3(?!\d)/);
  await answer("prof_4");
  await screen.findByText("Key of prof_4");

  begin("profile reset");
  reset("prof_5");
  await settle();
  expect(screen.queryByText("Key of prof_4")).toBeNull();
  await answer("prof_5");
  await screen.findByText("Key of prof_5");
  begin("done");
  observer.disconnect();

  expect(Object.fromEntries([...drawn].map(([k, v]) => [k, [...v].toSorted()]))).toEqual({
    a: ["prof_1"],
    "shown again": ["prof_1"],
    switch: ["prof_2"],
    "another account": ["prof_3"],
    ended: ["prof_4"],
    "profile reset": ["prof_5"],
  });
});

it("F16: a delete that answers after its account has gone writes nothing into the next", async () => {
  world.account = "acc_d";
  world.profile = "prof_6";
  const { runtime } = fakeRuntime();
  let auth!: ReturnType<typeof useAuth>;
  render(() => (
    <AuthProvider auth={runtime}>
      {(() => {
        auth = useAuth();
        return null;
      })()}
      <SecuritySection profileId="prof_6" />
    </AuthProvider>
  ));
  await answer("prof_6");
  (await screen.findByRole("button", { name: "Remove Key of prof_6" })).click();
  const sheet = await screen.findByRole("dialog");
  // The sheet reads whether an authenticator is set up.
  await waitFor(() => expect(reads.out.some((r) => r.name === "totp")).toBe(true));
  await flush("prof_6");
  (await within(sheet).findByRole("button", { name: /Use passkey/i })).click();
  await waitFor(() => expect(reads.deletes).toHaveLength(1));

  await auth.logout();
  await settle();
  await auth.adoptSession(sessionFor("acc_e", "prof_7"));
  await answer("prof_7");
  await screen.findByText("Same id as prof_6's");

  // prof_6's delete answers. Its outcome (that id gone) is never written into
  // prof_7's list: the list is forgotten and read again instead.
  reads.deletes[0]!();
  await settle();
  const outcomeWritten =
    screen.queryByText("Key of prof_7") !== null &&
    screen.queryByText("Same id as prof_6's") === null;
  expect(outcomeWritten).toBe(false);
  expect(document.body.textContent).not.toMatch(/of prof_6(?!\d)/);
  await answer("prof_7");
  expect(await screen.findByText("Same id as prof_6's")).toBeTruthy();
  expect(screen.getByText("Key of prof_7")).toBeTruthy();
});
