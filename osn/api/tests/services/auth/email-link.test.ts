/**
 * The emailed-link request under writes that land together: two people
 * acting on one link at once, a Resend landing between a read and its write,
 * and the tab's claim landing between a wrong pick's read and its delete.
 * A store call here can be held until the test releases it, as a round trip
 * can be slow: its answer held after it ran, or a swap held before it runs.
 * Other calls then land in a set order, whatever the machine's load, and
 * every call still runs in full.
 *
 * Then a request the tab's poll has claimed, whose finish failed part way:
 * the next poll finishes it on the same account, and nothing else that can
 * reach the request ends it or frees its address meanwhile.
 *
 * And a send that cannot read the accounts table, which mails nothing.
 *
 * And where the waiting screen's number falls among the sorted candidates.
 */

import { it, expect, describe } from "@effect/vitest";
import type { CoordinationNamespace, CoordinationOp } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { Cause, Effect, Fiber, Layer, Logger, References } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { createDurableCoordination } from "../../../src/lib/coordination/durable";
import { createAuthService } from "../../../src/services/auth";
import {
  EMAIL_LINK_CLAIM_HOLD_MS,
  EMAIL_LINK_PAIRING_CANDIDATES,
  MAX_OTP_ATTEMPTS,
} from "../../../src/services/auth/constants";
import { createAuthContext } from "../../../src/services/auth/context";
import { createEmailLinkModule } from "../../../src/services/auth/email-link";
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

/** One store call held until released. */
interface Held {
  readonly op: CoordinationOp;
  /** `before`: held before the call runs. `after`: it ran, and its answer is held. */
  readonly when: "before" | "after";
  readonly arrived: () => void;
  readonly gate: Promise<void>;
}

const OPS: readonly CoordinationOp[] = [
  "increment",
  "count",
  "read",
  "write",
  "remove",
  "claim",
  "guess",
  "take",
  "swap",
];

/**
 * `ns` with the call `next(op, when)` hands over held at that point, on a
 * request's `email_link` object; every other call goes straight through.
 */
function holdingCalls(
  ns: CoordinationNamespace,
  next: (op: CoordinationOp, when: Held["when"]) => Held | null,
): CoordinationNamespace {
  return {
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      if (!name.startsWith("email_link:")) return stub;
      const held = Object.fromEntries(
        OPS.map((op) => [
          op,
          async (...args: unknown[]) => {
            const before = next(op, "before");
            if (before) {
              before.arrived();
              await before.gate;
            }
            const value = await (stub[op] as (...a: unknown[]) => Promise<unknown>)(...args);
            const after = next(op, "after");
            if (after) {
              after.arrived();
              await after.gate;
            }
            return value;
          },
        ]),
      ) as unknown as typeof stub;
      return held;
    },
  };
}

