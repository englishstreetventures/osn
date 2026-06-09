import { Schema } from "effect";

export const RsvpBody = Schema.Struct({
  guestId: Schema.NonEmptyString,
  eventId: Schema.NonEmptyString,
  status: Schema.Literal("attending", "declined", "maybe"),
  dietary: Schema.optionalWith(Schema.String, { default: () => "" }),
});
export type RsvpBody = Schema.Schema.Type<typeof RsvpBody>;

export const BulkRsvpBody = Schema.Struct({
  rsvps: Schema.Array(
    Schema.Struct({
      guestId: Schema.NonEmptyString,
      eventId: Schema.NonEmptyString,
      status: Schema.Literal("attending", "declined", "maybe"),
      dietary: Schema.optionalWith(Schema.String, { default: () => "" }),
    }),
  ),
});
export type BulkRsvpBody = Schema.Schema.Type<typeof BulkRsvpBody>;

export const RsvpRecord = Schema.Struct({
  guestId: Schema.String,
  eventId: Schema.String,
  status: Schema.String,
  dietary: Schema.String,
});
export type RsvpRecord = Schema.Schema.Type<typeof RsvpRecord>;
