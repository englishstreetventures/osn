/**
 * A passkey's signature counter only moves forward. The verifier refuses an
 * assertion whose counter is not above the stored one (unless both are 0, a
 * counterless authenticator), and the write holds the same rule: of two
 * assertions verified against one stored counter, the second to write is
 * refused, as it is when they arrive one after the other. A passkey deleted
 * between the read and the write is refused by the same statement.
 */

import { it, expect, describe } from "@effect/vitest";
import { passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll, beforeEach, vi } from "vitest";

/** The counters the next assertions report, in the order they are verified. */
const nextCounters = vi.hoisted(() => [] as number[]);

// The verifier is stubbed: a unit test cannot produce a real assertion. The
// stub applies the library's own counter rule (`@simplewebauthn/server`
// 13.3.3, `verifyAuthenticationResponse.js:144-151`) to the counter it is given.
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
        credentialBackedUp: false,
        credentialDeviceType: "singleDevice",
      },
    })),
    verifyAuthenticationResponse: vi.fn(async (options: { credential: { counter: number } }) => {
      const counter = nextCounters.shift() ?? 0;
      const stored = options.credential.counter;
      if ((counter > 0 || stored > 0) && counter <= stored) {
        throw new Error(`Response counter value ${counter} was lower than expected ${stored}`);
      }
      return { verified: true, authenticationInfo: { newCounter: counter } };
    }),
  };
});

const { createAuthService } = await import("../../../src/services/auth");
const { makeTestAuthConfig } = await import("../../helpers/auth-config");
const { createTestLayerWithSqlite } = await import("../../helpers/db");
const { holdQueries } = await import("../../helpers/held-query");

let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  auth = createAuthService(await makeTestAuthConfig());
});

beforeEach(() => {
  nextCounters.length = 0;
});

function harness() {
  const { db, sqlite, email } = createTestLayerWithSqlite();
  const queries = holdQueries(db);
  return {
    layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
    hold: queries.hold,
    db,
    counterOf: (credentialId: string) =>
      (
        sqlite.query("SELECT counter FROM passkeys WHERE credential_id = ?").get(credentialId) as {
          counter: number;
        } | null
      )?.counter,
  };
}

const attestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

const assertion = (credentialId: string) =>
  ({
    id: credentialId,
    rawId: credentialId,
    response: {},
    type: "public-key",
    clientExtensionResults: {},
  }) as never;

/** An account with one passkey whose stored counter is `counter`. */
const withPasskey = (h: ReturnType<typeof harness>, handle: string, counter: number) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
    yield* auth.beginPasskeyRegistration(profile.accountId);
    const { passkeyId } = yield* auth.completePasskeyRegistration(
      profile.accountId,
      attestation(),
      null,
    );
    yield* Effect.promise(() =>
      h.db.update(passkeys).set({ counter }).where(eq(passkeys.id, passkeyId)),
    );
    const [row] = yield* Effect.promise(() =>
      h.db.select().from(passkeys).where(eq(passkeys.id, passkeyId)),
    );
    return { profile, credentialId: row!.credentialId };
  });

const WRITE = /^update "passkeys" set "counter"/;

describe("passkey sign-in: two assertions verified against one counter", () => {
  it.live("the one that writes second is refused, and the counter stays the higher", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { profile, credentialId } = yield* withPasskey(h, "pkclogin", 5);
      nextCounters.push(6, 7);

      yield* auth.beginPasskeyLogin(profile.handle);
      const write = h.hold(WRITE);
      const late = yield* Effect.forkChild(
        Effect.result(
          auth.completePasskeyLoginDirect({
            identifier: profile.handle,
            assertion: assertion(credentialId),
          }),
        ),
      );
      yield* Effect.promise(() => write.reached);
      yield* auth.beginPasskeyLogin(profile.handle);
      yield* auth.completePasskeyLoginDirect({
        identifier: profile.handle,
        assertion: assertion(credentialId),
      });
      write.release();

      const outcome = yield* Fiber.join(late);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure.message).toBe("Passkey verification failed");
      expect(h.counterOf(credentialId)).toBe(7);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a passkey deleted between the read and the write signs nothing in", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { profile, credentialId } = yield* withPasskey(h, "pkcgone", 5);
      nextCounters.push(6);

      yield* auth.beginPasskeyLogin(profile.handle);
      const write = h.hold(WRITE);
      const login = yield* Effect.forkChild(
        Effect.result(
          auth.completePasskeyLoginDirect({
            identifier: profile.handle,
            assertion: assertion(credentialId),
          }),
        ),
      );
      yield* Effect.promise(() => write.reached);
      yield* Effect.promise(() =>
        h.db.delete(passkeys).where(eq(passkeys.credentialId, credentialId)),
      );
      write.release();

      const outcome = yield* Fiber.join(login);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure.message).toBe("Passkey verification failed");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a counterless authenticator (0, and 0 stored) signs in every time", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { profile, credentialId } = yield* withPasskey(h, "pkczero", 0);
      nextCounters.push(0, 0);
      for (const _ of [0, 1]) {
        yield* auth.beginPasskeyLogin(profile.handle);
        yield* auth.completePasskeyLoginDirect({
          identifier: profile.handle,
          assertion: assertion(credentialId),
        });
      }
      expect(h.counterOf(credentialId)).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("passkey step-up: two assertions verified against one counter", () => {
  it.live("the one that writes second is refused, and no step-up token is issued", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { profile, credentialId } = yield* withPasskey(h, "pkcstep", 5);
      nextCounters.push(6, 7);

      yield* auth.beginStepUpPasskey(profile.accountId);
      const write = h.hold(WRITE);
      const late = yield* Effect.forkChild(
        Effect.result(auth.completeStepUpPasskey(profile.accountId, assertion(credentialId))),
      );
      yield* Effect.promise(() => write.reached);
      yield* auth.beginStepUpPasskey(profile.accountId);
      yield* auth.completeStepUpPasskey(profile.accountId, assertion(credentialId));
      write.release();

      const outcome = yield* Fiber.join(late);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure.message).toBe("Passkey verification failed");
      expect(h.counterOf(credentialId)).toBe(7);
    }).pipe(Effect.provide(h.layer));
  });
});
