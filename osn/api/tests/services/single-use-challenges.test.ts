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
import { accounts, passkeys } from "@osn/db/schema";
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
const { createServerMac } = await import("../../src/services/auth/server-mac");
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

/** The server secret the discoverable challenges are minted under, here. */
const PEPPER = "p".repeat(32);

function harness() {
  const fake = createFakeNamespace();
  const bundle = createDurableCoordination(fake.ns, () => {});
  const auth = createAuthService({
    ...base,
    sessionIpPepper: PEPPER,
    ceremonyStores: slowReads(bundle.ceremonyStores),
    passkeyChallengeClaims: bundle.passkeyChallengeClaims,
  });
  return { auth, fake, claims: bundle.passkeyChallengeClaims };
}

const base64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** An assertion whose `clientDataJSON` carries `challenge`, from the account `userId` names. */
const discoverableAssertion = (credentialId: string, challenge: string, userId: string) =>
  ({
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: base64url(
        JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:5173" }),
      ),
      userHandle: base64url(userId),
    },
    type: "public-key",
    clientExtensionResults: {},
  }) as never;

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
        .select({ credentialId: passkeys.credentialId, userId: accounts.passkeyUserId })
        .from(passkeys)
        .innerJoin(accounts, eq(accounts.id, passkeys.accountId))
        .where(eq(passkeys.id, passkeyId)),
    );
    return { profile, credentialId: rows[0]!.credentialId, userId: rows[0]!.userId };
  });

const successes = (results: readonly { readonly _tag: string }[]): number =>
  results.filter((r) => r._tag === "Success").length;