function harness() {
  const fake = createFakeNamespace();
  let pending: Held | null = null;
  const bundle = createDurableCoordination(
    holdingCalls(fake.ns, (op, when) => {
      if (!pending || pending.op !== op || pending.when !== when) return null;
      const held = pending;
      pending = null;
      return held;
    }),
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

  const hold = (op: CoordinationOp, when: Held["when"]) => {
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = { op, when, arrived, gate };
    return { reached: Effect.promise(() => reached), release };
  };

  return {
    auth,
    db,
    fake,
    layer,
    recorded: () => email.recorded(),
    /**
     * Holds the next swap on a request's entry before it runs. `reached`
     * waits until that swap has been made; `release` lets it run.
     */
    holdNextSwap: () => hold("swap", "before"),
    /**
     * Lets the next `op` on a request's entry run, and holds its answer: the
     * caller learns what the store held then only once `release` runs.
     * `reached` waits until the call has run.
     */
    holdNextAnswer: (op: CoordinationOp) => hold(op, "after"),
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
    /** Removes the sign-up parked at `address`, as its expiry would. */
    dropParked: (address: string) =>
      Effect.promise(() => bundle.ceremonyStores.pendingRegistrations.delete(address)),
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
      // The right pick reads the pending request and hears back only after
      // the decline has finished; its swap then loses and re-reads the
      // declined entry.
      const held = h.holdNextAnswer("guess");
      const picking = yield* Effect.forkChild(
        settle(
          h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: s.pairingCode,
          }),
        ),
      );
      yield* held.reached;
      const declined = yield* settle(
        h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: "none",
        }),
      );
      held.release();
      const picked = yield* Fiber.join(picking);

      expect(declined).toBe("declined");
      expect(picked).toBe("expired");
      expect((yield* h.entry(s.requestId))?.status).toBe("declined");
      expect(yield* h.auth.emailLinkCandidates(s.requestId, s.link.linkSecret)).toEqual({
        status: "expired",
      });
      // The tab that began is answered as for a request never mailed.
      expect(yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret))).toEqual({
        status: "pending",
        pairingCode: s.pairingCode,
      });
      expect(yield* h.auth.findProfileByEmail(address)).toBeNull();
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a right pick and a wrong pick at once", () => {
  it.live("leave the request ended, and no account is made", () => {
    const h = harness();
    const address = "race-wrong-right@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "racewrongright");
      // The right pick reads the pending request and hears back only after
      // the wrong pick has ended it; its swap then loses and re-reads the
      // ended entry, which nothing confirms.
      const held = h.holdNextAnswer("guess");
      const picking = yield* Effect.forkChild(
        settle(
          h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: s.pairingCode,
          }),
        ),
      );
      yield* held.reached;
      const wrong = yield* settle(
        h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: wrongPick(s.pairingCode),
        }),
      );
      held.release();
      const picked = yield* Fiber.join(picking);

      expect(wrong).toBe("expired");
      expect(picked).toBe("expired");
      expect((yield* h.entry(s.requestId))?.status).toBe("ended");
      expect(yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret))).toEqual({
        status: "pending",
        pairingCode: s.pairingCode,
      });
      expect(yield* h.auth.findProfileByEmail(address)).toBeNull();
      expect(h.strikes()).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("a wrong pick's strike", () => {
  it.live("is counted once for two wrong picks that read the request together", () => {
    const h = harness();
    return Effect.gen(function* () {
      const s = yield* h.begun("race-wrong@example.com", "racewrong");
      // The first guess reads the live request and hears back only after the
      // second pick has ended it.
      const pick = { linkSecret: s.link.linkSecret, pairingPick: wrongPick(s.pairingCode) };
      const held = h.holdNextAnswer("guess");
      const first = yield* Effect.forkChild(settle(h.auth.confirmEmailLink(s.requestId, pick)));
      yield* held.reached;
      const second = yield* settle(h.auth.confirmEmailLink(s.requestId, pick));
      held.release();
      const answers = [yield* Fiber.join(first), second];

      expect(answers).toEqual(["expired", "expired"]);
      expect((yield* h.entry(s.requestId))?.status).toBe("ended");
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
      // The wrong pick reads the confirmed request and hears back only after
      // the poll has claimed and finished it.
      const held = h.holdNextAnswer("guess");
      const picking = yield* Effect.forkChild(
        settle(
          h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: wrongPick(s.pairingCode),
          }),
        ),
      );
      yield* held.reached;
      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      held.release();
      const wrong = yield* Fiber.join(picking);

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
          { requestId: second.requestId, retireSecret: second.retireSecret },
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

describe("a send that cannot tell whether an account has the address", () => {
  it.live("mails nothing, and the next Resend mails once it can tell", () => {
    const h = harness();
    const address = "probe-down@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "probedown");

      h.db.sqlite.run("ALTER TABLE accounts RENAME TO accounts_away");
      expect(yield* settle(h.auth.resendRegistration(s.requestId, s.claimSecret))).toEqual({
        status: "sent",
      });
      h.db.sqlite.run("ALTER TABLE accounts_away RENAME TO accounts");
      expect(linksTo(h.recorded(), address)).toHaveLength(1);

      yield* settle(h.auth.resendRegistration(s.requestId, s.claimSecret));
      expect(linksTo(h.recorded(), address)).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("logs one fixed line with no cause, so the driver's error stays out of the log", () => {
    const h = harness();
    const address = "probe-log@example.com";
    const lines: { level: string; message: string; cause: Cause.Cause<unknown> }[] = [];
    const capture = Logger.layer([
      Logger.make(({ logLevel, message, cause }) => {
        lines.push({ level: logLevel, message: JSON.stringify(message), cause });
      }),
    ]);
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "probelog");
      lines.length = 0;

      h.db.sqlite.run("ALTER TABLE accounts RENAME TO accounts_away");
      yield* settle(h.auth.resendRegistration(s.requestId, s.claimSecret));
      h.db.sqlite.run("ALTER TABLE accounts_away RENAME TO accounts");

      const errors = lines.filter((line) => line.level === "Error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(
        JSON.stringify(["sign-up link not sent: the account probe failed"]),
      );
      for (const line of lines) {
        expect(line.cause.reasons).toHaveLength(0);
        expect(line.message).not.toContain(address);
        expect(line.message).not.toContain("probelog");
      }
    }).pipe(
      Effect.provide(capture),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(h.layer),
    );
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
      const held = h.holdNextAnswer("guess");
      const picking = yield* Effect.forkChild(
        settle(
          h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: s.pairingCode,
          }),
        ),
      );
      yield* held.reached;
      const resent = yield* settle(h.auth.resendRegistration(s.requestId, s.claimSecret));
      held.release();
      const picked = yield* Fiber.join(picking);

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
      // The decline reads first and hears back last; the Resend's read and
      // swap land in between.
      const held = h.holdNextAnswer("guess");
      const declining = yield* Effect.forkChild(
        settle(
          h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: "none",
          }),
        ),
      );
      yield* held.reached;
      const resent = yield* settle(h.auth.resendRegistration(s.requestId, s.claimSecret));
      held.release();
      const declined = yield* Fiber.join(declining);

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
      // Both Resends read before either writes: the first hears its read
      // back only after the second has written.
      const held = h.holdNextAnswer("read");
      const first = yield* Effect.forkChild(
        settle(h.auth.resendRegistration(s.requestId, s.claimSecret)),
      );
      yield* held.reached;
      const second = yield* settle(h.auth.resendRegistration(s.requestId, s.claimSecret));
      held.release();
      const answers = [yield* Fiber.join(first), second];

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
      // The first poll's claim lands and its answer is held; the second poll
      // reads the request in between.
      const held = h.holdNextAnswer("swap");
      const firstPoll = yield* Effect.forkChild(
        settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
      );
      yield* held.reached;
      const second = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      held.release();
      const first = yield* Fiber.join(firstPoll);

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
          { requestId: s.requestId, retireSecret: s.retireSecret },
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
      const held = h.holdNextAnswer("guess");
      const declining = yield* Effect.forkChild(
        settle(
          h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: "none",
          }),
        ),
      );
      yield* held.reached;
      const polled = yield* Effect.result(
        settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
      );
      held.release();
      const declined = yield* Fiber.join(declining);
      fault.allow();

      expect(polled._tag).toBe("Failure");
      expect(declined).toBe("expired");
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");
      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimeddeclinerace");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("refuses a decline that lost one swap to a confirm and the next to the claim", () => {
    const h = harness();
    const address = "claimed-decline-twice@example.com";
    return Effect.gen(function* () {
      const s = yield* h.begun(address, "claimeddeclinetwice");
      // The decline reads the pending request. A right pick confirms it before
      // the decline's first swap runs, and the poll claims it, then fails,
      // before its second.
      const first = h.holdNextSwap();
      const declining = yield* Effect.forkChild(
        h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: "none",
        }),
      );
      yield* first.reached;
      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: s.pairingCode,
        }),
      ).toBe("confirmed");
      const second = h.holdNextSwap();
      first.release();
      yield* second.reached;
      const fault = refuseSessions(h);
      const polled = yield* Effect.result(
        settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
      );
      fault.allow();
      second.release();

      expect(polled._tag).toBe("Failure");
      expect(yield* Fiber.join(declining)).toBe("expired");
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");
      expect((yield* h.parked(address))?.requestId).toBe(s.requestId);
      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimeddeclinetwice");
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
      const held = h.holdNextAnswer("guess");
      const picking = yield* Effect.forkChild(
        settle(
          h.auth.confirmEmailLink(s.requestId, {
            linkSecret: s.link.linkSecret,
            pairingPick: wrongPick(s.pairingCode),
          }),
        ),
      );
      yield* held.reached;
      const polled = yield* Effect.result(
        settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
      );
      held.release();
      const wrong = yield* Fiber.join(picking);
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

