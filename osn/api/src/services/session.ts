/**
 * Session management service — powers the "your active sessions" UI.
 *
 * Separated from `AuthService` because session management is a distinct
 * user-facing concern (list my devices, revoke that one, log me out
 * everywhere else) built on top of the session-row primitives that
 * `AuthService` already owns. Keeping the split small:
 *
 *   - `AuthService` — issues, rotates, and invalidates sessions.
 *   - `SessionService` — reads the sessions table for display and exposes
 *     the user-driven revoke surfaces.
 *
 * Every operation runs inside `withSessionManagement(action)` so the
 * duration histogram and structured error log land consistently.
 */

import { sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, desc, eq, ne } from "drizzle-orm";
import { Data, Effect } from "effect";

import { metricSessionListed, withSessionManagement } from "../metrics";
import { AuthError, DatabaseError, type AuthService, hashSessionToken } from "./auth";

/** Shape returned by `listSessions`. Snake_case; already on the wire shape. */
export interface SessionListItem {
  id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
  device_label: string | null;
  ip_hash_prefix: string | null;
  created_ip_hash_prefix: string | null;
  is_current: boolean;
}

export interface ListSessionsResult {
  sessions: SessionListItem[];
}

/**
 * Prefix of a 64-char hex hash surfaced in the UI as a weak identifier.
 * 12 hex chars = 48 bits — enough for humans to eyeball equality across
 * list entries without exposing the full fingerprint if the response ever
 * leaks into an unintended log.
 */
const IP_HASH_DISPLAY_PREFIX = 12;

function prefixHash(hash: string | null): string | null {
  return hash ? hash.slice(0, IP_HASH_DISPLAY_PREFIX) : null;
}

/** Tagged error specific to session-management NotFound semantics. */
export class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{
  readonly message: string;
}> {}

export type SessionRevokeError = AuthError | SessionNotFoundError | DatabaseError;

export function createSessionService(_auth: AuthService) {
  // _auth is reserved for future features (step-up auth) that will gate
  // revokes on a fresh ceremony. It's accepted now so the route wiring
  // doesn't need to change later.
  void _auth;

  /**
   * Returns every non-expired session row for the account, ordered by
   * `lastSeenAt` descending so the most recent device is first. The row
   * whose hash matches `currentSessionHash` is flagged `is_current: true`.
   *
   * The `session.id` (hash) IS returned — it's the stable opaque handle
   * the UI uses to target a specific session in the revoke endpoint. The
   * hash itself is not a secret (it's a hash, not the raw token) but we
   * still only expose it to the owning account.
   */
  const listSessions = (
    accountId: string,
    currentSessionHash: string | null,
  ): Effect.Effect<ListSessionsResult, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(sessions)
            .where(eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.lastSeenAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const items: SessionListItem[] = rows
        .filter((r) => r.expiresAt > nowSec)
        .map((r) => ({
          id: r.id,
          created_at: r.createdAt,
          last_seen_at: r.lastSeenAt,
          expires_at: r.expiresAt,
          user_agent: r.userAgent,
          device_label: r.deviceLabel,
          ip_hash_prefix: prefixHash(r.ipHash),
          created_ip_hash_prefix: prefixHash(r.createdIpHash),
          is_current: currentSessionHash !== null && r.id === currentSessionHash,
        }));

      metricSessionListed();
      return { sessions: items };
    }).pipe(withSessionManagement("list"));

  /**
   * Revokes a single session by id. Returns `SessionNotFoundError` when
   * the session doesn't exist OR belongs to a different account — the
   * same error shape for both cases so a caller can't use the endpoint as
   * an oracle against other accounts' session ids.
   *
   * The reason emitted to the unified revoke counter depends on whether
   * the caller is killing their own current device (`self`) or another
   * (`other`), which the route knows because it compares the session hash
   * against the cookie.
   */
  const revokeSession = (
    accountId: string,
    sessionId: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ wasCurrent: boolean }, SessionRevokeError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = rows[0];
      if (!row || row.accountId !== accountId) {
        return yield* Effect.fail(new SessionNotFoundError({ message: "Session not found" }));
      }

      const wasCurrent = currentSessionHash !== null && row.id === currentSessionHash;

      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.id, sessionId)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // `metricSessionRevoked` is emitted by the route so it can pass the
      // precise reason ("self" vs "other") — the service just reports back
      // whether the revoke targeted the caller's current device.
      return { wasCurrent };
    }).pipe(withSessionManagement("revoke"));

  /**
   * Revokes every session for the account except the one matching
   * `currentSessionHash`. Returns the count removed so the UI can surface
   * "Revoked 3 other devices".
   *
   * If `currentSessionHash` is null (caller lost their cookie somehow),
   * the operation still runs — it just revokes every row, effectively a
   * full logout. Emitting at warning level surfaces that unusual state.
   */
  const revokeOtherSessions = (
    accountId: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ revoked: number }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      if (currentSessionHash === null) {
        yield* Effect.logWarning(
          "revokeOtherSessions called without a current session hash — revoking every session",
        );
      }

      const existing = yield* Effect.tryPromise({
        try: () => db.select().from(sessions).where(eq(sessions.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const targeted = existing.filter(
        (r) => currentSessionHash === null || r.id !== currentSessionHash,
      ).length;

      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(sessions)
            .where(
              currentSessionHash === null
                ? eq(sessions.accountId, accountId)
                : and(eq(sessions.accountId, accountId), ne(sessions.id, currentSessionHash)),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return { revoked: targeted };
    }).pipe(withSessionManagement("revoke_others"));

  return {
    listSessions,
    revokeSession,
    revokeOtherSessions,
    hashSessionToken,
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
