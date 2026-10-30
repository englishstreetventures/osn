import { it, expect, describe } from "@effect/vitest";
import { accounts, emailChanges, totpCredentials } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { CoordinationNamespace, CoordinationOp } from "@shared/coordination";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { EmailError, EmailService, makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll, vi } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { MAX_OTP_ATTEMPTS, TOTP_MAX_ENROLL_ATTEMPTS } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";

/**
 * A success answers once the work that matters has committed. The store call
 * that only tidies up after it — deleting a spent code's entry, clearing a
 * lockout counter — runs in the background, registered with the request's
 * `waitUntil`, so the caller never waits a round trip for it. Each case holds
 * that one call until the answer is in, which an awaited cleanup would never
 * reach, then lets it go and checks it landed. A recovery code or an emailed
 * recovery code whose counter read 0 on the way in has nothing to clear, so it
 * makes no call at all. A TOTP check counts its own attempt before it compares
 * the code, so a right code always clears the count.
 *
 * The later cases hold one call — a cleanup, a claim, a capped guess's delete,
 * a failed send's settle — while another request writes at the same key, then
 * let it go and check what the other request wrote survived it.
 */

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

const STEP_SECONDS = 30;
/** Longer than any success takes here; far shorter than a call that never answers. */
const ANSWER_WITHIN = "2 seconds";

/**
 * `ns` with every call `held` accepts waiting until `release()`. Calls reach
 * the stand-in, and are recorded there, only once let go.
 */
function holding(ns: CoordinationNamespace, held: (store: string, op: CoordinationOp) => boolean) {
  let release!: () => void;
  let waiting = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped: CoordinationNamespace = {
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      const store = name.slice(0, name.indexOf(":"));
      const call = <A>(op: CoordinationOp, run: () => Promise<A>): Promise<A> => {
        if (!held(store, op)) return run();
        waiting += 1;
        return gate.then(run);
      };
      return {
        increment: (windowMs) => call("increment", () => stub.increment(windowMs)),
        count: () => call("count", () => stub.count()),
        read: () => call("read", () => stub.read()),
        write: (value, ttlMs) => call("write", () => stub.write(value, ttlMs)),
        remove: (expected) => call("remove", () => stub.remove(expected)),
        claim: (ttlMs) => call("claim", () => stub.claim(ttlMs)),
        guess: () => call("guess", () => stub.guess()),
        take: () => call("take", () => stub.take()),
        swap: (expected, value, ttlMs) => call("swap", () => stub.swap(expected, value, ttlMs)),
      };
    },
  };
  return { ns: wrapped, release, waiting: () => waiting };
}

/**
 * The auth service on the Durable Object bundle over a stand-in namespace,
 * with every call `held` accepts — asked at the moment the call is made —
 * waiting until `release()`. Mail goes to a recorder unless `mail` replaces it.
 */
