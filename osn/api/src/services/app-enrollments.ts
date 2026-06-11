import { appEnrollments } from "@osn/db/schema";
import type { AppEnrollment } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { AppEnrollmentApp } from "@shared/observability/metrics";
import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";

import { metricAppEnrollmentJoined, metricAppEnrollmentLeft } from "../metrics";

export class AppEnrollmentDbError extends Data.TaggedError("AppEnrollmentDbError")<{
  readonly cause: unknown;
}> {}

const enrollmentId = (): string => `aenr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * Returns the active (open) enrollment row for `accountId` × `app`, if any.
 * The active row is the one with `left_at IS NULL`. At most one such row
 * exists at a time per (account, app).
 */
export const getActiveEnrollment = (
  accountId: string,
  app: AppEnrollmentApp,
): Effect.Effect<AppEnrollment | null, AppEnrollmentDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(appEnrollments)
          .where(
            and(
              eq(appEnrollments.accountId, accountId),
              eq(appEnrollments.app, app),
              isNull(appEnrollments.leftAt),
            ),
          )
          .limit(1),
      catch: (cause) => new AppEnrollmentDbError({ cause }),
    });
    return rows[0] ?? null;
  });

/**
 * Lazy provisioning hook — used by Pulse / Zap on first authenticated call
 * (typically over an ARC bridge with a `app:join` scope, but for now a
 * direct service-layer write since osn-api owns the table).
 *
 * Idempotent: if an open row already exists, no-op. Otherwise inserts a
 * new row with `joined_at = now`. Re-joins after a leave create a fresh
 * row, preserving the closed history rows for audit.
 */
export const joinApp = (
  accountId: string,
  app: AppEnrollmentApp,
): Effect.Effect<{ enrolled: boolean }, AppEnrollmentDbError, Db> =>
  Effect.gen(function* () {
    const existing = yield* getActiveEnrollment(accountId, app);
    if (existing) return { enrolled: false };

    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);
    yield* Effect.tryPromise({
      try: () =>
        db.insert(appEnrollments).values({
          id: enrollmentId(),
          accountId,
          app,
          joinedAt: now,
          leftAt: null,
        }),
      catch: (cause) => new AppEnrollmentDbError({ cause }),
    });
    metricAppEnrollmentJoined(app);
    return { enrolled: true };
  });

/**
 * Closes the active enrollment row for `accountId` × `app` by setting
 * `left_at = now`. Idempotent — calling twice with no active row is a no-op.
 *
 * Called by:
 *   1. Pulse's leave-Pulse flow via the ARC `/internal/app-enrollment/leave`
 *      callback, after Pulse's local soft-delete commits.
 *   2. The OSN full-account-delete flow when fanning out (records the close
 *      in the same transaction as the OSN soft-delete).
 */
export const leaveApp = (
  accountId: string,
  app: AppEnrollmentApp,
): Effect.Effect<{ closed: boolean }, AppEnrollmentDbError, Db> =>
  Effect.gen(function* () {
    const existing = yield* getActiveEnrollment(accountId, app);
    if (!existing) {
      // Idempotent — emit an "ok" metric so we can still tell signal from noise.
      metricAppEnrollmentLeft(app, "ok");
      return { closed: false };
    }
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);
    yield* Effect.tryPromise({
      try: () =>
        db.update(appEnrollments).set({ leftAt: now }).where(eq(appEnrollments.id, existing.id)),
      catch: (cause) => {
        metricAppEnrollmentLeft(app, "error");
        return new AppEnrollmentDbError({ cause });
      },
    });
    metricAppEnrollmentLeft(app, "ok");
    return { closed: true };
  });

/**
 * Returns the list of app identifiers the account is currently enrolled in.
 * Used by the Flow A (full-OSN delete) to know which downstream services
 * to fan out to.
 */
export const listActiveApps = (
  accountId: string,
): Effect.Effect<AppEnrollmentApp[], AppEnrollmentDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ app: appEnrollments.app })
          .from(appEnrollments)
          .where(and(eq(appEnrollments.accountId, accountId), isNull(appEnrollments.leftAt))),
      catch: (cause) => new AppEnrollmentDbError({ cause }),
    });
    const seen = new Set<AppEnrollmentApp>();
    for (const row of rows) {
      if (row.app === "pulse" || row.app === "zap") {
        seen.add(row.app);
      }
    }
    return [...seen];
  });
