import { it, expect, describe } from "@effect/vitest";
import { recoveryCodes } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
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

// T-U2 — countActiveRecoveryCodes SQL-aggregate rewrite (P-I1).
describe("countActiveRecoveryCodes", () => {
  it.effect("returns {active: 9, total: 10} after one code is consumed", () =>
    Effect.gen(function* () {
      const profile = yield* registered("count-a@example.com", "counta");
      const { recoveryCodes: codes } = yield* auth.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      yield* auth.consumeRecoveryCode("count-a@example.com", codes[0]!);
      const counts = yield* auth.countActiveRecoveryCodes(profile.accountId);
      expect(counts).toEqual({ active: 9, total: 10 });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "returns {active: 0, total: 0} for a fresh account with no codes (SUM-over-zero-rows NULL coalesce)",
    () =>
      Effect.gen(function* () {
        const profile = yield* registered("count-none@example.com", "countnone");
        // No generateRecoveryCodesForAccount call — zero recovery_codes rows, so
        // the SQL SUM aggregate yields NULL and must coalesce to 0, not NaN.
        const counts = yield* auth.countActiveRecoveryCodes(profile.accountId);
        expect(counts).toEqual({ active: 0, total: 0 });
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

// ---------------------------------------------------------------------------
// O2 — per-account recovery-code lockout
// ---------------------------------------------------------------------------
describe("O2 recovery-code lockout", () => {
  // Fresh service per test so the in-memory lockout counter starts clean.
  const freshAuth = () => createAuthService(config);

  it.effect("5 fails then a correct code is still rejected (locked)", () =>
    Effect.gen(function* () {
      const svc = freshAuth();
      const profile = yield* svc.registerProfile("lock-a@example.com", "locka");
      const { recoveryCodes: codes } = yield* svc.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      // 5 wrong guesses → trips the lockout.
      for (let i = 0; i < 5; i++) {
        const err = yield* Effect.flip(
          svc.consumeRecoveryCode("lock-a@example.com", "dead-beef-cafe-0000"),
        );
        expect(err._tag).toBe("AuthError");
      }
      // A genuinely valid code is now rejected with the SAME generic error.
      const lockedErr = yield* Effect.flip(
        svc.consumeRecoveryCode("lock-a@example.com", codes[0]!),
      );
      expect(lockedErr._tag).toBe("AuthError");
      expect(lockedErr.message).toBe("Invalid request");

      // T-E1: the locked branch must be READ-ONLY — the correct code presented
      // while locked must NOT have been consumed. Every recovery_codes row for
      // the account still has used_at IS NULL.
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db
          .select({ usedAt: recoveryCodes.usedAt })
          .from(recoveryCodes)
          .where(eq(recoveryCodes.accountId, profile.accountId)),
      );
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.usedAt).toBeNull();
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a successful consume resets the counter", () =>
    Effect.gen(function* () {
      const svc = freshAuth();
      const profile = yield* svc.registerProfile("lock-reset@example.com", "lockreset");
      const { recoveryCodes: codes } = yield* svc.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      // 4 fails (one below threshold), then a success resets the counter.
      for (let i = 0; i < 4; i++) {
        yield* Effect.flip(
          svc.consumeRecoveryCode("lock-reset@example.com", "dead-beef-cafe-0000"),
        );
      }
      yield* svc.consumeRecoveryCode("lock-reset@example.com", codes[0]!);
      // After the reset, 4 more fails still don't lock (would need 5 fresh).
      for (let i = 0; i < 4; i++) {
        yield* Effect.flip(
          svc.consumeRecoveryCode("lock-reset@example.com", "dead-beef-cafe-0000"),
        );
      }
      // The 9th remaining valid code still works → not locked.
      yield* svc.consumeRecoveryCode("lock-reset@example.com", codes[1]!);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("lockout is isolated per account", () =>
    Effect.gen(function* () {
      const svc = freshAuth();
      const victim = yield* svc.registerProfile("lock-victim@example.com", "lockvictim");
      const other = yield* svc.registerProfile("lock-other@example.com", "lockother");
      const { recoveryCodes: otherCodes } = yield* svc.generateRecoveryCodesForAccount(
        other.accountId,
      );
      yield* svc.generateRecoveryCodesForAccount(victim.accountId);
      // Lock the victim out.
      for (let i = 0; i < 5; i++) {
        yield* Effect.flip(
          svc.consumeRecoveryCode("lock-victim@example.com", "dead-beef-cafe-0000"),
        );
      }
      // The other account is unaffected — a valid code still works.
      yield* svc.consumeRecoveryCode("lock-other@example.com", otherCodes[0]!);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("unknown-identifier fails never lock a real account", () =>
    Effect.gen(function* () {
      const svc = freshAuth();
      const profile = yield* svc.registerProfile("lock-unknown@example.com", "lockunknown");
      const { recoveryCodes: codes } = yield* svc.generateRecoveryCodesForAccount(
        profile.accountId,
      );
      // 10 attempts against an identifier that resolves to NO account — these
      // must not move any per-account counter.
      for (let i = 0; i < 10; i++) {
        yield* Effect.flip(svc.consumeRecoveryCode("ghost@example.com", "dead-beef-cafe-0000"));
      }
      // The real account is not locked — its valid code still works.
      yield* svc.consumeRecoveryCode("lock-unknown@example.com", codes[0]!);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("writes a recovery_code_lockout security-event row on lockout", () =>
    Effect.gen(function* () {
      const svc = freshAuth();
      const profile = yield* svc.registerProfile("lock-sev@example.com", "locksev");
      yield* svc.generateRecoveryCodesForAccount(profile.accountId);
      for (let i = 0; i < 5; i++) {
        yield* Effect.flip(svc.consumeRecoveryCode("lock-sev@example.com", "dead-beef-cafe-0000"));
      }
      const { events } = yield* svc.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events.some((e) => e.kind === "recovery_code_lockout")).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