function harness(
  held: (store: string, op: CoordinationOp) => boolean = () => false,
  mail?: Layer.Layer<EmailService>,
) {
  const fake = createFakeNamespace();
  const gate = holding(fake.ns, held);
  const bundle = createDurableCoordination(gate.ns, () => {});
  const auth = createAuthService({
    ...base,
    ceremonyStores: bundle.ceremonyStores,
    recoveryLockoutStore: bundle.recoveryLockoutStore,
    recoveryOtpLockoutStore: bundle.recoveryOtpLockoutStore,
    totpLockoutStore: bundle.totpLockoutStore,
  });
  const email = makeLogEmailLive();
  const layer = Layer.merge(createTestLayer(), mail ?? email.layer);
  const ops = (from = 0) => fake.calls.slice(from).map((call) => `${call.store}.${call.op}`);
  /** The newest six-digit code mailed. */
  const code = () => {
    const all = email.recorded();
    for (let i = all.length - 1; i >= 0; i--) {
      const match = all[i]!.text.match(/code is: (\d{6})/);
      if (match) return match[1]!;
    }
    throw new Error("no code mailed");
  };
  /** The newest six-digit code, once a send has landed: some sends run after the answer. */
  const mailedCode = Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (email.recorded().some((sent) => /code is: \d{6}/.test(sent.text))) return code();
      yield* Effect.sleep("5 millis");
    }
    throw new Error("no code mailed");
  });
  /** Waits until `op`, or one of several, has reached the store since call `from`. */
  const landed = (op: string | readonly string[], from = 0) =>
    Effect.gen(function* () {
      const wanted = typeof op === "string" ? [op] : op;
      for (let i = 0; i < 200; i++) {
        if (ops(from).some((seen) => wanted.includes(seen))) return;
        yield* Effect.sleep("5 millis");
      }
      throw new Error(`${wanted.join(" or ")} never reached the store`);
    });
  /** Waits until `n` held calls have been sent and are waiting on the gate. */
  const holdingAtLeast = (n: number) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        if (gate.waiting() >= n) return;
        yield* Effect.sleep("5 millis");
      }
      throw new Error(`only ${gate.waiting()} of ${n} held calls were sent`);
    });
  /** Lets background work run, then answers whether `op` reached the store after `from`. */
  const settledWithout = (op: string, from: number) =>
    Effect.gen(function* () {
      yield* Effect.sleep("50 millis");
      return !ops(from).includes(op);
    });
  return {
    auth,
    bundle,
    layer,
    ops,
    code,
    mailedCode,
    landed,
    holdingAtLeast,
    settledWithout,
    release: gate.release,
  };
}

/** A six-digit code that is not `code`. */
const wrongFor = (code: string) => (code === "000000" ? "000001" : "000000");

/** An account with a confirmed TOTP credential, and the step its enrolment code used. */
const withTotp = (auth: ReturnType<typeof createAuthService>, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
    const token = yield* auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
    const { totpSecret } = yield* auth.beginTotpEnrollment(profile.accountId, token);
    const secret = base32Decode(totpSecret);
    const step = Math.floor(Date.now() / 1000 / STEP_SECONDS);
    const code = yield* Effect.promise(() => deriveTotpCode(secret, step));
    yield* auth.completeTotpEnrollment(profile.accountId, code, "Test phone");
    // The next step's code: inside the drift window, and not yet used.
    const next = yield* Effect.promise(() => deriveTotpCode(secret, step + 1));
    return { profile, next };
  });

/** The authenticator code for the base32 `secret` now. */
const totpCodeFor = (secret: string) =>
  Effect.promise(() =>
    deriveTotpCode(base32Decode(secret), Math.floor(Date.now() / 1000 / STEP_SECONDS)),
  );

/**
 * Mail that records every code it is asked to send. The first send waits until
 * `failFirst()`, then fails with `error`; every later send succeeds.
 */
function scriptedMail(error: EmailError) {
  const codes: string[] = [];
  let failFirst!: () => void;
  const failing = new Promise<void>((resolve) => {
    failFirst = resolve;
  });
  let sends = 0;
  const layer = Layer.succeed(EmailService, {
    send: (input) =>
      Effect.gen(function* () {
        if ("code" in input.data) codes.push(input.data.code);
        sends += 1;
        if (sends > 1) return;
        yield* Effect.promise(() => failing);
        return yield* Effect.fail(error);
      }),
  });
  /** The code the `n`th send carried, counting from 0, once that send has been made. */
  const nth = (n: number) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        if (codes.length > n) return codes[n]!;
        yield* Effect.sleep("5 millis");
      }
      throw new Error(`no send ${n}`);
    });
  return { layer, nth, failFirst: () => failFirst() };
}

