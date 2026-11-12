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

import { createIssuerNetwork } from "../../src/services/auth/email-verification-network";
import { settle } from "../helpers/background";
import { createFakeIssuer } from "../helpers/email-verification";
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
const SEND_LIMIT_STORES = [
  "auth.registration_send_cap",
  "registration_link_lockout",
  "auth.registration_first_link_cap",
];

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
    registrationFirstLinkCap: bundle.registrationFirstLinkCap,
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
  /** The request's entry as the store holds it. */
  const entry = (requestId: string) =>
    Effect.promise(() => bundle.ceremonyStores.emailLinks.get(requestId));
  return { fake, auth, layer, record, recorded: () => email.recorded(), sendLimitCalls, entry };
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
        // Only the free address's send reads its limits: the lockout, and the
        // mailbox's first-link window. A begin's first link does not count
        // against the Resend cap.
        expect(yield* h.sendLimitCalls(2)).toBe(2);
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

describe("a send-limit store that cannot answer", () => {
  it.live("mails nothing for a begin when the lockout store fails", () => {
    const h = harness();
    return Effect.gen(function* () {
      h.fake.failWhen((call) => call.store === "registration_link_lockout");
      yield* h.auth.beginRegistration("seq-lockdown@example.com", "seqlockdown", "1990-01-01");

      expect(yield* h.sendLimitCalls(1)).toBe(1);
      expect(linksTo(h.recorded(), "seq-lockdown@example.com")).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("mails nothing for a Resend when the send cap fails, though the first link went", () => {
    const h = harness();
    return Effect.gen(function* () {
      const begun = yield* h.auth.beginRegistration(
        "seq-capdown@example.com",
        "seqcapdown",
        "1990-01-01",
      );
      yield* h.sendLimitCalls(2);
      expect(linksTo(h.recorded(), "seq-capdown@example.com")).toHaveLength(1);

      h.fake.failWhen((call) => call.store === "auth.registration_send_cap");
      yield* h.auth.resendRegistration(begun.requestId, begun.claimSecret);
      // The Resend reads the lockout, then the cap, which fails.
      expect(yield* h.sendLimitCalls(4)).toBe(4);
      expect(linksTo(h.recorded(), "seq-capdown@example.com")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("POST /register/:requestId/resend", () => {
  it.live(
    "makes the same calls for a free address's request, a taken one's, and one whose address another sign-up holds or held",
    () => {
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
        const holder = yield* h.auth.beginRegistration(
          "seq-rheld@example.com",
          "seqrholder",
          "1990-01-01",
        );
        const held = yield* h.auth.beginRegistration(
          "seq-rheld@example.com",
          "seqrheld",
          "1990-01-01",
        );

        const freeResend = yield* h.record(
          h.auth.resendRegistration(free.requestId, free.claimSecret),
        );
        const takenResend = yield* h.record(
          h.auth.resendRegistration(taken.requestId, taken.claimSecret),
        );
        const heldResend = yield* h.record(
          h.auth.resendRegistration(held.requestId, held.claimSecret),
        );
        // A request its reader declined: its Resend parks a decoy away from
        // the address and mails nothing, with the same calls.
        const declined = yield* h.auth.beginRegistration(
          "seq-rdeclined@example.com",
          "seqrdeclined",
          "1990-01-01",
        );
        yield* h.sendLimitCalls(2);
        const declinedLink = linksTo(h.recorded(), "seq-rdeclined@example.com")[0]!;
        yield* h.auth.confirmEmailLink(declined.requestId, {
          linkSecret: declinedLink.linkSecret,
          pairingPick: "none",
        });
        const declinedResend = yield* h.record(
          h.auth.resendRegistration(declined.requestId, declined.claimSecret),
        );
        const declinedPoll = yield* h.record(
          h.auth.registrationStatus(declined.requestId, declined.claimSecret),
        );
        const takenPoll = yield* h.record(
          h.auth.registrationStatus(taken.requestId, taken.claimSecret),
        );
        // The holder ends; the held request's next Resend parks its sign-up.
        yield* h.auth.beginRegistration(
          "seq-rheld-2@example.com",
          "seqrholder",
          "1990-01-01",
          undefined,
          { requestId: holder.requestId, claimSecret: holder.claimSecret },
        );
        const parkingResend = yield* h.record(
          h.auth.resendRegistration(held.requestId, held.claimSecret),
        );

        expect(freeResend).toEqual({
          ops: [
            "email_link.read",
            "email_link.swap",
            "pending_registration.swap",
            "pending_registration.read",
          ],
          outcome: "ok",
        });
        expect(takenResend).toEqual(freeResend);
        expect(heldResend).toEqual(freeResend);
        expect(parkingResend).toEqual(freeResend);
        expect(declinedResend).toEqual(freeResend);
        expect(declinedPoll).toEqual({ ops: ["email_link.read"], outcome: "ok" });
        expect(takenPoll).toEqual(declinedPoll);
        expect(linksTo(h.recorded(), "seq-rdeclined@example.com")).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

/**
 * A wrong pick, or a decline, whose writes the store fails: a request one
 * wrong pick has ended never stays confirmable. The mark is tried twice; then
 * the request is deleted; and when the delete is not answered either, this
 * process refuses the request until it expires.
 */
describe("an ending whose writes the store fails", () => {
  /** A begun sign-up, its link, and a wrong pick for it. */
  const begunWithLink = (h: ReturnType<typeof harness>, address: string, handle: string) =>
    Effect.gen(function* () {
      const begun = yield* h.auth.beginRegistration(address, handle, "1990-01-01");
      // The send waits on the held send-limit store; let it go and land.
      yield* h.sendLimitCalls(2);
      const link = linksTo(h.recorded(), address)[0]!;
      const wrong = String(Number(begun.pairingCode) === 99 ? 10 : Number(begun.pairingCode) + 1);
      return { begun, link, wrong };
    });
  const strikes = (h: ReturnType<typeof harness>) =>
    h.fake.calls.filter(
      (call) => call.store === "registration_link_lockout" && call.op === "increment",
    ).length;
  const swaps = (call: { store: string; op: string }) =>
    call.store === "email_link" && call.op === "swap";

  it.live("a mark that fails once is written by the retry: the request is ended", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { begun, link, wrong } = yield* begunWithLink(h, "seq-once@example.com", "seqonce");
      let failed = 0;
      h.fake.failWhen((call) => swaps(call) && failed++ === 0);
      const answer = yield* h.auth.confirmEmailLink(link.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: wrong,
      });
      h.fake.failWhen(null);
      expect(answer).toBe("expired");
      expect(strikes(h)).toBe(1);
      expect((yield* h.entry(begun.requestId))?.status).toBe("ended");
      expect(yield* h.auth.registrationStatus(begun.requestId, begun.claimSecret)).toEqual({
        status: "pending",
        pairingCode: begun.pairingCode,
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "a mark that fails twice deletes the request: the right pick then reads as unknown",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { begun, link, wrong } = yield* begunWithLink(
          h,
          "seq-twice@example.com",
          "seqtwice2",
        );
        h.fake.failWhen(swaps);
        const answer = yield* h.auth.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: wrong,
        });
        h.fake.failWhen(null);
        expect(answer).toBe("expired");
        expect(strikes(h)).toBe(1);
        expect(yield* h.entry(begun.requestId)).toBeNull();
        const right = yield* h.auth.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: begun.pairingCode,
        });
        expect(right).toBe("expired");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live(
    "a mark and a delete that both fail refuse the request: no pick or claim succeeds",
    () => {
      const h = harness();
      const address = "seq-stuck@example.com";
      return Effect.gen(function* () {
        const { begun, link, wrong } = yield* begunWithLink(h, address, "seqstuck");
        // Confirmed first, so a claim is all the tab's poll would need.
        yield* h.auth.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: begun.pairingCode,
        });
        h.fake.failWhen(
          (call) => call.store === "email_link" && (call.op === "swap" || call.op === "remove"),
        );
        const answer = yield* h.auth.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: wrong,
        });
        h.fake.failWhen(null);
        expect(answer).toBe("expired");
        expect(strikes(h)).toBe(1);
        expect((yield* h.entry(begun.requestId))?.status).toBe("confirmed");

        const right = yield* h.auth.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: begun.pairingCode,
        });
        expect(right).toBe("expired");
        expect(
          yield* settle(h.auth.registrationStatus(begun.requestId, begun.claimSecret)),
        ).toEqual({
          status: "expired",
        });
        expect(yield* h.auth.findProfileByEmail(address)).toBeNull();
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live(
    "a decline whose mark and delete both fail is refused, and so is every later pick",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { begun, link } = yield* begunWithLink(h, "seq-stuckdecline@example.com", "seqsd");
        h.fake.failWhen(
          (call) => call.store === "email_link" && (call.op === "swap" || call.op === "remove"),
        );
        const answer = yield* h.auth.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: "none",
        });
        h.fake.failWhen(null);
        expect(answer).toBe("expired");
        const right = yield* h.auth.confirmEmailLink(link.requestId, {
          linkSecret: link.linkSecret,
          pairingPick: begun.pairingCode,
        });
        expect(right).toBe("expired");
      }).pipe(Effect.provide(h.layer));
    },
  );
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

/**
 * A begin whose browser token verified makes one more write on its request
 * whatever the address: it confirms a free address's request, and writes a
 * taken or held one's back unchanged. So a verified begin costs the same for
 * all three, and mails nothing for any of them.
 */
describe("POST /register/begin with a browser token that verifies", () => {
  it.live("makes the same calls whether the address is free, taken, or already pending", () => {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(fake.ns, () => {});
    const email = makeLogEmailLive();
    return Effect.gen(function* () {
      const issuer = yield* Effect.promise(() => createFakeIssuer());
      const auth = createAuthService({
        ...base,
        // `frontendOrigin` reads the first WebAuthn origin: the token's audience.
        origin: "http://localhost:5173",
        ceremonyStores: bundle.ceremonyStores,
        registrationSendCap: bundle.registrationSendCap,
        registrationLinkLockoutStore: bundle.registrationLinkLockoutStore,
        emailVerificationNonceClaims: bundle.emailVerificationNonceClaims,
        emailVerification: { network: createIssuerNetwork(issuer.fetch) },
      });
      const tokenFor = (address: string) =>
        Effect.promise(async () => {
          const minted = auth.emailVerificationNonce();
          if (!minted) throw new Error("no nonce");
          const token = await issuer.mint({
            email: address,
            nonce: minted.nonce,
            aud: "http://localhost:5173",
          });
          return { emailVerificationToken: token, nonceSecret: minted.nonceSecret };
        });
      const begin = (address: string, handle: string) =>
        Effect.gen(function* () {
          const input = yield* tokenFor(address);
          const from = fake.calls.length;
          yield* auth.beginRegistration(address, handle, "1990-01-01", undefined, undefined, input);
          return fake.calls.slice(from).map((call) => `${call.store}.${call.op}`);
        });

      const takenAddress = `seq-vtaken@${issuer.domain}`;
      yield* auth.registerProfile(takenAddress, "seqvtaken");
      const freeAddress = `seq-vfree@${issuer.domain}`;

      const free = yield* begin(freeAddress, "seqvfree");
      const pending = yield* begin(freeAddress, "seqvfree");
      const taken = yield* begin(takenAddress, "seqvother");

      expect(free).toEqual([
        "email_verification_nonce.claim",
        "email_link.write",
        "pending_registration.swap",
        "email_link.swap",
      ]);
      expect(pending).toEqual(free);
      expect(taken).toEqual(free);
      yield* Effect.sleep("20 millis");
      expect(email.recorded()).toHaveLength(0);
    }).pipe(Effect.provide(Layer.merge(createTestLayer(), email.layer)));
  });
});

/**
 * Wrong link secrets on a taken address's request and on one whose reader
 * declined: the reader's confirm counted a guess and its write restarted the
 * count, so the two counts differ. Every wrong secret must still cost the one
 * counting call on both, the one that reaches the cap included.
 */
describe("POST /email-link/:requestId/confirm with wrong secrets", () => {
  it.live("makes the same calls on a taken address's request and a declined one's", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* h.auth.registerProfile("seq-wtaken@example.com", "seqwtaken");
      const declined = yield* h.auth.beginRegistration(
        "seq-wdeclined@example.com",
        "seqwdeclined",
        "1990-01-01",
      );
      yield* h.sendLimitCalls(2);
      const link = linksTo(h.recorded(), "seq-wdeclined@example.com")[0]!;
      yield* h.auth.confirmEmailLink(declined.requestId, {
        linkSecret: link.linkSecret,
        pairingPick: "none",
      });
      const taken = yield* h.auth.beginRegistration(
        "seq-wtaken@example.com",
        "seqwtaken2",
        "1990-01-01",
      );
      const wrong = { linkSecret: "0".repeat(64), pairingPick: "10" };
      for (let n = 0; n < 7; n++) {
        const a = yield* h.record(h.auth.confirmEmailLink(declined.requestId, wrong));
        const b = yield* h.record(h.auth.confirmEmailLink(taken.requestId, wrong));
        expect(a).toEqual({ ops: ["email_link.guess"], outcome: "ok" });
        expect(b).toEqual(a);
      }
    }).pipe(Effect.provide(h.layer));
  });
});
