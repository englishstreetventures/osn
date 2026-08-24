import { it, expect, describe } from "@effect/vitest";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Build a fresh email recorder + test layer. Tests that need to capture
 * sent codes destructure `captured` (a getter-backed array of codes)
 * and provide `layer` at `Effect.provide` time.
 */
function makeEmailCapture() {
  const email = makeLogEmailLive();
  return {
    layer: Layer.merge(createTestLayer(), email.layer),
    captured: {
      codes: () =>
        email
          .recorded()
          .flatMap((e) => e.text.match(/code is: (\d{6})/)?.[1] ?? [])
          .filter(Boolean),
      latest: () => {
        const all = email.recorded();
        for (let i = all.length - 1; i >= 0; i--) {
          const m = all[i].text.match(/code is: (\d{6})/);
          if (m) return m[1];
        }
        return undefined;
      },
    },
  };
}

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
const setup = (
  email: string,
  handle: string,
  captured: ReturnType<typeof makeEmailCapture>["captured"],
) =>
  Effect.gen(function* () {
    const auth = createAuthService(baseConfig);
    const profile = yield* auth.registerProfile(email, handle);
    yield* auth.beginStepUpOtp(profile.accountId);
    const stepUpCode = captured.latest()!;
    const { stepUpToken } = yield* auth.completeStepUpOtp(
      profile.accountId,
      stepUpCode,
      "email_change",
    );
    return { auth, profile, stepUpToken };
  });

describe("beginEmailChange + completeEmailChange", () => {
  it.effect("happy path: swaps email, returns the new address, revokes other sessions", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-happy@example.com",
        "echappy",
        captured,
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
      const otpCode = captured.latest()!;
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
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a missing / invalid step-up token", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-nostepup@example.com", "ecnostepup", captured);
      yield* auth.beginEmailChange(profile.accountId, "ec-nostepup-new@example.com");
      const err = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, "000000", "not.a.jwt", null),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(layer));
  });

  // S-H2: begin must NOT reveal collisions — silently returns { sent: true }
  // so an authenticated caller cannot enumerate other users' email addresses.
  it.effect("silently succeeds on collision (no enumeration oracle)", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-conflict@example.com",
        "ecconflict",
        captured,
      );
      // Reserve the target address with another account.
      yield* auth.registerProfile("ec-target@example.com", "ectarget");

      const result = yield* auth.beginEmailChange(profile.accountId, "ec-target@example.com");
      expect(result.sent).toBe(true);
      // The complete step still rejects the collision via UNIQUE(email) —
      // see the next test, which drives a real write-time conflict through it.
      void stepUpToken;
    }).pipe(Effect.provide(layer));
  });

  // O3/S-H2 write-time guard: the begin-time collision check only sees
  // accounts as they stand *right then*. Account B can grab the target
  // address (via its own, independent change) in the gap between account
  // A's begin (collision check passes — nobody holds it yet) and A's
  // complete. At that point the write hits UNIQUE(email) for real, and
  // the catch in `completeEmailChange` must turn that into the same
  // generic AuthError the OTP-mismatch path returns — never a raw
  // DatabaseError, and never a hint that the address is taken.
  it.effect("rejects at complete time when another account wins the email in the meantime", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const a = yield* setup("ec-race-a@example.com", "ecracea", captured);
      const b = yield* setup("ec-race-b@example.com", "ecraceb", captured);

      const target = "ec-race-target@example.com";

      // A begins first — target is free, so the collision check passes
      // and a pending change is stored.
      yield* a.auth.beginEmailChange(a.profile.accountId, target);
      const codeA = captured.latest()!;

      // B independently begins AND completes a change to the same
      // address before A completes — same target is still free from
      // B's point of view too.
      yield* b.auth.beginEmailChange(b.profile.accountId, target);
      const codeB = captured.latest()!;
      const bResult = yield* b.auth.completeEmailChange(
        b.profile.accountId,
        codeB,
        b.stepUpToken,
        null,
      );
      expect(bResult.email).toBe(target);

      // A's write now collides for real: B already owns `target`.
      const err = yield* Effect.flip(
        a.auth.completeEmailChange(a.profile.accountId, codeA, a.stepUpToken, null),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/invalid or expired code/i);
    }).pipe(Effect.provide(layer));
  });

  it.effect("enforces 2-per-7-days cap", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService(baseConfig);
      const profile = yield* auth.registerProfile("ec-cap@example.com", "eccap");

      const issueStepUp = Effect.gen(function* () {
        yield* auth.beginStepUpOtp(profile.accountId);
        const code = captured.latest()!;
        const { stepUpToken } = yield* auth.completeStepUpOtp(
          profile.accountId,
          code,
          "email_change",
        );
        return stepUpToken;
      });

      const performChange = (newEmail: string) =>
        Effect.gen(function* () {
          const stepUpToken = yield* issueStepUp;
          yield* auth.beginEmailChange(profile.accountId, newEmail);
          const code = captured.latest()!;
          return yield* auth.completeEmailChange(profile.accountId, code, stepUpToken, null);
        });

      yield* performChange("ec-cap-1@example.com");
      yield* performChange("ec-cap-2@example.com");
      // Third change inside 7 days must be rejected.
      const err = yield* Effect.flip(performChange("ec-cap-3@example.com"));
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/limit reached/i);
    }).pipe(Effect.provide(layer));
  });
});
