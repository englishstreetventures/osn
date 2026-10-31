import { it, expect, describe } from "@effect/vitest";
import { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import { Effect, Fiber, Layer, Logger } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { ROTATION_RACE_MESSAGE } from "../../src/lib/grant-failure";
import * as metrics from "../../src/metrics";
import * as accountErasure from "../../src/services/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { ROTATION_GRACE_MS } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import {
  createCapturingTestLayer,
  createTestLayer,
  createTestLayerWithSqlite,
} from "../helpers/db";
import { holdQueries } from "../helpers/held-query";

/**
 * Session list/revoke behaviour:
 *   • Listing returns sessions scoped to the caller's account only; other
 *     accounts' rows never leak across the join.
 *   • Revoke uses the short public handle (first 16 hex of the hash) and
 *     refuses handles that don't belong to the caller's account.
 *   • revokeAllOther keeps the caller's current session alive and kills
 *     the rest — the Settings "sign out everywhere else" surface.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

describe("listAccountSessions", () => {
  it.effect("returns all sessions for the account and flags the caller's current one", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("list-s@example.com", "lists");
      const t1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: "Firefox on macOS" },
      );
      const t2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: "Safari on iOS" },
      );

      const currentHash = auth.hashSessionToken(t1.refreshToken);
      const { sessions } = yield* auth.listAccountSessions(profile.accountId, currentHash);
      expect(sessions).toHaveLength(2);
      expect(sessions.some((s) => s.isCurrent)).toBe(true);
      expect(sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id))).toBe(true);
      // Metadata surfaced.
      expect(sessions.map((s) => s.uaLabel).toSorted()).toEqual([
        "Firefox on macOS",
        "Safari on iOS",
      ]);
      void t2;
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not expose sessions from other accounts", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("list-a@example.com", "lista");
      const bob = yield* auth.registerProfile("list-b@example.com", "listb");
      yield* auth.issueTokens(
        alice.id,
        alice.accountId,
        alice.email,
        alice.handle,
        alice.displayName,
      );
      yield* auth.issueTokens(bob.id, bob.accountId, bob.email, bob.handle, bob.displayName);

      const { sessions } = yield* auth.listAccountSessions(alice.accountId, null);
      expect(sessions).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a cookie the device has refreshed past still flags the device's session", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("list-past@example.com", "listpast");
      const open = () =>
        auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        );
      const me = (yield* open()).refreshToken;
      const other = (yield* open()).refreshToken;
      const refreshed = yield* auth.refreshTokens(me);

      const { sessions } = yield* auth.listAccountSessions(
        profile.accountId,
        auth.hashSessionToken(me),
      );

      const handle = (token: string) => auth.hashSessionToken(token).slice(0, 16);
      expect(sessions.filter((s) => s.isCurrent).map((s) => s.id)).toEqual([
        handle(refreshed.refreshToken),
      ]);
      expect(sessions.find((s) => s.id === handle(other))?.isCurrent).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("revokeAccountSession", () => {
  it.effect("revokes a non-current session and leaves the current one intact", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("rev-s@example.com", "revs");
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const other = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const meHash = auth.hashSessionToken(me.refreshToken);
      const otherHash = auth.hashSessionToken(other.refreshToken);

      const result = yield* auth.revokeAccountSession(
        profile.accountId,
        otherHash.slice(0, 16),
        meHash,
      );
      expect(result.revokedSelf).toBe(false);

      // Our session is still valid.
      yield* auth.verifyRefreshToken(me.refreshToken);
      // Theirs isn't.
      const err = yield* Effect.flip(auth.verifyRefreshToken(other.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("revoking your own session reports revokedSelf=true", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("rev-me@example.com", "revme");
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const meHash = auth.hashSessionToken(me.refreshToken);
      const result = yield* auth.revokeAccountSession(
        profile.accountId,
        meHash.slice(0, 16),
        meHash,
      );
      expect(result.revokedSelf).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Idempotent — a handle from another account (or a made-up one)
  // returns { revokedSelf: false } rather than surfacing "Session not
  // found", so revoke can't be weaponised as a handle-existence oracle.
  it.effect("silently ignores a handle that doesn't belong to the caller's account", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("rev-a@example.com", "reva");
      const bob = yield* auth.registerProfile("rev-b@example.com", "revb");
      const bobSess = yield* auth.issueTokens(
        bob.id,
        bob.accountId,
        bob.email,
        bob.handle,
        bob.displayName,
      );
      const bobHandle = auth.hashSessionToken(bobSess.refreshToken).slice(0, 16);
      const result = yield* auth.revokeAccountSession(alice.accountId, bobHandle, null);
      expect(result.revokedSelf).toBe(false);
      // Bob's session must still be alive.
      yield* auth.verifyRefreshToken(bobSess.refreshToken);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// Session rotation (C2) must preserve the uaLabel / ipHash it was
// issued with. Otherwise the Settings "Firefox on macOS" device flips to
// "Unknown device" on every refresh — a subtle UX regression that doesn't
// fail any existing assertion.
describe("session metadata carry-through on rotation", () => {
  it.effect("refreshTokens copies uaLabel to the rotated session row", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("rot-meta@example.com", "rotmeta");
      const original = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: "Firefox on macOS" },
      );

      const rotated = yield* auth.refreshTokens(original.refreshToken);

      const { sessions } = yield* auth.listAccountSessions(
        profile.accountId,
        auth.hashSessionToken(rotated.refreshToken),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.uaLabel).toBe("Firefox on macOS");
      expect(sessions[0]!.isCurrent).toBe(true);
      // lastUsedAt must be populated on the fresh row (rotation timestamp).
      expect(sessions[0]!.lastUsedAt).not.toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("revokeAllOtherAccountSessions", () => {
  it.effect("keeps the current session and kills the rest", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("revall@example.com", "revall");
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const other1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const other2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      yield* auth.revokeAllOtherAccountSessions(
        profile.accountId,
        auth.hashSessionToken(me.refreshToken),
      );
      yield* auth.verifyRefreshToken(me.refreshToken);
      const e1 = yield* Effect.flip(auth.verifyRefreshToken(other1.refreshToken));
      const e2 = yield* Effect.flip(auth.verifyRefreshToken(other2.refreshToken));
      expect(e1._tag).toBe("AuthError");
      expect(e2._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

/**
 * A revoke answers success only once no session of the device's family is
 * left, whenever the device's refresh lands: between the revoke's read and its
 * delete, between the rotation's own statements, or before the revoke, with a
 * handle the device has since rotated away from. Each test holds one statement
 * with the seam and lands the other request in between.
 */
