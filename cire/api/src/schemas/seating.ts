import { Schema } from "effect";

/** Longest table name, after trimming. */
export const MAX_TABLE_NAME_CHARS = 80;
/** Largest table. A long banquet table or a head table is the case at the top. */
export const MAX_TABLE_CAPACITY = 100;
/** Most tables one event holds — and so the longest reorder a request sends. */
export const MAX_TABLES_PER_EVENT = 100;

/** A name with something in it once trimmed, and no longer than the cap then. */
const TableName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_TABLE_NAME_CHARS),
);

const Capacity = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: MAX_TABLE_CAPACITY }),
);

/** A row id as the API mints them: word characters and hyphens only, which
 *  keeps an id safe inside the JSON path the reorder reads it through. */
const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[\w-]+$/),
);

export const CreateTableBody = Schema.Struct({ name: TableName, capacity: Capacity });
export type CreateTableBody = Schema.Schema.Type<typeof CreateTableBody>;

/** A partial patch: an absent field is left as it is. */
export const UpdateTableBody = Schema.Struct({
  name: Schema.optional(TableName),
  capacity: Schema.optional(Capacity),
});
export type UpdateTableBody = Schema.Schema.Type<typeof UpdateTableBody>;

/** The event's tables in their new order. */
export const ReorderTablesBody = Schema.Struct({
  orderedIds: Schema.Array(Id).check(Schema.isMaxLength(MAX_TABLES_PER_EVENT)),
});
export type ReorderTablesBody = Schema.Schema.Type<typeof ReorderTablesBody>;

/** Where a guest sits at an event: a table, or `null` for nowhere. */
export const SeatGuestBody = Schema.Struct({ tableId: Schema.NullOr(Id) });
export type SeatGuestBody = Schema.Schema.Type<typeof SeatGuestBody>;
