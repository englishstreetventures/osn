import { it, expect, describe } from "@effect/vitest";
import type { CoordinationNamespace, CoordinationOp } from "@shared/coordination";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
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
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped: CoordinationNamespace = {
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      const store = name.slice(0, name.indexOf(":"));
      const call = <A>(op: CoordinationOp, run: () => Promise<A>): Promise<A> =>
        held(store, op) ? gate.then(run) : run();
      return {
        increment: (windowMs) => call("increment", () => stub.increment(windowMs)),
        count: () => call("count", () => stub.count()),
        read: () => call("read", () => stub.read()),
        write: (value, ttlMs) => call("write", () => stub.write(value, ttlMs)),
        remove: () => call("remove", () => stub.remove()),
        claim: (ttlMs) => call("claim", () => stub.claim(ttlMs)),
        guess: () => call("guess", () => stub.guess()),
        take: () => call("take", () => stub.take()),
        swap: (expected, value, ttlMs) => call("swap", () => stub.swap(expected, value, ttlMs)),
      };
    },
  };
  return { ns: wrapped, release };
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
    settledWithout,
    release: gate.release,
  };
}

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
