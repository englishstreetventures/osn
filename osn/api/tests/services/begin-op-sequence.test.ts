/**
 * Passkey sign-in `begin` and registration `begin` answer the same whether or
 * not an identifier names an account (or an address is free), and they must
 * cost the same too. Each store call is a Durable Object round trip, so a
 * branch that makes a call the other skips can be told apart with a
 * stopwatch — and while the store is failing, it answers 503 where the other
 * answers 200. A recording namespace logs every call as `<store>.<op>`; every
 * branch must make the same calls, and every branch must fail together.
 */

import { it, expect, describe } from "@effect/vitest";
import type { CoordinationNamespace } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll, vi } from "vitest";

import { settle } from "../helpers/background";
import { linksTo } from "../helpers/registration";

// Registration's verifier is stubbed so an account can hold a passkey: a unit
// test cannot produce a real attestation.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: `cred-${Math.random().toString(16).slice(2, 12)}`,
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: undefined,
        },
        aaguid: "00000000-0000-0000-0000-000000000000",
        credentialBackedUp: false,
        credentialDeviceType: "singleDevice",
      },
    })),
  };
});

const { createDurableCoordination } = await import("../../src/lib/coordination/durable");
const { createAuthService } = await import("../../src/services/auth");
const { makeTestAuthConfig } = await import("../helpers/auth-config");
const { createFakeNamespace } = await import("../helpers/coordination-namespace");
const { createCapturingTestLayer, createTestLayer } = await import("../helpers/db");

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

/** The per-address limits a sign-up link's send reads, after the answer. */
const SEND_LIMIT_STORES = ["auth.registration_send_cap", "registration_link_lockout"];

