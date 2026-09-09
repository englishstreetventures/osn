import { it, expect, describe } from "@effect/vitest";
import { totpCredentials } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { createInMemoryRecoveryLockoutStore } from "../../src/lib/recovery-lockout-store";
import { TOTP_KEY_VERSION } from "../../src/lib/totp-secret-crypto";
import { createAuthService, type AuthConfig } from "../../src/services/auth";
import { TOTP_LOCKOUT_THRESHOLD } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";

/**
 * The TOTP credential's own behaviour. What matters here and is easy to get
 * wrong:
 *
 *   • an accepted code is single use (RFC 6238 §5.2), INCLUDING the one typed
 *     into the enrolment form, and including two submissions racing;
 *   • the next step's code still works, which is the whole reason
 *     `verifyTotpCode` returns the matched step rather than a boolean;
 *   • every failure looks identical on the wire;
 *   • the per-account lockout fails CLOSED, unlike its recovery-code sibling;
 *   • enrolment and disable each leave an audit row and send a notice;
 *   • which step-up verifiers a `totp` AMR reaches, and which refuse it.
 */

let config: AuthConfig;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

const STEP_SECONDS = 30;

function makeLayer() {
  const email = makeLogEmailLive();
  return Layer.merge(createTestLayer(), email.layer);
}

/**
 * Wrap a drizzle query builder so it does not execute until `delayMs` has
 * passed. Builders are thenable and chain by returning more builders, so every
 * method is proxied and `then` — the one point where the statement actually
 * runs — is what gets deferred.
 */
function delayChain(node: object, delayMs: number): object {
  return new Proxy(node, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          new Promise((resolve) => setTimeout(resolve, delayMs))
            .then(() =>
              (value as (...a: unknown[]) => unknown).call(target, (real: unknown) => real),
            )
            .then(onFulfilled, onRejected);
      }
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out !== null && typeof out === "object" ? delayChain(out, delayMs) : out;
      };
    },
  });
}

/**
 * A layer whose UPDATE statements land a few milliseconds after they are
 * issued. SELECTs are untouched, and everything still runs for real against
 * the in-memory SQLite.
 *
 * The gap between reading a row and writing it back is the entire subject of
 * `consumeStep`, and in a deployed tier that gap is a network round trip to
 * D1 — ample time for a second request to read the same row. On bun:sqlite it
 * is a couple of microtasks, and measurably too short: two fibres started
 * together still run one at a time through the consume, so an unmodified
 * in-memory run cannot tell a conditional UPDATE from a read-then-write and a
 * concurrency test over it passes under both. Deferring the write restores the
 * production timing rather than inventing a race that could not happen.
 */
function makeSlowUpdateLayer(delayMs = 20) {
  const real = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        return yield* Db;
      }),
      createTestLayer(),
    ),
  ).db;
  const proxied = new Proxy(real as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "update" && typeof value === "function") {
        return (...args: unknown[]) =>
          delayChain((value as (...a: unknown[]) => object).apply(target, args), delayMs);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof real;
  return Layer.merge(Layer.succeed(Db, { db: proxied }), makeLogEmailLive().layer);
}

/** Register an account and put a confirmed TOTP credential on it. */
const enrolled = (emailAddr: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(emailAddr, handle);
    const stepUpToken = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
    const { totpSecret, otpauthUri } = yield* auth.beginTotpEnrollment(
      profile.accountId,
      stepUpToken,
    );
    const secret = base32Decode(totpSecret);
    const code = yield* Effect.promise(() =>
      deriveTotpCode(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)),
    );
    yield* auth.completeTotpEnrollment(profile.accountId, code, "Test phone");
    return { profile, secret, otpauthUri, enrolmentCode: code };
  });

const codeAtStep = (secret: Uint8Array, step: number) =>
  Effect.promise(() => deriveTotpCode(secret, step));

const currentStep = () => Math.floor(Date.now() / 1000 / STEP_SECONDS);

/**
 * Move the wall clock on by one TOTP step.
 *
 * Only `Date` is faked — `setTimeout` stays real, so Effect's scheduler is
 * untouched. This is the honest way to test successive ceremonies: a code two
 * steps ahead of now is OUTSIDE the ±1 drift window and is supposed to be
 * refused, so "the next code still works" can only be shown by letting time
 * pass, not by reaching further up the counter.
 */
