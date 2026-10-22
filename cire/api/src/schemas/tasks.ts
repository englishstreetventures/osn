import { Effect, Schema } from "effect";

import { TIMEFRAME_BUCKETS } from "../lib/checklist-buckets";
import type { TimeframeBucket } from "../lib/checklist-buckets";
import { isKnownTimeZone, parseWallTime } from "../lib/event-time";
import { MAX_RUN_OFFSET_MINUTES } from "../lib/run-time";

export const MAX_TITLE_CHARS = 200;
const MAX_NOTES_CHARS = 2000;

// The bucket enum, sourced from the single list so the two never drift.
const bucketKeys = TIMEFRAME_BUCKETS.map((b) => b.key) as [TimeframeBucket, ...TimeframeBucket[]];
const TimeframeBucketSchema = Schema.Literals(bucketKeys);

const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TITLE_CHARS));
const Notes = Schema.String.check(Schema.isMaxLength(MAX_NOTES_CHARS));
// A loose date string (YYYY-MM-DD from the date input). Stored as text; null clears it.
const DueAt = Schema.String.check(Schema.isMaxLength(32));
const Status = Schema.Literals(["open", "done"]);

// Create: title + bucket required; notes/dueAt optional, absent → null.
export const CreateTaskBody = Schema.Struct({
  title: Title,
  timeframeBucket: TimeframeBucketSchema,
  notes: Schema.NullOr(Notes).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  dueAt: Schema.NullOr(DueAt).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
});
export type CreateTaskBody = Schema.Schema.Type<typeof CreateTaskBody>;

// A date and time from the editor, `YYYY-MM-DDTHH:MM` (seconds optional). Any
// offset or `Z` is read past, never believed: the zone it is read in is the
// one the patch names, or the event's.
const WallClock = Schema.String.check(
  Schema.makeFilter((s: string) =>
    s.length <= 32 && parseWallTime(s) !== null ? undefined : "Not a date and time",
  ),
);
// A real IANA zone, stored as sent. The fixed-offset spellings `Intl` accepts
// ("+10:00", "UTC+10") are refused: they never move with daylight saving.
const RunTimezone = Schema.String.check(
  Schema.makeFilter((s: string) =>
    s.length <= 64 && isKnownTimeZone(s) ? undefined : "Not a time zone",
  ),
);
// An event id; whether it is one of the task's wedding's is the service's to say.
const RunEventId = Schema.NonEmptyString.check(Schema.isMaxLength(64));
// Whole minutes from the event's start, negative before it, within a day.
const RunOffsetMinutes = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: -MAX_RUN_OFFSET_MINUTES, maximum: MAX_RUN_OFFSET_MINUTES }),
);

/**
 * A task's whole run time, replaced at once, so no write can leave half of
 * one (a time without its zone, a link without its offset, a link beside a
 * fixed time):
 *  - `fixed` — a date and time in `timezone`, unlinked;
 *  - `offset` — linked to `eventId`, `offsetMinutes` from its start;
 *  - `clock` — linked to `eventId` at a date and time on the event's clock,
 *    which the service turns into an offset from the event's start.
 * A key the kind does not take is ignored.
 */
export const RunTimePatch = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fixed"), at: WallClock, timezone: RunTimezone }),
  Schema.Struct({
    kind: Schema.Literal("offset"),
    eventId: RunEventId,
    offsetMinutes: RunOffsetMinutes,
  }),
  Schema.Struct({ kind: Schema.Literal("clock"), eventId: RunEventId, at: WallClock }),
]);
export type RunTimePatch = Schema.Schema.Type<typeof RunTimePatch>;

// Update: every field optional (a partial patch). An absent field is left as-is;
// an explicit null on notes/dueAt clears it, and on runTime makes the task
// untimed.
export const UpdateTaskBody = Schema.Struct({
  title: Schema.optional(Title),
  timeframeBucket: Schema.optional(TimeframeBucketSchema),
  notes: Schema.optional(Schema.NullOr(Notes)),
  dueAt: Schema.optional(Schema.NullOr(DueAt)),
  status: Schema.optional(Status),
  sortOrder: Schema.optional(Schema.Number),
  runTime: Schema.optional(Schema.NullOr(RunTimePatch)),
});
export type UpdateTaskBody = Schema.Schema.Type<typeof UpdateTaskBody>;

// A task holder's seat id (`wedding_hosts.id`), from the path of the routes
// that put a seat on a task or take it off. Bounded well past a seat id's
// length; whether the seat is one of this wedding's is the service's to say.
export const AssigneeHostId = Schema.NonEmptyString.check(Schema.isMaxLength(64));

// Reorder: the new left-to-right order of task ids within one bucket.
export const ReorderTasksBody = Schema.Struct({
  timeframeBucket: TimeframeBucketSchema,
  orderedIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(500)),
});
export type ReorderTasksBody = Schema.Schema.Type<typeof ReorderTasksBody>;

// Apply a checklist template: the keys of the items the couple ticked. A key
// the couple removed earlier is their confirmation to bring it back. Bounded
// well past any template's length; the route checks each key is the
// template's.
export const ApplyTemplateBody = Schema.Struct({
  items: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(64))).check(
    Schema.isMaxLength(100),
  ),
});
export type ApplyTemplateBody = Schema.Schema.Type<typeof ApplyTemplateBody>;
