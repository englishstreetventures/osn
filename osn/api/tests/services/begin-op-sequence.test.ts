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
const { createTestLayer } = await import("../helpers/db");

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

function harness() {
  const fake = createFakeNamespace();
  const bundle = createDurableCoordination(fake.ns, () => {});
  const auth = createAuthService({ ...base, ceremonyStores: bundle.ceremonyStores });
  const layer = Layer.merge(createTestLayer(), makeLogEmailLive().layer);
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
  return { fake, auth, layer, record };
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

describe("POST /register/begin", () => {
  it.live("makes the same calls whether the address is free, taken, or already pending", () => {
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

      expect(free).toEqual({ ops: ["pending_registration.swap"], outcome: "ok" });
      expect(pending).toEqual(free);
      expect(taken).toEqual(free);
    }).pipe(Effect.provide(h.layer));
  });

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

      expect(free).toEqual({ ops: ["pending_registration.swap"], outcome: "CoordinationError" });
      expect(taken).toEqual(free);
    }).pipe(Effect.provide(h.layer));
  });
});

/**
 * Two begins for one address at once: the first parks its code, the second
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

  it.live("sends one code", () => {
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
      expect(both).toEqual([{ sent: true }, { sent: true }]);
      expect(email.recorded()).toHaveLength(1);
    }).pipe(Effect.provide(Layer.merge(createTestLayer(), email.layer)));
  });
});
