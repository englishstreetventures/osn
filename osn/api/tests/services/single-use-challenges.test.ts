/**
 * A WebAuthn challenge is single use: of two presentations of one assertion
 * (or attestation) sent at once, exactly one reaches verification. A `get`
 * followed by a `delete` does not give that — both requests can read the
 * challenge before either delete lands, and both then verify, since a synced
 * passkey's counter does not move. The ceremonies read and remove the
 * challenge in one call (`take`).
 *
 * Run on the Durable Object bundle over a stand-in namespace, with every call
 * that reads an entry answering a few milliseconds late, as a round trip does,
 * so the two requests' reads overlap however the rest is scheduled.
 */

import { it, expect, describe } from "@effect/vitest";
import { passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeAll, vi } from "vitest";

// Both WebAuthn verifiers are stubbed to accept: a unit test cannot produce a
// real assertion, and what is under test is what reaches them, not them.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: `cred-${Math.random().toString(16).slice(2, 12)}`,
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: undefined,
        },
        aaguid: "00000000-0000-0000-0000-000000000000",
        credentialBackedUp: true,
        credentialDeviceType: "multiDevice",
      },
    })),
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    })),
  };
});

const { createDurableCoordination } = await import("../../src/lib/coordination/durable");
const { createAuthService } = await import("../../src/services/auth");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createFakeNamespace } = await import("../helpers/coordination-namespace");
const { createTestLayer } = await import("../helpers/db");

import type { CeremonyStore } from "../../src/lib/ceremony-store";
import type { CeremonyStores } from "../../src/services/auth/stores";

const READ_DELAY_MS = 10;

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

const late = <A>(run: Promise<A>): Promise<A> =>
  run.then((value) => new Promise((resolve) => setTimeout(() => resolve(value), READ_DELAY_MS)));

/** `stores` with every call that reads an entry answering `READ_DELAY_MS` late. */
function slowReads(stores: CeremonyStores): CeremonyStores {
  const out = {} as Record<keyof CeremonyStores, unknown>;
  for (const [name, store] of Object.entries(stores) as [
    keyof CeremonyStores,
    CeremonyStore<unknown>,
  ][]) {
    out[name] = {
      ...store,
      get: (key: string) => late(store.get(key)),
      guess: (key: string) => late(store.guess(key)),
      take: (key: string) => late(store.take(key)),
    };
  }
  return out as CeremonyStores;
}

function harness() {
  const bundle = createDurableCoordination(createFakeNamespace().ns, () => {});
  return createAuthService({ ...base, ceremonyStores: slowReads(bundle.ceremonyStores) });
}

const fakeAttestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

const fakeAssertion = (credentialId: string) =>
  ({
    id: credentialId,
    rawId: credentialId,
    response: {},
    type: "public-key",
    clientExtensionResults: {},
  }) as never;

/** Register an account with one passkey; answers its ids and the credential id. */
const accountWithPasskey = (auth: ReturnType<typeof createAuthService>, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
    yield* auth.beginPasskeyRegistration(profile.accountId);
    const { passkeyId } = yield* auth.completePasskeyRegistration(
      profile.accountId,
      fakeAttestation(),
      null,
    );
    const { db } = yield* Db;
    const rows = yield* Effect.promise(() =>
      db
        .select({ credentialId: passkeys.credentialId })
        .from(passkeys)
        .where(eq(passkeys.id, passkeyId)),
    );
    return { profile, credentialId: rows[0]!.credentialId };
  });

const successes = (results: readonly { readonly _tag: string }[]): number =>
  results.filter((r) => r._tag === "Success").length;

describe("one WebAuthn challenge, two presentations at once", () => {
  it.live("passkey sign-in: exactly one signs in", () => {
    const auth = harness();
    return Effect.gen(function* () {
      const { profile, credentialId } = yield* accountWithPasskey(auth, "suclogin");
      yield* auth.beginPasskeyLogin(profile.handle);
      const results = yield* Effect.all(
        [0, 1].map(() =>
          Effect.result(
            auth.completePasskeyLoginDirect({
              identifier: profile.handle,
              assertion: fakeAssertion(credentialId),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      expect(successes(results)).toBe(1);
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("passkey registration: exactly one credential is added", () => {
    const auth = harness();
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sucreg@example.com", "sucreg");
      yield* auth.beginPasskeyRegistration(profile.accountId);
      const results = yield* Effect.all(
        [0, 1].map(() =>
          Effect.result(
            auth.completePasskeyRegistration(profile.accountId, fakeAttestation(), null),
          ),
        ),
        { concurrency: "unbounded" },
      );
      expect(successes(results)).toBe(1);
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select().from(passkeys).where(eq(passkeys.accountId, profile.accountId)),
      );
      expect(rows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("step-up passkey: exactly one step-up token is minted", () => {
    const auth = harness();
    return Effect.gen(function* () {
      const { profile, credentialId } = yield* accountWithPasskey(auth, "sucstep");
      yield* auth.beginStepUpPasskey(profile.accountId);
      const results = yield* Effect.all(
        [0, 1].map(() =>
          Effect.result(auth.completeStepUpPasskey(profile.accountId, fakeAssertion(credentialId))),
        ),
        { concurrency: "unbounded" },
      );
      expect(successes(results)).toBe(1);
    }).pipe(Effect.provide(createTestLayer()));
  });
});
