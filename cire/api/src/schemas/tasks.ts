import { Effect, Schema } from "effect";

import { TIMEFRAME_BUCKETS } from "../lib/checklist-buckets";
import type { TimeframeBucket } from "../lib/checklist-buckets";

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

// Update: every field optional (a partial patch). An absent field is left as-is;
// an explicit null on notes/dueAt clears it.
export const UpdateTaskBody = Schema.Struct({
  title: Schema.optional(Title),
  timeframeBucket: Schema.optional(TimeframeBucketSchema),
  notes: Schema.optional(Schema.NullOr(Notes)),
  dueAt: Schema.optional(Schema.NullOr(DueAt)),
  status: Schema.optional(Status),
  sortOrder: Schema.optional(Schema.Number),
});
export type UpdateTaskBody = Schema.Schema.Type<typeof UpdateTaskBody>;

// Assign: the seat (`wedding_hosts.id`) to hand the task to, or null for
// nobody. Required, so a body that names neither is a 400 rather than a silent
// unassign. Bounded well past a seat id's length; whether the seat is one of
// this wedding's is the service's to say.
export const AssignTaskBody = Schema.Struct({
  assignedHostId: Schema.NullOr(Schema.NonEmptyString.check(Schema.isMaxLength(64))),
});
export type AssignTaskBody = Schema.Schema.Type<typeof AssignTaskBody>;

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
