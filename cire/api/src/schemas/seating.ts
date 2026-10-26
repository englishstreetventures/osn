import { Schema } from "effect";

/** Longest table or plan name, after trimming. */
export const MAX_TABLE_NAME_CHARS = 80;
/** Largest table. A long banquet table or a head table is the case at the top. */
export const MAX_TABLE_CAPACITY = 100;
/** Most tables one plan holds — and so the longest reorder a request sends,
 *  and the most tables one copy of a plan writes. */
export const MAX_TABLES_PER_PLAN = 100;
/** Most seating rows — tables and seats — one wedding may copy into new plans
 *  in one UTC day. D1 bills a row written for the row and one for each index
 *  it enters, four for a table or a seat, so a wedding's copies write at most
 *  about 12,000 rows a day, an eighth of the account's 100,000 on Workers
 *  Free. A full plan for a 1,000-guest event is about 1,100 rows, so a couple
 *  can copy one twice a day, and a smaller plan more often. */
export const MAX_COPIED_ROWS_PER_DAY = 3000;
/** Most seating plans one event holds. Each copy writes up to 100 tables and
 *  a seat for every guest the event invites, so the cap bounds what one
 *  event's plans cost the database. */
export const MAX_PLANS_PER_EVENT = 5;

/** A name with something in it once trimmed, and no longer than the cap then. */
const Name = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TABLE_NAME_CHARS));

const Capacity = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: MAX_TABLE_CAPACITY }),
);

/** A row id as the API mints them: word characters and hyphens only, which
 *  keeps an id safe inside the JSON path the reorder and the copy read it
 *  through. */
const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[\w-]+$/),
);

export const CreateTableBody = Schema.Struct({ name: Name, capacity: Capacity });
export type CreateTableBody = Schema.Schema.Type<typeof CreateTableBody>;

/** A partial patch: an absent field is left as it is. */
export const UpdateTableBody = Schema.Struct({
  name: Schema.optional(Name),
  capacity: Schema.optional(Capacity),
});
export type UpdateTableBody = Schema.Schema.Type<typeof UpdateTableBody>;

/** The plan's tables in their new order. */
export const ReorderTablesBody = Schema.Struct({
  orderedIds: Schema.Array(Id).check(Schema.isMaxLength(MAX_TABLES_PER_PLAN)),
});
export type ReorderTablesBody = Schema.Schema.Type<typeof ReorderTablesBody>;

/** Where a guest sits in a plan: a table, or `null` for nowhere. */
export const SeatGuestBody = Schema.Struct({ tableId: Schema.NullOr(Id) });
export type SeatGuestBody = Schema.Schema.Type<typeof SeatGuestBody>;

/** A new plan: blank, or a copy of another plan of the same event. */
export const CreatePlanBody = Schema.Struct({ name: Name, copyFrom: Schema.optional(Id) });
export type CreatePlanBody = Schema.Schema.Type<typeof CreatePlanBody>;

export const RenamePlanBody = Schema.Struct({ name: Name });
export type RenamePlanBody = Schema.Schema.Type<typeof RenamePlanBody>;

/** The plan the event's venue file reads. */
export const SelectPlanBody = Schema.Struct({ planId: Id });
export type SelectPlanBody = Schema.Schema.Type<typeof SelectPlanBody>;

/** The chart read's query: the plan to read, or none for the selected plan. */
export const ChartQuery = Schema.Struct({ plan: Schema.optional(Id) });
export type ChartQuery = Schema.Schema.Type<typeof ChartQuery>;
