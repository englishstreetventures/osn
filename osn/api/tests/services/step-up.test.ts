import { it, expect, describe } from "@effect/vitest";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll, vi } from "vitest";

import { createDurableJtiStore } from "../../src/lib/coordination/durable";
import * as metrics from "../../src/metrics";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";
import { stepUpThroughService } from "../helpers/step-up-link";

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

/** Fresh email recorder + merged test layer. */
function makeEmailCapture() {
  const email = makeLogEmailLive();
  return {
    layer: Layer.merge(createTestLayer(), email.layer),
    recorded: () => email.recorded(),
  };
}

const registered = (email: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(email, handle);
    return profile;
  });

describe("step-up by emailed link", () => {
  it.effect("begin + complete mints a token that /recovery/generate accepts", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-otp@example.com", "suotp");
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "recovery_generate",
        cap.recorded,
      );
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

      const stepUpToken = yield* stepUpThroughService(
        auth,
        alice.accountId,
        "recovery_generate",
        cap.recorded,
      );

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
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "recovery_generate",
        cap.recorded,
      );

      // First verification succeeds.
      yield* auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken);
      // Second verification on the same jti fails.
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  // F-SV5
  it.effect(
    "a token guard that cannot answer refuses the token, and is not counted as a replay",
    () => {
      const cap = makeEmailCapture();
      const fake = createFakeNamespace();
      fake.failWhen((call) => call.store === "step_up_jti");
      const guarded = createAuthService({
        ...config,
        stepUpJtiStore: createDurableJtiStore(fake.ns, () => {}),
      });
      const verified = vi.spyOn(metrics, "metricStepUpVerified");
      return Effect.gen(function* () {
        const profile = yield* guarded.registerProfile("su-jti-down@example.com", "sujtidown");
        const stepUpToken = yield* stepUpThroughService(
          guarded,
          profile.accountId,
          "recovery_generate",
          cap.recorded,
        );

        const err = yield* Effect.flip(
          guarded.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
        );
        expect(err._tag).toBe("AuthError");
        expect(err.message).toBe("Step-up token could not be verified");
        expect(verified.mock.calls.map(([result]) => result)).not.toContain("jti_replay");
        expect(fake.calls).toEqual([{ store: "step_up_jti", op: "claim" }]);
      }).pipe(
        Effect.provide(cap.layer),
        Effect.ensuring(Effect.sync(() => verified.mockRestore())),
      );
    },
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
      const stepUpToken = yield* stepUpThroughService(
        strictAuth,
        profile.accountId,
        "recovery_generate",
        cap.recorded,
      );
      const err = yield* Effect.flip(
        strictAuth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  // 5-min TTL is the containment window. A regression that drops the
  // `exp` claim or mis-sets the TTL would silently weaken the threat model.
  // With a 30s verifier clockTolerance, a 1.1s real-clock wait no longer
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
});

// The verifier accepts a token for a clock tolerance past its `exp`, so the
// claim on its id must still stand then, or a used token verifies again.
describe("a used step-up token stays used for as long as it verifies", () => {
  const guards = [
    ["the in-memory guard", () => ({})],
    [
      "the coordination store's guard",
      () => ({ stepUpJtiStore: createDurableJtiStore(createFakeNamespace().ns, () => {}) }),
    ],
  ] as const;

  for (const [name, guard] of guards) {
    it.effect(`${name}: presented again just inside the tolerance past exp, it is refused`, () => {
      const svc = createAuthService({ ...config, ...guard() });
      return Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date"] });
        const profile = yield* svc.registerProfile(
          `su-late-${name.length}@example.com`,
          `sulate${name.length}`,
        );
        const token = yield* svc.issueStepUpToken(
          profile.accountId,
          "passkey",
          "recovery_generate",
        );
        yield* svc.verifyStepUpForRecoveryGenerate(profile.accountId, token);

        const { exp } = JSON.parse(
          Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
        ) as { exp: number };
        vi.setSystemTime((exp + 29) * 1000);
        const again = yield* Effect.result(
          svc.verifyStepUpForRecoveryGenerate(profile.accountId, token),
        );
        expect(again._tag === "Failure" ? again.failure.message : "accepted again").toBe(
          "Step-up token already used",
        );
      }).pipe(
        Effect.provide(createTestLayer()),
        Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
      );
    });
  }
});

// Account deletion is the highest-stakes step-up consumer (Flow A —
// full account erasure) and had no direct coverage. It shares the recovery
// AMR allow-list, so pin both directions of the confused-deputy guard.
// Generating burns the account's whole existing set, so the gate
// requires a token minted for exactly that ceremony. Pin both directions.
describe("verifyStepUpForRecoveryGenerate (S-M1 purpose binding)", () => {
  it.effect("rejects a purposeless token", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-rec-nop@example.com", "surecnop");
      const stepUpToken = yield* auth.issueStepUpToken(profile.accountId, "otp");
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("rejects a token minted for a different purpose", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-rec-cross@example.com", "sureccross");
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "email_change",
        cap.recorded,
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });
});

describe("verifyStepUpForAccountDelete (S-C1 purpose binding)", () => {
  it.effect("accepts a token minted with purpose account_delete", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-del@example.com", "sudel");
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "account_delete",
        cap.recorded,
      );
      // Accepting the token must also CONSUME its jti, so a replay fails.
      // Asserting the replay proves both halves at once — a bare success
      // check would stay green if acceptance ever stopped consuming, leaving
      // a single-use step-up token replayable.
      yield* auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken);
      const err = yield* Effect.flip(
        auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("rejects a purposeless token (confused-deputy reuse)", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-del-noplan@example.com", "sudelnop");
      // Minted without a purpose — still valid for the legacy passkey gates,
      // but the account-delete verifier must refuse it.
      const stepUpToken = yield* auth.issueStepUpToken(profile.accountId, "otp");
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
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "pulse_app_delete",
        cap.recorded,
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });
});

// The cross-service verifier (`/internal/step-up/verify` for Pulse /
// Zap) accepts any account (`expectedAccountId = null`) but requires a
// matching purpose, and must return the accountId from the verified sub.
describe("verifyStepUpForExternalPurpose", () => {
  it.effect("returns the verified accountId for a matching purpose", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-ext@example.com", "suext");
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "pulse_app_delete",
        cap.recorded,
      );
      const result = yield* auth.verifyStepUpForExternalPurpose(stepUpToken, "pulse_app_delete");
      expect(result.accountId).toBe(profile.accountId);
    }).pipe(Effect.provide(cap.layer));
  });

  it.effect("rejects a purpose mismatch", () => {
    const cap = makeEmailCapture();
    return Effect.gen(function* () {
      const profile = yield* registered("su-ext-x@example.com", "suextx");
      const stepUpToken = yield* stepUpThroughService(
        auth,
        profile.accountId,
        "account_delete",
        cap.recorded,
      );
      const err = yield* Effect.flip(
        auth.verifyStepUpForExternalPurpose(stepUpToken, "pulse_app_delete"),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(cap.layer));
  });
});