/**
 * `ns` with every call to a send-limit store waiting until `release()`, so
 * the ops a begin or a Resend makes before it answers can be told apart from
 * the ones its forked send makes after.
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

function harness() {
  const fake = createFakeNamespace();
  const limits = holdingSendLimits(fake.ns);
  const bundle = createDurableCoordination(limits.ns, () => {});
  const auth = createAuthService({
    ...base,
    ceremonyStores: bundle.ceremonyStores,
    registrationSendCap: bundle.registrationSendCap,
    registrationLinkLockoutStore: bundle.registrationLinkLockoutStore,
  });
  const email = makeLogEmailLive();
  const layer = Layer.merge(createTestLayer(), email.layer);
  /** The calls `run` makes, and how it ended. */
  const record = <A, E extends { readonly _tag: string }, R>(run: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const from = fake.calls.length;
      const result = yield* Effect.result(run);
      return {
        ops: fake.calls.slice(from).map((call) => `${call.store}.${call.op}`),
        outcome: result._tag === "Success" ? "ok" : result.failure._tag,
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
  return { fake, auth, layer, record, recorded: () => email.recorded(), sendLimitCalls };
}

const fakeAttestation = () =>
  ({ id: "x", rawId: "x", response: {}, type: "public-key", clientExtensionResults: {} }) as never;

describe("POST /login/passkey/begin with an identifier", () => {
  it.live(
    "makes the same calls whether the identifier has passkeys, has none, or names nobody",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const withKey = yield* h.auth.registerProfile("seq-pk@example.com", "seqpk");
        yield* h.auth.beginPasskeyRegistration(withKey.accountId);
        yield* h.auth.completePasskeyRegistration(withKey.accountId, fakeAttestation(), null);
        yield* h.auth.registerProfile("seq-nopk@example.com", "seqnopk");

        const real = yield* h.record(h.auth.beginPasskeyLogin("seqpk"));
        const none = yield* h.record(h.auth.beginPasskeyLogin("seqnopk"));
        const nobody = yield* h.record(h.auth.beginPasskeyLogin("seq-pknobody@example.com"));

        expect(real).toEqual({ ops: ["login_challenge.write"], outcome: "ok" });
        expect(none).toEqual(real);
        expect(nobody).toEqual(real);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("makes the same calls for an address typed in capitals, whoever it names", () => {
    // An address with capitals is looked up as typed and lower-cased; that
    // must cost the same whether or not either names an account.
    const h = harness();
    return Effect.gen(function* () {
      const withKey = yield* h.auth.registerProfile("seq-pkcaps@example.com", "seqpkcaps");
      yield* h.auth.beginPasskeyRegistration(withKey.accountId);
      yield* h.auth.completePasskeyRegistration(withKey.accountId, fakeAttestation(), null);

      const real = yield* h.record(h.auth.beginPasskeyLogin("SEQ-PkCaps@Example.com"));
      const nobody = yield* h.record(h.auth.beginPasskeyLogin("SEQ-PkCapsNobody@Example.com"));

      expect(real).toEqual({ ops: ["login_challenge.write"], outcome: "ok" });
      expect(nobody).toEqual(real);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("fails on every branch alike while every store call fails", () => {
    const h = harness();
    return Effect.gen(function* () {
      const withKey = yield* h.auth.registerProfile("seq-pkdown@example.com", "seqpkdown");
      yield* h.auth.beginPasskeyRegistration(withKey.accountId);
      yield* h.auth.completePasskeyRegistration(withKey.accountId, fakeAttestation(), null);
      h.fake.failWhen(() => true);

      const real = yield* h.record(h.auth.beginPasskeyLogin("seqpkdown"));
      const nobody = yield* h.record(h.auth.beginPasskeyLogin("seq-pkgone@example.com"));

      expect(real).toEqual({ ops: ["login_challenge.write"], outcome: "CoordinationError" });
      expect(nobody).toEqual(real);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("POST /login/passkey/complete with an identifier", () => {
  it.live(
    "makes the same calls and statements refusing a stranger's credential, whoever the identifier names",
    () => {
      // A known identifier's `begin` parks its challenge where `complete`
      // reads it, and an unknown one's at the probe key, where nothing does.
      // The refusal of a credential the caller does not hold must still cost
      // the same, or `begin` then `complete` reads out whether an address has
      // an account.
      const fake = createFakeNamespace();
      const bundle = createDurableCoordination(fake.ns, () => {});
      const auth = createAuthService({ ...base, ceremonyStores: bundle.ceremonyStores });
      const database = createCapturingTestLayer();
      const record = <A, E extends { readonly _tag: string }, R>(run: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const from = fake.calls.length;
          const fromStatement = database.captured.length;
          const result = yield* Effect.result(run);
          return {
            ops: fake.calls.slice(from).map((call) => `${call.store}.${call.op}`),
            statements: database.captured.slice(fromStatement).map((statement) => statement.sql),
            outcome: result._tag === "Success" ? "ok" : result.failure._tag,
          };
        });
      const stranger = {
        id: "not-a-stored-credential",
        rawId: "not-a-stored-credential",
        response: {},
        type: "public-key",
        clientExtensionResults: {},
      } as never;
      return Effect.gen(function* () {
        const withKey = yield* auth.registerProfile("seq-pkc@example.com", "seqpkc");
        yield* auth.beginPasskeyRegistration(withKey.accountId);
        yield* auth.completePasskeyRegistration(withKey.accountId, fakeAttestation(), null);

        yield* auth.beginPasskeyLogin("SEQ-PKC@Example.com");
        yield* auth.beginPasskeyLogin("SEQ-PKCNobody@Example.com");
        const real = yield* record(
          auth.completePasskeyLoginDirect({
            identifier: "SEQ-PKC@Example.com",
            assertion: stranger,
          }),
        );
        const nobody = yield* record(
          auth.completePasskeyLoginDirect({
            identifier: "SEQ-PKCNobody@Example.com",
            assertion: stranger,
          }),
        );

        expect(real.outcome).toBe("AuthError");
        expect(real.statements).toHaveLength(1);
        expect(nobody).toEqual(real);
      }).pipe(Effect.provide(database.layer));
    },
  );
});

describe("POST /register/begin", () => {
  it.live(
    "makes the same calls whether the address is free, taken, or already pending, and reads the send limits only after answering a free one",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        yield* h.auth.registerProfile("seq-taken@example.com", "seqtaken");

        const free = yield* h.record(
          h.auth.beginRegistration("seq-free@example.com", "seqfree", "1990-01-01"),
        );
        const pending = yield* h.record(
          h.auth.beginRegistration("seq-free@example.com", "seqfree", "1990-01-01"),
        );
        const taken = yield* h.record(
          h.auth.beginRegistration("seq-taken@example.com", "seqother", "1990-01-01"),
        );

        expect(free).toEqual({
          ops: ["email_link.write", "pending_registration.swap"],
          outcome: "ok",
        });
        expect(pending).toEqual(free);
        expect(taken).toEqual(free);
        // Only the free address's send reads a limit: the lockout. A begin's
        // first link does not count against the Resend cap.
        expect(yield* h.sendLimitCalls(1)).toBe(1);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("fails on every branch alike while every store call fails", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-taken2@example.com", "seqtaken2");
      h.fake.failWhen(() => true);

      const free = yield* h.record(
        h.auth.beginRegistration("seq-free2@example.com", "seqfree2", "1990-01-01"),
      );
      const taken = yield* h.record(
        h.auth.beginRegistration("seq-taken2@example.com", "seqother2", "1990-01-01"),
      );

      expect(free).toEqual({ ops: ["email_link.write"], outcome: "CoordinationError" });
      expect(taken).toEqual(free);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("POST /register/:requestId/resend", () => {
  it.live("makes the same calls for a taken address's request as for a free one's", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-rtaken@example.com", "seqrtaken");
      const free = yield* h.auth.beginRegistration(
        "seq-rfree@example.com",
        "seqrfree",
        "1990-01-01",
      );
      const taken = yield* h.auth.beginRegistration(
        "seq-rtaken@example.com",
        "seqrother",
        "1990-01-01",
      );

      const freeResend = yield* h.record(
        h.auth.resendRegistration(free.requestId, free.claimSecret),
      );
      const takenResend = yield* h.record(
        h.auth.resendRegistration(taken.requestId, taken.claimSecret),
      );

      expect(freeResend).toEqual({
        ops: ["email_link.read", "email_link.swap", "pending_registration.read"],
        outcome: "ok",
      });
      expect(takenResend).toEqual(freeResend);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a wrong pick whose delete the store fails", () => {
  it.live("still answers expired and counts the strike", () => {
    const h = harness();
    return Effect.gen(function* () {
      const begun = yield* h.auth.beginRegistration(
        "seq-wrongpick@example.com",
        "seqwrongpick",
        "1990-01-01",
      );
      // The send waits on the held send-limit store; let it go and land.
      yield* h.sendLimitCalls(1);
      const link = linksTo(h.recorded(), "seq-wrongpick@example.com")[0]!;
      h.fake.failWhen((call) => call.store === "email_link" && call.op === "remove");

      const wrong = String(Number(begun.pairingCode) === 99 ? 10 : Number(begun.pairingCode) + 1);
      const answer = yield* h.auth.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: wrong,
      });
      expect(answer).toBe("expired");
      const strikes = h.fake.calls.filter(
        (call) => call.store === "registration_link_lockout" && call.op === "increment",
      );
      expect(strikes).toHaveLength(1);
      expect(begun.requestId).toBe(link.requestId);
    }).pipe(Effect.provide(h.layer));
  });
});

/**
 * Two begins for one address at once: the first parks its sign-up, the second
 * finds it live and sends nothing, however the two calls interleave. Every
 * `read` answers a few milliseconds late here, as a round trip does, so a
 * begin that read and then wrote would let both through.
 */
describe("POST /register/begin, twice at once for one address", () => {
  const READ_DELAY_MS = 10;

  /** `ns` with every `read` answering `READ_DELAY_MS` late. */
  const slowReads = (ns: CoordinationNamespace): CoordinationNamespace => ({
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      return {
        ...stub,
        read: async () => {
          const value = await stub.read();
          await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
          return value;
        },
      };
    },
  });

  it.live("sends one link", () => {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(slowReads(fake.ns), () => {});
    const auth = createAuthService({ ...base, ceremonyStores: bundle.ceremonyStores });
    const email = makeLogEmailLive();
    return Effect.gen(function* () {
      const both = yield* settle(
        Effect.all(
          [
            auth.beginRegistration("seq-twice@example.com", "seqtwice", "1990-01-01"),
            auth.beginRegistration("seq-twice@example.com", "seqtwice", "1990-01-01"),
          ],
          { concurrency: "unbounded" },
        ),
      );
      expect(both.map((answer) => answer.requestId)).toHaveLength(2);
      expect(email.recorded()).toHaveLength(1);
    }).pipe(Effect.provide(Layer.merge(createTestLayer(), email.layer)));
  });
});
