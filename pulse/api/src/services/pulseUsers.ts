import { pulseUsers, type PulseProfile } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { jsonEachIn } from "@shared/db-utils";
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

export type AttendanceVisibility = PulseProfile["attendanceVisibility"];

const AttendanceVisibilitySchema = Schema.Literal("connections", "no_one");

const UpdateSettingsSchema = Schema.Struct({
  attendanceVisibility: Schema.optional(AttendanceVisibilitySchema),
});

/**
 * Returns the Pulse user row for this profileId, or null if none exists yet.
 * Readers should fall back to the default when null is returned rather than
 * eagerly inserting — writes happen via upsertPulseProfile.
 */
export const getPulseProfile = (
  profileId: string,
): Effect.Effect<PulseProfile | null, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<PulseProfile[]> =>
        db.select().from(pulseUsers).where(eq(pulseUsers.profileId, profileId)).limit(1) as Promise<
          PulseProfile[]
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
  profileId: string,
): Effect.Effect<AttendanceVisibility, DatabaseError, Db> =>
  Effect.gen(function* () {
    const row = yield* getPulseProfile(profileId);
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
 *
 * osn-tracker#591: `listRsvps`' `filterByAttendeePrivacy` calls this with
 * every distinct attendee on the page (up to 200 — see `rsvps.ts`'s
 * `fetchLimit`), which crossed D1's 100-bound-parameter cap on a plain
 * `inArray`. `jsonEachIn` binds the id list as one JSON parameter instead
 * of one per id, so the same query works whether the page holds 20
 * attendees or 200.
 */
export const getAttendanceVisibilityBatch = (
  profileIds: string[],
): Effect.Effect<Map<string, AttendanceVisibility>, DatabaseError, Db> =>
  Effect.gen(function* () {
    const result = new Map<string, AttendanceVisibility>();
    if (profileIds.length === 0) return result;

    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<Pick<PulseProfile, "profileId" | "attendanceVisibility">[]> =>
        db
          .select({
            profileId: pulseUsers.profileId,
            attendanceVisibility: pulseUsers.attendanceVisibility,
          })
          .from(pulseUsers)
          .where(inArray(pulseUsers.profileId, jsonEachIn(profileIds))) as Promise<
          Pick<PulseProfile, "profileId" | "attendanceVisibility">[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Seed defaults for every requested id so callers never need to
    // check for missing entries — ids without a row fall back to the
    // default visibility.
    for (const id of profileIds) result.set(id, DEFAULT_ATTENDANCE_VISIBILITY);
    for (const row of rows) result.set(row.profileId, row.attendanceVisibility);
    return result;
  });

/**
 * Ensures a pulse_users row exists for this profileId. Idempotent — uses
 * INSERT ... ON CONFLICT DO NOTHING. Safe to call on every write.
 */
export const ensurePulseProfile = (profileId: string): Effect.Effect<void, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db
          .insert(pulseUsers)
          .values({ profileId, createdAt: now, updatedAt: now })
          .onConflictDoNothing(),
      catch: (cause) => new DatabaseError({ cause }),
    });
  });

/**
 * Updates the caller's Pulse-side settings. Creates the row if missing.
 */
export const updateSettings = (
  profileId: string,
  data: unknown,
): Effect.Effect<PulseProfile, ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(UpdateSettingsSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    yield* ensurePulseProfile(profileId);

    const { db } = yield* Db;
    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(pulseUsers)
          .set({ ...validated, updatedAt: now })
          .where(eq(pulseUsers.profileId, profileId)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const rows = yield* Effect.tryPromise({
      try: (): Promise<PulseProfile[]> =>
        db.select().from(pulseUsers).where(eq(pulseUsers.profileId, profileId)).limit(1) as Promise<
          PulseProfile[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    // ensurePulseProfile just ran, so the row must exist.
    return rows[0]!;
  }).pipe(Effect.withSpan("pulse.settings.update"));
