import { it, expect, describe } from "@effect/vitest";
import { passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll, vi } from "vitest";

// O4: `completePasskeyRegistration` runs a real WebAuthn attestation through
// `@simplewebauthn/server`, which we cannot produce in a unit test. We stub the
// verifier so the function reaches the session-invalidation branch this test
// pins. `generateRegistrationOptions` is left to produce a normal challenge.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: `cred-${Math.random().toString(16).slice(2, 10)}`,
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: undefined,
        },
        aaguid: "00000000-0000-0000-0000-000000000000",
        credentialBackedUp: false,
        credentialDeviceType: "singleDevice",
      },
    })),
  };
});

// Imported AFTER the mock is registered.
const { createAuthService } = await import("../../src/services/auth");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createTestLayer } = await import("../helpers/db");

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

const fakeAttestation = () =>
  ({
    id: "x",
    rawId: "x",
    response: {},
    type: "public-key",
    clientExtensionResults: {},
  }) as never;

describe("O4 completePasskeyRegistration session invalidation", () => {
  it.effect("with a caller session: keeps the caller, revokes other sessions", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("pkreg-keep@example.com", "pkregkeep");
      // Seed one existing passkey so the begin gate path is realistic, then
      // begin to plant the challenge for the (mocked) complete.
      const current = yield* auth.issueTokens(
        alice.id,
        alice.accountId,
        alice.email,
        alice.handle,
        alice.displayName,
      );
      const other = yield* auth.issueTokens(
        alice.id,
        alice.accountId,
        alice.email,
        alice.handle,
        alice.displayName,
      );

      yield* auth.beginPasskeyRegistration(alice.accountId);
      yield* auth.completePasskeyRegistration(
        alice.accountId,
        fakeAttestation(),
        current.refreshToken,
      );

      // Caller session survives; the other session is revoked (H1).
      yield* auth.verifyRefreshToken(current.refreshToken);
      const err = yield* Effect.flip(auth.verifyRefreshToken(other.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("cookieless (no caller session): nukes ALL account sessions (O4)", () =>
    Effect.gen(function* () {
      const bob = yield* auth.registerProfile("pkreg-nuke@example.com", "pkregnuke");
      const s1 = yield* auth.issueTokens(
        bob.id,
        bob.accountId,
        bob.email,
        bob.handle,
        bob.displayName,
      );
      const s2 = yield* auth.issueTokens(
        bob.id,
        bob.accountId,
        bob.email,
        bob.handle,
        bob.displayName,
      );

      yield* auth.beginPasskeyRegistration(bob.accountId);
      // No caller session token → the O4 else-branch must invalidate EVERY
      // session on the account (previously this was a silent no-op).
      yield* auth.completePasskeyRegistration(bob.accountId, fakeAttestation(), null);

      const e1 = yield* Effect.flip(auth.verifyRefreshToken(s1.refreshToken));
      const e2 = yield* Effect.flip(auth.verifyRefreshToken(s2.refreshToken));
      expect(e1._tag).toBe("AuthError");
      expect(e2._tag).toBe("AuthError");

      // No sessions remain for the account.
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select().from(passkeys).where(eq(passkeys.accountId, bob.accountId)),
      );
      // Sanity: the passkey was actually inserted (proves we reached the branch).
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-U1: pins the per-call-site template/kind wiring of the shared
  // notifySecurityEventByAccountId helper — a swapped template here would
  // pass every other test silently.
  it.effect("sends the passkey-added notification email on successful enrolment", () => {
    const email = makeLogEmailLive();
    const layer = Layer.merge(createTestLayer(), email.layer);
    return Effect.gen(function* () {
      const carol = yield* auth.registerProfile("pkreg-notify@example.com", "pkregnotify");
      yield* auth.beginPasskeyRegistration(carol.accountId);
      yield* auth.completePasskeyRegistration(carol.accountId, fakeAttestation(), null);

      // The notification is forkDaemon'd — wait for the fiber to complete.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)));

      const sent = email
        .recorded()
        .filter((e) => e.template === "passkey-added" && e.to === "pkreg-notify@example.com");
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