describe("one WebAuthn challenge, two presentations at once", () => {
  it.live("passkey sign-in: exactly one signs in", () => {
    const { auth } = harness();
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
    const { auth } = harness();
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
    const { auth } = harness();
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

  it.live("discoverable passkey sign-in: exactly one signs in", () => {
    const { auth } = harness();
    return Effect.gen(function* () {
      const { credentialId, userId } = yield* accountWithPasskey(auth, "sucdisc");
      const { challengeId } = yield* auth.beginPasskeyLogin(null);
      const assertion = discoverableAssertion(credentialId, challengeId!, userId);
      const results = yield* Effect.all(
        [0, 1].map(() =>
          Effect.result(auth.completePasskeyLoginDirect({ challengeId: challengeId!, assertion })),
        ),
        { concurrency: "unbounded" },
      );
      expect(successes(results)).toBe(1);
    }).pipe(Effect.provide(createTestLayer()));
  });
});

/**
 * The discoverable challenge carries its own proof, so `begin` stores nothing
 * and `complete` must refuse anything the server did not mint, has changed,
 * has expired, or is used a second time.
 */
describe("discoverable passkey challenge", () => {
  const refusal = (
    auth: ReturnType<typeof createAuthService>,
    challengeId: string,
    assertion: never,
  ) =>
    auth.completePasskeyLoginDirect({ challengeId, assertion }).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    );

  it.live("begin makes no store call and answers the challenge as its id", () => {
    const { auth, fake } = harness();
    return Effect.gen(function* () {
      const { options, challengeId } = yield* auth.beginPasskeyLogin(null);
      expect(fake.calls).toEqual([]);
      expect(challengeId).toBe(options.challenge);
      expect(createServerMac(PEPPER).openChallenge(options.challenge).ok).toBe(true);
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("signs in once with a fresh challenge, then refuses it", () => {
    const { auth, fake } = harness();
    return Effect.gen(function* () {
      const { credentialId, userId, profile } = yield* accountWithPasskey(auth, "discok");
      const { challengeId } = yield* auth.beginPasskeyLogin(null);
      const assertion = discoverableAssertion(credentialId, challengeId!, userId);
      const before = fake.calls.length;
      const first = yield* auth.completePasskeyLoginDirect({
        challengeId: challengeId!,
        assertion,
      });
      expect(first.profile.handle).toBe(profile.handle);
      expect(fake.calls.slice(before).map((c) => `${c.store}.${c.op}`)).toEqual([
        "passkey_challenge_claim.claim",
      ]);
      expect(yield* refusal(auth, challengeId!, assertion)).toBe("Challenge expired or not found");
    }).pipe(Effect.provide(createTestLayer()));
  });

  // The claim must outlive every moment any isolate could still accept the
  // challenge. An isolate whose clock runs behind the store's accepts it past
  // `expiresAt`, so a claim that ends exactly then lets a replay through.
  it.live("holds the nonce's claim for a minute after the challenge expires", () => {
    const { auth, claims } = harness();
    return Effect.gen(function* () {
      const { credentialId, userId } = yield* accountWithPasskey(auth, "discmargin");
      const { challengeId } = yield* auth.beginPasskeyLogin(null);
      const assertion = discoverableAssertion(credentialId, challengeId!, userId);
      yield* auth.completePasskeyLoginDirect({ challengeId: challengeId!, assertion });

      const opened = createServerMac(PEPPER).openChallenge(challengeId!);
      if (!opened.ok) throw new Error("the minted challenge does not open");
      const later = vi.spyOn(Date, "now").mockReturnValue(opened.expiresAt + 59_000);
      try {
        expect(yield* Effect.promise(() => claims.claim(opened.nonce, 1_000))).toBe(false);
      } finally {
        later.mockRestore();
      }
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("refuses a challenge with a changed byte", () => {
    const { auth } = harness();
    return Effect.gen(function* () {
      const { credentialId, userId } = yield* accountWithPasskey(auth, "discforged");
      const { challengeId } = yield* auth.beginPasskeyLogin(null);
      const bytes = Buffer.from(challengeId!, "base64url");
      bytes[30] = bytes[30]! ^ 0x01;
      const forged = bytes.toString("base64url");
      const assertion = discoverableAssertion(credentialId, forged, userId);
      expect(yield* refusal(auth, forged, assertion)).toBe("Challenge expired or not found");
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("refuses an expired challenge", () => {
    const { auth } = harness();
    return Effect.gen(function* () {
      const { credentialId, userId } = yield* accountWithPasskey(auth, "discexpired");
      const expired = Buffer.from(createServerMac(PEPPER).mintChallenge(Date.now() - 1)).toString(
        "base64url",
      );
      const assertion = discoverableAssertion(credentialId, expired, userId);
      expect(yield* refusal(auth, expired, assertion)).toBe("Challenge expired or not found");
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("refuses a challenge minted under another secret", () => {
    const { auth } = harness();
    return Effect.gen(function* () {
      const { credentialId, userId } = yield* accountWithPasskey(auth, "discother");
      const foreign = Buffer.from(
        createServerMac("q".repeat(32)).mintChallenge(Date.now() + 60_000),
      ).toString("base64url");
      const assertion = discoverableAssertion(credentialId, foreign, userId);
      expect(yield* refusal(auth, foreign, assertion)).toBe("Challenge expired or not found");
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("refuses when the signed challenge is not the one the client names", () => {
    const { auth } = harness();
    return Effect.gen(function* () {
      const { credentialId, userId } = yield* accountWithPasskey(auth, "discmismatch");
      const first = yield* auth.beginPasskeyLogin(null);
      const second = yield* auth.beginPasskeyLogin(null);
      const assertion = discoverableAssertion(credentialId, first.challengeId!, userId);
      expect(yield* refusal(auth, second.challengeId!, assertion)).toBe(
        "Challenge expired or not found",
      );
    }).pipe(Effect.provide(createTestLayer()));
  });

  it.live("refuses an assertion whose client data cannot be read", () => {
    const { auth } = harness();
    return Effect.gen(function* () {
      const { credentialId } = yield* accountWithPasskey(auth, "discunread");
      const { challengeId } = yield* auth.beginPasskeyLogin(null);
      expect(yield* refusal(auth, challengeId!, fakeAssertion(credentialId))).toBe(
        "Challenge expired or not found",
      );
    }).pipe(Effect.provide(createTestLayer()));
  });
});