describe("a decline that lost one swap to a confirm and the next to another decline", () => {
  it.live("answers declined, and the request stays declined for the next decline", () => {
    const h = harness();
    return Effect.gen(function* () {
      const s = yield* h.begun("decline-twice@example.com", "declinetwice");
      const none = { linkSecret: s.link.linkSecret, pairingPick: "none" };
      const first = h.holdNextSwap();
      const declining = yield* Effect.forkChild(h.auth.confirmEmailLink(s.requestId, none));
      yield* first.reached;
      expect(
        yield* h.auth.confirmEmailLink(s.requestId, {
          linkSecret: s.link.linkSecret,
          pairingPick: s.pairingCode,
        }),
      ).toBe("confirmed");
      const second = h.holdNextSwap();
      first.release();
      yield* second.reached;
      expect(yield* h.auth.confirmEmailLink(s.requestId, none)).toBe("declined");
      second.release();

      expect(yield* Fiber.join(declining)).toBe("declined");
      expect((yield* h.entry(s.requestId))?.status).toBe("declined");
      expect(yield* h.auth.confirmEmailLink(s.requestId, none)).toBe("declined");
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
      // The first poll's claim lands and its answer is held. Meanwhile its
      // hold passes, and a second poll takes the request over.
      const held = h.holdNextAnswer("swap");
      const firstPoll = yield* Effect.forkChild(
        settle(h.auth.registrationStatus(s.requestId, s.claimSecret)),
      );
      yield* held.reached;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + EMAIL_LINK_CLAIM_HOLD_MS + 1_000);
      const second = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      held.release();
      const first = yield* Fiber.join(firstPoll);

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
      // The poll claims the request and its finish fails; the pending entry
      // then goes (it expired, or the store lost it).
      const fault = refuseSessions(h);
      yield* Effect.result(settle(h.auth.registrationStatus(s.requestId, s.claimSecret)));
      fault.allow();
      yield* h.dropParked(address);
      expect(yield* h.parked(address)).toBeNull();
      expect((yield* h.entry(s.requestId))?.status).toBe("claimed");

      const done = yield* settle(h.auth.registrationStatus(s.requestId, s.claimSecret));
      expect(done.status === "complete" && done.handle).toBe("claimunparked");
    }).pipe(Effect.provide(h.layer));
  });
});