describe("revoke holds against a refresh", () => {
  function held() {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    return {
      layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
      hold: queries.hold,
      familyOf: (refreshToken: string) =>
        (
          sqlite
            .query("SELECT family_id AS familyId FROM sessions WHERE id = ?")
            .get(auth.hashSessionToken(refreshToken)) as { familyId: string } | null
        )?.familyId,
      familyRows: (familyId: string) =>
        (
          sqlite.query("SELECT COUNT(*) AS n FROM sessions WHERE family_id = ?").get(familyId) as {
            n: number;
          }
        ).n,
    };
  }

  const signIn = (email: string, handle: string) =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile(email, handle);
      const { refreshToken } = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      return { profile, refreshToken };
    });

  /** True when `refreshToken` does not verify. */
  const dead = (refreshToken: string) =>
    Effect.result(auth.verifyRefreshToken(refreshToken)).pipe(
      Effect.map((outcome) => outcome._tag === "Failure"),
    );

  it.live("a refresh that lands while the revoke is held at its delete is revoked too", () => {
    const h = held();
    return Effect.gen(function* () {
      const { profile, refreshToken } = yield* signIn("rv-r1@example.com", "rvr1");
      const familyId = h.familyOf(refreshToken)!;
      const handle = auth.hashSessionToken(refreshToken).slice(0, 16);

      const remove = h.hold(/^delete from "sessions"/);
      const revoke = yield* Effect.forkChild(
        Effect.result(auth.revokeAccountSession(profile.accountId, handle, null)),
      );
      yield* Effect.promise(() => remove.reached);
      const refreshed = yield* auth.refreshTokens(refreshToken);
      remove.release();

      expect((yield* Fiber.join(revoke))._tag).toBe("Success");
      expect(yield* dead(refreshed.refreshToken)).toBe(true);
      expect(h.familyRows(familyId)).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a revoke that lands while a refresh is held at its insert leaves no session", () => {
    const h = held();
    return Effect.gen(function* () {
      const { profile, refreshToken } = yield* signIn("rv-r2@example.com", "rvr2");
      const familyId = h.familyOf(refreshToken)!;
      const handle = auth.hashSessionToken(refreshToken).slice(0, 16);

      const insert = h.hold(/^insert into "sessions"/);
      const refresh = yield* Effect.forkChild(Effect.result(auth.refreshTokens(refreshToken)));
      yield* Effect.promise(() => insert.reached);
      yield* auth.revokeAccountSession(profile.accountId, handle, null);
      insert.release();

      expect((yield* Fiber.join(refresh))._tag).toBe("Failure");
      expect(h.familyRows(familyId)).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a revoke that lands while a refresh is held at its delete leaves no session", () => {
    const h = held();
    return Effect.gen(function* () {
      const { profile, refreshToken } = yield* signIn("rv-r3@example.com", "rvr3");
      const familyId = h.familyOf(refreshToken)!;
      const handle = auth.hashSessionToken(refreshToken).slice(0, 16);

      const remove = h.hold(/^delete from "sessions"/);
      const refresh = yield* Effect.forkChild(Effect.result(auth.refreshTokens(refreshToken)));
      yield* Effect.promise(() => remove.reached);
      yield* auth.revokeAccountSession(profile.accountId, handle, null);
      remove.release();

      const outcome = yield* Fiber.join(refresh);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.message).toBe(ROTATION_RACE_MESSAGE);
      expect(h.familyRows(familyId)).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a handle the device has rotated away from since the list still revokes it", () =>
    Effect.gen(function* () {
      const { profile, refreshToken } = yield* signIn("rv-r4@example.com", "rvr4");
      const { sessions: listed } = yield* auth.listAccountSessions(profile.accountId, null);
      expect(listed).toHaveLength(1);

      const refreshed = yield* auth.refreshTokens(refreshToken);
      const result = yield* auth.revokeAccountSession(profile.accountId, listed[0]!.id, null);

      expect(result.revokedSelf).toBe(false);
      expect(yield* dead(refreshed.refreshToken)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a handle from another account's rotated-out token revokes nothing", () =>
    Effect.gen(function* () {
      const alice = yield* signIn("rv-r6a@example.com", "rvr6a");
      const bob = yield* signIn("rv-r6b@example.com", "rvr6b");
      const bobHandle = auth.hashSessionToken(bob.refreshToken).slice(0, 16);
      const bobNow = yield* auth.refreshTokens(bob.refreshToken);

      const result = yield* auth.revokeAccountSession(alice.profile.accountId, bobHandle, null);

      expect(result.revokedSelf).toBe(false);
      expect(yield* dead(bobNow.refreshToken)).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("searches each table by its key range, never a scan", () => {
    const { layer, db, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const { profile, refreshToken } = yield* signIn("rv-r7@example.com", "rvr7");
      const handle = auth.hashSessionToken(refreshToken).slice(0, 16);
      yield* auth.refreshTokens(refreshToken);
      captured.length = 0;

      yield* auth.revokeAccountSession(profile.accountId, handle, null);

      const removal = captured.find((s) => /^\s*delete from "sessions"/i.test(s.sql));
      expect(removal).toBeDefined();
      const details = (
        db.$client
          .query(`EXPLAIN QUERY PLAN ${removal!.sql}`)
          .all(...(removal!.params as never[])) as Array<{ detail: string }>
      ).map((row) => row.detail);
      expect(
        details.some((d) =>
          /^SEARCH rotated_sessions USING .*\(token_hash>\? AND token_hash<\?\)/.test(d),
        ),
      ).toBe(true);
      expect(details.some((d) => /^SEARCH sessions USING .*\(id>\? AND id<\?\)/.test(d))).toBe(
        true,
      );
      expect(details.filter((d) => /^SCAN (rotated_sessions|sessions)\b/.test(d))).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

/**
 * The four deletes that revoke every session but the caller's take the
 * caller's session hash from the request. A refresh of that session in
 * another tab, held at any of its statements while the delete runs, completes
 * and keeps the caller's device; every other device goes. A hash no live
 * session holds when the delete runs — one already rotated out — spares
 * nothing, so a stale token cannot shield its family.
 */
describe("account-wide deletes keep the caller's device across its own refresh", () => {
  function held() {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    return {
      layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
      hold: queries.hold,
      sqlite,
      latestCode: (): string => {
        const all = email.recorded();
        for (let i = all.length - 1; i >= 0; i--) {
          const m = all[i]!.text.match(/code is: (\d{6})/);
          if (m) return m[1]!;
        }
        throw new Error("no code mailed");
      },
    };
  }
  type Held = ReturnType<typeof held>;

  /** The caller's device and one other, which has refreshed once. */
  const twoDevices = (handle: string) =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
      const open = () =>
        auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        );
      const me = (yield* open()).refreshToken;
      const otherFirst = (yield* open()).refreshToken;
      const other = (yield* auth.refreshTokens(otherFirst)).refreshToken;
      return { profile, me, otherFirst, other };
    });

  type Profile = { readonly accountId: string; readonly email: string };

  /**
   * Each site, prepared up to the point where it needs the caller's hash:
   * anything it must do first (a step-up, a mailed code) is done before a
   * test arms its hold.
   */
  const sites: ReadonlyArray<{
    readonly name: string;
    /** Whether the site deletes rotation records outside the caller's family too. */
    readonly records: boolean;
    readonly prepare: (
      profile: Profile,
      h: Held,
    ) => Effect.Effect<
      (callerHash: string) => Effect.Effect<unknown, unknown, Db | EmailService>,
      unknown,
      Db | EmailService
    >;
  }> = [
    {
      name: "sign out everywhere else",
      records: false,
      prepare: (profile) =>
        Effect.succeed((hash: string) =>
          auth.revokeAllOtherAccountSessions(profile.accountId, hash),
        ),
    },
    {
      name: "passkey add and delete",
      records: false,
      prepare: (profile) =>
        Effect.succeed((hash: string) =>
          auth.invalidateOtherAccountSessions(profile.accountId, hash),
        ),
    },
    {
      name: "email change",
      records: false,
      prepare: (profile, h) =>
        Effect.gen(function* () {
          const stepUp = yield* auth.issueStepUpToken(profile.accountId, "otp", "email_change");
          yield* auth.beginEmailChange(profile.accountId, `new-${profile.email}`);
          const code = h.latestCode();
          return (hash: string) => auth.completeEmailChange(profile.accountId, code, stepUp, hash);
        }),
    },
    {
      name: "erasure",
      records: true,
      prepare: (profile) =>
        Effect.succeed((hash: string) =>
          accountErasure.requestErasure({ accountId: profile.accountId, cancelSessionId: hash }),
        ),
    },
  ];

  /** True when `refreshToken` does not verify. */
  const dead = (refreshToken: string) =>
    Effect.result(auth.verifyRefreshToken(refreshToken)).pipe(
      Effect.map((outcome) => outcome._tag === "Failure"),
    );

  const recordOf = (h: Held, refreshToken: string) =>
    h.sqlite
      .query("SELECT token_hash FROM rotated_sessions WHERE token_hash = ?")
      .get(auth.hashSessionToken(refreshToken)) !== null;

  /** The statements of a rotation, in the order it runs them. */
  const ROTATION_STEPS: ReadonlyArray<{ readonly step: string; readonly pattern: RegExp }> = [
    { step: "insert of the new session", pattern: /^insert into "sessions"/ },
    { step: "rotation record", pattern: /^insert into "rotated_sessions"/ },
    { step: "swap", pattern: /^delete from "sessions"/ },
  ];

  for (const [index, site] of sites.entries()) {
    for (const [at, { step, pattern }] of ROTATION_STEPS.entries()) {
      it.live(`${site.name}: the caller's refresh held at its ${step} still completes`, () => {
        const h = held();
        return Effect.gen(function* () {
          const { profile, me, otherFirst, other } = yield* twoDevices(`wipe${index}h${at}`);
          const run = yield* site.prepare(profile, h);

          const rotation = h.hold(pattern);
          const refreshing = yield* Effect.forkChild(Effect.result(auth.refreshTokens(me)));
          yield* Effect.promise(() => rotation.reached);
          yield* run(auth.hashSessionToken(me));
          rotation.release();

          const outcome = yield* Fiber.join(refreshing);
          expect(outcome._tag).toBe("Success");
          if (outcome._tag === "Success") {
            expect(yield* dead(outcome.success.refreshToken)).toBe(false);
          }
          expect(yield* dead(other)).toBe(true);
          if (site.records) {
            expect(recordOf(h, me)).toBe(true);
            expect(recordOf(h, otherFirst)).toBe(false);
          }
        }).pipe(Effect.provide(h.layer));
      });
    }

    it.live(`${site.name}: a hash rotated out before the delete spares nothing`, () => {
      const h = held();
      return Effect.gen(function* () {
        const { profile, me, other } = yield* twoDevices(`wipe${index}stale`);
        const run = yield* site.prepare(profile, h);
        const rotated = yield* auth.refreshTokens(me);

        yield* run(auth.hashSessionToken(me));

        expect(yield* dead(rotated.refreshToken)).toBe(true);
        expect(yield* dead(other)).toBe(true);
        if (site.records) expect(recordOf(h, me)).toBe(false);
      }).pipe(Effect.provide(h.layer));
    });
  }
});

/**
 * Logout and the revoke's "was it the caller's own device" answer take the
 * session hash the caller's cookie held. A refresh of that session in another
 * tab can move the device to a new session between the cookie read and the
 * write, or be in flight when the write runs. Logout still ends every session
 * of the device, and a revoke of the device still reports it as the caller's,
 * so the route clears the cookie. Another device is never touched by the one,
 * nor reported as the caller's by the other.
 */
describe("logout and revoke follow the caller's device across its own refresh", () => {
  function held() {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    return {
      layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
      hold: queries.hold,
      familyOf: (refreshToken: string) =>
        (
          sqlite
            .query("SELECT family_id AS familyId FROM sessions WHERE id = ?")
            .get(auth.hashSessionToken(refreshToken)) as { familyId: string } | null
        )?.familyId,
      familyRows: (familyId: string) =>
        (
          sqlite.query("SELECT COUNT(*) AS n FROM sessions WHERE family_id = ?").get(familyId) as {
            n: number;
          }
        ).n,
    };
  }

  /** The caller's device and one other, each signed in once. */
  const twoDevices = (handle: string) =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
      const open = () =>
        auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        );
      const me = (yield* open()).refreshToken;
      const other = (yield* open()).refreshToken;
      return { profile, me, other };
    });

  /** True when `refreshToken` does not verify. */
  const dead = (refreshToken: string) =>
    Effect.result(auth.verifyRefreshToken(refreshToken)).pipe(
      Effect.map((outcome) => outcome._tag === "Failure"),
    );

  const handleOf = (refreshToken: string) => auth.hashSessionToken(refreshToken).slice(0, 16);

  /** The statements of a rotation, in the order it runs them. */
  const ROTATION_STEPS: ReadonlyArray<{ readonly step: string; readonly pattern: RegExp }> = [
    { step: "insert of the new session", pattern: /^insert into "sessions"/ },
    { step: "rotation record", pattern: /^insert into "rotated_sessions"/ },
    { step: "swap", pattern: /^delete from "sessions"/ },
  ];

  it.live("a refresh that completes while logout is held at its delete is ended too", () => {
    const h = held();
    return Effect.gen(function* () {
      const { me, other } = yield* twoDevices("lo_held");
      const familyId = h.familyOf(me)!;

      const remove = h.hold(/^delete from "sessions"/);
      const logout = yield* Effect.forkChild(auth.invalidateSession(me));
      yield* Effect.promise(() => remove.reached);
      const refreshed = yield* auth.refreshTokens(me);
      remove.release();
      yield* Fiber.join(logout);

      expect(yield* dead(refreshed.refreshToken)).toBe(true);
      expect(h.familyRows(familyId)).toBe(0);
      expect(yield* dead(other)).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  for (const [at, { step, pattern }] of ROTATION_STEPS.entries()) {
    it.live(`logout while the caller's refresh is held at its ${step} leaves no session`, () => {
      const h = held();
      return Effect.gen(function* () {
        const { me, other } = yield* twoDevices(`lo_step${at}`);
        const familyId = h.familyOf(me)!;

        const rotation = h.hold(pattern);
        const refreshing = yield* Effect.forkChild(Effect.result(auth.refreshTokens(me)));
        yield* Effect.promise(() => rotation.reached);
        yield* auth.invalidateSession(me);
        rotation.release();

        expect((yield* Fiber.join(refreshing))._tag).toBe("Failure");
        expect(h.familyRows(familyId)).toBe(0);
        expect(yield* dead(other)).toBe(false);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.live("a refresh that completes while the revoke is held at its delete is the caller's", () => {
    const h = held();
    return Effect.gen(function* () {
      const { profile, me } = yield* twoDevices("rs_held");
      const callerHash = auth.hashSessionToken(me);

      const remove = h.hold(/^delete from "sessions"/);
      const revoke = yield* Effect.forkChild(
        auth.revokeAccountSession(profile.accountId, handleOf(me), callerHash),
      );
      yield* Effect.promise(() => remove.reached);
      const refreshed = yield* auth.refreshTokens(me);
      remove.release();

      expect((yield* Fiber.join(revoke)).revokedSelf).toBe(true);
      expect(yield* dead(refreshed.refreshToken)).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a cookie the device has refreshed past still names it as the caller's", () =>
    Effect.gen(function* () {
      const { profile, me } = yield* twoDevices("rs_stalecookie");
      const refreshed = yield* auth.refreshTokens(me);

      const result = yield* auth.revokeAccountSession(
        profile.accountId,
        handleOf(refreshed.refreshToken),
        auth.hashSessionToken(me),
      );

      expect(result.revokedSelf).toBe(true);
      expect(yield* dead(refreshed.refreshToken)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  for (const [at, { step, pattern }] of ROTATION_STEPS.entries()) {
    it.live(`a revoke while the caller's refresh is held at its ${step} is the caller's`, () => {
      const h = held();
      return Effect.gen(function* () {
        const { profile, me } = yield* twoDevices(`rs_step${at}`);
        const familyId = h.familyOf(me)!;

        const rotation = h.hold(pattern);
        const refreshing = yield* Effect.forkChild(Effect.result(auth.refreshTokens(me)));
        yield* Effect.promise(() => rotation.reached);
        const result = yield* auth.revokeAccountSession(
          profile.accountId,
          handleOf(me),
          auth.hashSessionToken(me),
        );
        rotation.release();
        yield* Fiber.join(refreshing);

        expect(result.revokedSelf).toBe(true);
        expect(h.familyRows(familyId)).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("a cookie whose rotation record has expired ends nothing at logout", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { me } = yield* twoDevices("lo_expired");
      const refreshed = yield* auth.refreshTokens(me);
      sqlite
        .query("UPDATE rotated_sessions SET expires_at = ? WHERE token_hash = ?")
        .run(Date.now() - 1, auth.hashSessionToken(me));

      yield* auth.invalidateSession(me);

      expect(yield* dead(refreshed.refreshToken)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("revoking another device is never the caller's, whatever its cookie names", () =>
    Effect.gen(function* () {
      const { profile, me, other } = yield* twoDevices("rs_other");
      const refreshed = yield* auth.refreshTokens(me);

      const result = yield* auth.revokeAccountSession(
        profile.accountId,
        handleOf(other),
        auth.hashSessionToken(me),
      );

      expect(result.revokedSelf).toBe(false);
      expect(yield* dead(other)).toBe(true);
      expect(yield* dead(refreshed.refreshToken)).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("logout of a rotated-out token", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One device signed in, refreshed once; the database beside it. */
  const refreshedOnce = (handle: string) => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    const setUp = Effect.gen(function* () {
      const profile = yield* auth.registerProfile(`${handle}@example.com`, handle);
      const old = (yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      )).refreshToken;
      const familyId = (
        sqlite
          .query("SELECT family_id AS familyId FROM sessions WHERE id = ?")
          .get(auth.hashSessionToken(old)) as { familyId: string }
      ).familyId;
      const current = (yield* auth.refreshTokens(old)).refreshToken;
      return { profile, old, current, familyId };
    });
    /** Moves every rotation record past the grace window. */
    const ageRecords = () =>
      sqlite
        .query("UPDATE rotated_sessions SET rotated_at = ?")
        .run(Date.now() - ROTATION_GRACE_MS - 1);
    const records = (accountId: string) =>
      (
        sqlite
          .query("SELECT COUNT(*) AS n FROM rotated_sessions WHERE account_id = ?")
          .get(accountId) as { n: number }
      ).n;
    return { layer, sqlite, setUp, ageRecords, records };
  };

  const capture = () => {
    const lines: { level: string; message: unknown }[] = [];
    const layer = Logger.layer([
      Logger.map(Logger.formatStructured, (line) => {
        lines.push(line);
      }),
    ]);
    const reuseLines = (level: string) =>
      lines.filter(
        (line) =>
          line.level === level && String(line.message).includes("Session token reuse detected"),
      );
    return { lines, layer, reuseLines };
  };

  const dead = (refreshToken: string) =>
    Effect.result(auth.verifyRefreshToken(refreshToken)).pipe(
      Effect.map((outcome) => outcome._tag === "Failure"),
    );

  it.effect("outside the grace window counts reuse, warns, and names no one", () => {
    const db = refreshedOnce("lo_reuse");
    const log = capture();
    const reuse = vi.spyOn(metrics, "metricSessionReuseDetected");
    const revoked = vi.spyOn(metrics, "metricSessionFamilyRevoked");
    return Effect.gen(function* () {
      const { profile, old, current, familyId } = yield* db.setUp;
      db.ageRecords();
      log.lines.length = 0;

      yield* auth.invalidateSession(old);

      expect(reuse).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(log.reuseLines("WARN").map((line) => String(line.message))).toEqual([
        "Session token reuse detected at logout — family revoked",
      ]);
      expect(yield* dead(current)).toBe(true);
      expect(db.records(profile.accountId)).toBe(0);
      const written = JSON.stringify(log.lines);
      for (const secret of [profile.accountId, auth.hashSessionToken(old), familyId]) {
        expect(written).not.toContain(secret);
      }
    }).pipe(Effect.provide(db.layer), Effect.provide(log.layer));
  });

  it.effect("counts once: a second logout with the same token finds nothing", () => {
    const db = refreshedOnce("lo_twice");
    const log = capture();
    const reuse = vi.spyOn(metrics, "metricSessionReuseDetected");
    return Effect.gen(function* () {
      const { old } = yield* db.setUp;
      db.ageRecords();

      yield* auth.invalidateSession(old);
      yield* auth.invalidateSession(old);

      expect(reuse).toHaveBeenCalledTimes(1);
      expect(log.reuseLines("WARN")).toHaveLength(1);
      expect(log.reuseLines("INFO")).toEqual([]);
    }).pipe(Effect.provide(db.layer), Effect.provide(log.layer));
  });

  it.effect("whose family has no session left counts reuse and logs it at info", () => {
    const db = refreshedOnce("lo_gone");
    const log = capture();
    const reuse = vi.spyOn(metrics, "metricSessionReuseDetected");
    const revoked = vi.spyOn(metrics, "metricSessionFamilyRevoked");
    return Effect.gen(function* () {
      const { profile, old, current } = yield* db.setUp;
      // Revoked by handle: the family's sessions go, its records stay.
      yield* auth.revokeAccountSession(
        profile.accountId,
        auth.hashSessionToken(current).slice(0, 16),
        null,
      );
      db.ageRecords();

      yield* auth.invalidateSession(old);

      expect(reuse).toHaveBeenCalledTimes(1);
      expect(revoked).not.toHaveBeenCalled();
      expect(log.reuseLines("WARN")).toEqual([]);
      expect(log.reuseLines("INFO").map((line) => String(line.message))).toEqual([
        "Session token reuse detected at logout — no session of the family was left",
      ]);
      expect(db.records(profile.accountId)).toBe(0);
    }).pipe(Effect.provide(db.layer), Effect.provide(log.layer));
  });

  it.effect("inside the grace window is the device's own race, not reuse", () => {
    const db = refreshedOnce("lo_grace");
    const log = capture();
    const reuse = vi.spyOn(metrics, "metricSessionReuseDetected");
    return Effect.gen(function* () {
      const { old, current } = yield* db.setUp;

      yield* auth.invalidateSession(old);

      expect(reuse).not.toHaveBeenCalled();
      expect(log.reuseLines("WARN")).toEqual([]);
      expect(yield* dead(current)).toBe(true);
    }).pipe(Effect.provide(db.layer), Effect.provide(log.layer));
  });

  it.effect("of a live token is not reuse, even with an old record of its hash", () => {
    const db = refreshedOnce("lo_live");
    const log = capture();
    const reuse = vi.spyOn(metrics, "metricSessionReuseDetected");
    return Effect.gen(function* () {
      const { profile, current, familyId } = yield* db.setUp;
      // What a rotation that wrote its record and then failed its swap leaves
      // on the statement-at-a-time driver: the hash live and recorded.
      db.sqlite
        .query(
          "INSERT INTO rotated_sessions (token_hash, family_id, account_id, rotated_at, expires_at) VALUES (?, ?, ?, 0, ?)",
        )
        .run(auth.hashSessionToken(current), familyId, profile.accountId, Date.now() + 60_000);
      db.ageRecords();

      yield* auth.invalidateSession(current);

      expect(reuse).not.toHaveBeenCalled();
      expect(log.reuseLines("WARN")).toEqual([]);
      expect(yield* dead(current)).toBe(true);
    }).pipe(Effect.provide(db.layer), Effect.provide(log.layer));
  });
});
