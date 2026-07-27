/**
 * Session invalidation (Copenhagen Book C1 revocation) and the Settings
 * introspection surface (list / revoke-one / revoke-all-other).
 */

import { sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import type { SecurityInvalidationTrigger } from "@shared/observability/metrics";
import { and, desc, eq, like, ne } from "drizzle-orm";
import { Effect } from "effect";

import { metricSessionSecurityInvalidation, withSessionOp } from "../../metrics";
import { MAX_SESSIONS_PER_ACCOUNT } from "./constants";
import { AuthError, DatabaseError } from "./errors";
import { deriveSessionBinding, hashSessionToken, sessionHandleFromHash } from "./helpers";
import type { SessionSummary } from "./types";

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
   * Invalidates a single session by deleting its DB row. Used by the
   * `/logout` endpoint. Silently succeeds if the session doesn't exist
   * (idempotent — don't leak whether a session was valid).
   */
  const invalidateSession = (sessionToken: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const sessionId = hashSessionToken(sessionToken);
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.id, sessionId)),
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
   * OTHER session on the account (H1 on passkey register, S-L3 on passkey
   * delete). Both inputs are server-derived: the hash comes from the
   * HttpOnly cookie, the binding from the signed access token. Neither is
   * ever read from the request body (S-H1).
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
    Effect.gen(function* () {
      const { cookieSessionHash, sessionBinding } = caller;
      if (!cookieSessionHash && !sessionBinding) return null;
      const ids = yield* liveSessionIds(accountId);
      if (cookieSessionHash && ids.includes(cookieSessionHash)) return cookieSessionHash;
      return sessionBinding ? matchBinding(ids, profileId, sessionBinding) : null;
    }).pipe(Effect.withSpan("auth.session.resolve_caller"));

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
   * Invalidates all sessions for an account EXCEPT the one identified by
   * `keepSessionHash`. Used after security events (H1) where the current
   * session should survive but all others must be revoked (passkey
   * registration, passkey deletion, …). `trigger` labels the emitted metric
   * so the security-invalidation dashboard can attribute the sweep.
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
            .where(and(eq(sessions.accountId, accountId), ne(sessions.id, keepSessionHash))),
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
      // P-W2: hard cap defends the Settings page against pathological
      // accounts. MAX_SESSIONS_PER_ACCOUNT is the real ceiling (enforced
      // at issueTokens) but the LIMIT here is belt-and-braces plus a
      // signal to the planner.
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
   * Revokes a single session by its public handle (first 16 hex chars of
   * the SHA-256). Scopes the DELETE to the caller's accountId so a stolen
   * handle from another account's log line can't revoke anyone else's
   * sessions. Returns whether the caller's own session was the one revoked
   * so the HTTP layer can clear the cookie.
   *
   * S-M4: Idempotent — a handle that doesn't match any row returns
   * `{ revokedSelf: false }` rather than surfacing "Session not found".
   * This mirrors the `/logout` posture ("don't leak whether the session
   * existed") and closes the handle-existence oracle.
   *
   * P-W1: The match uses a `LIKE 'handle%'` predicate so the DB returns
   * at most one row via the PK index rather than fetching every session
   * for the account into JS and finding in-memory.
   */
  const revokeAccountSession = (
    accountId: string,
    sessionHandle: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ revokedSelf: boolean }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Short-circuit on malformed handles so the LIKE pattern stays
      // safe (no escape concerns since we've already enforced [0-9a-f]{16}
      // at the route but defence-in-depth at the service boundary).
      if (!/^[0-9a-f]{16}$/.test(sessionHandle)) {
        return { revokedSelf: false };
      }
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.accountId, accountId), like(sessions.id, `${sessionHandle}%`)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const match = rows[0];
      if (!match) {
        // S-M4: idempotent — indistinguishable from a no-op revoke of a
        // handle that existed for a different account (scoping predicate
        // already filtered those out).
        return { revokedSelf: false };
      }
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.id, match.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSessionSecurityInvalidation("session_revoke");
      return { revokedSelf: currentSessionHash !== null && match.id === currentSessionHash };
    }).pipe(withSessionOp("revoke"));

  /**
   * Revokes all sessions for the account except the caller's, for the
   * "Sign out everywhere else" button in Settings.
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
            .where(and(eq(sessions.accountId, accountId), ne(sessions.id, currentSessionHash))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSessionSecurityInvalidation("session_revoke_all");
    }).pipe(withSessionOp("revoke_all"));

  return {
    invalidateSession,
    resolveSessionByBinding,
    resolveCallerSession,
    invalidateAccountSessions,
    invalidateOtherAccountSessions,
    listAccountSessions,
    revokeAccountSession,
    revokeAllOtherAccountSessions,
  };
}

export type SessionsModule = ReturnType<typeof createSessionsModule>;