/**
 * The confirm page's candidates come sorted ascending, and the begin draws the
 * waiting screen's number uniformly from them, so the number's place in the
 * list is uniform and the order says nothing about which one is right. Hosts
 * pass the list on as given. The draw reads `crypto.getRandomValues`, which
 * takes no seed, so this counts many begins against a wide band.
 */
describe("the waiting screen's number among the sorted candidates", () => {
  it.live(
    "takes each of the five places about equally often over 2000 begins: unseeded, so each count is held to 400 ± 100, over five standard deviations",
    () => {
      const links = createEmailLinkModule(createAuthContext(base));
      const begins = 2000;
      const places = Array.from({ length: EMAIL_LINK_PAIRING_CANDIDATES }, () => 0);
      return Effect.gen(function* () {
        for (let i = 0; i < begins; i++) {
          const opened = yield* links.open("registration", `place-${i}@example.com`, 600_000);
          const read = yield* links.candidates(opened.requestId, new URL(opened.url).hash.slice(1));
          if (read.status !== "ready") {
            return yield* Effect.die(new Error(`the read answered ${read.status}`));
          }
          const list = read.pairingCandidates;
          expect(list.toSorted((a, b) => Number(a) - Number(b))).toEqual(list);
          const place = list.indexOf(opened.pairingCode);
          expect(place).toBeGreaterThanOrEqual(0);
          places[place]! += 1;
        }
        // Each count is binomial over 2000 tries at one in five: mean 400,
        // standard deviation 17.9.
        for (const count of places) {
          expect(count).toBeGreaterThanOrEqual(300);
          expect(count).toBeLessThanOrEqual(500);
        }
      });
    },
  );
});
