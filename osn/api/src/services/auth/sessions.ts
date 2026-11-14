/**
 * Session invalidation (Copenhagen Book C1 revocation) and the Settings
 * introspection surface (list / revoke-one / revoke-all-other).
 */

import { accounts, oauthAuthorizationCodes, rotatedSessions, sessions } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { rowsChanged } from "@shared/db-utils";
import type { SecurityInvalidationTrigger } from "@shared/observability/metrics";
import {
  and,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";

import { canBatch } from "../../lib/batch";
import {
  metricSessionFamilyRevoked,
  metricSessionReuseDetected,
  metricSessionSecurityInvalidation,
  withSessionOp,
} from "../../metrics";
import { MAX_SESSIONS_PER_ACCOUNT, ROTATION_GRACE_MS } from "./constants";
import { AuthError, DatabaseError } from "./errors";
import { deriveSessionBinding, hashSessionToken, sessionHandleFromHash } from "./helpers";
import type { SessionSummary } from "./types";

/**
 * How a destructive "revoke every OTHER session" path should treat the caller.
 * See {@link createSessionsModule}'s `classifyCallerSession`.
 */
type CallerSessionResolution =
  | { readonly _tag: "resolved"; readonly sessionHash: string }
  | { readonly _tag: "none" }
  | { readonly _tag: "stale" };

/*
 * A family is one device's refresh chain: a rotation inserts the new session
 * in the old one's family before it deletes the old one, so a write that names
 * the caller's device by family reaches it wherever in its own refresh the
 * write lands. Which sessions a hash may name follows one rule: a hash may end
 * its family, say the caller's device was ended, or mark the caller's device in
 * a list, whether it is live or rotated out; only a live session spares or
 * lifts anything, so a stale token
 * cannot shield or widen a family someone else's refresh has moved on.
 */

/** The family of the live session `sessionHash` names; none for any other hash. */
const liveFamilyOf = (db: DbService["db"], sessionHash: string) =>
  db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, sessionHash));

/**
 * The family of the session `sessionHash` names, live or rotated out while its
 * token could still have been used (the record's `expires_at`, as reuse
 * detection reads it). Each arm reads its table's primary key. With
 * `withinGrace`, a rotation record counts only while it is younger than
 * `ROTATION_GRACE_MS`; the live-session arm is the same.
 */
const familyOf = (db: DbService["db"], sessionHash: string, nowMs: number, withinGrace = false) =>
  db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, sessionHash))
    .unionAll(
      db
        .select({ familyId: rotatedSessions.familyId })
        .from(rotatedSessions)
        .where(
          and(
            eq(rotatedSessions.tokenHash, sessionHash),
            gt(rotatedSessions.expiresAt, nowMs),
            withinGrace ? gt(rotatedSessions.rotatedAt, nowMs - ROTATION_GRACE_MS) : undefined,
          ),
        ),
    );

/**
 * Rows outside the family of the live session `sessionHash` names, for the
 * account-wide deletes that spare the caller's device. A hash already rotated
 * out, revoked or never issued spares nothing.
 */
export const outsideFamilyOf = (
  db: DbService["db"],
  familyColumn: typeof sessions.familyId | typeof rotatedSessions.familyId,
  sessionHash: string,
) => notInArray(familyColumn, liveFamilyOf(db, sessionHash));

/**
 * Sessions in the family of the live session `sessionHash` names, for the
 * restriction lift. A hash already rotated out, revoked or never issued names
 * none.
 */
export const inLiveFamilyOf = (db: DbService["db"], sessionHash: string) =>
  inArray(sessions.familyId, liveFamilyOf(db, sessionHash));

/**
 * True for a row whose account is scheduled for deletion. Such an account's
 * one live family is the deletion's cancel handle (the soft delete ends every
 * other), and a tombstoned account cannot sign in again to get another.
 */
const accountScheduledForDeletion = (
  db: DbService["db"],
  accountColumn: typeof sessions.accountId | typeof rotatedSessions.accountId,
) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(accounts)
      .where(and(eq(accounts.id, accountColumn), isNotNull(accounts.deletedAt))),
  );

