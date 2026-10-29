import { it, expect, describe } from "@effect/vitest";
import { accounts, securityEvents, sessions, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { CoordinationNamespace } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { MAX_SESSIONS_PER_ACCOUNT } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";

function makeAuth() {
  const email = makeLogEmailLive();
  const svc = createAuthService(config);
  const layer = Layer.merge(createTestLayer(), email.layer);
  const captured = {
    get code(): string | undefined {
      const all = email.recorded();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i].text.match(/code is: (\d{6})/);
        if (m) return m[1];
      }
      return undefined;
    },
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
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      // Register a user first
      yield* svc.beginRegistration("cdl@example.com", "cdl_user", "1990-01-01");
      yield* svc.completeRegistration("cdl@example.com", captured.code!, {
        uaLabel: "Device A",
      });
      const profile = yield* svc.findProfileByEmail("cdl@example.com");
      expect(profile).not.toBeNull();

      // Device B begins CDL
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin({
        uaLabel: "Device B",
      });

      // Device A approves
      captured.reset();
      yield* svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId, {
        uaLabel: "Device A",
      });

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
      const events = yield* svc.listUnacknowledgedSecurityEvents(profile!.accountId);
      expect(events.events.some((e) => e.kind === "cross_device_login")).toBe(true);

      // The notification email is forkDaemon'd — wait for the fiber to
      // complete (same pattern as the passkey-removed test), then pin
      // the template so the shared notify helper's per-call-site wiring is
      // asserted for this flow too.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)));
      expect(captured.lastTemplate).toBe("cross-device-login");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approved session is consumed on first poll (one-time)", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* svc.beginRegistration("cdl2@example.com", "cdl_user2", "1990-01-01");
      yield* svc.completeRegistration("cdl2@example.com", captured.code!, {});
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
      yield* svc.beginRegistration("cdl3@example.com", "cdl_user3", "1990-01-01");
      yield* svc.completeRegistration("cdl3@example.com", captured.code!, {});
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
      yield* svc.beginRegistration("cdl4@example.com", "cdl_user4", "1990-01-01");
      yield* svc.completeRegistration("cdl4@example.com", captured.code!, {});
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
 * the Durable Object bundle over a stand-in namespace, with every `read`
 * answering a few milliseconds late, as a round trip does, so two requests'
 * reads overlap however the rest is scheduled.
 */
describe("cross-device login on the shared store", () => {
  const READ_DELAY_MS = 10;

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

  function harness() {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(slowReads(fake.ns), () => {});
    const svc = createAuthService({ ...config, ceremonyStores: bundle.ceremonyStores });
    const layer = Layer.merge(createTestLayer(), makeLogEmailLive().layer);
    return { svc, layer, fake, store: bundle.ceremonyStores.crossDeviceRequests };
  }

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
          "ipHash",
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
        yield* Effect.promise(() =>
          db.update(users).set({ accountId: other.accountId }).where(eq(users.id, profile.id)),
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

  it.live("of two polls at once, one gets a session and the other finds nothing", () => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-polls@example.com", "cdlpolls");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);

      const polls = yield* Effect.all(
        [
          svc.getCrossDeviceLoginStatus(requestId, cdlSecret),
          svc.getCrossDeviceLoginStatus(requestId, cdlSecret),
        ],
        { concurrency: "unbounded" },
      );
      expect(polls.map((p) => p.status).toSorted()).toEqual(["approved", "expired"]);
      const approved = polls.find((p) => p.status === "approved");
      if (approved?.status !== "approved") throw new Error("no poll was approved");
      expect(approved.session.refreshToken).toMatch(/^ses_/);
      expect(approved.profile.handle).toBe("cdlpolls");
      expect((yield* countRows(profile.accountId)).sessions).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("of two approvals at once, one wins: one session and one security event", () => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-approve@example.com", "cdlapprove");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      const approvals = yield* Effect.all(
        [
          Effect.result(svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId)),
          Effect.result(svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId)),
        ],
        { concurrency: "unbounded" },
      );
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
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-either@example.com", "cdleither");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      const decisions = yield* Effect.all(
        [
          Effect.result(svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId)),
          Effect.result(svc.rejectCrossDeviceLogin(requestId, cdlSecret)),
        ],
        { concurrency: "unbounded" },
      );
      expect(successes(decisions)).toBe(1);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe(decisions[0]._tag === "Success" ? "approved" : "rejected");
    }).pipe(Effect.provide(layer));
  });
});
