/**
 * Cross-device login (QR-code mediated session transfer). Device B begins +
 * polls; device A scans, approves (or rejects). 256-bit secret hashed at
 * rest, one-time consumption, short TTL — state lives in the injectable
 * cross-device ceremony store.
 */

import { createHash } from "node:crypto";

import { securityEvents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { EmailService } from "@shared/email";
import { Effect } from "effect";

import { timingSafeEqualString } from "../../lib/timing-safe";
import { metricSecurityEventRecorded, withCrossDeviceOp } from "../../metrics";
import { CDL_TTL_SECONDS } from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import { genId } from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { SecurityEventsModule } from "./security-events";
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
  const { findDefaultProfile } = profiles;
  const { issueTokens } = tokens;
  /** See {@link SecurityEventsModule.notifySecurityEventByAccountId}. */
  const notifyCrossDeviceLoginByAccountId = (accountId: string) =>
    securityEventsModule.notifySecurityEventByAccountId(
      accountId,
      "cross_device_login",
      "cross-device-login",
    );

  /**
   * Device B calls this to create a pending login request. Returns a
   * `requestId` + random `secret` (256-bit). Device B renders a QR code
   * encoding `${issuerUrl}/login/cross-device/${requestId}#${secret}` and
   * begins polling `/login/cross-device/:requestId/status`.
   */
  const beginCrossDeviceLogin = (
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ requestId: string; cdlSecret: string; expiresAt: number }, AuthError, never> =>
    Effect.gen(function* () {
      // O3: the store self-bounds (CEREMONY_STORE_MAX in-memory FIFO drop,
      // native PX expiry on Redis), replacing the prior inline FIFO eviction.
      const requestId = genId("cdl_");
      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = Buffer.from(secretBytes).toString("hex");
      const secretHash = createHash("sha256").update(secret).digest("hex");
      const nowMs = Date.now();
      const expiresAtMs = nowMs + CDL_TTL_SECONDS * 1000;

      yield* Effect.promise(() =>
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
   * Returns `{ status: "pending" }` until approved, then returns the session
   * tokens exactly once (marks the request as consumed to prevent replay).
   */
  const getCrossDeviceLoginStatus = (
    requestId: string,
    secret: string,
  ): Effect.Effect<
    | { status: "pending"; uaLabel: string | null }
    | { status: "approved"; session: TokenSet; profile: PublicProfile }
    | { status: "rejected" }
    | { status: "expired" },
    AuthError,
    never
  > =>
    Effect.gen(function* () {
      const entry = yield* Effect.promise(() => stores.crossDeviceRequests.get(requestId));
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
        yield* Effect.promise(() => stores.crossDeviceRequests.delete(requestId));
        return { status: "expired" as const };
      }

      if (entry.status === "rejected") {
        yield* Effect.promise(() => stores.crossDeviceRequests.delete(requestId));
        return { status: "rejected" as const };
      }

      if (entry.status === "approved" && entry.session && entry.profile) {
        // One-time consumption — prevent replay.
        yield* Effect.promise(() => stores.crossDeviceRequests.delete(requestId));
        return {
          status: "approved" as const,
          session: entry.session,
          profile: entry.profile,
        };
      }

      return { status: "pending" as const, uaLabel: entry.uaLabel };
    }).pipe(withCrossDeviceOp("poll"));

  /**
   * Device A (authenticated) approves the request. The server issues a
   * session for device B and records a `cross_device_login` security event.
   */
  const approveCrossDeviceLogin = (
    requestId: string,
    secret: string,
    accountId: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const entry = yield* Effect.promise(() => stores.crossDeviceRequests.get(requestId));
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
        yield* Effect.promise(() => stores.crossDeviceRequests.delete(requestId));
        return yield* Effect.fail(new AuthError({ message: "Request expired" }));
      }

      // Resolve the approver's default profile to issue session for device B.
      const profile = yield* findDefaultProfile(accountId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }

      // Issue session for device B using device B's session meta (from begin).
      const session = yield* issueTokens(
        profile.id,
        accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: entry.uaLabel, ip: null },
      );

      // Store the session + profile on the request for device B to pick up.
      // O3: re-persist the mutated entry (the store returns a copy, not a live
      // reference) carrying the remaining TTL so it still expires on schedule.
      const approvedEntry: CrossDeviceRequest = {
        ...entry,
        status: "approved",
        accountId,
        session,
        profile: toPublicProfile(profile, profile.email),
      };
      yield* Effect.promise(() =>
        stores.crossDeviceRequests.set(
          requestId,
          approvedEntry,
          Math.max(0, entry.expiresAt - Date.now()),
        ),
      );

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
      yield* Effect.forkDaemon(
        notifyCrossDeviceLoginByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );
    }).pipe(withCrossDeviceOp("approve"));

  /**
   * Device A explicitly rejects the request — the next poll from device B
   * will see `{ status: "rejected" }`.
   */
  const rejectCrossDeviceLogin = (
    requestId: string,
    secret: string,
  ): Effect.Effect<void, AuthError, never> =>
    Effect.gen(function* () {
      const entry = yield* Effect.promise(() => stores.crossDeviceRequests.get(requestId));
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

      // O3: re-persist the rejected status (store returns a copy) with the
      // remaining TTL so a subsequent poll observes "rejected" then cleans up.
      yield* Effect.promise(() =>
        stores.crossDeviceRequests.set(
          requestId,
          { ...entry, status: "rejected" },
          Math.max(0, entry.expiresAt - Date.now()),
        ),
      );
    }).pipe(withCrossDeviceOp("reject"));

  return {
    beginCrossDeviceLogin,
    getCrossDeviceLoginStatus,
    approveCrossDeviceLogin,
    rejectCrossDeviceLogin,
  };
}

export type CrossDeviceModule = ReturnType<typeof createCrossDeviceModule>;
