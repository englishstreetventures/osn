import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Email-change ceremony:
 *   • begin sends a code to the NEW email (verifying deliverability).
 *   • complete requires BOTH the OTP AND a valid step-up token.
 *   • On success every OTHER session is revoked atomically with the
 *     accounts.email swap.
 *   • Hard cap of 2 successful changes per trailing 7 days — honours
 *     typo-and-correction but blocks account-stuffing churn.
 */

let baseConfig: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  baseConfig = await makeTestAuthConfig();
});

/** Shared helper: register and mint a step-up token via the OTP ceremony. */
const setup = (email: string, handle: string) =>
  Effect.gen(function* () {
    const captured: string[] = [];
    const auth = createAuthService({
      ...baseConfig,
      sendEmail: async (_to, _subject, body) => {
        const m = body.match(/code is: (\d{6})/);
        if (m) captured.push(m[1]!);
      },
    });
    const profile = yield* auth.registerProfile(email, handle);
    yield* auth.beginStepUpOtp(profile.accountId);
    const stepUpCode = captured[captured.length - 1]!;
    const { stepUpToken } = yield* auth.completeStepUpOtp(profile.accountId, stepUpCode);
    return { auth, profile, captured, stepUpToken };
  });

describe("beginEmailChange + completeEmailChange", () => {
  it.effect("happy path: swaps email, returns the new address, revokes other sessions", () =>
    Effect.gen(function* () {
      const { auth, profile, captured, stepUpToken } = yield* setup(
        "ec-happy@example.com",
        "echappy",
      );

      // Caller's "current" session; should survive the change.
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // Another device.
      const other = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      yield* auth.beginEmailChange(profile.accountId, "ec-happy-new@example.com");
      const otpCode = captured[captured.length - 1]!;
      const result = yield* auth.completeEmailChange(
        profile.accountId,
        otpCode,
        stepUpToken,
        auth.hashSessionToken(me.refreshToken),
      );
      expect(result.email).toBe("ec-happy-new@example.com");

      // Current session survives; other is gone.
      yield* auth.verifyRefreshToken(me.refreshToken);
      const err = yield* Effect.flip(auth.verifyRefreshToken(other.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects a missing / invalid step-up token", () =>
    Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-nostepup@example.com", "ecnostepup");
      yield* auth.beginEmailChange(profile.accountId, "ec-nostepup-new@example.com");
      const err = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, "000000", "not.a.jwt", null),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // S-H2: begin must NOT reveal collisions — silently returns { sent: true }
  // so an authenticated caller cannot enumerate other users' email addresses.
  it.effect("silently succeeds on collision (no enumeration oracle)", () =>
    Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup("ec-conflict@example.com", "ecconflict");
      // Reserve the target address with another account.
      yield* auth.registerProfile("ec-target@example.com", "ectarget");

      const result = yield* auth.beginEmailChange(profile.accountId, "ec-target@example.com");
      expect(result.sent).toBe(true);
      // The complete step would still reject the collision via UNIQUE(email),
      // so the protection is where it matters — on the write.
      void stepUpToken;
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("enforces 2-per-7-days cap", () =>
    Effect.gen(function* () {
      const captured: string[] = [];
      const auth = createAuthService({
        ...baseConfig,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) captured.push(m[1]!);
        },
      });
      const profile = yield* auth.registerProfile("ec-cap@example.com", "eccap");

      const issueStepUp = Effect.gen(function* () {
        yield* auth.beginStepUpOtp(profile.accountId);
        const code = captured[captured.length - 1]!;
        const { stepUpToken } = yield* auth.completeStepUpOtp(profile.accountId, code);
        return stepUpToken;
      });

      const performChange = (newEmail: string) =>
        Effect.gen(function* () {
          const stepUpToken = yield* issueStepUp;
          yield* auth.beginEmailChange(profile.accountId, newEmail);
          const code = captured[captured.length - 1]!;
          return yield* auth.completeEmailChange(profile.accountId, code, stepUpToken, null);
        });

      yield* performChange("ec-cap-1@example.com");
      yield* performChange("ec-cap-2@example.com");
      // Third change inside 7 days must be rejected.
      const err = yield* Effect.flip(performChange("ec-cap-3@example.com"));
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/limit reached/i);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
