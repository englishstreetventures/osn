/**
 * Session invalidation (Copenhagen Book C1 revocation) and the Settings
 * introspection surface (list / revoke-one / revoke-all-other).
 */

import { oauthAuthorizationCodes, rotatedSessions, sessions } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import type { SecurityInvalidationTrigger } from "@shared/observability/metrics";
import { and, desc, eq, gt, gte, inArray, lt, notInArray } from "drizzle-orm";
import { Effect } from "effect";

import { canBatch } from "../../lib/batch";
import { metricSessionSecurityInvalidation, withSessionOp } from "../../metrics";
import { MAX_SESSIONS_PER_ACCOUNT } from "./constants";
import { AuthError, DatabaseError } from "./errors";
import { deriveSessionBinding, hashSessionToken, sessionHandleFromHash } from "./helpers";
import type { SessionSummary } from "./types";

/**
 * How a destructive "revoke every OTHER session" path should treat the caller.
 * See {@link createSessionsModule}'s `classifyCallerSession`.
 */
export type CallerSessionResolution =
  | { readonly _tag: "resolved"; readonly sessionHash: string }
  | { readonly _tag: "none" }
  | { readonly _tag: "stale" };

/*
 * A family is one device's refresh chain: a rotation inserts the new session
 * in the old one's family before it deletes the old one, so a write that names
 * the caller's device by family reaches it wherever in its own refresh the
 * write lands. Which sessions a hash may name follows one rule: a hash may end
 * its family, or say the caller's device was ended, whether it is live or
 * rotated out; only a live session spares or lifts anything, so a stale token
 * cannot shield or widen a family someone else's refresh has moved on.
 */

/** The family of the live session `sessionHash` names; none for any other hash. */
const liveFamilyOf = (db: DbService["db"], sessionHash: string) =>
  db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, sessionHash));

/**
 * The family of the session `sessionHash` names, live or rotated out while its
 * token could still have been used (the record's `expires_at`, as reuse
 * detection reads it). Each arm reads its table's primary key.
 */
const familyOf = (db: DbService["db"], sessionHash: string, nowMs: number) =>
  db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, sessionHash))
    .unionAll(
      db
        .select({ familyId: rotatedSessions.familyId })
        .from(rotatedSessions)
        .where(
          and(eq(rotatedSessions.tokenHash, sessionHash), gt(rotatedSessions.expiresAt, nowMs)),
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
   * (see {@link familyOf}). Used by the `/logout` endpoint. One statement, so
   * a refresh of the same token in another tab, whether it finished before
   * the delete or is in flight when the delete runs, leaves no session of the
   * device behind.
   *
   * Silently succeeds when the token names nothing (idempotent — don't leak
   * whether a session was valid). The family's rotation records stay, as a
   * revoke by handle leaves them: a later replay finds no session to revoke.
   */
  const invalidateSession = (sessionToken: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const sessionId = hashSessionToken(sessionToken);
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(sessions)
            .where(inArray(sessions.familyId, familyOf(db, sessionId, Date.now()))),
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

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
   * Names the caller's own live session for the paths that revoke every
   * OTHER session on the account (passkey register and passkey delete). Both
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
   */
  const resolveCallerSession = (
    accountId: string,
    profileId: string,
    caller: { cookieSessionHash?: string | null; sessionBinding?: string | null },
  ): Effect.Effect<string | null, DatabaseError, Db> =>
    classifyCallerSession(accountId, profileId, caller).pipe(
      Effect.map((r) => (r._tag === "resolved" ? r.sessionHash : null)),
    );

  /**
   * The three-way classification behind {@link resolveCallerSession}, for the
   * destructive "revoke every OTHER session" paths (passkey register/delete)
   * that must NOT degrade to an account-wide wipe on ambiguity:
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
   * Invalidates ALL sessions for an account. Used when a security event
   * demands full session revocation (e.g. passkey registration, email
   * change, account compromise). See auth improvements H1.
   */
  const invalidateAccountSessions = (accountId: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  /**
   * Invalidates all sessions for an account EXCEPT the device of the one
   * identified by `keepSessionHash` (its family; see {@link outsideFamilyOf}).
   * Used after security events (H1) where the current session should survive
   * but all others must be revoked (passkey registration, passkey deletion,
   * …). `trigger` labels the emitted metric so the security-invalidation
   * dashboard can attribute the sweep.
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
            .select()
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
          isCurrent: currentSessionHash !== null && row.id === currentSessionHash,
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
    resolveSessionByBinding,
    resolveCallerSession,
    classifyCallerSession,
    invalidateAccountSessions,
    invalidateOtherAccountSessions,
    listAccountSessions,
    revokeAccountSession,
    revokeAllOtherAccountSessions,
  };
}

export type SessionsModule = ReturnType<typeof createSessionsModule>;
