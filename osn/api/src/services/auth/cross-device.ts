/**
 * Cross-device login (QR-code mediated session transfer). Device B begins +
 * polls; device A scans, approves (or rejects). 256-bit secret hashed at
 * rest, one-time delivery, short TTL — state lives in the injectable
 * cross-device ceremony store.
 *
 * No token is ever stored. An approval reserves a `sessions` row for device B
 * whose token nobody keeps, so every revocation that follows it — sign out
 * everywhere else, a recovery, an erasure, any wipe of the account's
 * sessions — removes that row as it would a signed-in device's. The poll that
 * takes the approved entry deletes the reserved row and, only if it was still
 * there and the account and profile still stand, mints device B's session
 * from the rows as they are then.
 */

import { createHash } from "node:crypto";

import { securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { rowsChanged } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import { and, eq, gt } from "drizzle-orm";
import { Effect } from "effect";

import { forkBackground } from "../../lib/background";
import { metricSecurityEventRecorded, withCrossDeviceOp } from "../../metrics";
import { CDL_TTL_SECONDS } from "./constants";
import type { AuthContext } from "./context";
import { AuthError, type CoordinationError, DatabaseError } from "./errors";
import { genId } from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { SecurityEventsModule } from "./security-events";
import { storeCall } from "./store-call";
import type { CrossDeviceRequest } from "./stores";
import type { TokensModule } from "./tokens";
import type { PublicProfile, SessionMeta, TokenSet } from "./types";
import { toPublicProfile } from "./types";

export function createCrossDeviceModule(
  ctx: AuthContext,
  profiles: ProfilesModule,
  tokens: TokensModule,
  securityEventsModule: SecurityEventsModule,
) {
  const { stores, hashIp } = ctx;
  const { findDefaultProfile, findProfileById } = profiles;
  const { issueTokens, makeRoomForReservation, reserveSession } = tokens;

  /**
   * Deletes the reserved row `id` while it is live, and answers whether this
   * call deleted it: false once a revocation removed it, it expired, or
   * another call took it first.
   */
  const releaseSession = (
    accountId: string,
    id: string,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const deleted = yield* Effect.tryPromise({
        try: () =>
          db
            .delete(sessions)
            .where(
              and(
                eq(sessions.id, id),
                eq(sessions.accountId, accountId),
                gt(sessions.expiresAt, Math.floor(Date.now() / 1000)),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rowsChanged(deleted) === 1;
    });
  /** See {@link SecurityEventsModule.notifySecurityEventByAccountId}. */
  const notifyCrossDeviceLoginByAccountId = (accountId: string) =>
    securityEventsModule.notifySecurityEventByAccountId(
      accountId,
      "cross_device_login",
      "cross-device-login",
      {},
    );

  /**
   * Device B calls this to create a pending login request. Returns a
   * `requestId` + random `secret` (256-bit). Device B renders a QR code
   * encoding `${issuerUrl}/login/cross-device/${requestId}#${secret}` and
   * begins polling `/login/cross-device/:requestId/status`.
   */
  const beginCrossDeviceLogin = (
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { requestId: string; cdlSecret: string; expiresAt: number },
    AuthError | CoordinationError,
    never
  > =>
    Effect.gen(function* () {
      // The store self-bounds (CEREMONY_STORE_MAX in-memory FIFO drop,
      // per-entry TTL on the Durable Object store).
      const requestId = genId("cdl_");
      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = Buffer.from(secretBytes).toString("hex");
      const secretHash = createHash("sha256").update(secret).digest("hex");
      const nowMs = Date.now();
      const expiresAtMs = nowMs + CDL_TTL_SECONDS * 1000;

      yield* storeCall(stores.crossDeviceRequests, "set", () =>
        stores.crossDeviceRequests.set(
          requestId,
          {
            requestId,
            secretHash,
            status: "pending",
            uaLabel: sessionMeta?.uaLabel ?? null,
            ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
            expiresAt: expiresAtMs,
            createdAt: nowMs,
          },
          CDL_TTL_SECONDS * 1000,
        ),
      );

      // API response uses Unix seconds for consistency with other endpoints.
      // Field named `cdlSecret` to match the redaction deny-list entry.
      return { requestId, cdlSecret: secret, expiresAt: Math.floor(expiresAtMs / 1000) };
    }).pipe(withCrossDeviceOp("begin"));

  /**
   * Device B polls this to check whether device A has approved the request.
   * Returns `{ status: "pending" }` until approved. The poll that finds the
   * approval takes the entry, so the session is delivered once — of two polls
   * at once, one gets it and the other answers `expired`. It then deletes the
   * reserved row and reloads the profile; it answers `expired`, with no
   * token, when the row is gone (a revocation since the approval), the
   * account is deleted or scheduled for deletion, or the profile is gone or
   * belongs to another account. Otherwise it mints device B's session from
   * the profile and account as they are now. A session that fails to mint
   * after the take answers the error, and the request is spent: device B
   * begins again.
   */
  const getCrossDeviceLoginStatus = (
    requestId: string,
    secret: string,
  ): Effect.Effect<
    | { status: "pending"; uaLabel: string | null }
    | { status: "approved"; session: TokenSet; profile: PublicProfile }
    | { status: "rejected" }
    | { status: "expired" },
    AuthError | DatabaseError | CoordinationError,
    Db
  > =>
    Effect.gen(function* () {
      const entry = yield* storeCall(stores.crossDeviceRequests, "get", () =>
        stores.crossDeviceRequests.get(requestId),
      );
      if (!entry) {
        return { status: "expired" as const };
      }

      // Verify secret
      const providedHash = createHash("sha256").update(secret).digest("hex");
      if (!timingSafeEqualString(providedHash, entry.secretHash)) {
        return yield* Effect.fail(new AuthError({ message: "Invalid secret" }));
      }

      // Check expiry
      if (Date.now() > entry.expiresAt) {
        yield* storeCall(stores.crossDeviceRequests, "delete", () =>
          stores.crossDeviceRequests.delete(requestId),
        );
        return { status: "expired" as const };
      }

      if (entry.status === "rejected") {
        yield* storeCall(stores.crossDeviceRequests, "delete", () =>
          stores.crossDeviceRequests.delete(requestId),
        );
        return { status: "rejected" as const };
      }

      if (entry.status === "approved") {
        // Single delivery: the take removes the entry in the same call that
        // reads it, so only one poll holds the approval it mints from.
        const taken = yield* storeCall(stores.crossDeviceRequests, "take", () =>
          stores.crossDeviceRequests.take(requestId),
        );
        if (
          taken?.status !== "approved" ||
          !taken.accountId ||
          !taken.profileId ||
          !taken.sessionId
        ) {
          return { status: "expired" as const };
        }
        const { accountId, profileId, sessionId } = taken;
        // Every revocation since the approval removed the reserved row.
        const reserved = yield* releaseSession(accountId, sessionId);
        if (!reserved) return { status: "expired" as const };
        // Excludes an account scheduled for deletion, as well as a deleted one.
        const profile = yield* findProfileById(profileId);
        if (!profile || profile.accountId !== accountId) {
          return { status: "expired" as const };
        }
        // Device B's session, carrying device B's label from begin.
        const session = yield* issueTokens(
          profile.id,
          accountId,
          profile.email,
          profile.handle,
          profile.displayName,
          undefined,
          { uaLabel: taken.uaLabel, ip: null },
        );
        return {
          status: "approved" as const,
          session,
          profile: toPublicProfile(profile, profile.email),
        };
      }

      return { status: "pending" as const, uaLabel: entry.uaLabel };
    }).pipe(withCrossDeviceOp("poll"));

  /**
   * Device A (authenticated) approves the request: it reserves device B's
   * session row, and the entry records who approved, which profile device B
   * signs in as and the reserved row's id, never a token — device B's poll
   * mints the session. The approval replaces the pending entry it read in one
   * `swap`, so of two decisions at once (two approvals, or an approval and a
   * rejection) exactly one lands; the other releases its reserved row and
   * answers "already processed". An approval whose `swap` fails releases its
   * row too, and answers the store's error. Only the approval that lands
   * makes room under the session cap, so a lost race or a failed store call
   * signs no device out; until it does, the account holds one row over the
   * cap for each approval in flight. Records a `cross_device_login` security
   * event.
   */
  const approveCrossDeviceLogin = (
    requestId: string,
    secret: string,
    accountId: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<void, AuthError | DatabaseError | CoordinationError, Db | EmailService> =>
    Effect.gen(function* () {
      const entry = yield* storeCall(stores.crossDeviceRequests, "get", () =>
        stores.crossDeviceRequests.get(requestId),
      );
      if (!entry) {
        return yield* Effect.fail(new AuthError({ message: "Request not found or expired" }));
      }

      if (entry.status !== "pending") {
        return yield* Effect.fail(new AuthError({ message: "Request already processed" }));
      }

      // Verify secret
      const providedHash = createHash("sha256").update(secret).digest("hex");
      if (!timingSafeEqualString(providedHash, entry.secretHash)) {
        return yield* Effect.fail(new AuthError({ message: "Invalid secret" }));
      }

      // Check expiry
      if (Date.now() > entry.expiresAt) {
        yield* storeCall(stores.crossDeviceRequests, "delete", () =>
          stores.crossDeviceRequests.delete(requestId),
        );
        return yield* Effect.fail(new AuthError({ message: "Request expired" }));
      }

      // The approver's default profile is the one device B signs in as.
      const profile = yield* findDefaultProfile(accountId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }

      // Device B's session row is reserved before the approval lands, so a
      // poll never finds an approval without one. Every approval of this
      // request reserves its row in one family, the request's id, so the
      // winner's room-making leaves out a racing loser's row.
      const sessionId = yield* reserveSession(
        accountId,
        requestId,
        Math.ceil(entry.expiresAt / 1000),
        { uaLabel: entry.uaLabel, ip: null },
      );

      // Replaces exactly the pending entry read above, with the remaining TTL
      // so it still expires on schedule.
      const approvedEntry: CrossDeviceRequest = {
        ...entry,
        status: "approved",
        accountId,
        profileId: profile.id,
        sessionId,
      };
      const decided = yield* storeCall(stores.crossDeviceRequests, "swap", () =>
        stores.crossDeviceRequests.swap(
          requestId,
          entry,
          approvedEntry,
          Math.max(1, entry.expiresAt - Date.now()),
        ),
      ).pipe(Effect.tapError(() => releaseSession(accountId, sessionId).pipe(Effect.ignore)));
      if (!decided) {
        yield* releaseSession(accountId, sessionId).pipe(Effect.ignore);
        return yield* Effect.fail(new AuthError({ message: "Request already processed" }));
      }
      // The approval stands: its reservation now takes a place under the cap.
      yield* makeRoomForReservation(accountId, requestId);

      // Audit trail — security event + best-effort email notification.
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(securityEvents).values({
            id: genId("sev_"),
            accountId,
            kind: "cross_device_login",
            createdAt: nowSec,
            uaLabel: sessionMeta?.uaLabel ?? null,
            ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSecurityEventRecorded("cross_device_login");

      // Best-effort email notification (forked daemon, 10s timeout).
      yield* forkBackground(
        notifyCrossDeviceLoginByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.void),
        ),
      );
    }).pipe(withCrossDeviceOp("approve"));

  /**
   * Device A explicitly rejects the request — the next poll from device B
   * will see `{ status: "rejected" }`. Like an approval, it replaces the
   * pending entry it read in one `swap`, so it lands only if no other
   * decision has.
   */
  const rejectCrossDeviceLogin = (
    requestId: string,
    secret: string,
  ): Effect.Effect<void, AuthError | CoordinationError, never> =>
    Effect.gen(function* () {
      const entry = yield* storeCall(stores.crossDeviceRequests, "get", () =>
        stores.crossDeviceRequests.get(requestId),
      );
      if (!entry) {
        return yield* Effect.fail(new AuthError({ message: "Request not found or expired" }));
      }

      if (entry.status !== "pending") {
        return yield* Effect.fail(new AuthError({ message: "Request already processed" }));
      }

      const providedHash = createHash("sha256").update(secret).digest("hex");
      if (!timingSafeEqualString(providedHash, entry.secretHash)) {
        return yield* Effect.fail(new AuthError({ message: "Invalid secret" }));
      }

      // The rejected status, with the remaining TTL, so a subsequent poll
      // observes "rejected" and then cleans up.
      const decided = yield* storeCall(stores.crossDeviceRequests, "swap", () =>
        stores.crossDeviceRequests.swap(
          requestId,
          entry,
          { ...entry, status: "rejected" },
          Math.max(1, entry.expiresAt - Date.now()),
        ),
      );
      if (!decided) {
        return yield* Effect.fail(new AuthError({ message: "Request already processed" }));
      }
    }).pipe(withCrossDeviceOp("reject"));

  return {
    beginCrossDeviceLogin,
    getCrossDeviceLoginStatus,
    approveCrossDeviceLogin,
    rejectCrossDeviceLogin,
  };
}

export type CrossDeviceModule = ReturnType<typeof createCrossDeviceModule>;
