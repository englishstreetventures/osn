import { it, expect, describe } from "@effect/vitest";
import { EmailError, EmailService, makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
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

/** Fresh email recorder + merged test layer. Replaces the old sendEmail callback. */
function makeEmailCapture() {
  const email = makeLogEmailLive();
  return {
    layer: Layer.merge(createTestLayer(), email.layer),
    latest: (): string | undefined => {
      const all = email.recorded();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i].text.match(/step-up code is: (\d{6})/);
        if (m) return m[1];
      }
      return undefined;
    },
  };
}

const registered = (email: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(email, handle);
    return profile;
  });

describe("step-up OTP ceremony", () => {
  it.effect("begin + complete mints a token that /recovery/generate accepts", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-otp@example.com", "suotp");
      yield* auth.beginStepUpOtp(profile.accountId);
      expect(cap.latest()).toMatch(/^\d{6}$/);

      const { stepUpToken } = yield* auth.completeStepUpOtp(profile.accountId, cap.latest()!);
      expect(stepUpToken).toMatch(/^eyJ/);

      // Accepted by the /recovery/generate gate.
      yield* auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken);
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("wrong account rejects a token issued for another", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const alice = yield* registered("su-cross-a@example.com", "sucrossa");
      const bob = yield* registered("su-cross-b@example.com", "sucrossb");

      yield* auth.beginStepUpOtp(alice.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(alice.accountId, cap.latest()!);

      // Alice's token must NOT pass when Bob is the caller.
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(bob.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("jti replay is rejected", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-replay@example.com", "sureplay");
      yield* auth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(profile.accountId, cap.latest()!);

      // First verification succeeds.
      yield* auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken);
      // Second verification on the same jti fails.
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("expired / wrong code is rejected with a generic error", () =>
    Effect.gen(function* () {
      const profile = yield* registered("su-expire@example.com", "suexpire");
      yield* auth.beginStepUpOtp(profile.accountId);
      const err = yield* Effect.flip(auth.completeStepUpOtp(profile.accountId, "000000"));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("amr-not-allowed is enforced by the verifier", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-amr@example.com", "suamr");
      // Narrow the recovery-generate allow-list to webauthn only so an
      // OTP-amr token must be refused.
      const strictAuth = createAuthService({
        ...config,
        recoveryGenerateAllowedAmr: ["webauthn"],
      });
      yield* strictAuth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* strictAuth.completeStepUpOtp(profile.accountId, cap.latest()!);
      const err = yield* Effect.flip(
        strictAuth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  // T-S1: 5-min TTL is the containment window. A regression that drops the
  // `exp` claim or mis-sets the TTL would silently weaken the threat model.
  // Use a 1-second TTL so the real-clock wait is cheap. `Effect.sleep` runs
  // synchronously under the default test runtime, so we use a Promise-based
  // delay (yielded via Effect.promise) to actually advance wall time.
  it.effect(
    "expired token is rejected",
    () => {
      const cap = makeEmailCapture();
      return Effect.gen(function* () {
        const profile = yield* registered("su-expiry@example.com", "suexpiry");
        const shortTtlAuth = createAuthService({
          ...config,
          stepUpTokenTtl: 1,
        });
        yield* shortTtlAuth.beginStepUpOtp(profile.accountId);
        const { stepUpToken } = yield* shortTtlAuth.completeStepUpOtp(
          profile.accountId,
          cap.latest()!,
        );
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 1100)));
        const err = yield* Effect.flip(
          shortTtlAuth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
        );
        expect(err._tag).toBe("AuthError");
      }).pipe(Effect.provide(cap.layer));
    },
    { timeout: 10_000 },
  );

  it.effect(
    "T-M2: begin fails with AuthError (not EmailError) when email transport rejects",
    () => {
      const failingEmailLayer = Layer.succeed(EmailService, {
        send: () =>
          Effect.fail(new EmailError({ reason: "dispatch_failed", cause: "simulated failure" })),
      });
      const layer = Layer.merge(createTestLayer(), failingEmailLayer);
      return Effect.gen(function* () {
        const profile = yield* registered("su-fail-email@example.com", "sufailmail");
        const err = yield* Effect.flip(auth.beginStepUpOtp(profile.accountId));
        expect(err._tag).toBe("AuthError");
        expect(err.message).toContain("dispatch_failed");
      }).pipe(Effect.provide(layer));
    },
  );
});
