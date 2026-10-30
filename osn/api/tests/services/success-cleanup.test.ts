import { it, expect, describe } from "@effect/vitest";
import type { CoordinationNamespace, CoordinationOp } from "@shared/coordination";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { MAX_OTP_ATTEMPTS } from "../../src/services/auth/constants";
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

function harness(held: (store: string, op: CoordinationOp) => boolean = () => false) {
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
  const layer = Layer.merge(createTestLayer(), email.layer);
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
  /** Waits until `op` has reached the store. */
  const landed = (op: string) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        if (ops().includes(op)) return;
        yield* Effect.sleep("5 millis");
      }
      throw new Error(`${op} never reached the store`);
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

  it.live("email change complete: the spent entry's delete", () => {
    const h = harness((store, op) => store === "pending_email_change" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("clean-ec@example.com", "cleanec");
      const token = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
      yield* h.auth.beginEmailChange(profile.accountId, "clean-ec-new@example.com");
      const done = yield* h.auth
        .completeEmailChange(profile.accountId, h.code(), token, null)
        .pipe(Effect.timeout(ANSWER_WITHIN));
      expect(done.email).toBe("clean-ec-new@example.com");
      h.release();
      yield* h.landed("pending_email_change.remove");
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
    const h = harness((store, op) => store === "pending_email_change" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("keep-ec@example.com", "keepec");
      const first = yield* h.auth.issueStepUpToken(profile.accountId, "otp", "email_change");
      yield* h.auth.beginEmailChange(profile.accountId, "keep-ec-1@example.com");
      yield* h.auth.completeEmailChange(profile.accountId, h.code(), first, null);

      // The completed change's delete is still held when the next change begins.
      yield* h.auth.beginEmailChange(profile.accountId, "keep-ec-2@example.com");
      const code = h.code();
      h.release();
      yield* h.landed("pending_email_change.remove");

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
