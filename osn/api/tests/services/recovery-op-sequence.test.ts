import { it, expect, describe } from "@effect/vitest";
import { recoveryCodes } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { RECOVERY_LOCKOUT_THRESHOLD } from "../../src/lib/recovery-lockout-store";
import { createAuthService } from "../../src/services/auth";
import { RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createCapturingTestLayer, createTestLayerWithSqlite } from "../helpers/db";

/**
 * F-CL13. The recovery routes answer the same whether or not the identifier
 * names an account, and they must cost the same too: each store call is a
 * Durable Object round trip, so a branch that makes different calls — or
 * calls on objects named differently — can be told apart with a stopwatch.
 * A recording namespace logs every call as `<store>.<op>` and the name of the
 * object it reached; every refusal must make the same calls, in the same
 * order, on objects whose names have the same length. Where the routes also
 * touch D1, every refusal sends the same statements too.
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
    recoveryLockoutStore: bundle.recoveryLockoutStore,
    recoveryOtpLockoutStore: bundle.recoveryOtpLockoutStore,
    recoveryEmailBeginCap: bundle.recoveryEmailBeginCap,
    totpLockoutStore: bundle.totpLockoutStore,
  });
  const database = createCapturingTestLayer();
  const layer = Layer.merge(Layer.succeed(Db, { db: database.db }), email.layer);
  /**
   * The calls `run` makes, the lengths of the object names they reach, and
   * the SQL of every D1 statement it sends (the bound values left out).
   */
  const record = <A, E, R>(run: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const from = fake.calls.length;
      const fromStatement = database.captured.length;
      yield* Effect.result(run);
      return {
        ops: fake.calls.slice(from).map((call) => `${call.store}.${call.op}`),
        nameLengths: fake.names.slice(from).map((name) => name.length),
        statements: database.captured.slice(fromStatement).map((statement) => statement.sql),
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

const BEGIN = ["auth.recovery_email_begin_cap.increment", "pending_recovery_otp.write"];

// The first two run side by side, started in this order.
const COMPLETE_REFUSED = [
  "recovery_otp_lockout.count",
  "pending_recovery_otp.guess",
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
      expect(right.ops.slice(0, 2)).toEqual(COMPLETE_REFUSED.slice(0, 2));
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
      // A handle, like the real one: a handle and an address resolve through
      // different lookups, whoever they name.
      const nobody = yield* h.record(h.auth.completeTotpRecovery("seqtnobody", "000000"));
      // One call each: the attempt is counted before its code is compared.
      expect(real.ops).toEqual(["totp_lockout.increment"]);
      expect(nobody).toEqual(real);
    }).pipe(Effect.provide(h.layer));
  });
});

const RECOVERY_CODE_REFUSED = ["recovery_lockout.count", "recovery_lockout.increment"];

/** The D1 statements of a refusal that touch `recovery_codes`, in order. */
const codeStatements = (statements: readonly string[]) =>
  statements.filter((sql) => sql.includes("recovery_codes"));

