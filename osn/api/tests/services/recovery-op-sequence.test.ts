import { it, expect, describe } from "@effect/vitest";
import { recoveryCodes } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { CoordinationNamespace } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { RECOVERY_LOCKOUT_THRESHOLD } from "../../src/lib/recovery-lockout-store";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createCapturingTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { latestLinkTo } from "../helpers/registration";

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

/** The stores a recovery link's send reads, after the answer. */
const SEND_LIMIT_STORES = [
  "auth.recovery_link_address_cap",
  "auth.recovery_resend_cap",
  "auth.recovery_link_ceiling",
  "recovery_otp_lockout",
];

/**
 * `ns` with every call to a send-limit store waiting until `release()`, so
 * the calls a begin or a Resend makes before it answers can be told apart from
 * the ones its forked send makes after. A request that waited on one of them
 * would never answer.
 */
function holdingSendLimits(ns: CoordinationNamespace) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped: CoordinationNamespace = {
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      if (!SEND_LIMIT_STORES.some((store) => name.startsWith(`${store}:`))) return stub;
      const later =
        <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
        (...args: A) =>
          gate.then(() => run(...args));
      return {
        ...stub,
        increment: later(stub.increment.bind(stub)),
        count: later(stub.count.bind(stub)),
        read: later(stub.read.bind(stub)),
        write: later(stub.write.bind(stub)),
        remove: later(stub.remove.bind(stub)),
      };
    },
  };
  return { ns: wrapped, release };
}

