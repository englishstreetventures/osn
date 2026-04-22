import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Step-up tokens must:
 *   • Be scoped to a specific account (`sub` match).
 *   • Carry an `amr` claim the verifier checks against a caller-supplied
 *     allow-list (so /recovery/generate can accept webauthn+otp, while
 *     a future /account/delete path could narrow to webauthn-only).
 *   • Be single-use (jti replay guard) so a log leak doesn't grant two
 *     bites at a sensitive action.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

const registered = (email: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(email, handle);
    return profile;
  });

describe("step-up OTP ceremony", () => {
  it.effect("begin + complete mints a token that /recovery/generate accepts", () =>
    Effect.gen(function* () {
      const profile = yield* registered("su-otp@example.com", "suotp");
      let captured: string | undefined;
      const captureAuth = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/step-up code is: (\d{6})/);
          if (m) captured = m[1];
        },
      });

      yield* captureAuth.beginStepUpOtp(profile.accountId);
      expect(captured).toMatch(/^\d{6}$/);

      const { stepUpToken } = yield* captureAuth.completeStepUpOtp(profile.accountId, captured!);
      expect(stepUpToken).toMatch(/^eyJ/);

      // Accepted by the /recovery/generate gate.
      yield* auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("wrong account rejects a token issued for another", () =>
    Effect.gen(function* () {
      const alice = yield* registered("su-cross-a@example.com", "sucrossa");
      const bob = yield* registered("su-cross-b@example.com", "sucrossb");

      let aliceCode: string | undefined;
      const captureAuth = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/step-up code is: (\d{6})/);
          if (m) aliceCode = m[1];
        },
      });
      yield* captureAuth.beginStepUpOtp(alice.accountId);
      const { stepUpToken } = yield* captureAuth.completeStepUpOtp(alice.accountId, aliceCode!);

      // Alice's token must NOT pass when Bob is the caller.
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(bob.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("jti replay is rejected", () =>
    Effect.gen(function* () {
      const profile = yield* registered("su-replay@example.com", "sureplay");
      let captured: string | undefined;
      const captureAuth = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/step-up code is: (\d{6})/);
          if (m) captured = m[1];
        },
      });
      yield* captureAuth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* captureAuth.completeStepUpOtp(profile.accountId, captured!);

      // First verification succeeds.
      yield* auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken);
      // Second verification on the same jti fails.
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("expired / wrong code is rejected with a generic error", () =>
    Effect.gen(function* () {
      const profile = yield* registered("su-expire@example.com", "suexpire");
      yield* auth.beginStepUpOtp(profile.accountId);
      const err = yield* Effect.flip(auth.completeStepUpOtp(profile.accountId, "000000"));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("amr-not-allowed is enforced by the verifier", () =>
    Effect.gen(function* () {
      const profile = yield* registered("su-amr@example.com", "suamr");
      let captured: string | undefined;
      const captureAuth = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/step-up code is: (\d{6})/);
          if (m) captured = m[1];
        },
        // Narrow the recovery-generate allow-list to webauthn only so an
        // OTP-amr token must be refused.
        recoveryGenerateAllowedAmr: ["webauthn"],
      });
      yield* captureAuth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* captureAuth.completeStepUpOtp(profile.accountId, captured!);
      const err = yield* Effect.flip(
        captureAuth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-S1: 5-min TTL is the containment window. A regression that drops the
  // `exp` claim or mis-sets the TTL would silently weaken the threat model.
  // Use a 1-second TTL so the real-clock wait is cheap. `Effect.sleep` runs
  // synchronously under the default test runtime, so we use a Promise-based
  // delay (yielded via Effect.promise) to actually advance wall time.
  it.effect(
    "expired token is rejected",
    () =>
      Effect.gen(function* () {
        const profile = yield* registered("su-expiry@example.com", "suexpiry");
        let captured: string | undefined;
        const shortTtlAuth = createAuthService({
          ...config,
          sendEmail: async (_to, _subject, body) => {
            const m = body.match(/step-up code is: (\d{6})/);
            if (m) captured = m[1];
          },
          stepUpTokenTtl: 1,
        });
        yield* shortTtlAuth.beginStepUpOtp(profile.accountId);
        const { stepUpToken } = yield* shortTtlAuth.completeStepUpOtp(profile.accountId, captured!);
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 1100)));
        const err = yield* Effect.flip(
          shortTtlAuth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
        );
        expect(err._tag).toBe("AuthError");
      }).pipe(Effect.provide(createTestLayer())),
    { timeout: 10_000 },
  );
});
