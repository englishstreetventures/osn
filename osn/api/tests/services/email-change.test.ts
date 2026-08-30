import { it, expect, describe } from "@effect/vitest";
import { Db } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createInMemoryAccountCap } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";

/**
 * Build a fresh email recorder + test layer. Tests that need to capture
 * sent codes destructure `captured` (a getter-backed array of codes)
 * and provide `layer` at `Effect.provide` time. Also exposes the raw
 * SQLite handle behind the layer for tests that need to install a
 * fault-injection trigger the service layer has no route to create.
 */
function makeEmailCapture() {
  const email = makeLogEmailLive();
  const { layer: dbLayer, sqlite } = createTestLayerWithSqlite();
  return {
    layer: Layer.merge(dbLayer, email.layer),
    sqlite,
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
      const { db } = yield* Db;
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

      // A refreshes before the failed complete — proves A's session is
      // untouched by the collision, not just A's email.
      const aTokens = yield* a.auth.issueTokens(
        a.profile.id,
        a.profile.accountId,
        a.profile.email,
        a.profile.handle,
        a.profile.displayName,
      );

      // A's write now collides for real: B already owns `target`.
      const err = yield* Effect.flip(
        a.auth.completeEmailChange(a.profile.accountId, codeA, a.stepUpToken, null),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/invalid or expired code/i);
      // Regression pin for S3: the conflict branch tags its metric bucket
      // explicitly rather than leaving it to `classifyError`'s substring
      // match (which would also fire here, but for the wrong reason).
      expect(err).toMatchObject({ metricResult: "conflict" });

      // Invariant pins, not half-applied-batch/rollback detectors: the
      // first batch statement (the accounts update) is what throws the
      // UNIQUE violation, so the emailChanges insert and sessions delete
      // never execute. These assert nothing about A changed, not that a
      // partial write was rolled back.
      const [aAccount] = yield* Effect.promise(() =>
        db.query.accounts.findMany({ where: (acc, { eq }) => eq(acc.id, a.profile.accountId) }),
      );
      expect(aAccount?.email).toBe("ec-race-a@example.com");
      const [bAccount] = yield* Effect.promise(() =>
        db.query.accounts.findMany({ where: (acc, { eq }) => eq(acc.id, b.profile.accountId) }),
      );
      expect(bAccount?.email).toBe(target);
      const aEmailChanges = yield* Effect.promise(() =>
        db.query.emailChanges.findMany({
          where: (ec, { eq }) => eq(ec.accountId, a.profile.accountId),
        }),
      );
      expect(aEmailChanges).toHaveLength(0);

      // A's pre-existing session still verifies — the failed complete
      // didn't touch sessions at all (S2's delete only removes the
      // pending ceremony state, never a session).
      yield* a.auth.verifyRefreshToken(aTokens.refreshToken);
    }).pipe(Effect.provide(layer));
  });

  // Positive control for the race test above: proves the ceremony still
  // succeeds end-to-end when the target address really is free, on the
  // same shared email recorder / call-ordering the race test relies on.
  it.effect("succeeds completing a change to a free address (positive control)", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const c = yield* setup("ec-race-c@example.com", "ecracec", captured);
      yield* c.auth.beginEmailChange(c.profile.accountId, "ec-race-c-new@example.com");
      const codeC = captured.latest()!;
      const result = yield* c.auth.completeEmailChange(
        c.profile.accountId,
        codeC,
        c.stepUpToken,
        null,
      );
      expect(result.email).toBe("ec-race-c-new@example.com");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an invalid new-email address", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-badaddr@example.com", "ecbadaddr", captured);
      const err = yield* Effect.flip(auth.beginEmailChange(profile.accountId, "not-an-email"));
      expect(err._tag).toBe("ValidationError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a change to the caller's own current email", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-selfemail@example.com", "ecselfemail", captured);
      const err = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "ec-selfemail@example.com"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/matches current email/i);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a change to the caller's own email in a different case", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile } = yield* setup("ec-selfcase@example.com", "ecselfcase", captured);
      // EmailSchema accepts uppercase (the guard normalises before comparing,
      // so decode alone must not swallow this).
      const err = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "EC-SELFCASE@EXAMPLE.COM"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/matches current email/i);
    }).pipe(Effect.provide(layer));
  });

  // #520: begin is capped per-account independently of the per-IP rate
  // limiter. makeTestAuthConfig() sets no cap/TTL overrides, so exercising
  // this requires building a service with an injected emailChangeBeginCap
  // rather than relying on the shared test config.
  it.effect("caps the number of email-change begins per account", () => {
    const { layer } = makeEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService({
        ...baseConfig,
        emailChangeBeginCap: createInMemoryAccountCap(2, 60_000),
      });
      const profile = yield* auth.registerProfile("ec-begincap@example.com", "ecbegincap");
      yield* auth.beginEmailChange(profile.accountId, "ec-begincap-1@example.com");
      yield* auth.beginEmailChange(profile.accountId, "ec-begincap-2@example.com");
      const err = yield* Effect.flip(
        auth.beginEmailChange(profile.accountId, "ec-begincap-3@example.com"),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/too many email change attempts/i);
    }).pipe(Effect.provide(layer));
  });

  // Regression pin for S1: a non-uniqueness constraint failure at the write
  // must surface as DatabaseError, never get folded into the same generic
  // AuthError the OTP-mismatch/UNIQUE-conflict paths return. No FK
  // enforcement exists anywhere in this tree to trigger a real one, so a
  // fault-injection trigger stands in for "some other constraint failed".
  it.effect("surfaces a non-uniqueness constraint failure as DatabaseError", () => {
    const { layer, captured, sqlite } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-fault@example.com",
        "ecfault",
        captured,
      );
      yield* auth.beginEmailChange(profile.accountId, "ec-fault-new@example.com");
      const code = captured.latest()!;

      sqlite.exec(
        `CREATE TRIGGER ec_force_fault BEFORE INSERT ON email_changes
         BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: email_changes.new_email'); END;`,
      );

      const err = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, code, stepUpToken, null),
      );
      expect(err._tag).toBe("DatabaseError");
    }).pipe(Effect.provide(layer));
  });

  // #512 T-E3 / #521: five wrong submissions lock out the pending change;
  // the sixth, correct, submission still fails because the entry is gone.
  // Step-up tokens are single-use (jti consumed on verify), so a naive test
  // reusing one token across submissions dies at replay before reaching the
  // OTP comparison — mint a fresh one per submission.
  it.effect(
    "locks out after MAX_OTP_ATTEMPTS wrong codes, even with a fresh token each time",
    () => {
      const { layer, captured } = makeEmailCapture();
      return Effect.gen(function* () {
        const auth = createAuthService(baseConfig);
        const profile = yield* auth.registerProfile("ec-lockout@example.com", "eclockout");

        const issueStepUp = Effect.gen(function* () {
          yield* auth.beginStepUpOtp(profile.accountId);
          const otpCode = captured.latest()!;
          const { stepUpToken } = yield* auth.completeStepUpOtp(
            profile.accountId,
            otpCode,
            "email_change",
          );
          return stepUpToken;
        });

        yield* issueStepUp; // burn one to keep the ceremony above honest — begin needs no step-up.
        yield* auth.beginEmailChange(profile.accountId, "ec-lockout-new@example.com");

        // Five wrong submissions, each with a fresh step-up token.
        for (let i = 0; i < 5; i++) {
          const stepUpToken = yield* issueStepUp;
          const err = yield* Effect.flip(
            auth.completeEmailChange(profile.accountId, "000000", stepUpToken, null),
          );
          expect(err._tag).toBe("AuthError");
          expect(err.message).toMatch(/invalid or expired code/i);
        }

        // Sixth submission: correct code, but the pending entry was wiped by
        // the fifth failed attempt hitting MAX_OTP_ATTEMPTS.
        const correctCode = captured.latest()!;
        const stepUpToken = yield* issueStepUp;
        const err = yield* Effect.flip(
          auth.completeEmailChange(profile.accountId, correctCode, stepUpToken, null),
        );
        expect(err._tag).toBe("AuthError");
        expect(err.message).toMatch(/invalid or expired code/i);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("rejects completing with no pending change", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const { auth, profile, stepUpToken } = yield* setup(
        "ec-nopending@example.com",
        "ecnopending",
        captured,
      );
      const err = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, "000000", stepUpToken, null),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/invalid or expired code/i);
    }).pipe(Effect.provide(layer));
  });

  // #512 T-E3: expiry is wall-clock (`Date.now()` comparisons), so this must
  // run on the real clock. it.effect's TestClock suspends Effect.sleep until
  // manually advanced — it would hang here, and advancing it wouldn't help
  // since the service never reads TestClock. it.live is required.
  it.live("rejects completing after the pending change has expired", () => {
    const { layer, captured } = makeEmailCapture();
    return Effect.gen(function* () {
      const auth = createAuthService({ ...baseConfig, otpTtl: 1 });
      const profile = yield* auth.registerProfile("ec-expired@example.com", "ecexpired");
      yield* auth.beginStepUpOtp(profile.accountId);
      const stepUpOtpCode = captured.latest()!;
      const { stepUpToken } = yield* auth.completeStepUpOtp(
        profile.accountId,
        stepUpOtpCode,
        "email_change",
      );
      yield* auth.beginEmailChange(profile.accountId, "ec-expired-new@example.com");
      const code = captured.latest()!;

      // Real wall-clock sleep past the 1s otpTtl, with 500ms of CI slack.
      // Kept as short as the margin allows: this is the only real sleep in the
      // package and it is paid on every run.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 1500)));

      const err = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, code, stepUpToken, null),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toMatch(/invalid or expired code/i);
    }).pipe(Effect.provide(layer));
  });

  // #484 / #514 P-I4: proves the S2 delete (removing a conflicted pending
  // change) actually matters, rather than being dead code. Extends the race
  // test's world: A's complete already lost the genuine UNIQUE race once
  // (S2 fires, pending is gone). A second, non-uniqueness fault is then
  // installed and A resubmits with a fresh token — with S2 in place this
  // short-circuits at `!pending` (AuthError) rather than ever reaching the
  // write and turning into a DatabaseError. Without S2 the pending entry
  // would survive and this assertion would catch the regression.
  it.effect("S2 delete: a conflicted pending change cannot be resurrected by retrying", () => {
    const { layer, captured, sqlite } = makeEmailCapture();
    return Effect.gen(function* () {
      const a = yield* setup("ec-s2-a@example.com", "ecs2a", captured);
      const b = yield* setup("ec-s2-b@example.com", "ecs2b", captured);

      const target = "ec-s2-target@example.com";

      yield* a.auth.beginEmailChange(a.profile.accountId, target);
      const codeA = captured.latest()!;

      yield* b.auth.beginEmailChange(b.profile.accountId, target);
      const codeB = captured.latest()!;
      yield* b.auth.completeEmailChange(b.profile.accountId, codeB, b.stepUpToken, null);

      // Genuine UNIQUE conflict must happen first — installing the second
      // trigger before this would mask it.
      const firstErr = yield* Effect.flip(
        a.auth.completeEmailChange(a.profile.accountId, codeA, a.stepUpToken, null),
      );
      expect(firstErr._tag).toBe("AuthError");

      sqlite.exec(
        `CREATE TRIGGER ec_block_update BEFORE UPDATE ON accounts
         BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: accounts.email'); END;`,
      );

      yield* a.auth.beginStepUpOtp(a.profile.accountId);
      const stepUpOtpCode = captured.latest()!;
      const { stepUpToken: freshStepUpToken } = yield* a.auth.completeStepUpOtp(
        a.profile.accountId,
        stepUpOtpCode,
        "email_change",
      );

      const secondErr = yield* Effect.flip(
        a.auth.completeEmailChange(a.profile.accountId, codeA, freshStepUpToken, null),
      );
      // With S2: the pending entry is already gone, so this short-circuits
      // at `!pending` — AuthError. Without S2, the pending entry would
      // survive and reach the write, where `ec_block_update` fires a
      // non-UNIQUE message that S1 correctly re-throws as DatabaseError.
      expect(secondErr._tag).toBe("AuthError");
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
