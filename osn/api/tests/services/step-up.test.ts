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
  // O1: with a 30s verifier clockTolerance, a 1.1s real-clock wait no longer
  // proves expiry rejection — the token would still be inside tolerance. We
  // forge a step-up token whose `exp` is well past the 30s window (but
  // otherwise valid: correct iss/aud/sub/amr/jti) so the assertion is
  // deterministic without a 31s sleep.
  it.effect("expired token is rejected (beyond clockTolerance)", () =>
    Effect.gen(function* () {
      const profile = yield* registered("su-expiry@example.com", "suexpiry");
      const { SignJWT } = yield* Effect.tryPromise(() => import("jose"));
      const nowSec = Math.floor(Date.now() / 1000);
      const expired = yield* Effect.tryPromise(() =>
        new SignJWT({
          sub: profile.accountId,
          aud: "osn-step-up",
          amr: ["otp"],
          jti: crypto.randomUUID(),
        })
          .setProtectedHeader({ alg: "ES256", kid: config.jwtKid })
          .setIssuer(config.issuerUrl)
          // iat + exp both 120s in the past — clear of the 30s tolerance.
          .setIssuedAt(nowSec - 120)
          .setExpirationTime(nowSec - 120)
          .sign(config.jwtPrivateKey),
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, expired),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
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

// T-S1: account deletion is the highest-stakes step-up consumer (Flow A —
// full account erasure) and had no direct coverage. Its verifier is the
// only purpose-REQUIRING gate on the recovery-AMR allow-list, so pin both
// directions of the S-C1 confused-deputy guard.
describe("verifyStepUpForAccountDelete (S-C1 purpose binding)", () => {
  it.effect("accepts a token minted with purpose account_delete", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-del@example.com", "sudel");
      yield* auth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(
        profile.accountId,
        cap.latest()!,
        "account_delete",
      );
      yield* auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken);
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("rejects a purposeless token (confused-deputy reuse)", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-del-noplan@example.com", "sudelnop");
      yield* auth.beginStepUpOtp(profile.accountId);
      // Minted without a purpose — valid for recovery/passkey gates, but the
      // account-delete verifier must refuse it.
      const { stepUpToken } = yield* auth.completeStepUpOtp(profile.accountId, cap.latest()!);
      const err = yield* Effect.flip(
        auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("rejects a token minted for a different purpose", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-del-cross@example.com", "sudelcross");
      yield* auth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(
        profile.accountId,
        cap.latest()!,
        "pulse_app_delete",
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });
});

// T-S1: the cross-service verifier (`/internal/step-up/verify` for Pulse /
// Zap) accepts any account (`expectedAccountId = null`) but requires a
// matching purpose, and must return the accountId from the verified sub.
describe("verifyStepUpForExternalPurpose", () => {
  it.effect("returns the verified accountId for a matching purpose", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-ext@example.com", "suext");
      yield* auth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(
        profile.accountId,
        cap.latest()!,
        "pulse_app_delete",
      );
      const result = yield* auth.verifyStepUpForExternalPurpose(stepUpToken, "pulse_app_delete");
      expect(result.accountId).toBe(profile.accountId);
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("rejects a purpose mismatch", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-ext-x@example.com", "suextx");
      yield* auth.beginStepUpOtp(profile.accountId);
      const { stepUpToken } = yield* auth.completeStepUpOtp(
        profile.accountId,
        cap.latest()!,
        "account_delete",
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForExternalPurpose(stepUpToken, "pulse_app_delete"),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });
});
