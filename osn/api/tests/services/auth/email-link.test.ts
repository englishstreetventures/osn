/**
 * The emailed-link request under writes that land together: two people
 * acting on one link at once, a Resend landing between a read and its write,
 * and the tab's claim landing between a wrong pick's read and its delete.
 * Each store answer here can be made to come back late, as a round trip does,
 * so the calls interleave the way they would on the Durable Object; every
 * call still runs, in full, at the moment it is made.
 *
 * Then a request the tab's poll has claimed, whose finish failed part way:
 * the next poll finishes it on the same account, and nothing else that can
 * reach the request ends it or frees its address meanwhile.
 */

import { it, expect, describe } from "@effect/vitest";
import type { CoordinationNamespace, CoordinationOp } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { createDurableCoordination } from "../../../src/lib/coordination/durable";
import { createAuthService } from "../../../src/services/auth";
import { EMAIL_LINK_CLAIM_HOLD_MS, MAX_OTP_ATTEMPTS } from "../../../src/services/auth/constants";
import { makeTestAuthConfig } from "../../helpers/auth-config";
import { settle } from "../../helpers/background";
import { createFakeNamespace } from "../../helpers/coordination-namespace";
import { createTestLayerWithSqlite } from "../../helpers/db";
import { latestLinkTo, linksTo } from "../../helpers/registration";

let base: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  base = await makeTestAuthConfig();
});

