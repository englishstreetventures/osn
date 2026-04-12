import { pulseUsers, type PulseUser } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { eq, inArray } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

/**
 * Pulse users default to "connections" on first read. This is the Pulse-side
 * counterpart to the OSN user row and is created lazily when a user takes
 * any write action (RSVP, event creation, settings update).
 */
export const DEFAULT_ATTENDANCE_VISIBILITY = "connections" as const;

export type AttendanceVisibility = PulseUser["attendanceVisibility"];

const AttendanceVisibilitySchema = Schema.Literal("connections", "no_one");

const UpdateSettingsSchema = Schema.Struct({
  attendanceVisibility: Schema.optional(AttendanceVisibilitySchema),
});

/**
 * Returns the Pulse user row for this userId, or null if none exists yet.
 * Readers should fall back to the default when null is returned rather than
 * eagerly inserting — writes happen via upsertPulseUser.
 */
export const getPulseUser = (userId: string): Effect.Effect<PulseUser | null, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<PulseUser[]> =>
        db.select().from(pulseUsers).where(eq(pulseUsers.userId, userId)).limit(1) as Promise<
          PulseUser[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    return rows[0] ?? null;
  });

/**
 * Returns the user's attendanceVisibility, falling back to the default
 * when no Pulse user row exists yet. Used by the RSVP visibility filter.
 *
 * For batch lookups, prefer `getAttendanceVisibilityBatch` — it collapses
 * N queries into one and is what the RSVP filter uses on the hot path.
 */
export const getAttendanceVisibility = (
  userId: string,
): Effect.Effect<AttendanceVisibility, DatabaseError, Db> =>
  Effect.gen(function* () {
    const row = yield* getPulseUser(userId);
    return row?.attendanceVisibility ?? DEFAULT_ATTENDANCE_VISIBILITY;
  });

/**
 * Batch-fetch attendance visibility for many users in a single query.
 * Missing rows fall back to `DEFAULT_ATTENDANCE_VISIBILITY` — the returned
 * Map contains an entry for every id in the input array.
 *
 * This is the canonical helper for the RSVP visibility filter — it
 * collapses an N+1 ("yield* getAttendanceVisibility(id) in a for loop")
 * into a single SELECT, which matters for popular events where the
 * limit clause can return up to 200 rows per request.
 */
export const getAttendanceVisibilityBatch = (
  userIds: string[],
): Effect.Effect<Map<string, AttendanceVisibility>, DatabaseError, Db> =>
  Effect.gen(function* () {
    const result = new Map<string, AttendanceVisibility>();
    if (userIds.length === 0) return result;

    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<Pick<PulseUser, "userId" | "attendanceVisibility">[]> =>
        db
          .select({
            userId: pulseUsers.userId,
            attendanceVisibility: pulseUsers.attendanceVisibility,
          })
          .from(pulseUsers)
          .where(inArray(pulseUsers.userId, userIds)) as Promise<
          Pick<PulseUser, "userId" | "attendanceVisibility">[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Seed defaults for every requested id so callers never need to
    // check for missing entries — ids without a row fall back to the
    // default visibility.
    for (const id of userIds) result.set(id, DEFAULT_ATTENDANCE_VISIBILITY);
    for (const row of rows) result.set(row.userId, row.attendanceVisibility);
    return result;
  });

/**
 * Ensures a pulse_users row exists for this userId. Idempotent — uses
 * INSERT ... ON CONFLICT DO NOTHING. Safe to call on every write.
 */
export const ensurePulseUser = (userId: string): Effect.Effect<void, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db
          .insert(pulseUsers)
          .values({ userId, createdAt: now, updatedAt: now })
          .onConflictDoNothing(),
      catch: (cause) => new DatabaseError({ cause }),
    });
  });

/**
 * Updates the caller's Pulse-side settings. Creates the row if missing.
 */
export const updateSettings = (
  userId: string,
  data: unknown,
): Effect.Effect<PulseUser, ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(UpdateSettingsSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    yield* ensurePulseUser(userId);

    const { db } = yield* Db;
    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(pulseUsers)
          .set({ ...validated, updatedAt: now })
          .where(eq(pulseUsers.userId, userId)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const rows = yield* Effect.tryPromise({
      try: (): Promise<PulseUser[]> =>
        db.select().from(pulseUsers).where(eq(pulseUsers.userId, userId)).limit(1) as Promise<
          PulseUser[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    // ensurePulseUser just ran, so the row must exist.
    return rows[0]!;
  }).pipe(Effect.withSpan("pulse.settings.update"));