const advanceOneStep = () => {
  vi.setSystemTime(new Date(Date.now() + STEP_SECONDS * 1000));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("TOTP enrolment", () => {
  it.effect("enrols, and status reports it without any secret material", () =>
    Effect.gen(function* () {
      const { profile, otpauthUri } = yield* enrolled("totp-a@example.com", "totpa");

      expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);

      const status = yield* auth.getTotpStatus(profile.accountId);
      expect(status.enrolled).toBe(true);
      expect(status.label).toBe("Test phone");

      // Assert the WHOLE body, not a field: a future column added to the
      // projection would otherwise ship silently.
      expect(Object.keys(status).toSorted()).toEqual([
        "createdAt",
        "enrolled",
        "label",
        "lastUsedAt",
      ]);
      expect(JSON.stringify(status)).not.toContain("otpauth");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses enrolment without a step-up token minted for it", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-b@example.com", "totpb");
      // A real step-up token, but minted for a DIFFERENT ceremony. Purpose
      // binding, not the AMR list, is what stops this.
      const wrongPurpose = yield* auth.issueStepUpToken(
        profile.accountId,
        "passkey",
        "passkey_register",
      );
      const err = yield* Effect.flip(auth.beginTotpEnrollment(profile.accountId, wrongPurpose));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a second credential while one is confirmed", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-c@example.com", "totpc");
      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      const err = yield* Effect.flip(auth.beginTotpEnrollment(profile.accountId, token));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a wrong code at enroll/complete", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-d@example.com", "totpd");
      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      yield* auth.beginTotpEnrollment(profile.accountId, token);

      const err = yield* Effect.flip(
        auth.completeTotpEnrollment(profile.accountId, "000000", null),
      );
      expect(err._tag).toBe("AuthError");

      const status = yield* auth.getTotpStatus(profile.accountId);
      expect(status.enrolled).toBe(false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses enroll/complete when no enrolment is pending", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-e@example.com", "totpe");
      const err = yield* Effect.flip(
        auth.completeTotpEnrollment(profile.accountId, "123456", null),
      );
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP single use (RFC 6238 §5.2)", () => {
  it.effect("accepts a code once and refuses the same code again", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-f@example.com", "totpf");
      // A later step than the enrolment consumed, so this is a clean first use.
      const step = currentStep() + 1;
      const code = yield* codeAtStep(secret, step);

      const first = yield* auth.completeStepUpTotp(profile.accountId, code);
      expect(first.stepUpToken).toMatch(/^eyJ/);

      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, code));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses the enrolment code itself at step-up", () =>
    Effect.gen(function* () {
      // The enrolment code is a real code and the most-observed one the
      // credential will ever produce — it is typed into a form. If the row went
      // in with a null step it would stay replayable for the rest of its window.
      const { profile, enrolmentCode } = yield* enrolled("totp-g@example.com", "totpg");
      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, enrolmentCode));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a code from a step at or below the last accepted one", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-h@example.com", "totph");
      const step = currentStep() + 1;
      yield* auth.completeStepUpTotp(profile.accountId, yield* codeAtStep(secret, step));

      // The previous step is still inside the ±1 drift window, so it verifies
      // arithmetically — only the stored step rejects it.
      const older = yield* codeAtStep(secret, step - 1);
      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, older));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("still accepts the NEXT step's code straight after a success", () =>
    Effect.gen(function* () {
      // This is the case the boolean-returning alternative would have broken:
      // refusing every code for the rest of the drift window would fail a
      // legitimate second ceremony ~90 seconds later.
      const { profile, secret } = yield* enrolled("totp-i@example.com", "totpi");

      vi.useFakeTimers({ toFake: ["Date"] });
      advanceOneStep();
      yield* auth.completeStepUpTotp(profile.accountId, yield* codeAtStep(secret, currentStep()));

      advanceOneStep();
      const next = yield* auth.completeStepUpTotp(
        profile.accountId,
        yield* codeAtStep(secret, currentStep()),
      );
      expect(next.stepUpToken).toMatch(/^eyJ/);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("lets exactly ONE of two concurrent submissions of the same code through", () =>
    Effect.gen(function* () {
      // The claim `consumeStep` is written for, and the only test here that can
      // see it. Every other single-use test submits sequentially, where a
      // SELECT-then-UPDATE rejects the second attempt just as well — so none of
      // them can tell the two implementations apart.
      //
      // The write is deferred (see `makeSlowUpdateLayer`) so the second fibre
      // reads the row while the first fibre's write is still in flight, which
      // is the ordinary case against D1 and the one the docstring is about.
      // A read-then-write lets both through here; the conditional UPDATE means
      // the loser changes zero rows and is rejected as a replay.
      const { profile, secret } = yield* enrolled("totp-cc@example.com", "totpcc");
      const code = yield* codeAtStep(secret, currentStep() + 1);

      const outcomes = yield* Effect.all(
        [
          Effect.result(auth.completeStepUpTotp(profile.accountId, code)),
          Effect.result(auth.completeStepUpTotp(profile.accountId, code)),
        ],
        { concurrency: "unbounded" },
      );

      expect(outcomes.filter((o) => o._tag === "Success")).toHaveLength(1);
    }).pipe(Effect.provide(makeSlowUpdateLayer())),
  );
});

describe("TOTP key version", () => {
  it.effect("a row under an unknown key version is a DatabaseError, not the generic 400", () =>
    Effect.gen(function* () {
      // Rotation is not implemented (xchromo/osn#968), so today the only way to
      // reach this is a hand-edited row — but the moment anyone attempts a
      // rotation it is every row, and this is the shape of the failure: a
      // decrypt error inside `checkTotpCode`'s tryPromise, which maps to
      // DatabaseError and a 500 rather than the 400 every other TOTP failure
      // produces.
      const { profile, secret } = yield* enrolled("totp-kv@example.com", "totpkv");

      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(totpCredentials)
          .set({ keyVersion: TOTP_KEY_VERSION + 1 })
          .where(eq(totpCredentials.accountId, profile.accountId)),
      );

      const code = yield* codeAtStep(secret, currentStep() + 1);
      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, code));
      expect(err._tag).toBe("DatabaseError");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP failures are indistinguishable on the wire", () => {
  it.effect("answers the same message for a wrong code and for no credential", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-j@example.com", "totpj");
      const noTotp = yield* auth.registerProfile("totp-k@example.com", "totpk");

      const wrong = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      const absent = yield* Effect.flip(auth.completeStepUpTotp(noTotp.accountId, "000000"));

      expect(wrong.message).toBe(absent.message);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("answers that same message for a replayed code", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-l@example.com", "totpl");
      const step = currentStep() + 1;
      const code = yield* codeAtStep(secret, step);
      yield* auth.completeStepUpTotp(profile.accountId, code);

      const replayed = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, code));
      const wrong = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      expect(replayed.message).toBe(wrong.message);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP per-account lockout", () => {
  it.effect("blocks even a CORRECT code once the threshold is crossed", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-m@example.com", "totpm");

      for (let i = 0; i < TOTP_LOCKOUT_THRESHOLD; i++) {
        yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      }

      // The right code, refused: the lockout is keyed on the account, so a
      // rotating fleet cannot spread the guesses past it.
      const good = yield* codeAtStep(secret, currentStep() + 1);
      const err = yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, good));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("clears the counter after a success", () =>
    Effect.gen(function* () {
      const { profile, secret } = yield* enrolled("totp-n@example.com", "totpn");

      for (let i = 0; i < TOTP_LOCKOUT_THRESHOLD - 1; i++) {
        yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      }

      vi.useFakeTimers({ toFake: ["Date"] });
      advanceOneStep();
      yield* auth.completeStepUpTotp(profile.accountId, yield* codeAtStep(secret, currentStep()));

      // Were the counter still at threshold-1, one more failure would lock the
      // account and the next correct code would be refused.
      yield* Effect.flip(auth.completeStepUpTotp(profile.accountId, "000000"));
      advanceOneStep();
      const ok = yield* auth.completeStepUpTotp(
        profile.accountId,
        yield* codeAtStep(secret, currentStep()),
      );
      expect(ok.stepUpToken).toMatch(/^eyJ/);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies a CORRECT code when the lockout store itself fails — fail closed", () =>
    Effect.gen(function* () {
      // A guard is not verified until it has been seen to fail, and it is not
      // verified against an account that would have been refused anyway: with
      // no credential enrolled, `checkTotpCode` falls through to the
      // constant-cost "not enrolled" branch and answers the same AuthError
      // whatever `isLocked` returned. So enrol first and submit a code that
      // WOULD be accepted — flip `isLocked` to false and this test goes red.
      //
      // Recovery codes fail OPEN here on purpose; TOTP must not, because a
      // six-digit code has no wide search space behind the counter.
      const { profile, secret } = yield* enrolled("totp-o@example.com", "totpo");

      const broken = {
        backend: "redis" as const,
        isLocked: () => Promise.resolve(true),
        recordFailure: () => Promise.resolve(TOTP_LOCKOUT_THRESHOLD),
        reset: () => Promise.resolve(),
      };
      const failClosedAuth = createAuthService({ ...config, totpLockoutStore: broken });

      const good = yield* codeAtStep(secret, currentStep() + 1);
      const err = yield* Effect.flip(failClosedAuth.completeStepUpTotp(profile.accountId, good));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );

  it("the in-memory store cannot fail, so failClosed leaves its counting alone", async () => {
    // The fail-closed posture only ever bites on the Redis-backed store (its
    // own tests cover that). Pinned here so nobody "implements" failClosed in
    // the memory backend: reporting a permanent lockout, or a first failure as
    // having reached the threshold, would break every local dev ceremony.
    const store = createInMemoryRecoveryLockoutStore({ failClosed: true, threshold: 3 });
    expect(await store.isLocked("acc_x")).toBe(false);
    expect(await store.recordFailure("acc_x")).toBe(1);
    expect(await store.isLocked("acc_x")).toBe(false);
    expect(await store.recordFailure("acc_x")).toBe(2);
    expect(await store.recordFailure("acc_x")).toBe(3);
    expect(await store.isLocked("acc_x")).toBe(true);
  });
});

describe("TOTP disable", () => {
  it.effect("removes the credential and is idempotent", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-p@example.com", "totpp");

      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_disable");
      const first = yield* auth.disableTotp(profile.accountId, token);
      expect(first.disabled).toBe(true);

      const status = yield* auth.getTotpStatus(profile.accountId);
      expect(status.enrolled).toBe(false);

      const token2 = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_disable");
      const second = yield* auth.disableTotp(profile.accountId, token2);
      expect(second.disabled).toBe(false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a step-up token minted for another ceremony", () =>
    Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-q@example.com", "totpq");
      const wrong = yield* auth.issueStepUpToken(profile.accountId, "passkey", "recovery_generate");
      const err = yield* Effect.flip(auth.disableTotp(profile.accountId, wrong));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP enrolment and disable are audible", () => {
  // The `security_events` row is the only IN-APP channel telling a user their
  // account grew or lost a second factor, and the threat model leans on it. It
  // shares a `commitBatch` with the credential write, so a regression could
  // drop the audit row while the ceremony itself keeps working — nothing else
  // in this file would notice.

  it.effect("enrolment writes totp_enrolled and dispatches the notice", () => {
    const test = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-ev1@example.com", "totpev1");

      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events.map((e) => e.kind)).toContain("totp_enrolled");

      // The notice is forked detached — let the fiber finish.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      const sent = test.email
        .recorded()
        .filter((e) => e.template === "totp-enrolled" && e.to === "totp-ev1@example.com");
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("disable writes totp_disabled and dispatches the notice", () => {
    const test = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { profile } = yield* enrolled("totp-ev2@example.com", "totpev2");
      const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_disable");
      yield* auth.disableTotp(profile.accountId, token);

      const { events } = yield* auth.listUnacknowledgedSecurityEvents(profile.accountId);
      expect(events.map((e) => e.kind)).toContain("totp_disabled");

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      const sent = test.email
        .recorded()
        .filter((e) => e.template === "totp-disabled" && e.to === "totp-ev2@example.com");
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });
});

describe("which gates a totp-AMR step-up token reaches", () => {
  // Four allow-lists, and `recoveryGenerateAllowedAmr` is read by five separate
  // verifiers — so a gate per verifier, not a gate per list. Every one of the
  // five is exercised below by the verifier it actually runs through.
  //
  // Each case pins the DIRECT gate: whether a token carrying `amr: ["totp"]`
  // satisfies that verifier. None of them says anything about what a chain of
  // ceremonies can reach — see wiki/systems/totp.md §Threat model.
  const mintTotpToken = (accountId: string, purpose: Parameters<typeof auth.issueStepUpToken>[2]) =>
    auth.issueStepUpToken(accountId, "totp", purpose);

  it.effect("is ACCEPTED at passkey_register", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-r@example.com", "totpr");
      const token = yield* mintTotpToken(profile.accountId, "passkey_register");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForPasskeyRegister(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is REJECTED at the DIRECT passkey_delete verifier", () =>
    Effect.gen(function* () {
      // What this pins is `passkeyDeleteAllowedAmr` itself: a token carrying
      // `amr: ["totp"]` does not satisfy `verifyStepUpForPasskeyDelete`.
      //
      // This is the DIRECT path only. The register-then-assert pivot reaches
      // the same verifier carrying `amr: ["webauthn"]`, which this list admits,
      // and is closed by the credential-provenance rule rather than by this
      // allow-list — see `tests/services/step-up-provenance.test.ts`, which
      // walks the whole four-request chain.
      const profile = yield* auth.registerProfile("totp-s@example.com", "totps");
      const token = yield* mintTotpToken(profile.accountId, "passkey_delete");
      const err = yield* Effect.flip(
        auth.verifyStepUpForPasskeyDelete(profile.accountId, token, "pk_000000000000"),
      );
      expect(err.message).toBe("Step-up factor not permitted");
    }).pipe(Effect.provide(makeLayer())),
  );

  // `recoveryGenerateAllowedAmr` gates FIVE ceremonies, not the one its name
  // suggests. Written out per gate rather than table-driven so each names the
  // verifier it actually exercises.
  it.effect("is ACCEPTED at recovery_generate", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-rg@example.com", "totprg");
      const token = yield* mintTotpToken(profile.accountId, "recovery_generate");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForRecoveryGenerate(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at account_delete, which shares that allow-list", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-ad@example.com", "totpad");
      const token = yield* mintTotpToken(profile.accountId, "account_delete");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForAccountDelete(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at account_export, which shares that allow-list", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("totp-ae@example.com", "totpae");
      const token = yield* mintTotpToken(profile.accountId, "account_export");
      const outcome = yield* Effect.result(
        auth.verifyStepUpForAccountExport(profile.accountId, token),
      );
      expect(outcome._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at verifyStepUpForExternalPurpose, the Pulse / Zap app delete", () =>
    Effect.gen(function* () {
      // The cross-service verifier behind ARC-gated `/internal/step-up/verify`.
      // It reads the same allow-list but takes no expected accountId — it
      // returns the token's verified `sub` for the calling service to use.
      const profile = yield* auth.registerProfile("totp-ex@example.com", "totpex");
      const token = yield* mintTotpToken(profile.accountId, "pulse_app_delete");
      const result = yield* auth.verifyStepUpForExternalPurpose(token, "pulse_app_delete");
      expect(result.accountId).toBe(profile.accountId);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is ACCEPTED at the security-event ack-all path", () =>
    Effect.gen(function* () {
      // The fifth reader of the list, and the least discoverable from its name.
      // Enrolment left a `totp_enrolled` row, so the ack is a real one — a
      // no-op ack would pass with the gate removed and prove nothing.
      const { profile } = yield* enrolled("totp-ack@example.com", "totpack");
      const token = yield* mintTotpToken(profile.accountId, "security_event_ack");
      const { acknowledged } = yield* auth.acknowledgeAllSecurityEvents(profile.accountId, token);
      expect(acknowledged).toBeGreaterThan(0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is REJECTED at email_change, which keeps an allow-list of its own", () =>
    Effect.gen(function* () {
      // `emailChangeAllowedAmr` in `context.ts` is `["webauthn","otp"]` — the
      // fourth allow-list, and the one no config knob reaches. Left narrow
      // deliberately: the `otp` arm there proves control of the CURRENT
      // mailbox, which a TOTP seed does not.
      //
      // As with `passkey_delete` above, this pins the DIRECT gate only.
      const profile = yield* auth.registerProfile("totp-t@example.com", "totpt");
      const token = yield* mintTotpToken(profile.accountId, "email_change");
      const err = yield* Effect.flip(
        auth.completeEmailChange(profile.accountId, "123456", token, null),
      );
      expect(err.message).toBe("Step-up factor not permitted");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("TOTP without an encryption key", () => {
  it.effect("fails closed rather than storing anything in plain text", () =>
    Effect.gen(function* () {
      const { totpEncryptionKey: _dropped, ...withoutKey } = config;
      void _dropped;
      const keyless = createAuthService(withoutKey);

      const profile = yield* keyless.registerProfile("totp-u@example.com", "totpu");
      const token = yield* keyless.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");

      const err = yield* Effect.flip(keyless.beginTotpEnrollment(profile.accountId, token));
      expect(err.message).toBe("TOTP is not configured");
    }).pipe(Effect.provide(makeLayer())),
  );
});