/**
 * Finds the session id whose per-profile binding equals `sessionBinding`.
 *
 * The comparison is constant-time even though the presented value arrives
 * inside a JWT this server signed — nobody can iterate candidates today, and
 * keeping the digest comparison uniform means that stays true if `osn_sid`
 * ever becomes settable from another surface.
 */
function matchBinding(
  sessionIds: readonly string[],
  profileId: string,
  sessionBinding: string,
): string | null {
  const match = sessionIds.find((id) =>
    timingSafeEqualString(deriveSessionBinding(id, profileId), sessionBinding),
  );
  return match ?? null;
}

export function createSessionsModule() {
  /**
   * Ends the device a session token belongs to: every session of its family,
   * found from the live session or from the token's live rotation record
   * (see {@link familyOf}). One statement, so a refresh of the same token in
   * another tab, whether it finished before the delete or is in flight when
   * the delete runs, leaves no session of the device behind.
   *
   * A token no live session holds, found through a rotation record written
   * longer than `ROTATION_GRACE_MS` ago, is a replay of a token its device has
   * moved on from, and counts as reuse as it does at `/token`. When this
   * request's delete removed a session, `family_revoked` and a warning. Then
   * the family's rotation records are deleted, and the request whose delete
   * removes them counts `reuse_detected` (with an info line when its own
   * delete found no session left), so two requests replaying one token at once
   * count it once. Each line says which request found it (`at`); none names
   * the account, the family or the token. A records delete that fails is
   * logged on its own: the family's sessions are already gone, and a later
   * replay of the token counts the reuse. Inside the window it is the
   * device's own race with its refresh, and nothing is counted.
   *
   * A sign-in (`at` is `"sign-in"`) ends nothing of an account scheduled for
   * deletion: that account's one family is the deletion's cancel handle, and
   * its sessions and records are left as they are, reuse included.
   *
   * Silently succeeds when the token names nothing (idempotent — don't leak
   * whether a session was valid). Otherwise the family's rotation records
   * stay, as a revoke by handle leaves them.
   */
  const endFamilyOfToken = (
    sessionToken: string,
    at: "logout" | "sign-in",
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const sessionId = hashSessionToken(sessionToken);
      const { db } = yield* Db;
      const nowMs = Date.now();
      const sparesCancelHandle = at === "sign-in";
      // The token's live rotation record, when no live session holds its hash.
      // Read before the delete, which removes the live session of a token
      // still in use.
      const rotatedOut = db
        .select({
          accountId: rotatedSessions.accountId,
          familyId: rotatedSessions.familyId,
          rotatedAt: rotatedSessions.rotatedAt,
        })
        .from(rotatedSessions)
        .where(
          and(
            eq(rotatedSessions.tokenHash, sessionId),
            gt(rotatedSessions.expiresAt, nowMs),
            notExists(
              db
                .select({ one: sql`1` })
                .from(sessions)
                .where(eq(sessions.id, sessionId)),
            ),
            sparesCancelHandle
              ? not(accountScheduledForDeletion(db, rotatedSessions.accountId))
              : undefined,
          ),
        )
        .limit(1);
      const removal = db
        .delete(sessions)
        .where(
          and(
            inArray(sessions.familyId, familyOf(db, sessionId, nowMs)),
            sparesCancelHandle
              ? not(accountScheduledForDeletion(db, sessions.accountId))
              : undefined,
          ),
        );
      const { record, removed } = yield* Effect.tryPromise({
        try: async () => {
          // One batch on D1, so one request and one transaction, over the two
          // tables the delete's own lookup reads.
          if (canBatch(db)) {
            const [records, result] = await db.batch([rotatedOut, removal]);
            return { record: records[0], removed: rowsChanged(result) };
          }
          // In turn on bun:sqlite, where a failed read loses only the reuse
          // signal, never the delete.
          const records = await rotatedOut.then(
            (rows) => rows,
            () => [],
          );
          return { record: records[0], removed: rowsChanged(await removal) };
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (record === undefined || nowMs - record.rotatedAt < ROTATION_GRACE_MS) return;

      if (removed > 0) {
        metricSessionFamilyRevoked();
        yield* Effect.logWarning(`Session token reuse detected at ${at} — family revoked`);
      }
      // Led by `account_id` so it searches `rotated_sessions_account_family_idx`.
      // No cause in the line: a database error's text carries the ids.
      const recordsRemoved = yield* Effect.tryPromise({
        try: async () =>
          rowsChanged(
            await db
              .delete(rotatedSessions)
              .where(
                and(
                  eq(rotatedSessions.accountId, record.accountId),
                  eq(rotatedSessions.familyId, record.familyId),
                ),
              ),
          ),
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(
        Effect.catch(() =>
          Effect.logError(
            "Session token reuse: the family's rotation records could not be removed",
          ).pipe(Effect.map(() => 0)),
        ),
      );
      if (recordsRemoved === 0) return;
      metricSessionReuseDetected();
      if (removed === 0) {
        yield* Effect.logInfo(
          `Session token reuse detected at ${at} — no session of the family was left`,
        );
      }
    });

  /** `POST /logout`: ends the device the cookie's token belongs to ({@link endFamilyOfToken}). */
  const invalidateSession = (sessionToken: string): Effect.Effect<void, DatabaseError, Db> =>
    endFamilyOfToken(sessionToken, "logout");

  /**
   * A route that has just issued a new session ends the device the request's
   * own session cookie named ({@link endFamilyOfToken}). The browser drops that
   * cookie when the new one lands, and a renewal sent with it before the
   * sign-in can answer after it: ending the family leaves that answer's
   * rotated cookie naming no session, so the next renewal with it is refused
   * rather than acting as whoever held the old cookie. Every new session has
   * a family of its own, so this never ends the session the request issued.
   * The cancel handle of an account scheduled for deletion is spared;
   * `refreshTokens` keeps its cookie from renewing as anyone else's profile.
   */
  const endReplacedSession = (sessionToken: string): Effect.Effect<void, DatabaseError, Db> =>
    endFamilyOfToken(sessionToken, "sign-in").pipe(Effect.withSpan("auth.session.end_replaced"));

  /**
   * The account's live session ids, most recently used first.
   *
   * `MAX_SESSIONS_PER_ACCOUNT` is enforced read-then-delete in `issueTokens`
   * and D1 has no interactive transaction, so two concurrent logins can leave
   * the account one or two rows over the cap. The ordering makes that
   * harmless: the caller's own session is by definition recently used, so it
   * sits at the front of the window rather than being the row that falls off
   * the end. `sessions_account_last_used_idx` covers the sort.
   */
  const liveSessionIds = (accountId: string): Effect.Effect<string[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.lastUsedAt))
            .limit(MAX_SESSIONS_PER_ACCOUNT),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows.map((row) => row.id);
    });

  /**
   * Resolves the caller's own session row from an access token's `osn_sid`
   * claim. Recomputes the binding over the account's session ids and
   * returns the matching hash, or null when nothing matches (token minted
   * before the claim existed, or its session has since been revoked).
   *
   * This is the Bearer-token equivalent of reading the session cookie:
   * routes that must preserve "this session" while revoking the rest no
   * longer depend on a cookie riding along with the request.
   */
  const resolveSessionByBinding = (
    accountId: string,
    profileId: string,
    sessionBinding: string,
  ): Effect.Effect<string | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const ids = yield* liveSessionIds(accountId);
      return matchBinding(ids, profileId, sessionBinding);
    }).pipe(Effect.withSpan("auth.session.resolve_binding"));

  /**
   * Names the caller's own session for the paths that revoke every OTHER
   * session on the account (passkey register and passkey delete). Both
   * inputs are server-derived: the hash comes from the HttpOnly cookie, the
   * binding from the signed access token. Neither is ever read from the
   * request body, so a caller cannot name someone else's session as its own
   * and keep it through the sweep.
   *
   * The cookie wins when it names a session that is still live, but it does
   * NOT win merely by being present. A cookie holding a revoked, expired or
   * rotated-out token hashes to a value matching no row, and handing that to
   * `invalidateOtherAccountSessions` deletes everything — the same
   * sign-you-out-everywhere failure the binding exists to prevent, reached
   * through a stale cookie instead of a missing one. Checking membership
   * costs nothing extra: the fallback already reads these rows.
   *
   * Three answers, because these paths must NOT degrade to an account-wide
   * wipe on ambiguity:
   *
   *  - `resolved`  — a cookie or `osn_sid` binding names a live session. Keep
   *    it, revoke the rest.
   *  - `none`      — neither a cookie nor a binding was presented at all. A
   *    genuinely credential-less-but-authenticated call (an access token
   *    with no `osn_sid`, no cookie): there is no "self" to preserve, so
   *    revoking every session on the account is the intended outcome.
   *  - `stale`     — a cookie and/or binding WAS presented but matches no live
   *    row. The caller plainly has a session; it has just rotated out or been
   *    LRU-evicted past `MAX_SESSIONS_PER_ACCOUNT`. Wiping the account here
   *    would sign the caller out everywhere — the failure `osn_sid` exists to
   *    prevent, reached through a stale credential instead of a missing one.
   *    Destructive callers must fail closed here (re-authenticate) instead.
   */
  const classifyCallerSession = (
    accountId: string,
    profileId: string,
    caller: { cookieSessionHash?: string | null; sessionBinding?: string | null },
  ): Effect.Effect<CallerSessionResolution, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { cookieSessionHash, sessionBinding } = caller;
      if (!cookieSessionHash && !sessionBinding) return { _tag: "none" } as const;
      const ids = yield* liveSessionIds(accountId);
      if (cookieSessionHash && ids.includes(cookieSessionHash)) {
        return { _tag: "resolved", sessionHash: cookieSessionHash } as const;
      }
      const bound = sessionBinding ? matchBinding(ids, profileId, sessionBinding) : null;
      if (bound) return { _tag: "resolved", sessionHash: bound } as const;
      return { _tag: "stale" } as const;
    }).pipe(Effect.withSpan("auth.session.classify_caller"));

  /**
   * The caller's live, ordinary session on the account — its hash and its
   * family — or null: the row its session cookie names, else the row its
   * access token's `osn_sid` binding names, provided that row belongs to this
   * account, is unrestricted and is not yet expired. Both inputs are server-derived: the hash from the
   * HttpOnly cookie, the binding from the signed token.
   *
   * Stricter than {@link classifyCallerSession}, which counts every row of the
   * account. Here a restricted recovery row counts for nothing, since such a
   * session may only enrol a passkey and must never mint a step-up token or
   * an ordinary access token, and neither does a row past its `expires_at`,
   * which nothing deletes the moment it lapses.
   *
   * The cookie is read as well as the binding because each browser tab keeps
   * its own access token while sharing the cookie: a renewal in one tab
   * deletes the row another tab's token is bound to, and the cookie names the
   * row that replaced it. A caller presenting neither holds nothing to check
   * and gets null without a read.
   */
  const resolveLiveOrdinarySession = (
    accountId: string,
    profileId: string,
    caller: { cookieSessionHash: string | null; sessionBinding: string | null },
  ): Effect.Effect<{ sessionHash: string; familyId: string } | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { cookieSessionHash, sessionBinding } = caller;
      if (!cookieSessionHash && !sessionBinding) return null;
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      // Same window as `liveSessionIds`: newest first, so the caller's own
      // row (recently used by definition) sits inside the cap.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: sessions.id, familyId: sessions.familyId })
            .from(sessions)
            .where(
              and(
                eq(sessions.accountId, accountId),
                isNull(sessions.restrictedUntil),
                gt(sessions.expiresAt, nowSec),
              ),
            )
            .orderBy(desc(sessions.lastUsedAt))
            .limit(MAX_SESSIONS_PER_ACCOUNT),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const ids = rows.map((row) => row.id);
      const hash =
        cookieSessionHash && ids.includes(cookieSessionHash)
          ? cookieSessionHash
          : sessionBinding
            ? matchBinding(ids, profileId, sessionBinding)
            : null;
      const row = hash === null ? undefined : rows.find((r) => r.id === hash);
      return row ? { sessionHash: row.id, familyId: row.familyId } : null;
    }).pipe(Effect.withSpan("auth.session.check_live"));

  /**
   * Invalidates all sessions for an account EXCEPT the device of the one
   * identified by `keepSessionHash` (its family; see {@link outsideFamilyOf}).
   * Used after a passkey is registered or deleted: the caller's device stays,
   * and every other session goes, since one opened before the change may be
   * held by whoever the change is meant to lock out. `trigger` labels the
   * emitted metric so the security-invalidation dashboard can attribute the
   * sweep.
   */
  const invalidateOtherAccountSessions = (
    accountId: string,
    keepSessionHash: string,
    trigger: SecurityInvalidationTrigger = "passkey_register",
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(sessions)
            .where(
              and(
                eq(sessions.accountId, accountId),
                outsideFamilyOf(db, sessions.familyId, keepSessionHash),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSessionSecurityInvalidation(trigger);
    }).pipe(Effect.withSpan("auth.session.invalidate_other"));

  /**
   * The account's sessions for the Settings list. `isCurrent` marks the
   * caller's device: every session in the family of the session
   * `currentSessionHash` names, live or rotated out within `ROTATION_GRACE_MS`
   * (see {@link familyOf}). So a cookie the device refreshed past a moment ago
   * (a second tab) still marks the device's live session, and a cookie rotated
   * past longer ago marks nothing. `revokeAccountSession` decides `revokedSelf`
   * on the family without that age limit. The marker grants nothing: a revoke by handle and the account-wide deletes do not read it.
   */
  const listAccountSessions = (
    accountId: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ sessions: SessionSummary[] }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // The LIMIT bounds the Settings page whatever the account holds.
      // MAX_SESSIONS_PER_ACCOUNT is the real ceiling (enforced at issuance),
      // and concurrent logins can leave an account a row or two over it.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: sessions.id,
              uaLabel: sessions.uaLabel,
              createdAt: sessions.createdAt,
              lastUsedAt: sessions.lastUsedAt,
              expiresAt: sessions.expiresAt,
              isCurrent:
                currentSessionHash === null
                  ? sql<boolean>`0`.mapWith(Boolean)
                  : inArray(
                      sessions.familyId,
                      familyOf(db, currentSessionHash, Date.now(), true),
                    ).mapWith(Boolean),
            })
            .from(sessions)
            .where(eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.lastUsedAt))
            .limit(MAX_SESSIONS_PER_ACCOUNT),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return {
        sessions: rows.map((row) => ({
          id: sessionHandleFromHash(row.id),
          uaLabel: row.uaLabel,
          createdAt: row.createdAt,
          lastUsedAt: row.lastUsedAt,
          expiresAt: row.expiresAt,
          isCurrent: row.isCurrent,
        })),
      };
    }).pipe(withSessionOp("list"));

  /**
   * Revokes a device by the public handle of one of its sessions (first 16
   * hex chars of the SHA-256): every session of that session's family, the
   * device's refresh chain (or the reservations of one cross-device request).
   * Scoped to the caller's accountId, so a stolen handle from another
   * account's log line can't revoke anyone else's sessions.
   *
   * The delete is one statement, so no refresh can land between finding the
   * family and deleting it; and a rotation in flight leaves nothing behind it
   * (see `refreshTokens`). The handle is looked up among the rotation records
   * as well as the live sessions, so a handle the device has since rotated
   * away from — a Settings list a few minutes old — still finds its family.
   *
   * Returns whether the caller's own device was among those revoked, so the
   * HTTP layer can clear the cookie: the family of the session the cookie
   * names, live or rotated out, read before the delete (in the same batch on
   * D1). A family never changes, so a refresh of the caller's session between
   * the read and the delete, or before the read, leaves the answer true.
   *
   * Idempotent: a handle that matches nothing returns `{ revokedSelf: false }`
   * rather than "Session not found", as `/logout` does, so revoke is not an
   * oracle for which handles exist.
   */
  const revokeAccountSession = (
    accountId: string,
    sessionHandle: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ revokedSelf: boolean }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // The route enforces the shape; checked again here because the bounds
      // below are only a prefix range for a lowercase hex handle.
      if (!/^[0-9a-f]{16}$/.test(sessionHandle)) {
        return { revokedSelf: false };
      }
      const { db } = yield* Db;
      // Every id and record key with the handle as its prefix: 64 lowercase
      // hex characters, and "g" sorts after every hex digit. Each arm reads
      // its table's primary key by range, not the account's rows; the outer
      // `account_id` keeps the delete to the caller's account, since a family
      // belongs to one account.
      const upper = `${sessionHandle}g`;
      const families = db
        .select({ familyId: sessions.familyId })
        .from(sessions)
        .where(and(gte(sessions.id, sessionHandle), lt(sessions.id, upper)))
        .unionAll(
          db
            .select({ familyId: rotatedSessions.familyId })
            .from(rotatedSessions)
            .where(
              and(
                gte(rotatedSessions.tokenHash, sessionHandle),
                lt(rotatedSessions.tokenHash, upper),
              ),
            ),
        );
      const removal = db
        .delete(sessions)
        .where(and(eq(sessions.accountId, accountId), inArray(sessions.familyId, families)))
        .returning({ familyId: sessions.familyId });
      const { callerFamily, removed } = yield* Effect.tryPromise({
        try: async () => {
          if (currentSessionHash === null) {
            return { callerFamily: undefined, removed: await removal };
          }
          // Before the delete: a live session of the revoked family is gone
          // after it, and has no rotation record to be found by.
          const callerRead = familyOf(db, currentSessionHash, Date.now()).limit(1);
          const [callerRows, removedRows] = canBatch(db)
            ? await db.batch([callerRead, removal])
            : ([await callerRead, await removal] as const);
          return { callerFamily: callerRows[0]?.familyId, removed: removedRows };
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (removed.length > 0) metricSessionSecurityInvalidation("session_revoke");
      return {
        revokedSelf:
          callerFamily !== undefined && removed.some((row) => row.familyId === callerFamily),
      };
    }).pipe(withSessionOp("revoke"));

  /**
   * Revokes all sessions for the account except the caller's device (its
   * family; see {@link outsideFamilyOf}), for the "Sign out everywhere else"
   * button in Settings, then deletes the account's
   * OIDC authorization codes in flight. A code is bound to the account, not to
   * the session that minted it, so one held from a revoked session would
   * otherwise still open a session at its relying party for the minute it
   * lives. Sessions go first: once they are gone, no new code can be minted
   * from them.
   */
  const revokeAllOtherAccountSessions = (
    accountId: string,
    currentSessionHash: string,
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(sessions)
            .where(
              and(
                eq(sessions.accountId, accountId),
                outsideFamilyOf(db, sessions.familyId, currentSessionHash),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(oauthAuthorizationCodes)
            .where(eq(oauthAuthorizationCodes.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSessionSecurityInvalidation("session_revoke_all");
    }).pipe(withSessionOp("revoke_all"));

  return {
    invalidateSession,
    endReplacedSession,
    resolveSessionByBinding,
    classifyCallerSession,
    resolveLiveOrdinarySession,
    invalidateOtherAccountSessions,
    listAccountSessions,
    revokeAccountSession,
    revokeAllOtherAccountSessions,
  };
}

export type SessionsModule = ReturnType<typeof createSessionsModule>;
