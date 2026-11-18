import { it, expect, describe } from "@effect/vitest";
import { totpCredentials } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { CoordinationNamespace, CoordinationOp } from "@shared/coordination";
import { base32Decode, deriveTotpCode } from "@shared/crypto/totp";
import { type EmailService, makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { TOTP_MAX_ENROLL_ATTEMPTS } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";
import { latestLinkTo } from "../helpers/registration";
import {
  changeEmailThroughService,
  confirmedEmailChange,
  NO_LIVE_SESSION,
} from "../helpers/step-up-link";
import { completeTotpStepUp, mintStepUpToken } from "../helpers/step-up-session";

/**
 * A success answers once the work that matters has committed. The store call
 * that only tidies up after it — deleting a spent code's entry, clearing a
 * lockout counter — runs in the background, registered with the request's
 * `waitUntil`, so the caller never waits a round trip for it. Each case holds
 * that one call until the answer is in, which an awaited cleanup would never
 * reach, then lets it go and checks it landed. A recovery code whose counter
 * read 0 on the way in has nothing to clear, so it makes no call at all. A TOTP check counts its own attempt before it compares
 * the code, so a right code always clears the count.
 *
 * The later cases hold one call — a cleanup, a claim, a capped guess's delete
 * — while another request writes at the same key, then let it go and check
 * what the other request wrote survived it.
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
  const recorded = () => email.recorded();
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
    recorded,
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
    const token = yield* mintStepUpToken(auth, profile.accountId, "passkey", "totp_enroll");
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

describe("success paths answer without waiting on their cleanup", () => {
  it.live("registration complete: the pending entry's delete", () => {
    const h = harness((store, op) => store === "pending_registration" && op === "remove");
    const address = "clean-reg@example.com";
    return Effect.gen(function* () {
      const begun = yield* settle(h.auth.beginRegistration(address, "cleanreg", "1990-01-01"));
      const link = latestLinkTo(h.recorded(), address)!;
      yield* h.auth.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: begun.pairingCode,
      });
      const done = yield* h.auth
        .registrationStatus(begun.requestId, begun.claimSecret)
        .pipe(Effect.timeout(ANSWER_WITHIN));
      expect(done.status === "complete" && done.handle).toBe("cleanreg");
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
      yield* Effect.flip(completeTotpStepUp(h.auth, profile.accountId, "000000"));

      const done = yield* completeTotpStepUp(h.auth, profile.accountId, next).pipe(
        Effect.timeout(ANSWER_WITHIN),
      );
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
      const done = yield* completeTotpStepUp(h.auth, profile.accountId, next).pipe(
        Effect.timeout(ANSWER_WITHIN),
      );
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
});

/**
 * A cleanup removes only what its own request saw. Each case holds the cleanup
 * while another request writes to the same key — a new `begin`, a wrong code —
 * then lets the cleanup land, and checks that the other request's write
 * survived it.
 */
describe("a cleanup leaves what another request wrote", () => {
  it.live("email change: a begin after the answer keeps its entry", () => {
    // Every pending-change remove is held, so the completed change's cleanup
    // is still in flight when the next change begins.
    const h = harness((store, op) => store === "pending_email_change" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("keep-ec@example.com", "keepec");
      const first = yield* mintStepUpToken(h.auth, profile.accountId, "otp", "email_change");
      yield* changeEmailThroughService(
        h.auth,
        profile.accountId,
        "keep-ec-1@example.com",
        first,
        h.recorded,
      );
      yield* h.holdingAtLeast(1);

      const begun = yield* confirmedEmailChange(
        h.auth,
        profile.accountId,
        "keep-ec-2@example.com",
        h.recorded,
      );
      h.release();

      const second = yield* mintStepUpToken(h.auth, profile.accountId, "otp", "email_change");
      const done = yield* h.auth.completeEmailChange(
        profile.accountId,
        profile.id,
        begun.requestId,
        begun.claimSecret,
        second,
        NO_LIVE_SESSION,
      );
      expect(done.email).toBe("keep-ec-2@example.com");
    }).pipe(Effect.provide(h.layer));
  });

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
      yield* Effect.flip(completeTotpStepUp(h.auth, profile.accountId, wrongFor(next)));
      yield* completeTotpStepUp(h.auth, profile.accountId, next);

      // The reset is still held when the next attempt is counted.
      yield* Effect.flip(completeTotpStepUp(h.auth, profile.accountId, wrongFor(next)));
      h.release();
      yield* h.landed("totp_lockout.remove");
      expect(
        yield* Effect.promise(() => h.bundle.totpLockoutStore.status(profile.accountId)),
      ).toEqual({ status: "open", failures: 1 });
    }).pipe(Effect.provide(h.layer));
  });
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
  it.live("TOTP enrolment: a begin while the right code's claim is in flight", () => {
    const h = harness((store, op) => store === "pending_totp_enroll" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("claim-totp@example.com", "claimtotp");
      const token = () => mintStepUpToken(h.auth, profile.accountId, "passkey", "totp_enroll");
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
      const token = () => mintStepUpToken(h.auth, profile.accountId, "passkey", "totp_enroll");
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

  it.live("email change: a begin while the request's claim is in flight keeps its entry", () => {
    // The claim is the request's own entry, which a new begin does not touch,
    // so the change already authorised goes through; the cleanup after it
    // removes the account's pending change only while it names that request,
    // so the new begin's change can still complete.
    const h = harness((store, op) => store === "email_link" && op === "remove");
    return Effect.gen(function* () {
      const profile = yield* h.auth.registerProfile("claim-ec@example.com", "claimec");
      const first = yield* mintStepUpToken(h.auth, profile.accountId, "otp", "email_change");
      const old = yield* confirmedEmailChange(
        h.auth,
        profile.accountId,
        "claim-ec-1@example.com",
        h.recorded,
      );
      const finishing = yield* Effect.forkChild(
        h.auth.completeEmailChange(
          profile.accountId,
          profile.id,
          old.requestId,
          old.claimSecret,
          first,
          NO_LIVE_SESSION,
        ),
      );
      yield* h.holdingAtLeast(1);

      const begun = yield* confirmedEmailChange(
        h.auth,
        profile.accountId,
        "claim-ec-2@example.com",
        h.recorded,
      );
      h.release();
      expect((yield* Fiber.join(finishing)).email).toBe("claim-ec-1@example.com");

      const second = yield* mintStepUpToken(h.auth, profile.accountId, "otp", "email_change");
      const done = yield* h.auth.completeEmailChange(
        profile.accountId,
        profile.id,
        begun.requestId,
        begun.claimSecret,
        second,
        NO_LIVE_SESSION,
      );
      expect(done.email).toBe("claim-ec-2@example.com");
    }).pipe(Effect.provide(h.layer));
  });
});
