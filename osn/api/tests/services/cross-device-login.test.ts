import { it, expect, describe } from "@effect/vitest";
import { accounts, securityEvents, sessions, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { CoordinationNamespace, CoordinationOp, CoordinationStub } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { and, eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { MAX_SESSIONS_PER_ACCOUNT } from "../../src/services/auth/constants";
import { deriveSessionBinding } from "../../src/services/auth/helpers";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { holdQueries } from "../helpers/held-query";
import { registerThroughService } from "../helpers/registration";

function makeAuth() {
  const email = makeLogEmailLive();
  const svc = createAuthService(config);
  const layer = Layer.merge(createTestLayer(), email.layer);
  const captured = {
    recorded: () => email.recorded(),
    reset: () => email.reset(),
    get lastTemplate(): string | undefined {
      const all = email.recorded();
      return all.length > 0 ? all[all.length - 1].template : undefined;
    },
  };
  return { svc, captured, layer };
}

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("cross-device login", () => {
  it.effect("begin returns requestId, secret, and expiresAt", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const result = yield* svc.beginCrossDeviceLogin({ uaLabel: "Chrome on macOS" });
      expect(result.requestId).toMatch(/^cdl_[a-f0-9]{12}$/);
      expect(result.cdlSecret).toHaveLength(64); // 32 bytes hex
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  it.effect("poll returns pending before approval", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      const status = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(status.status).toBe("pending");
    }).pipe(Effect.provide(layer));
  });

  it.effect("poll returns expired for unknown requestId", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const status = yield* svc.getCrossDeviceLoginStatus("cdl_000000000000", "deadbeef");
      expect(status.status).toBe("expired");
    }).pipe(Effect.provide(layer));
  });

  it.effect("poll rejects wrong secret", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const { requestId } = yield* svc.beginCrossDeviceLogin();
      const error = yield* Effect.flip(svc.getCrossDeviceLoginStatus(requestId, "wrong_secret"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("full lifecycle: begin → approve → poll returns session", () => {
    const { captured, layer } = makeAuth();
    // A pepper, so the approval's security event can hash device A's IP.
    const svc = createAuthService({ ...config, sessionIpPepper: "x".repeat(32) });
    return Effect.gen(function* () {
      // Register a user first
      yield* registerThroughService(svc, captured.recorded, "cdl@example.com", "cdl_user", {
        sessionMeta: {
          uaLabel: "Device A",
        },
      });
      const profile = yield* svc.findProfileByEmail("cdl@example.com");
      expect(profile).not.toBeNull();

      // Device B begins CDL
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin({
        uaLabel: "Device B",
      });

      // Device A approves; the notice goes out in the background, and
      // `settle` waits for it.
      captured.reset();
      yield* settle(
        svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId, {
          uaLabel: "Device A",
          ip: "203.0.113.5",
        }),
      );

      // Device B polls and gets session
      const result = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(result.status).toBe("approved");
      if (result.status === "approved") {
        expect(result.session.accessToken).toBeTruthy();
        expect(result.session.refreshToken).toMatch(/^ses_/);
        expect(result.profile.handle).toBe("cdl_user");
      }

      // The approve path records a cross_device_login audit row in the
      // same request (synchronous — no daemon race).
      // It keeps a peppered hash of device A's IP, never the IP.
      const events = yield* svc.listUnacknowledgedSecurityEvents(profile!.accountId);
      const approval = events.events.find((e) => e.kind === "cross_device_login");
      expect(approval?.ipHash).toMatch(/^[a-f0-9]{64}$/);

      // Pin the notice's template, so the shared notify helper's
      // per-call-site wiring is asserted for this flow too.
      expect(captured.lastTemplate).toBe("cross-device-login");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approved session is consumed on first poll (one-time)", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* registerThroughService(svc, captured.recorded, "cdl2@example.com", "cdl_user2");
      const profile = yield* svc.findProfileByEmail("cdl2@example.com");

      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId);

      // First poll: get session
      const first = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(first.status).toBe("approved");

      // Second poll: request consumed → expired
      const second = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(second.status).toBe("expired");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reject marks request as rejected", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.rejectCrossDeviceLogin(requestId, secret);

      const status = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(status.status).toBe("rejected");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approve rejects wrong secret", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* registerThroughService(svc, captured.recorded, "cdl3@example.com", "cdl_user3");
      const profile = yield* svc.findProfileByEmail("cdl3@example.com");

      const { requestId } = yield* svc.beginCrossDeviceLogin();
      const error = yield* Effect.flip(
        svc.approveCrossDeviceLogin(requestId, "bad_secret", profile!.accountId),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approve fails on already-approved request", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* registerThroughService(svc, captured.recorded, "cdl4@example.com", "cdl_user4");
      const profile = yield* svc.findProfileByEmail("cdl4@example.com");

      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId);

      const error = yield* Effect.flip(
        svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("already processed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reject fails on unknown request", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        svc.rejectCrossDeviceLogin("cdl_000000000000", "any_secret"),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("not found");
    });
  });
});

/**
 * An approval reserves a session row for device B and parks who approved,
 * which profile, and the reserved row's id — never a token. The poll that
 * takes the approved entry replaces the reserved row with device B's session,
 * minted from the account and profile as they are then, and refuses when a
 * revocation has removed the row or the account or profile has gone. Run on
 * the Durable Object bundle over a stand-in namespace. A race case holds one
 * request's store call (`hold`) until the other request has made its own, so
 * the two overlap the same way on every run.
 */
describe("cross-device login on the shared store", () => {
  /** A store call a test holds until it lets it go. */
  interface Held {
    readonly ops: readonly CoordinationOp[];
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
   * `ns` with calls on a request's `cross_device` object held as `armed`
   * says: each call is held by the first armed hold that names its op at that
   * point, which it then uses up. Every other call goes straight through.
   */
  const holdingCalls = (ns: CoordinationNamespace, armed: Held[]): CoordinationNamespace => ({
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      if (!name.startsWith("cross_device:")) return stub;
      const at = async (op: CoordinationOp, when: Held["when"]) => {
        const index = armed.findIndex((held) => held.when === when && held.ops.includes(op));
        if (index < 0) return;
        const [held] = armed.splice(index, 1);
        held!.arrived();
        await held!.gate;
      };
      return Object.fromEntries(
        OPS.map((op) => [
          op,
          async (...args: unknown[]) => {
            await at(op, "before");
            const value = await (stub[op] as (...a: unknown[]) => Promise<unknown>)(...args);
            await at(op, "after");
            return value;
          },
        ]),
      ) as unknown as CoordinationStub;
    },
  });

  function harness() {
    const fake = createFakeNamespace();
    const armed: Held[] = [];
    const bundle = createDurableCoordination(holdingCalls(fake.ns, armed), () => {});
    const svc = createAuthService({ ...config, ceremonyStores: bundle.ceremonyStores });
    const layer = Layer.merge(createTestLayer(), makeLogEmailLive().layer);
    /**
     * Holds the next call to any of `ops` on a request's entry, before it
     * runs or after (its answer). `reached` waits until that call is held;
     * `release` lets it go on.
     */
    const hold = (ops: readonly CoordinationOp[], when: Held["when"]) => {
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed.push({ ops, when, arrived, gate });
      return { reached: Effect.promise(() => reached), release };
    };
    return { svc, layer, fake, hold, store: bundle.ceremonyStores.crossDeviceRequests };
  }

  /**
   * `first` and `second`, each deciding the same request with one `swap`:
   * `first` is held at its swap, `second` reads the pending entry, reserves
   * what it reserves and is held at its own swap; then `first` swaps and runs
   * to its end, and only then `second` swaps. Both read the pending entry,
   * both have reserved before either decides, and the winner's writes land
   * while the loser's reservation is still there. Answers both outcomes,
   * `first`'s first.
   */
  const twoDecisionsAtOnce = <A, B, E1, E2, R1, R2>(
    hold: ReturnType<typeof harness>["hold"],
    first: Effect.Effect<A, E1, R1>,
    second: Effect.Effect<B, E2, R2>,
  ) =>
    Effect.gen(function* () {
      const firstSwap = hold(["swap"], "before");
      const one = yield* Effect.forkChild(Effect.result(first));
      yield* firstSwap.reached;
      const secondSwap = hold(["swap"], "before");
      const two = yield* Effect.forkChild(Effect.result(second));
      yield* secondSwap.reached;
      firstSwap.release();
      const oneResult = yield* Fiber.join(one);
      secondSwap.release();
      return [oneResult, yield* Fiber.join(two)] as const;
    });

  /** While set, every `swap` on the cross-device store rejects, as an unreachable object does. */
  const failSwaps = (fake: ReturnType<typeof createFakeNamespace>) =>
    fake.failWhen((call) => call.store === "cross_device" && call.op === "swap");

  const sessionIds = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId)),
      );
      return rows.map((row) => row.id);
    });

  /**
   * Signs `profile` in on MAX_SESSIONS_PER_ACCOUNT devices, and makes one of
   * them the least recently used by a clear margin. Answers every session's
   * id and that one's.
   */
  const fillToCap = (
    svc: ReturnType<typeof createAuthService>,
    profile: {
      readonly id: string;
      readonly accountId: string;
      readonly email: string;
      readonly handle: string;
      readonly displayName: string | null;
    },
  ) =>
    Effect.gen(function* () {
      const seeded: string[] = [];
      for (let i = 0; i < MAX_SESSIONS_PER_ACCOUNT; i++) {
        const tokens = yield* svc.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        );
        seeded.push(svc.hashSessionToken(tokens.refreshToken));
      }
      const { db } = yield* Db;
      const oldest = seeded[7]!;
      yield* Effect.promise(() =>
        db.update(sessions).set({ lastUsedAt: 1 }).where(eq(sessions.id, oldest)),
      );
      return { seeded, oldest };
    });

  const countRows = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const live = yield* Effect.promise(() =>
        db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId)),
      );
      const events = yield* Effect.promise(() =>
        db
          .select({ id: securityEvents.id })
          .from(securityEvents)
          .where(
            and(
              eq(securityEvents.accountId, accountId),
              eq(securityEvents.kind, "cross_device_login"),
            ),
          ),
      );
      return { sessions: live.length, events: events.length };
    });

  const successes = (results: readonly { readonly _tag: string }[]) =>
    results.filter((r) => r._tag === "Success").length;

  /**
   * Rewrites the request's entry as an osn-api from before this one stored
   * it, with device B's IP hash in it, so a decision made across a deploy
   * meets that shape.
   */
  const asEarlierWorkerStoredIt = (store: ReturnType<typeof harness>["store"], requestId: string) =>
    Effect.promise(async () => {
      // The earlier shape's key order: device B's hash came after its label.
      const { expiresAt, createdAt, ...head } = (await store.get(requestId))!;
      const earlier = { ...head, ipHash: "a".repeat(64), expiresAt, createdAt };
      await store.set(requestId, earlier, 60_000);
    });

  it.live("an approval decides a request an earlier osn-api stored", () => {
    const { svc, layer, store } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-earlier@example.com", "cdlearlier");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* asEarlierWorkerStoredIt(store, requestId);

      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe("approved");
      if (poll.status === "approved") expect(poll.session.refreshToken).toMatch(/^ses_/);
    }).pipe(Effect.provide(layer));
  });

  it.live("a rejection decides a request an earlier osn-api stored", () => {
    const { svc, layer, store } = harness();
    return Effect.gen(function* () {
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* asEarlierWorkerStoredIt(store, requestId);

      yield* svc.rejectCrossDeviceLogin(requestId, cdlSecret);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe("rejected");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "the approved entry holds the account, the profile id and the reserved row, no token",
    () => {
      const { svc, layer, store } = harness();
      return Effect.gen(function* () {
        const profile = yield* svc.registerProfile("cdl-store@example.com", "cdlstore");
        const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
        yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);

        const entry = yield* Effect.promise(() => store.get(requestId));
        expect(entry).toMatchObject({
          status: "approved",
          accountId: profile.accountId,
          profileId: profile.id,
        });
        expect(Object.keys(entry!).toSorted()).toEqual([
          "accountId",
          "createdAt",
          "expiresAt",
          "profileId",
          "requestId",
          "secretHash",
          "sessionId",
          "status",
          "uaLabel",
        ]);
        const stored = JSON.stringify(entry);
        expect(stored).not.toMatch(/ses_|eyJ|accessToken|refreshToken|cdl-store@example\.com/);
        // The reserved row is the only session, and it lasts no longer than the request.
        const { db } = yield* Db;
        const rows = yield* Effect.promise(() =>
          db.select().from(sessions).where(eq(sessions.accountId, profile.accountId)),
        );
        expect(rows.map((r) => r.id)).toEqual([entry!.sessionId]);
        expect(rows[0]!.expiresAt).toBeLessThanOrEqual(Math.ceil(entry!.expiresAt / 1000));
      }).pipe(Effect.provide(layer));
    },
  );

  /** An account, a request it approved, and the poll that follows `between`. */
  const approvedThen = <E>(
    handle: string,
    between: (
      svc: ReturnType<typeof createAuthService>,
      profile: { readonly id: string; readonly accountId: string },
    ) => Effect.Effect<unknown, E, Db>,
  ) => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile(`${handle}@example.com`, handle);
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);
      yield* between(svc, profile);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      const { sessions: live } = yield* countRows(profile.accountId);
      return { poll, live, profile };
    }).pipe(Effect.provide(layer));
  };

  it.live("refuses, with no token, once the account's other sessions are revoked", () =>
    approvedThen("cdlrevoked", (svc, profile) =>
      svc.revokeAllOtherAccountSessions(profile.accountId, "ses-hash-of-device-a"),
    ).pipe(
      Effect.tap(({ poll, live }) =>
        Effect.sync(() => {
          expect(poll).toEqual({ status: "expired" });
          expect(live).toBe(0);
        }),
      ),
    ),
  );

  it.live("refuses, with no token, once the account is scheduled for deletion", () =>
    approvedThen("cdldeleted", (_svc, profile) =>
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .update(accounts)
            .set({ deletedAt: Math.floor(Date.now() / 1000) })
            .where(eq(accounts.id, profile.accountId)),
        );
      }),
    ).pipe(
      Effect.tap(({ poll, live }) =>
        Effect.sync(() => {
          expect(poll).toEqual({ status: "expired" });
          expect(live).toBe(0);
        }),
      ),
    ),
  );

  it.live("refuses, with no token, once the profile is gone", () =>
    approvedThen("cdlgone", (_svc, profile) =>
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() => db.delete(users).where(eq(users.id, profile.id)));
      }),
    ).pipe(
      Effect.tap(({ poll, live }) =>
        Effect.sync(() => {
          expect(poll).toEqual({ status: "expired" });
          expect(live).toBe(0);
        }),
      ),
    ),
  );

  it.live("refuses, with no token, once the profile belongs to another account", () =>
    approvedThen("cdlmoved", (svc, profile) =>
      Effect.gen(function* () {
        const other = yield* svc.registerProfile("cdlmoved-other@example.com", "cdlmovedother");
        const { db } = yield* Db;
        // Not the default there: the other account has its own, and an
        // account holds one.
        yield* Effect.promise(() =>
          db
            .update(users)
            .set({ accountId: other.accountId, isDefault: false })
            .where(eq(users.id, profile.id)),
        );
      }),
    ).pipe(
      Effect.tap(({ poll, live }) =>
        Effect.sync(() => {
          expect(poll).toEqual({ status: "expired" });
          expect(live).toBe(0);
        }),
      ),
    ),
  );

  it.live("signs device B in with the profile as it is at the poll", () =>
    approvedThen("cdlrenamed", (_svc, profile) =>
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .update(users)
            .set({ handle: "cdlrenamednow", displayName: "Renamed" })
            .where(eq(users.id, profile.id)),
        );
        yield* Effect.promise(() =>
          db
            .update(accounts)
            .set({ email: "cdlrenamed-now@example.com" })
            .where(eq(accounts.id, profile.accountId)),
        );
      }),
    ).pipe(
      Effect.tap(({ poll, live }) =>
        Effect.sync(() => {
          if (poll.status !== "approved") throw new Error(`poll answered ${poll.status}`);
          expect(poll.profile).toMatchObject({
            handle: "cdlrenamednow",
            displayName: "Renamed",
            email: "cdlrenamed-now@example.com",
          });
          const claims = JSON.parse(
            Buffer.from(poll.session.accessToken.split(".")[1]!, "base64url").toString("utf8"),
          ) as Record<string, unknown>;
          expect(claims).toMatchObject({
            handle: "cdlrenamednow",
            email: "cdlrenamed-now@example.com",
          });
          // The reserved row was replaced by device B's session, not added to.
          expect(live).toBe(1);
        }),
      ),
    ),
  );

  it.live("an approval at the session cap evicts the least recently used session", () => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-cap@example.com", "cdlcap");
      const { oldest } = yield* fillToCap(svc, profile);

      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);

      const ids = yield* sessionIds(profile.accountId);
      expect(ids).toHaveLength(MAX_SESSIONS_PER_ACCOUNT);
      expect(ids).not.toContain(oldest);

      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe("approved");
      expect((yield* countRows(profile.accountId)).sessions).toBe(MAX_SESSIONS_PER_ACCOUNT);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "of two approvals at once at the session cap, only the winner evicts, and only one session",
    () => {
      const { svc, layer, hold } = harness();
      return Effect.gen(function* () {
        const profile = yield* svc.registerProfile("cdl-cap-race@example.com", "cdlcaprace");
        const { seeded, oldest } = yield* fillToCap(svc, profile);
        const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

        const approve = svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);
        const approvals = yield* twoDecisionsAtOnce(hold, approve, approve);
        expect(successes(approvals)).toBe(1);

        const ids = yield* sessionIds(profile.accountId);
        expect(ids).toHaveLength(MAX_SESSIONS_PER_ACCOUNT);
        expect(seeded.filter((id) => !ids.includes(id))).toEqual([oldest]);

        const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
        expect(poll.status).toBe("approved");
        expect((yield* countRows(profile.accountId)).sessions).toBe(MAX_SESSIONS_PER_ACCOUNT);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("an approval whose swap fails at the session cap evicts nothing", () => {
    const { svc, layer, fake } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-cap-fail@example.com", "cdlcapfail");
      const { seeded } = yield* fillToCap(svc, profile);
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      failSwaps(fake);
      const error = yield* Effect.flip(
        svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId),
      );
      expect(error._tag).toBe("CoordinationError");
      expect((yield* sessionIds(profile.accountId)).toSorted()).toEqual(seeded.toSorted());
    }).pipe(Effect.provide(layer));
  });

  it.live("of two polls at once, one gets a session and the other finds nothing", () => {
    const { svc, layer, hold } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-polls@example.com", "cdlpolls");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);

      // Both polls read the approved entry before either takes it, and each
      // poll's take (whatever store calls it makes, read first) answers only
      // once the other's has run too.
      const poll = svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      const reads = [hold(["read"], "after"), hold(["read"], "after")];
      const fibers = [yield* Effect.forkChild(poll), yield* Effect.forkChild(poll)];
      for (const read of reads) yield* read.reached;
      const takes = [hold(["take", "read"], "after"), hold(["take", "read"], "after")];
      for (const read of reads) read.release();
      for (const take of takes) yield* take.reached;
      for (const take of takes) take.release();
      const polls = [];
      for (const fiber of fibers) polls.push(yield* Fiber.join(fiber));
      expect(polls.map((p) => p.status).toSorted()).toEqual(["approved", "expired"]);
      const approved = polls.find((p) => p.status === "approved");
      if (approved?.status !== "approved") throw new Error("no poll was approved");
      expect(approved.session.refreshToken).toMatch(/^ses_/);
      expect(approved.profile.handle).toBe("cdlpolls");
      expect((yield* countRows(profile.accountId)).sessions).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("of two approvals at once, one wins: one session and one security event", () => {
    const { svc, layer, hold } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-approve@example.com", "cdlapprove");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      const approve = svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);
      const approvals = yield* twoDecisionsAtOnce(hold, approve, approve);
      expect(successes(approvals)).toBe(1);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe("approved");
      expect(yield* countRows(profile.accountId)).toEqual({ sessions: 1, events: 1 });
    }).pipe(Effect.provide(layer));
  });

  it.live("an approval whose swap fails releases the row it reserved and records nothing", () => {
    const { svc, layer, fake } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-swapfail@example.com", "cdlswapfail");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      failSwaps(fake);
      const error = yield* Effect.flip(
        svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId),
      );
      expect(error._tag).toBe("CoordinationError");
      expect(yield* countRows(profile.accountId)).toEqual({ sessions: 0, events: 0 });

      fake.failWhen(null);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe("pending");
    }).pipe(Effect.provide(layer));
  });

  it.live("of an approval and a rejection at once, one wins", () => {
    const { svc, layer, hold } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-either@example.com", "cdleither");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      const decisions = yield* twoDecisionsAtOnce(
        hold,
        svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId),
        svc.rejectCrossDeviceLogin(requestId, cdlSecret),
      );
      expect(successes(decisions)).toBe(1);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe(decisions[0]._tag === "Success" ? "approved" : "rejected");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a poll at the session cap signs no device out while another request's reservation stands",
    () => {
      const { svc, layer } = harness();
      return Effect.gen(function* () {
        const profile = yield* svc.registerProfile("cdl-cap-poll@example.com", "cdlcappoll");
        const { seeded, oldest } = yield* fillToCap(svc, profile);
        const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
        yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);
        const survivors = seeded.filter((id) => id !== oldest);

        // The approval left the account at the cap. One device is now clearly
        // the least recently used, and another request's approval has
        // reserved its row and not yet decided.
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db.update(sessions).set({ lastUsedAt: 2 }).where(eq(sessions.id, survivors[11]!)),
        );
        const nowSec = Math.floor(Date.now() / 1000);
        yield* Effect.promise(() =>
          db.insert(sessions).values({
            id: "reserved-by-another-request",
            accountId: profile.accountId,
            familyId: "cdl_0123456789ab",
            expiresAt: nowSec + 300,
            createdAt: nowSec,
            authenticatedAt: nowSec,
            uaLabel: null,
            lastUsedAt: nowSec,
          }),
        );

        const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
        expect(poll.status).toBe("approved");
        const ids = yield* sessionIds(profile.accountId);
        expect(survivors.filter((id) => !ids.includes(id))).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("device B's session is a row of its own family, opened by its own tokens", () => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-row@example.com", "cdlrow");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin({ uaLabel: "Device B" });
      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      if (poll.status !== "approved") throw new Error(`poll answered ${poll.status}`);

      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select().from(sessions).where(eq(sessions.accountId, profile.accountId)),
      );
      const id = svc.hashSessionToken(poll.session.refreshToken);
      expect(rows.map((row) => row.id)).toEqual([id]);
      expect(rows[0]!.familyId).toMatch(/^sfam_/);
      expect(rows[0]!.uaLabel).toBe("Device B");
      expect(rows[0]!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 86_400);

      const claims = JSON.parse(
        Buffer.from(poll.session.accessToken.split(".")[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      expect(claims["osn_sid"]).toBe(deriveSessionBinding(id, profile.id));
      const verified = yield* svc.verifyRefreshToken(poll.session.refreshToken);
      expect(verified).toMatchObject({ accountId: profile.accountId, sessionId: id });
    }).pipe(Effect.provide(layer));
  });

  it.live("an approval reads its request and the approver's default profile side by side", () => {
    const { svc, hold } = harness();
    const { db, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    const layer = Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer);
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-sbs@example.com", "cdlsbs");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      // The request read is held before it runs, and the profile read once it
      // starts. Were the profile read to wait on the request read, it would
      // never start; the bound only ends that wait, and a passing run never
      // reaches it.
      const requestRead = hold(["read"], "before");
      const profileRead = queries.hold(/from "users"/);
      const approval = yield* Effect.forkChild(
        svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId),
      );
      yield* requestRead.reached;
      const profileReadStarted = yield* Effect.promise(() => profileRead.reached).pipe(
        Effect.timeoutOption("1 second"),
      );
      requestRead.release();
      profileRead.release();
      yield* Fiber.join(approval);
      expect(profileReadStarted._tag).toBe("Some");
    }).pipe(Effect.provide(layer));
  });

  describe("an answer that does not wait on tidying the entry away", () => {
    /** Rewrites the request's entry as past its own expiry, while the store still holds it. */
    const pastItsExpiry = (store: ReturnType<typeof harness>["store"], requestId: string) =>
      Effect.promise(async () => {
        const entry = await store.get(requestId);
        await store.set(requestId, { ...entry!, expiresAt: Date.now() - 1_000 }, 60_000);
      });
    const failRemoves = (fake: ReturnType<typeof createFakeNamespace>) =>
      fake.failWhen((call) => call.store === "cross_device" && call.op === "remove");

    it.live(
      "a poll of a rejected request answers rejected while the store cannot delete it",
      () => {
        const { svc, layer, fake } = harness();
        return Effect.gen(function* () {
          const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
          yield* svc.rejectCrossDeviceLogin(requestId, cdlSecret);
          failRemoves(fake);
          expect(yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret)).toEqual({
            status: "rejected",
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a poll past the request's expiry answers expired while the store cannot delete it",
      () => {
        const { svc, layer, fake, store } = harness();
        return Effect.gen(function* () {
          const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
          yield* pastItsExpiry(store, requestId);
          failRemoves(fake);
          expect(yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret)).toEqual({
            status: "expired",
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "an approval past the request's expiry is refused while the store cannot delete it",
      () => {
        const { svc, layer, fake, store } = harness();
        return Effect.gen(function* () {
          const profile = yield* svc.registerProfile("cdl-late@example.com", "cdllate");
          const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
          yield* pastItsExpiry(store, requestId);
          failRemoves(fake);
          const error = yield* Effect.flip(
            svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId),
          );
          expect({ tag: error._tag, message: error.message }).toEqual({
            tag: "AuthError",
            message: "Request expired",
          });
        }).pipe(Effect.provide(layer));
      },
    );
  });

  it.live("an approval whose eviction fails still records its event and sends its notice", () => {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(fake.ns, () => {});
    const svc = createAuthService({ ...config, ceremonyStores: bundle.ceremonyStores });
    const { layer: dbLayer, sqlite, email } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-evict-fail@example.com", "cdlevictfail");
      yield* fillToCap(svc, profile);
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      // At the cap the approval's eviction deletes a row; nothing else in an
      // approval that lands deletes one.
      sqlite.run(`
        CREATE TRIGGER refuse_session_eviction BEFORE DELETE ON sessions
        BEGIN SELECT RAISE(ABORT, 'eviction refused'); END;
      `);
      // `settle` waits for the notice the approval sends in the background,
      // failed or not.
      const error = yield* Effect.flip(
        settle(svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId)),
      );
      expect(error._tag).toBe("DatabaseError");
      expect((yield* countRows(profile.accountId)).events).toBe(1);
      const noticed = email.recorded().some((sent) => sent.template === "cross-device-login");
      expect(noticed).toBe(true);
    }).pipe(Effect.provide(dbLayer));
  });
});
