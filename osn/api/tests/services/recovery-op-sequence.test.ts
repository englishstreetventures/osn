import { it, expect, describe } from "@effect/vitest";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";

/**
 * F-CL13. The emailed-recovery routes answer the same whether or not the
 * identifier names an account, and they must cost the same too: each store
 * call is a Durable Object round trip, so a branch that makes different calls
 * — or calls on objects named differently — can be told apart with a
 * stopwatch. A recording namespace logs every call as `<store>.<op>` and the
 * name of the object it reached; every refusal must make the same calls, in
 * the same order, on objects whose names have the same length.
 */

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

function harness() {
  const fake = createFakeNamespace();
  const bundle = createDurableCoordination(fake.ns, () => {});
  const email = makeLogEmailLive();
  const auth = createAuthService({
    ...base,
    ceremonyStores: bundle.ceremonyStores,
    recoveryOtpLockoutStore: bundle.recoveryOtpLockoutStore,
    recoveryEmailBeginCap: bundle.recoveryEmailBeginCap,
    totpLockoutStore: bundle.totpLockoutStore,
  });
  const layer = Layer.merge(createTestLayer(), email.layer);
  /** The calls `run` makes, and the lengths of the object names they reach. */
  const record = <A, E, R>(run: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const from = fake.calls.length;
      yield* Effect.result(run);
      return {
        ops: fake.calls.slice(from).map((call) => `${call.store}.${call.op}`),
        nameLengths: fake.names.slice(from).map((name) => name.length),
      };
    });
  const codes = () =>
    email.recorded().flatMap((sent) => sent.text.match(/code is: (\d{6})/)?.[1] ?? []);
  /** The `n`th recovery code mailed; the send runs in the background. */
  const nthCode = (n: number) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        if (codes().length > n) return codes()[n]!;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      }
      throw new Error("no code captured");
    });
  return { fake, auth, layer, record, nthCode };
}

const BEGIN = [
  "auth.recovery_email_begin_cap.increment",
  "pending_recovery_otp.write",
  "pending_recovery_otp-attempts.remove",
];

const COMPLETE_REFUSED = [
  "recovery_otp_lockout.count",
  "pending_recovery_otp.read",
  "pending_recovery_otp-attempts.increment",
  "recovery_otp_lockout.increment",
];

describe("POST /login/recovery/email/begin", () => {
  it.live("makes the same calls whether it sends, is capped, or names nobody", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-sent@example.com", "seqsent");
      yield* h.auth.registerProfile("seq-cap@example.com", "seqcap");
      for (let i = 0; i < RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX; i++) {
        yield* h.auth.beginEmailRecovery("seq-cap@example.com");
      }

      const sent = yield* h.record(h.auth.beginEmailRecovery("seq-sent@example.com"));
      const capped = yield* h.record(h.auth.beginEmailRecovery("seq-cap@example.com"));
      const nobody = yield* h.record(h.auth.beginEmailRecovery("seq-nobody@example.com"));

      expect(sent.ops).toEqual(BEGIN);
      expect(capped).toEqual(sent);
      expect(nobody).toEqual(sent);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("POST /login/recovery/email/complete", () => {
  it.live("makes the same calls on every refusal, whoever the identifier names", () => {
    const h = harness();
    return Effect.gen(function* () {
      // A code pending, answered wrongly.
      yield* h.auth.registerProfile("seq-wrong@example.com", "seqwrong");
      yield* h.auth.beginEmailRecovery("seq-wrong@example.com");
      yield* h.nthCode(0);
      const wrong = yield* h.record(
        h.auth.completeEmailRecovery("seq-wrong@example.com", "000000"),
      );

      // A real account with nothing pending.
      yield* h.auth.registerProfile("seq-empty@example.com", "seqempty");
      const empty = yield* h.record(
        h.auth.completeEmailRecovery("seq-empty@example.com", "000000"),
      );

      // A locked account: five wrong codes against one pending entry.
      yield* h.auth.registerProfile("seq-lock@example.com", "seqlock");
      yield* h.auth.beginEmailRecovery("seq-lock@example.com");
      yield* h.nthCode(1);
      for (let i = 0; i < 5; i++) {
        yield* Effect.result(h.auth.completeEmailRecovery("seq-lock@example.com", "000000"));
      }
      const locked = yield* h.record(
        h.auth.completeEmailRecovery("seq-lock@example.com", "000000"),
      );

      // An identifier that names no account.
      const nobody = yield* h.record(
        h.auth.completeEmailRecovery("seq-nobody@example.com", "000000"),
      );

      expect(wrong.ops).toEqual(COMPLETE_REFUSED);
      expect(empty).toEqual(wrong);
      expect(locked).toEqual(wrong);
      expect(nobody).toEqual(wrong);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a right code makes the same calls as a wrong one until the code is compared", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-right@example.com", "seqright");
      yield* h.auth.beginEmailRecovery("seq-right@example.com");
      const code = yield* h.nthCode(0);
      const right = yield* h.record(h.auth.completeEmailRecovery("seq-right@example.com", code));
      expect(right.ops.slice(0, 3)).toEqual(COMPLETE_REFUSED.slice(0, 3));
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "makes the same calls for a real account and for nobody while every store call fails",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        yield* h.auth.registerProfile("seq-down@example.com", "seqdown");
        yield* h.auth.beginEmailRecovery("seq-down@example.com");
        yield* h.nthCode(0);
        h.fake.failWhen(() => true);

        const real = yield* h.record(
          h.auth.completeEmailRecovery("seq-down@example.com", "000000"),
        );
        const nobody = yield* h.record(
          h.auth.completeEmailRecovery("seq-gone@example.com", "000000"),
        );

        expect(real.ops.length).toBeGreaterThan(0);
        expect(nobody).toEqual(real);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("POST /login/recovery/totp/complete", () => {
  it.live("makes the same calls for a real account and for nobody", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-totp@example.com", "seqtotp");
      const real = yield* h.record(h.auth.completeTotpRecovery("seqtotp", "000000"));
      const nobody = yield* h.record(
        h.auth.completeTotpRecovery("seq-tnobody@example.com", "000000"),
      );
      expect(real.ops).toEqual(["totp_lockout.count", "totp_lockout.increment"]);
      expect(nobody).toEqual(real);
    }).pipe(Effect.provide(h.layer));
  });
});