describe("success paths answer without waiting on their cleanup", () => {
  it.live("registration complete: the spent entry's delete", () => {
    const h = harness((store, op) => store === "pending_registration" && op === "remove");
    return Effect.gen(function* () {
      yield* settle(h.auth.beginRegistration("clean-reg@example.com", "cleanreg", "1990-01-01"));
      const done = yield* h.auth
        .completeRegistration("clean-reg@example.com", h.code())
        .pipe(Effect.timeout(ANSWER_WITHIN));
      expect(done.handle).toBe("cleanreg");
      h.release();
      yield* h.landed("pending_registration.remove");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("recovery-code sign-in after a wrong code: the lockout reset", () => {
    const h = harness((store, op) => store === "recovery_lockout" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("clean-rc@example.com", "cleanrc");
      const { recoveryCodes } = yield* h.auth.generateRecoveryCodesForAccount(profile.accountId);
      yield* Effect.flip(h.auth.consumeRecoveryCode("cleanrc", "wrong-code"));

      const done = yield* h.auth
        .consumeRecoveryCode("cleanrc", recoveryCodes[0]!)
        .pipe(Effect.timeout(ANSWER_WITHIN));
      expect(done.profile.accountId).toBe(profile.accountId);
      h.release();
      yield* h.landed("recovery_lockout.remove");
      expect(
        yield* Effect.promise(() => h.bundle.recoveryLockoutStore.status(profile.accountId)),
      ).toEqual({ status: "open", failures: 0 });
    }).pipe(Effect.provide(h.layer));
  });

  it.live("TOTP step-up after a wrong code: the lockout reset", () => {
    const h = harness((store, op) => store === "totp_lockout" && op === "remove");
    return Effect.gen(function* () {
      const { profile, next } = yield* withTotp(h.auth, "cleantotp");
      yield* Effect.flip(h.auth.completeStepUpTotp(profile.accountId, "000000"));

      const done = yield* h.auth
        .completeStepUpTotp(profile.accountId, next)
        .pipe(Effect.timeout(ANSWER_WITHIN));
      expect(done.stepUpToken).toBeTruthy();
      h.release();
      yield* h.landed("totp_lockout.remove");
      expect(
        yield* Effect.promise(() => h.bundle.totpLockoutStore.status(profile.accountId)),
      ).toEqual({ status: "open", failures: 0 });
    }).pipe(Effect.provide(h.layer));
  });

  it.live("TOTP step-up with no failures on record: the count its own attempt made", () => {
    const h = harness((store, op) => store === "totp_lockout" && op === "remove");
    return Effect.gen(function* () {
      const { profile, next } = yield* withTotp(h.auth, "cleantotp0");
      const done = yield* h.auth
        .completeStepUpTotp(profile.accountId, next)
        .pipe(Effect.timeout(ANSWER_WITHIN));
      expect(done.stepUpToken).toBeTruthy();
      h.release();
      yield* h.landed("totp_lockout.remove");
      expect(
        yield* Effect.promise(() => h.bundle.totpLockoutStore.status(profile.accountId)),
      ).toEqual({ status: "open", failures: 0 });
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a lockout with no failures on record", () => {
  it.live("recovery-code sign-in makes no reset call", () => {
    const h = harness();
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("clean-rc0@example.com", "cleanrc0");
      const { recoveryCodes } = yield* h.auth.generateRecoveryCodesForAccount(profile.accountId);
      const from = h.ops().length;
      yield* h.auth.consumeRecoveryCode("cleanrc0", recoveryCodes[0]!);
      expect(h.ops(from)).toContain("recovery_lockout.count");
      expect(yield* h.settledWithout("recovery_lockout.remove", from)).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("emailed recovery code sign-in makes no reset call", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("clean-er0@example.com", "cleaner0");
      yield* h.auth.beginEmailRecovery("clean-er0@example.com");
      const code = yield* h.mailedCode;
      const from = h.ops().length;
      yield* h.auth.completeEmailRecovery("clean-er0@example.com", code);
      expect(h.ops(from)).toContain("recovery_otp_lockout.count");
      expect(yield* h.settledWithout("recovery_otp_lockout.remove", from)).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });
});

/**
 * A cleanup removes only what its own request saw. Each case holds the cleanup
 * while another request writes to the same key — a new `begin`, a wrong code —
 * then lets the cleanup land, and checks that the other request's write
 * survived it.
 */
describe("a cleanup leaves what another request wrote", () => {
  it.live("email change: a begin after the answer keeps its entry", () => {
    // Every remove but the first — the completing change's own claim — is held,
    // so any delete the completed change made after its answer would still be
    // in flight when the next change begins.
    let removes = 0;
    const h = harness(
      (store, op) => store === "pending_email_change" && op === "remove" && ++removes > 1,
    );
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("keep-ec@example.com", "keepec");
      const first = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
      yield* h.auth.beginEmailChange(profile.accountId, "keep-ec-1@example.com");
      yield* h.auth.completeEmailChange(profile.accountId, h.code(), first, null);

      yield* h.auth.beginEmailChange(profile.accountId, "keep-ec-2@example.com");
      const code = h.code();
      h.release();

      const second = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
      const done = yield* h.auth.completeEmailChange(profile.accountId, code, second, null);
      expect(done.email).toBe("keep-ec-2@example.com");
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "email change: a begin while the capped guess's delete is in flight keeps its entry",
    () => {
      const h = harness((store, op) => store === "pending_email_change" && op === "remove");
      return Effect.gen(function* () {
        const profile = yield* h.auth.registerProfile("keep-ecl@example.com", "keepecl");
        yield* h.auth.beginEmailChange(profile.accountId, "keep-ecl-1@example.com");
        const wrong = wrongFor(h.code());
        for (let i = 1; i < MAX_OTP_ATTEMPTS; i++) {
          const token = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
          yield* Effect.flip(h.auth.completeEmailChange(profile.accountId, wrong, token, null));
        }
        const last = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
        const capped = yield* Effect.forkChild(
          Effect.flip(h.auth.completeEmailChange(profile.accountId, wrong, last, null)),
        );
        yield* h.holdingAtLeast(1);

        yield* h.auth.beginEmailChange(profile.accountId, "keep-ecl-2@example.com");
        const code = h.code();
        h.release();
        expect((yield* Fiber.join(capped))._tag).toBe("AuthError");

        const token = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
        const done = yield* h.auth.completeEmailChange(profile.accountId, code, token, null);
        expect(done.email).toBe("keep-ecl-2@example.com");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("recovery-code sign-in: a wrong code after the answer keeps its failure", () => {
    const h = harness((store, op) => store === "recovery_lockout" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("keep-rc@example.com", "keeprc");
      const { recoveryCodes } = yield* h.auth.generateRecoveryCodesForAccount(profile.accountId);
      yield* Effect.flip(h.auth.consumeRecoveryCode("keeprc", "wrong-code"));
      yield* h.auth.consumeRecoveryCode("keeprc", recoveryCodes[0]!);

      // The reset is still held when the next wrong code is counted.
      yield* Effect.flip(h.auth.consumeRecoveryCode("keeprc", "wrong-code"));
      h.release();
      yield* h.landed("recovery_lockout.remove");
      expect(
        yield* Effect.promise(() => h.bundle.recoveryLockoutStore.status(profile.accountId)),
      ).toEqual({ status: "open", failures: 1 });
    }).pipe(Effect.provide(h.layer));
  });

  it.live("TOTP step-up: a wrong attempt after the answer keeps its count", () => {
    const h = harness((store, op) => store === "totp_lockout" && op === "remove");
    return Effect.gen(function* () {
      const { profile, next } = yield* withTotp(h.auth, "keeptotp");
      yield* Effect.flip(h.auth.completeStepUpTotp(profile.accountId, wrongFor(next)));
      yield* h.auth.completeStepUpTotp(profile.accountId, next);

      // The reset is still held when the next attempt is counted.
      yield* Effect.flip(h.auth.completeStepUpTotp(profile.accountId, wrongFor(next)));
      h.release();
      yield* h.landed("totp_lockout.remove");
      expect(
        yield* Effect.promise(() => h.bundle.totpLockoutStore.status(profile.accountId)),
      ).toEqual({ status: "open", failures: 1 });
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "emailed recovery code: a wrong code counted while the reset is in flight keeps its failure",
    () => {
      const h = harness(
        (store, op) =>
          (store === "pending_recovery_otp" || store === "recovery_otp_lockout") && op === "remove",
      );
      return Effect.gen(function* () {
        const profile = yield* h.auth.registerProfile("keep-er@example.com", "keeper");
        yield* h.auth.beginEmailRecovery("keep-er@example.com");
        const code = yield* h.mailedCode;
        yield* Effect.flip(h.auth.completeEmailRecovery("keep-er@example.com", wrongFor(code)));

        // The right code's claim and reset are both held; a wrong code guesses
        // against the still-live entry and counts its failure on the account.
        const right = yield* Effect.forkChild(
          h.auth.completeEmailRecovery("keep-er@example.com", code),
        );
        yield* h.holdingAtLeast(2);
        yield* Effect.flip(h.auth.completeEmailRecovery("keep-er@example.com", wrongFor(code)));
        h.release();
        yield* Fiber.join(right);
        expect(
          yield* Effect.promise(() => h.bundle.recoveryOtpLockoutStore.status(profile.accountId)),
        ).toEqual({ status: "open", failures: 1 });
      }).pipe(Effect.provide(h.layer));
    },
  );
});

/** The tag of the error `result` failed with, or `"ok"`. */
const outcome = (result: {
  readonly _tag: string;
  readonly failure?: { readonly _tag: string };
}) => (result._tag === "Success" ? "ok" : result.failure!._tag);

/**
 * A right code claims, and a wrong code at the cap deletes, only the entry its
 * guess read. Each case holds that claim or delete while a new `begin` writes a
 * fresh entry at the same key, then lets it go: the old code wins nothing, and
 * the fresh code works.
 */
describe("a claim or a capped guess's delete takes only the entry the guess read", () => {
  it.live("step-up OTP: a begin while the right code's claim is in flight", () => {
    const h = harness((store, op) => store === "step_up_otp" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("claim-su@example.com", "claimsu");
      yield* h.auth.beginStepUpOtp(profile.accountId);
      const old = yield* Effect.forkChild(
        Effect.result(h.auth.completeStepUpOtp(profile.accountId, h.code())),
      );
      yield* h.holdingAtLeast(1);

      yield* h.auth.beginStepUpOtp(profile.accountId);
      const code = h.code();
      h.release();
      expect(outcome(yield* Fiber.join(old))).toBe("AuthError");

      const done = yield* h.auth.completeStepUpOtp(profile.accountId, code);
      expect(done.stepUpToken).toBeTruthy();
    }).pipe(Effect.provide(h.layer));
  });

  it.live("step-up OTP: a begin while the capped guess's delete is in flight", () => {
    const h = harness((store, op) => store === "step_up_otp" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("cap-su@example.com", "capsu");
      yield* h.auth.beginStepUpOtp(profile.accountId);
      const wrong = wrongFor(h.code());
      for (let i = 1; i < MAX_OTP_ATTEMPTS; i++) {
        yield* Effect.flip(h.auth.completeStepUpOtp(profile.accountId, wrong));
      }
      const capped = yield* Effect.forkChild(
        Effect.flip(h.auth.completeStepUpOtp(profile.accountId, wrong)),
      );
      yield* h.holdingAtLeast(1);

      yield* h.auth.beginStepUpOtp(profile.accountId);
      const code = h.code();
      h.release();
      expect((yield* Fiber.join(capped))._tag).toBe("AuthError");

      const done = yield* h.auth.completeStepUpOtp(profile.accountId, code);
      expect(done.stepUpToken).toBeTruthy();
    }).pipe(Effect.provide(h.layer));
  });

  it.live("TOTP enrolment: a begin while the right code's claim is in flight", () => {
    const h = harness((store, op) => store === "pending_totp_enroll" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("claim-totp@example.com", "claimtotp");
      const token = () => h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      const first = yield* h.auth.beginTotpEnrollment(profile.accountId, yield* token());
      const old = yield* Effect.forkChild(
        Effect.result(
          h.auth.completeTotpEnrollment(
            profile.accountId,
            yield* totpCodeFor(first.totpSecret),
            null,
          ),
        ),
      );
      yield* h.holdingAtLeast(1);

      const second = yield* h.auth.beginTotpEnrollment(profile.accountId, yield* token());
      h.release();
      expect(outcome(yield* Fiber.join(old))).toBe("AuthError");
      const { db } = yield* Db;
      const enrolled = yield* Effect.promise(() =>
        db.select().from(totpCredentials).where(eq(totpCredentials.accountId, profile.accountId)),
      );
      expect(enrolled).toHaveLength(0);

      const done = yield* h.auth.completeTotpEnrollment(
        profile.accountId,
        yield* totpCodeFor(second.totpSecret),
        null,
      );
      expect(done.enrolled).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("TOTP enrolment: a begin while the capped code's delete is in flight", () => {
    const h = harness((store, op) => store === "pending_totp_enroll" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("cap-totp@example.com", "captotp");
      const token = () => h.auth.issueStepUpToken(profile.accountId, "passkey", "totp_enroll");
      const first = yield* h.auth.beginTotpEnrollment(profile.accountId, yield* token());
      const wrong = wrongFor(yield* totpCodeFor(first.totpSecret));
      for (let i = 1; i < TOTP_MAX_ENROLL_ATTEMPTS; i++) {
        yield* Effect.flip(h.auth.completeTotpEnrollment(profile.accountId, wrong, null));
      }
      const capped = yield* Effect.forkChild(
        Effect.flip(h.auth.completeTotpEnrollment(profile.accountId, wrong, null)),
      );
      yield* h.holdingAtLeast(1);

      const second = yield* h.auth.beginTotpEnrollment(profile.accountId, yield* token());
      h.release();
      expect((yield* Fiber.join(capped))._tag).toBe("AuthError");

      const done = yield* h.auth.completeTotpEnrollment(
        profile.accountId,
        yield* totpCodeFor(second.totpSecret),
        null,
      );
      expect(done.enrolled).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("emailed recovery code: a begin while the right code's claim is in flight", () => {
    // No failure is on record, so the right code makes no reset: the one held
    // call is its claim.
    const h = harness((store, op) => store === "pending_recovery_otp" && op === "remove");
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("claim-er@example.com", "claimer");
      yield* settle(h.auth.beginEmailRecovery("claim-er@example.com"));
      const old = yield* Effect.forkChild(
        Effect.result(h.auth.completeEmailRecovery("claim-er@example.com", h.code())),
      );
      yield* h.holdingAtLeast(1);

      yield* settle(h.auth.beginEmailRecovery("claim-er@example.com"));
      const code = h.code();
      h.release();
      expect(outcome(yield* Fiber.join(old))).toBe("AuthError");

      const done = yield* h.auth.completeEmailRecovery("claim-er@example.com", code);
      expect(done.session.accessToken).toMatch(/^eyJ/);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("email change: a begin while the right code's claim is in flight", () => {
    const h = harness((store, op) => store === "pending_email_change" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("claim-ec@example.com", "claimec");
      const first = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
      yield* h.auth.beginEmailChange(profile.accountId, "claim-ec-1@example.com");
      const old = yield* Effect.forkChild(
        Effect.result(h.auth.completeEmailChange(profile.accountId, h.code(), first, null)),
      );
      yield* h.holdingAtLeast(1);

      yield* h.auth.beginEmailChange(profile.accountId, "claim-ec-2@example.com");
      const code = h.code();
      h.release();
      expect(outcome(yield* Fiber.join(old))).toBe("AuthError");
      const { db } = yield* Db;
      const changes = yield* Effect.promise(() =>
        db.select().from(emailChanges).where(eq(emailChanges.accountId, profile.accountId)),
      );
      expect(changes).toHaveLength(0);
      const [account] = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, profile.accountId)),
      );
      expect(account?.email).toBe("claim-ec@example.com");

      const second = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
      const done = yield* h.auth.completeEmailChange(profile.accountId, code, second, null);
      expect(done.email).toBe("claim-ec-2@example.com");
    }).pipe(Effect.provide(h.layer));
  });

  // A registration `begin` writes only where nothing is live, so it can land
  // between a guess and its delete only once the guessed entry's life has run
  // out. The clock is moved past it while the delete is held.
  it.live(
    "registration: a begin after the entry expired while the capped guess's delete is in flight",
    () => {
      const h = harness((store, op) => store === "pending_registration" && op === "remove");
      const address = "cap-reg@example.com";
      let clock: { mockRestore(): void } | undefined;
      return Effect.gen(function* () {
        yield* settle(h.auth.beginRegistration(address, "capreg", "1990-01-01"));
        const wrong = wrongFor(h.code());
        for (let i = 1; i < MAX_OTP_ATTEMPTS; i++) {
          yield* Effect.flip(h.auth.completeRegistration(address, wrong));
        }
        const capped = yield* Effect.forkChild(
          Effect.flip(h.auth.completeRegistration(address, wrong)),
        );
        yield* h.holdingAtLeast(1);

        const later = Date.now() + (base.otpTtl ?? 600) * 1000 + 1_000;
        clock = vi.spyOn(Date, "now").mockReturnValue(later);
        yield* settle(h.auth.beginRegistration(address, "capreg", "1990-01-01"));
        const code = h.code();
        h.release();
        expect((yield* Fiber.join(capped))._tag).toBe("AuthError");

        const done = yield* h.auth.completeRegistration(address, code);
        expect(done.handle).toBe("capreg");
      }).pipe(Effect.ensuring(Effect.sync(() => clock?.mockRestore())), Effect.provide(h.layer));
    },
  );
});

/**
 * A registration whose code's send failed settles the entry its own `begin`
 * wrote, in one call that names that entry: gone when nothing was sent, held a
 * minute when the code may still arrive. Each case holds that call — armed
 * once the steps before it have run — while another request changes the
 * entry, then lets it go.
 */
describe("a failed send's settle touches only the entry its begin wrote", () => {
  it.live("nothing sent: a begin while the settle's delete is in flight keeps its entry", () => {
    let armed = false;
    const mail = scriptedMail(new EmailError({ reason: "dispatch_failed", cause: 403 }));
    const h = harness(
      (store, op) => armed && store === "pending_registration" && op === "remove",
      mail.layer,
    );
    const address = "settle-none@example.com";
    return Effect.gen(function* () {
      yield* h.auth.beginRegistration(address, "settlenone", "1990-01-01");
      const wrong = wrongFor(yield* mail.nth(0));
      // The cap spends the entry while its send is still out.
      for (let i = 1; i <= MAX_OTP_ATTEMPTS; i++) {
        yield* Effect.flip(h.auth.completeRegistration(address, wrong));
      }

      armed = true;
      mail.failFirst();
      yield* h.holdingAtLeast(1);
      yield* settle(h.auth.beginRegistration(address, "settlenone", "1990-01-01"));
      const code = yield* mail.nth(1);
      const from = h.ops().length;
      h.release();
      yield* h.landed("pending_registration.remove", from);

      const done = yield* h.auth.completeRegistration(address, code);
      expect(done.handle).toBe("settlenone");
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "may still arrive: an entry spent while the settle's hold is in flight stays spent",
    () => {
      let armed = false;
      const mail = scriptedMail(new EmailError({ reason: "api_unreachable" }));
      const h = harness(
        (store, op) =>
          armed && store === "pending_registration" && (op === "write" || op === "swap"),
        mail.layer,
      );
      const address = "settle-held@example.com";
      return Effect.gen(function* () {
        yield* h.auth.beginRegistration(address, "settleheld", "1990-01-01");
        const code = yield* mail.nth(0);

        armed = true;
        mail.failFirst();
        yield* h.holdingAtLeast(1);
        const done = yield* h.auth.completeRegistration(address, code);
        expect(done.handle).toBe("settleheld");
        yield* h.landed("pending_registration.remove");
        const from = h.ops().length;
        h.release();
        yield* h.landed(["pending_registration.write", "pending_registration.swap"], from);

        expect(
          yield* Effect.promise(() => h.bundle.ceremonyStores.pendingRegistrations.get(address)),
        ).toBeNull();
      }).pipe(Effect.provide(h.layer));
    },
  );
});