function harness(options: { holdSendLimits?: boolean } = {}) {
  const fake = createFakeNamespace();
  const limits = holdingSendLimits(fake.ns);
  const bundle = createDurableCoordination(options.holdSendLimits ? limits.ns : fake.ns, () => {});
  const email = makeLogEmailLive();
  const auth = createAuthService({
    ...base,
    ceremonyStores: bundle.ceremonyStores,
    recoveryLockoutStore: bundle.recoveryLockoutStore,
    recoveryOtpLockoutStore: bundle.recoveryOtpLockoutStore,
    recoveryLinkAddressCap: bundle.recoveryLinkAddressCap,
    recoveryResendCap: bundle.recoveryResendCap,
    recoveryLinkCeiling: bundle.recoveryLinkCeiling,
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
  /** Lets the held send-limit calls go, and waits for `count` of them to land. */
  const sendLimitCalls = (count: number) =>
    Effect.gen(function* () {
      limits.release();
      const landed = () =>
        fake.calls.filter((call) => SEND_LIMIT_STORES.includes(call.store)).length;
      for (let i = 0; i < 200 && landed() < count; i++) yield* Effect.sleep("5 millis");
      yield* Effect.sleep("20 millis");
      return landed();
    });
  return { fake, auth, layer, record, sendLimitCalls, recorded: () => email.recorded() };
}

const meta = { ip: "198.51.100.7", uaLabel: null };

describe("POST /login/recovery/email/begin", () => {
  it.live(
    "makes the same calls before it answers whether or not the address has an account",
    () => {
      const h = harness({ holdSendLimits: true });
      return Effect.gen(function* () {
        yield* h.auth.registerProfile("seq-sent@example.com", "seqsent");

        // The send's limits are held: a begin that waited on any of them would
        // never answer.
        const sent = yield* h.record(h.auth.beginEmailRecovery("seq-sent@example.com", meta));
        const nobody = yield* h.record(h.auth.beginEmailRecovery("seq-nobody@example.com", meta));

        expect(sent.ops).toEqual(["email_link.write"]);
        expect(nobody).toEqual(sent);

        // After the answer, only the account's send reads its limits: the
        // lockout, the address cap and the ceiling. A first link spends no
        // Resend.
        expect(yield* h.sendLimitCalls(3)).toBe(3);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("fails alike for a real account and for nobody while every store call fails", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-bdown@example.com", "seqbdown");
      h.fake.failWhen(() => true);
      const real = yield* h.record(h.auth.beginEmailRecovery("seq-bdown@example.com", meta));
      const nobody = yield* h.record(h.auth.beginEmailRecovery("seq-bgone@example.com", meta));
      expect(real.ops.length).toBeGreaterThan(0);
      expect(nobody).toEqual(real);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("POST /login/recovery/email/:requestId/resend and /status", () => {
  it.live("make the same calls and statements whether or not the address has an account", () => {
    const h = harness({ holdSendLimits: true });
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-rs@example.com", "seqrs");
      const known = yield* h.auth.beginEmailRecovery("seq-rs@example.com", meta);
      const nobody = yield* h.auth.beginEmailRecovery("seq-rsnobody@example.com", meta);

      const knownResend = yield* h.record(
        h.auth.resendEmailRecovery(known.requestId, known.claimSecret, meta),
      );
      const nobodyResend = yield* h.record(
        h.auth.resendEmailRecovery(nobody.requestId, nobody.claimSecret, meta),
      );
      expect(knownResend.ops.length).toBeGreaterThan(0);
      expect(nobodyResend).toEqual(knownResend);

      const knownPoll = yield* h.record(
        h.auth.emailRecoveryStatus(known.requestId, known.claimSecret),
      );
      const nobodyPoll = yield* h.record(
        h.auth.emailRecoveryStatus(nobody.requestId, nobody.claimSecret),
      );
      expect(knownPoll.ops).toEqual(["email_link.read"]);
      expect(nobodyPoll).toEqual(knownPoll);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("make the same calls and statements for a request its reader declined", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-rsd@example.com", "seqrsd");
      const known = yield* settle(h.auth.beginEmailRecovery("seq-rsd@example.com", meta));
      const nobody = yield* settle(h.auth.beginEmailRecovery("seq-rsdnobody@example.com", meta));
      const link = latestLinkTo(h.recorded(), "seq-rsd@example.com")!;
      yield* settle(
        h.auth.confirmEmailLink(known.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: "none",
        }),
      );
      const mailed = h.recorded().length;

      const knownResend = yield* h.record(
        settle(h.auth.resendEmailRecovery(known.requestId, known.claimSecret, meta)),
      );
      const nobodyResend = yield* h.record(
        settle(h.auth.resendEmailRecovery(nobody.requestId, nobody.claimSecret, meta)),
      );
      expect(knownResend.ops.length).toBeGreaterThan(0);
      expect(nobodyResend).toEqual(knownResend);
      const knownPoll = yield* h.record(
        h.auth.emailRecoveryStatus(known.requestId, known.claimSecret),
      );
      const nobodyPoll = yield* h.record(
        h.auth.emailRecoveryStatus(nobody.requestId, nobody.claimSecret),
      );
      expect(knownPoll.ops).toEqual(["email_link.read"]);
      expect(nobodyPoll).toEqual(knownPoll);
      expect(h.recorded().length).toBe(mailed);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("POST /email-link/:requestId/confirm on a recovery request", () => {
  it.live("a wrong secret makes the same calls whether or not the address has an account", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-cf@example.com", "seqcf");
      const known = yield* settle(h.auth.beginEmailRecovery("seq-cf@example.com", meta));
      const nobody = yield* settle(h.auth.beginEmailRecovery("seq-cfnobody@example.com", meta));
      const wrong = { linkSecret: "0".repeat(64), pairingPick: known.pairingCode };

      const real = yield* h.record(h.auth.confirmEmailLink(known.requestId, wrong));
      const none = yield* h.record(h.auth.confirmEmailLink(nobody.requestId, wrong));
      // The guess on the request, and nothing on the account.
      expect(real.ops).toEqual(["email_link.guess"]);
      expect(none).toEqual(real);
    }).pipe(Effect.provide(h.layer));
  });
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
 * An address with capitals is looked up as typed and lower-cased, in one
 * statement with two values where a lower-case address has one. Each refusal
 * must still make the same calls, on objects of the same name length, and
 * send the same statements, whether or not the address names an account.
 */
describe("an address typed in capitals", () => {
  it.live("costs the same at every recovery route, whoever it names", () => {
    const h = harness({ holdSendLimits: true });
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-caps@example.com", "seqcaps");

      // The send's limits are held, so no send lands between two records.
      const sent = yield* h.record(h.auth.beginEmailRecovery("SEQ-Caps@Example.com", meta));
      const unsent = yield* h.record(h.auth.beginEmailRecovery("SEQ-CapsNobody@Example.com", meta));
      expect(sent.ops).toEqual(["email_link.write"]);
      expect(unsent).toEqual(sent);
      // The account's send reads its three limits after the answer; let it
      // land before the next routes are recorded.
      expect(yield* h.sendLimitCalls(3)).toBe(3);

      const totp = yield* h.record(h.auth.completeTotpRecovery("SEQ-Caps@Example.com", "000000"));
      const totpNobody = yield* h.record(
        h.auth.completeTotpRecovery("SEQ-CapsNobody@Example.com", "000000"),
      );
      expect(totp.ops).toEqual(["totp_lockout.increment"]);
      expect(totpNobody).toEqual(totp);

      const code = yield* h.record(
        h.auth.consumeRecoveryCode("SEQ-Caps@Example.com", "wrong-code"),
      );
      const codeNobody = yield* h.record(
        h.auth.consumeRecoveryCode("SEQ-CapsNobody@Example.com", "wrong-code"),
      );
      expect(code.ops).toEqual(RECOVERY_CODE_REFUSED);
      expect(codeStatements(code.statements)).toHaveLength(2);
      expect(codeNobody).toEqual(code);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("longer than any account's identifier, is refused at every route with no lookup", () => {
    // No stored email or handle is longer than 255 characters, so a longer
    // identifier names nobody; it gets an unknown identifier's refusal without
    // the account lookup. Goes red on dropping the length check from
    // `resolveIdentifier`.
    const h = harness();
    const long = `${"A".repeat(300)}@Example.com`;
    const lookups = (statements: readonly string[]) =>
      statements.filter((sql) => sql.includes('"accounts"'));
    return Effect.gen(function* () {
      const begun = yield* h.record(h.auth.beginEmailRecovery(long, meta));
      const totp = yield* h.record(h.auth.completeTotpRecovery(long, "000000"));
      const code = yield* h.record(h.auth.consumeRecoveryCode(long, "wrong-code"));

      expect(begun.ops).toEqual(["email_link.write"]);
      expect(totp.ops).toEqual(["totp_lockout.increment"]);
      expect(code.ops).toEqual(RECOVERY_CODE_REFUSED);
      for (const recorded of [begun, totp, code]) {
        expect(lookups(recorded.statements)).toEqual([]);
      }
    }).pipe(Effect.provide(h.layer));
  });
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