describe("POST /login/recovery/complete", () => {
  it.live(
    "makes the same store calls and D1 statements on every refusal, whoever the identifier names",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        // A real account, a wrong code.
        yield* h.auth.registerProfile("seq-rc-wrong@example.com", "seqrcwrong");
        const wrong = yield* h.record(h.auth.consumeRecoveryCode("seqrcwrong", "wrong-code"));

        // A locked account: the threshold's worth of wrong codes first.
        yield* h.auth.registerProfile("seq-rc-lock@example.com", "seqrclock");
        for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
          yield* Effect.result(h.auth.consumeRecoveryCode("seqrclock", "wrong-code"));
        }
        // The threshold's audit row is written in the background; let it land
        // before the next request is recorded.
        yield* Effect.sleep("20 millis");
        const locked = yield* h.record(h.auth.consumeRecoveryCode("seqrclock", "wrong-code"));

        // An identifier that names no account.
        const nobody = yield* h.record(h.auth.consumeRecoveryCode("seqrcnobody", "wrong-code"));

        expect(wrong.ops).toEqual(RECOVERY_CODE_REFUSED);
        expect(codeStatements(wrong.statements)).toHaveLength(2);
        expect(locked).toEqual(wrong);
        expect(nobody).toEqual(wrong);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live(
    "makes the same calls for a real account and for nobody while every store call fails",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        yield* h.auth.registerProfile("seq-rc-down@example.com", "seqrcdown");
        h.fake.failWhen(() => true);

        const real = yield* h.record(h.auth.consumeRecoveryCode("seqrcdown", "wrong-code"));
        const nobody = yield* h.record(h.auth.consumeRecoveryCode("seqrcgone", "wrong-code"));

        expect(real.ops).toEqual(RECOVERY_CODE_REFUSED);
        expect(nobody).toEqual(real);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

/**
 * A refused recovery code reads `recovery_codes` to classify the refusal and
 * records the failure on the store; neither waits on the other, so they run
 * side by side, on the real branch and on the padded one alike. Here every
 * read of `recovery_codes` waits until released: the failure record must
 * reach the store while it waits.
 */
describe("POST /login/recovery/complete, a refusal's last two calls", () => {
  /** `node`, a query builder, not run while `gate` holds once it reads `recovery_codes`. */
  function holdChain(
    node: object,
    gate: { readonly held: Promise<void> },
    reads: { codes: boolean },
  ): object {
    return new Proxy(node, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop === "then") {
          return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            (reads.codes ? gate.held : Promise.resolve())
              .then(() =>
                (value as (...a: unknown[]) => unknown).call(target, (real: unknown) => real),
              )
              .then(onFulfilled, onRejected);
        }
        return (...args: unknown[]) => {
          if (prop === "from" && args[0] === recoveryCodes) reads.codes = true;
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out !== null && typeof out === "object" ? holdChain(out, gate, reads) : out;
        };
      },
    });
  }

  function harness() {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(fake.ns, () => {});
    const auth = createAuthService({ ...base, recoveryLockoutStore: bundle.recoveryLockoutStore });
    let release!: () => void;
    const gate = {
      held: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { db } = createTestLayerWithSqlite();
    const holding = new Proxy(db as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "select" && typeof value === "function") {
          return (...args: unknown[]) =>
            holdChain((value as (...a: unknown[]) => object).apply(target, args), gate, {
              codes: false,
            });
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
    const layer = Layer.merge(Layer.succeed(Db, { db: holding }), makeLogEmailLive().layer);
    /** Whether the failure record reaches the store within a second. */
    const recorded = Effect.gen(function* () {
      for (let i = 0; i < 100; i++) {
        if (fake.calls.some((c) => `${c.store}.${c.op}` === "recovery_lockout.increment")) {
          return true;
        }
        yield* Effect.sleep("10 millis");
      }
      return false;
    });
    return { auth, layer, recorded, release };
  }

  /** Refuses a wrong code for `handle`, answering whether the failure was recorded while the read waited. */
  const refuse = (handle: string, real: boolean) => {
    const h = harness();
    return Effect.gen(function* () {
      if (real) yield* h.auth.registerProfile(`${handle}@example.com`, handle);
      const refusal = yield* Effect.forkChild(
        Effect.result(h.auth.consumeRecoveryCode(handle, "wrong-code")),
      );
      const sideBySide = yield* h.recorded;
      h.release();
      const outcome = yield* Fiber.join(refusal);
      return { sideBySide, outcome: outcome._tag };
    }).pipe(Effect.provide(h.layer));
  };

  it.live("records the failure while the classification read waits, for a real account", () =>
    refuse("seqrcpar", true).pipe(
      Effect.map((result) => expect(result).toEqual({ sideBySide: true, outcome: "Failure" })),
    ),
  );

  it.live("records the failure while the classification read waits, for nobody", () =>
    refuse("seqrcparnobody", false).pipe(
      Effect.map((result) => expect(result).toEqual({ sideBySide: true, outcome: "Failure" })),
    ),
  );
});