afterEach(() => {
  vi.useRealTimers();
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

  /** Rows in `table` whose `column` is `value`. */
  const rows = (table: "accounts" | "sessions", column: string, value: string): number =>
    (
      db.sqlite.query(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
        n: number;
      }
    ).n;

  return {
    auth,
    db,
    fake,
    layer,
    recorded: () => email.recorded(),
    /** From now on, each operation named answers that many milliseconds late. */
    answerLate: (next: Late) => {
      late = next;
    },
    /** The request's entry as the store holds it. */
    entry: (requestId: string) =>
      Effect.promise(() => bundle.ceremonyStores.emailLinks.get(requestId)),
    /** Overwrites the request's entry, for a stored shape no route writes. */
    putEntry: (requestId: string, value: unknown) =>
      Effect.promise(() =>
        bundle.ceremonyStores.emailLinks.set(requestId, value as never, 600_000),
      ),
    /** The sign-up parked at `address`. */
    parked: (address: string) =>
      Effect.promise(() => bundle.ceremonyStores.pendingRegistrations.get(address)),
    /** Account rows holding `address`. */
    accounts: (address: string) => rows("accounts", "email", address),
    /** Session rows of the account holding `address`. */
    sessions: (address: string) => {
      const account = db.sqlite.query("SELECT id FROM accounts WHERE email = ?").get(address) as {
        id: string;
      } | null;
      return account ? rows("sessions", "account_id", account.id) : 0;
    },
    /** Wrong picks counted against any address so far. */
    strikes: () =>
      fake.calls.filter(
        (call) => call.store === "registration_link_lockout" && call.op === "increment",
      ).length,
    begun,
  };
}

type Harness = ReturnType<typeof harness>;

/** Makes every `sessions` insert fail, as a database fault would, until `allow()`. */
const refuseSessions = (h: Harness) => {
  h.db.sqlite.run(`
    CREATE TRIGGER refuse_sessions BEFORE INSERT ON sessions
    BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: sessions'); END;
  `);
  return { allow: () => h.db.sqlite.run("DROP TRIGGER refuse_sessions") };
};

/**
 * A sign-up whose link was confirmed and whose first poll failed after its
 * account and profile committed: the session's insert refused. The request
 * stays claimed for the tab, and the account has no session yet.
 */
const claimedAfterFault = (h: Harness, address: string, handle: string) =>
  Effect.gen(function* () {
    const s = yield* h.begun(address, handle);
    yield* h.auth.confirmEmailLink(s.requestId, {
      linkSecret: s.link.linkSecret,
      pairingPick: s.pairingCode,
    });
    const fault = refuseSessions(h);
    const failed = yield* Effect.flip(
      settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
    );
    expect(failed._tag).toBe("DatabaseError");
    fault.allow();
    expect(h.accounts(address)).toBe(1);
    return s;
  });

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

describe("a wrong pick's strike", () => {
  it.live("is counted once for two wrong picks that read the request together", () => {
    const h = harness();
    return Effect.gen(function* () {
      const s = yield* h.begun("race-wrong@example.com", "racewrong");
      // Both guesses run before either answers, so both read the live request.
      h.answerLate({ guess: 20 });
      const pick = { linkSecret: s.link.linkSecret, pairingPick: wrongPick(s.pairingCode) };

      const answers = yield* settle(
        Effect.all(
          [h.auth.confirmEmailLink(s.requestId, pick), h.auth.confirmEmailLink(s.requestId, pick)],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(answers).toEqual(["expired", "expired"]);
      expect(yield* h.entry(s.requestId)).toBeNull();
      expect(h.strikes()).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("is not counted when the tab's claim took the request first", () => {
    const h = harness();
    const address = "race-claim@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "raceclaim");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      // The wrong pick reads the confirmed request at once and hears back
      // late; the poll's two reads answer sooner, so its claim lands in
      // between.
      h.answerLate({ guess: 40, read: 10 });

      const [wrong, done] = yield* settle(
        Effect.all(
          [
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: wrongPick(s.pairingCode),
            }),
            h.auth.registrationStatus(s.requestId, s.claimSecret),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(wrong).toBe("expired");
      expect(done.status === "complete" && done.handle).toBe("raceclaim");
      expect((yield* h.auth.findProfileByEmail(address))?.handle).toBe("raceclaim");
      expect(h.strikes()).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("retiring a request that did not park", () => {
  it.live("leaves the sign-up that holds the address, whose link still finishes it", () => {
    const h = harness();
    const address = "release-other@example.com";
    return Effect.gen(function* () {
      const holder = yield* h.begun(address, "releaseholder");
      const second = yield* settle(
        h.auth.beginRegistration(address, "releasesecond", "1990-01-01"),
      );
      // The tab that began the second goes back and begins for another address.
      yield* settle(
        h.auth.beginRegistration(
          "release-other-2@example.com",
          "releasesecond",
          "1990-01-01",
          undefined,
          { requestId: second.requestId, claimSecret: second.claimSecret },
        ),
      );

      expect(yield* h.entry(second.requestId)).toBeNull();
      expect(
        yield* h.auth.confirmEmailLink(holder.requestId, {
          linkSecret: holder.link.linkSecret,
          pairingPick: holder.pairingCode,
        }),
      ).toBe("confirmed");
      const done = yield* settle(h.auth.registrationStatus(holder.requestId, holder.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("releaseholder");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a write that loses its swap to a Resend", () => {
  it.live("a right pick tries again on the entry the Resend wrote, and confirms it", () => {
    const h = harness();
    const address = "lost-confirm@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "lostconfirm");
      // The pick reads first and hears back last; the Resend's read and swap
      // land in between.
      h.answerLate({ guess: 30, read: 10 });

      const [picked, resent] = yield* settle(
        Effect.all(
          [
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: s.pairingCode,
            }),
            h.auth.resendRegistration(s.requestId, s.claimSecret),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(picked).toBe("confirmed");
      expect(resent).toEqual({ status: "sent" });
      const stored = yield* h.entry(s.requestId);
      expect(stored?.status).toBe("confirmed");
      expect(stored?.mailSecretHashes).toHaveLength(2);
      // The Resend's link is kept: it reads the request as confirmed.
      const resentLink = linksTo(h.recorded(), address)[1]!;
      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: resentLink.linkSecret,
          pairingPick: s.pairingCode,
        }),
      ).toBe("confirmed");
      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status).toBe("complete");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a decline tries again on the entry the Resend wrote, and keeps it declined", () => {
    const h = harness();
    return Effect.gen(function* () {
      const s = yield* h.begun("lost-decline@example.com", "lostdecline");
      h.answerLate({ guess: 30, read: 10 });

      const [declined, resent] = yield* settle(
        Effect.all(
          [
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: "none",
            }),
            h.auth.resendRegistration(s.requestId, s.claimSecret),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(declined).toBe("declined");
      expect(resent).toEqual({ status: "sent" });
      const stored = yield* h.entry(s.requestId);
      expect(stored?.status).toBe("declined");
      expect(stored?.mailSecretHashes).toHaveLength(2);
      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: "none",
        }),
      ).toBe("declined");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a second Resend tries again on the entry the first wrote, and both links go", () => {
    const h = harness();
    const address = "lost-resend@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "lostresend");
      // Both Resends read before either writes.
      h.answerLate({ read: 10 });

      const answers = yield* settle(
        Effect.all(
          [
            h.auth.resendRegistration(s.requestId, s.claimSecret),
            h.auth.resendRegistration(s.requestId, s.claimSecret),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(answers).toEqual([{ status: "sent" }, { status: "sent" }]);
      const stored = yield* h.entry(s.requestId);
      expect(stored?.status).toBe("pending");
      expect(stored?.mailSecretHashes).toHaveLength(3);
      const links = linksTo(h.recorded(), address);
      expect(links).toHaveLength(3);
      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: links[2]!.linkSecret,
          pairingPick: s.pairingCode,
        }),
      ).toBe("confirmed");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a poll whose finish fails after the claim", () => {
  it.live(
    "a session that would not write is finished by the next poll, on the same account",
    () => {
      const h = harness();
      const address = "claim-session@example.com";
      return Effect.gen(function* () {
        const s = yield* claimedAfterFault(h, address, "claimsession");
        const profile = yield* h.auth.findProfileByEmail(address);

        const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
        expect(done.status === "complete" && done.profileId).toBe(profile?.id);
        expect(h.accounts(address)).toBe(1);
        expect(h.sessions(address)).toBe(1);
        // Delivered once: the request is spent.
        expect(yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret))).toEqual({
          status: "expired",
        });
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live(
    "an insert that committed but reported a fault is finished, not read as a conflict",
    () => {
      const h = harness();
      const address = "claim-committed@example.com";
      return Effect.gen(function* () {
        const s = yield* h.begun(address, "claimcommitted");
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: s.pairingCode,
        });
        // The rows are written, then the call reports a fault, as a batch whose
        // answer was lost on the way back does.
        h.db.sqlite.run(`
        CREATE TRIGGER report_users_insert AFTER INSERT ON users
        BEGIN SELECT RAISE(FAIL, 'D1_ERROR: Network connection lost.'); END;
      `);
        const failed = yield* Effect.flip(
          settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
        );
        h.db.sqlite.run("DROP TRIGGER report_users_insert");
        expect(failed._tag).toBe("DatabaseError");
        const profile = yield* h.auth.findProfileByEmail(address);
        expect(profile?.handle).toBe("claimcommitted");

        const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
        expect(done.status === "complete" && done.profileId).toBe(profile?.id);
        expect(h.accounts(address)).toBe(1);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("a poll that reads the claim while another poll holds it answers expired", () => {
    const h = harness();
    const address = "claim-held@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "claimheld");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      // The first poll's claim lands at once and hears back late; the second
      // poll reads the request in between.
      h.answerLate({ swap: 40 });

      const [first, second] = yield* settle(
        Effect.all(
          [
            h.auth.registrationStatus(s.requestId, s.claimSecret),
            Effect.sleep("15 millis").pipe(
              Effect.andThen(h.auth.registrationStatus(s.requestId, s.claimSecret)),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(first.status === "complete" && first.handle).toBe("claimheld");
      expect(second).toEqual({ status: "expired" });
      expect(h.accounts(address)).toBe(1);
      expect(h.sessions(address)).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a claim whose poll could not let go is taken by a poll once its hold has passed", () => {
    const h = harness();
    const address = "claim-stuck@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "claimstuck");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      // The insert fails, and so does every write to the request after the
      // claim, so the poll cannot let go of it.
      h.db.sqlite.run(`
        CREATE TRIGGER refuse_accounts BEFORE INSERT ON accounts
        BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: accounts'); END;
      `);
      let swaps = 0;
      h.fake.failWhen((call) => call.store === "email_link" && call.op === "swap" && ++swaps > 1);
      const failed = yield* Effect.flip(
        settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
      );
      expect(failed._tag).toBe("DatabaseError");
      h.fake.failWhen(null);
      h.db.sqlite.run("DROP TRIGGER refuse_accounts");
      const claimed = yield* h.entry(s.requestId);
      expect(claimed?.status).toBe("claimed");

      expect(yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret))).toEqual({
        status: "expired",
      });
      expect(h.accounts(address)).toBe(0);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + EMAIL_LINK_CLAIM_HOLD_MS + 1_000);
      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.profileId).toBe(claimed?.claim?.profileId);
      expect(h.accounts(address)).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a request the tab's poll has claimed", () => {
  it.live("refuses a decline, keeps its address, and finishes on the next poll", () => {
    const h = harness();
    const address = "claimed-decline@example.com";
    return Effect.gen(function* () {
      const s = yield* claimedAfterFault(h, address, "claimeddecline");

      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: "none",
        }),
      ).toBe("expired");
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");
      expect((yield* h.parked(address))?.requestId).toBe(s.requestId);

      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimeddecline");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("refuses a wrong pick without ending it or counting a strike", () => {
    const h = harness();
    return Effect.gen(function* () {
      const s = yield* claimedAfterFault(h, "claimed-wrong@example.com", "claimedwrong");

      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: wrongPick(s.pairingCode),
        }),
      ).toBe("expired");
      expect(h.strikes()).toBe(0);
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");

      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status).toBe("complete");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("is not wiped by wrong link secrets reaching the cap", () => {
    const h = harness();
    const address = "claimed-wipe@example.com";
    return Effect.gen(function* () {
      const s = yield* claimedAfterFault(h, address, "claimedwipe");

      for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
        expect(
          yield* h.auth.confirmEmailLink(s.requestId, {
            linkSecret: "0".repeat(64),
            pairingPick: s.pairingCode,
          }),
        ).toBe("expired");
      }
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");
      expect((yield* h.parked(address))?.requestId).toBe(s.requestId);

      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status).toBe("complete");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("is not retired by a begin that names it as previous", () => {
    const h = harness();
    const address = "claimed-retire@example.com";
    return Effect.gen(function* () {
      const s = yield* claimedAfterFault(h, address, "claimedretire");

      yield* settle(
        h.auth.beginRegistration(
          "claimed-retire-2@example.com",
          "claimedretire2",
          "1990-01-01",
          undefined,
          { requestId: s.requestId, claimSecret: s.claimSecret },
        ),
      );
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");
      expect((yield* h.parked(address))?.requestId).toBe(s.requestId);

      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimedretire");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("reads as confirmed to its link and its Resend, and none of them writes", () => {
    const h = harness();
    const address = "claimed-reads@example.com";
    return Effect.gen(function* () {
      const s = yield* claimedAfterFault(h, address, "claimedreads");
      const before = yield* h.entry(s.requestId);
      const mailed = linksTo(h.recorded(), address).length;

      expect(yield* settle(h.auth.resendRegistration(s.requestId, s.claimSecret))).toEqual({
        status: "sent",
      });
      expect(linksTo(h.recorded(), address)).toHaveLength(mailed);
      expect(yield* h.auth.emailLinkCandidates(s.requestId, s.link.linkSecret)).toEqual({
        status: "confirmed",
      });
      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: s.pairingCode,
        }),
      ).toBe("confirmed");
      expect(yield* h.entry(s.requestId)).toEqual(before);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("keeps the claim against a decline whose swap lost to it", () => {
    const h = harness();
    const address = "claimed-decline-race@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "claimeddeclinerace");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      // The decline reads the confirmed request at once and hears back late;
      // the poll claims it in between, and its finish fails.
      const fault = refuseSessions(h);
      h.answerLate({ guess: 40, read: 10 });
      const [declined, polled] = yield* settle(
        Effect.all(
          [
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: "none",
            }),
            Effect.result(h.auth.registrationStatus(s.requestId, s.claimSecret)),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});
      fault.allow();

      expect(polled._tag).toBe("Failure");
      expect(declined).toBe("expired");
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");
      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimeddeclinerace");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("keeps the claim against a wrong pick whose delete lost to it", () => {
    const h = harness();
    const address = "claimed-wrong-race@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "claimedwrongrace");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      const fault = refuseSessions(h);
      h.answerLate({ guess: 40, read: 10 });
      const [wrong, polled] = yield* settle(
        Effect.all(
          [
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: wrongPick(s.pairingCode),
            }),
            Effect.result(h.auth.registrationStatus(s.requestId, s.claimSecret)),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});
      fault.allow();

      expect(polled._tag).toBe("Failure");
      expect(wrong).toBe("expired");
      expect(h.strikes()).toBe(0);
      expect((yield* h.parked(address))?.requestId).toBe(s.requestId);
      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimedwrongrace");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("is refused when stored without its account, or under a status no write gives", () => {
    const h = harness();
    return Effect.gen(function* () {
      const s = yield* h.begun("claimed-shape@example.com", "claimedshape");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      const confirmed = (yield* h.entry(s.requestId))!;

      for (const status of ["claimed", "approved"]) {
        yield* h.putEntry(s.requestId, { ...confirmed, status });
        expect(yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret))).toEqual({
          status: "expired",
        });
        expect(
          yield* h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: s.pairingCode,
          }),
        ).toBe("expired");
      }
      expect(yield* h.auth.findProfileByEmail("claimed-shape@example.com")).toBeNull();
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a poll that overran its hold", () => {
  it.live("loses the request to the poll that took it over, which alone delivers", () => {
    const h = harness();
    const address = "claim-overrun@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "claimoverrun");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      // The first poll's claim hears back late. Meanwhile its hold passes, and
      // a second poll takes the request over.
      h.answerLate({ swap: 40 });
      const [first, second] = yield* settle(
        Effect.all(
          [
            h.auth.registrationStatus(s.requestId, s.claimSecret),
            Effect.sleep("15 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  vi.useFakeTimers({ toFake: ["Date"] });
                  vi.setSystemTime(Date.now() + EMAIL_LINK_CLAIM_HOLD_MS + 1_000);
                }),
              ),
              Effect.andThen(h.auth.registrationStatus(s.requestId, s.claimSecret)),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});

      expect(first).toEqual({ status: "expired" });
      expect(second.status === "complete" && second.handle).toBe("claimoverrun");
      expect(h.accounts(address)).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a claimed request whose pending entry was freed", () => {
  it.live("still finishes on the next poll", () => {
    const h = harness();
    const address = "claim-unparked@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "claimunparked");
      yield* h.auth.confirmEmailLink(s.requestId, {
        linkSecret: s.link.linkSecret,
        pairingPick: s.pairingCode,
      });
      // A wrong pick reads the confirmed request and hears back late; the
      // poll claims it in between and its finish fails. The wrong pick's
      // deletes then fail in the store, so it frees the pending entry.
      const fault = refuseSessions(h);
      h.fake.failWhen((call) => call.store === "email_link" && call.op === "remove");
      h.answerLate({ guess: 40, read: 10 });
      yield* settle(
        Effect.all(
          [
            h.auth.confirmEmailLink(s.requestId, {
              linkSecret: s.link.linkSecret,
              pairingPick: wrongPick(s.pairingCode),
            }),
            Effect.result(h.auth.registrationStatus(s.requestId, s.claimSecret)),
          ],
          { concurrency: "unbounded" },
        ),
      );
      h.answerLate({});
      h.fake.failWhen(null);
      fault.allow();
      expect(yield* h.parked(address)).toBeNull();
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");

      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimunparked");
    }).pipe(Effect.provide(h.layer));
  });
});
