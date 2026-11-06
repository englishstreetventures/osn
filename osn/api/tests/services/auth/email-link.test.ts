/**
 * The emailed-link request under writes that land together: two people
 * acting on one link at once, a Resend landing between a read and its write,
 * and the tab's claim landing between a wrong pick's read and its delete.
 * Each store answer here can be made to come back late, as a round trip does,
 * so the calls interleave the way they would on the Durable Object; every
 * call still runs, in full, at the moment it is made.
 */

import { it, expect, describe } from "@effect/vitest";
import type { CoordinationNamespace, CoordinationOp } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../../src/lib/coordination/durable";
import { createAuthService } from "../../../src/services/auth";
import { makeTestAuthConfig } from "../../helpers/auth-config";
import { settle } from "../../helpers/background";
import { createFakeNamespace } from "../../helpers/coordination-namespace";
import { createTestLayerWithSqlite } from "../../helpers/db";
import { latestLinkTo, linksTo } from "../../helpers/registration";

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

type Late = Partial<Record<CoordinationOp, number>>;

/**
 * `ns` with each operation `late()` names answering that many milliseconds
 * after it ran. The operation itself runs, and is recorded, when it is called.
 */
function answeringLate(ns: CoordinationNamespace, late: () => Late): CoordinationNamespace {
  return {
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      const delayed =
        <A extends unknown[], R>(op: CoordinationOp, run: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          const value = await run(...args);
          const ms = late()[op];
          if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
          return value;
        };
      return {
        increment: delayed("increment", stub.increment.bind(stub)),
        count: delayed("count", stub.count.bind(stub)),
        read: delayed("read", stub.read.bind(stub)),
        write: delayed("write", stub.write.bind(stub)),
        remove: delayed("remove", stub.remove.bind(stub)),
        claim: delayed("claim", stub.claim.bind(stub)),
        guess: delayed("guess", stub.guess.bind(stub)),
        take: delayed("take", stub.take.bind(stub)),
        swap: delayed("swap", stub.swap.bind(stub)),
      };
    },
  };
}

function harness() {
  const fake = createFakeNamespace();
  let late: Late = {};
  const bundle = createDurableCoordination(
    answeringLate(fake.ns, () => late),
    () => {},
  );
  const auth = createAuthService({
    ...base,
    ceremonyStores: bundle.ceremonyStores,
    registrationSendCap: bundle.registrationSendCap,
    registrationLinkLockoutStore: bundle.registrationLinkLockoutStore,
  });
  const email = makeLogEmailLive();
  const db = createTestLayerWithSqlite();
  const layer = Layer.merge(db.layer, email.layer);

  /** A sign-up begun for a free `address`, and the link mailed for it. */
  const begun = (address: string, handle: string) =>
    Effect.gen(function* () {
      const answer = yield* settle(auth.beginRegistration(address, handle, "1990-01-01"));
      const link = latestLinkTo(email.recorded(), address);
      if (!link || link.requestId !== answer.requestId) {
        return yield* Effect.die(new Error(`no link mailed for ${address}`));
      }
      return { ...answer, link };
    });

  return {
    auth,
    db,
    layer,
    recorded: () => email.recorded(),
    /** From now on, each operation named answers that many milliseconds late. */
    answerLate: (next: Late) => {
      late = next;
    },
    /** The request's entry as the store holds it. */
    entry: (requestId: string) =>
      Effect.promise(() => bundle.ceremonyStores.emailLinks.get(requestId)),
    /** Wrong picks counted against any address so far. */
    strikes: () =>
      fake.calls.filter(
        (call) => call.store === "registration_link_lockout" && call.op === "increment",
      ).length,
    begun,
  };
}

/** A two-digit candidate that is not `code`. */
const wrongPick = (code: string) => String(Number(code) === 99 ? 10 : Number(code) + 1);

describe("a right pick and a decline at once", () => {
  it.live("leave the request declined, and no account is made", () => {
    const h = harness();
    const address = "race-decline@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "racedecline");
      h.answerLate({ read: 10 });

      // The decline's swap lands first; the right pick's swap then loses and
      // re-reads the declined entry.
      const [declined, picked] = yield* settle(
        Effect.all(
          [
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: "none",
            }),
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: s.pairingCode,
            }),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(declined).toBe("declined");
      expect(picked).toBe("expired");
      expect((yield* h.entry(s.requestId))?.status).toBe("declined");
      expect(yield* h.auth.emailLinkCandidates(s.requestId, s.link.linkSecret)).toEqual({
        status: "expired",
      });
      expect(yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret))).toEqual({
        status: "expired",
      });
      expect(yield* h.auth.findProfileByEmail(address)).toBeNull();
    }).pipe(Effect.provide(h.layer));
  });
});
