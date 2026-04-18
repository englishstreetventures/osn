import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

// Helper — register a profile and also return the accountId for convenience.
const registered = (email: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(email, handle);
    return profile;
  });

describe("generateRecoveryCodesForAccount", () => {
  it.effect("returns a fresh 10-code batch, format xxxx-xxxx-xxxx-xxxx", () =>
    Effect.gen(function* () {
      const profile = yield* registered("alice@example.com", "alice");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      expect(codes).toHaveLength(10);
      for (const c of codes) {
        expect(c).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
      }
      const active = yield* auth.countActiveRecoveryCodes(profile.accountId);
      expect(active.active).toBe(10);
      expect(active.total).toBe(10);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("regenerating replaces the previous set entirely", () =>
    Effect.gen(function* () {
      const profile = yield* registered("bob@example.com", "bob");
      const first = yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      const second = yield* auth.generateRecoveryCodesForAccount(profile.accountId);

      // Counts match after regenerate.
      const counts = yield* auth.countActiveRecoveryCodes(profile.accountId);
      expect(counts.total).toBe(10);

      // An old code from `first` should no longer consume.
      const result = yield* Effect.flip(
        auth.consumeRecoveryCode("bob@example.com", first.recoveryCodes[0]!),
      );
      expect(result._tag).toBe("AuthError");

      // A code from the new set works.
      yield* auth.consumeRecoveryCode("bob@example.com", second.recoveryCodes[0]!);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("consumeRecoveryCode", () => {
  it.effect("succeeds on first use and returns the right profile", () =>
    Effect.gen(function* () {
      const profile = yield* registered("carol@example.com", "carol");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      const { profile: consumed } = yield* auth.consumeRecoveryCode("carol@example.com", codes[0]!);
      expect(consumed.id).toBe(profile.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("reusing the same code fails (single-use)", () =>
    Effect.gen(function* () {
      const profile = yield* registered("dan@example.com", "dan");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      yield* auth.consumeRecoveryCode("dan@example.com", codes[0]!);
      const err = yield* Effect.flip(auth.consumeRecoveryCode("dan@example.com", codes[0]!));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("accepts identifier as handle", () =>
    Effect.gen(function* () {
      const profile = yield* registered("eve@example.com", "eve");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      yield* auth.consumeRecoveryCode("eve", codes[0]!);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("unknown identifier fails with generic AuthError", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        auth.consumeRecoveryCode("nobody@example.com", "abcd-1234-5678-ef00"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toBe("Invalid request");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // S-M2: known vs unknown identifier should present the same error AND
  // execute the same set of DB + hash work, so the caller can't distinguish
  // "identifier doesn't exist" from "code is wrong" via timing.
  it.effect("unknown identifier and wrong-code return the same generic error", () =>
    Effect.gen(function* () {
      const profile = yield* registered("same-error@example.com", "sameerr");
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);

      const unknown = yield* Effect.flip(
        auth.consumeRecoveryCode("nobody@example.com", "abcd-1234-5678-ef00"),
      );
      const wrong = yield* Effect.flip(
        auth.consumeRecoveryCode("same-error@example.com", "abcd-1234-5678-ef00"),
      );

      expect(unknown._tag).toBe("AuthError");
      expect(wrong._tag).toBe("AuthError");
      expect(unknown.message).toBe(wrong.message);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("wrong code for a known account fails with the same message", () =>
    Effect.gen(function* () {
      const profile = yield* registered("frank@example.com", "frank");
      yield* auth.generateRecoveryCodesForAccount(profile.accountId);
      const err = yield* Effect.flip(
        auth.consumeRecoveryCode("frank@example.com", "dead-beef-cafe-0000"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toBe("Invalid request");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("revokes all existing sessions on successful consume", () =>
    Effect.gen(function* () {
      const profile = yield* registered("gus@example.com", "gus");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );

      // Seed two active sessions for the account.
      const first = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const second = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Consume a recovery code.
      yield* auth.consumeRecoveryCode("gus@example.com", codes[0]!);

      // Both previous session tokens should now be invalid.
      const e1 = yield* Effect.flip(auth.verifyRefreshToken(first.refreshToken));
      const e2 = yield* Effect.flip(auth.verifyRefreshToken(second.refreshToken));
      expect(e1._tag).toBe("AuthError");
      expect(e2._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("completeRecoveryLogin", () => {
  it.effect("returns a fresh session + PublicProfile", () =>
    Effect.gen(function* () {
      const profile = yield* registered("hank@example.com", "hank");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      const result = yield* auth.completeRecoveryLogin("hank@example.com", codes[0]!);
      expect(result.profile.id).toBe(profile.id);
      expect(result.session.accessToken).toMatch(/^eyJ/);
      expect(result.session.refreshToken).toMatch(/^ses_/);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
