import { Schema } from "effect";

import { TIMEFRAME_BUCKETS } from "../lib/checklist-buckets";

const MAX_TITLE_CHARS = 200;
const MAX_NOTES_CHARS = 2000;

// The bucket enum, sourced from the single list so the two never drift.
const bucketKeys = TIMEFRAME_BUCKETS.map((b) => b.key) as [string, ...string[]];
const TimeframeBucketSchema = Schema.Literal(...bucketKeys);

const Title = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_TITLE_CHARS));
const Notes = Schema.String.pipe(Schema.maxLength(MAX_NOTES_CHARS));
// A loose date string (YYYY-MM-DD from the date input). Stored as text; null clears it.
const DueAt = Schema.String.pipe(Schema.maxLength(32));
const Status = Schema.Literal("open", "done");

// Create: title + bucket required; notes/dueAt optional, absent → null.
export const CreateTaskBody = Schema.Struct({
  title: Title,
  timeframeBucket: TimeframeBucketSchema,
  notes: Schema.optionalWith(Schema.NullOr(Notes), { default: () => null }),
  dueAt: Schema.optionalWith(Schema.NullOr(DueAt), { default: () => null }),
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

// Reorder: the new left-to-right order of task ids within one bucket.
export const ReorderTasksBody = Schema.Struct({
  timeframeBucket: TimeframeBucketSchema,
  orderedIds: Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(500)),
});
export type ReorderTasksBody = Schema.Schema.Type<typeof ReorderTasksBody>;
