import { Schema } from "effect";

// S-L2: free-text + array bounds. `dietary` is stored unbounded otherwise, and
// the batch array had no length cap — a single request could push an arbitrary
// payload. 500 chars is generous for dietary notes; 200 RSVPs comfortably
// covers the largest realistic family-batch submit.
const MAX_DIETARY_CHARS = 500;
const MAX_RSVP_BATCH = 200;

// Free-text dietary field, capped at MAX_DIETARY_CHARS.
const DietaryText = Schema.String.pipe(Schema.maxLength(MAX_DIETARY_CHARS));

export const RsvpBody = Schema.Struct({
  guestId: Schema.NonEmptyString,
  eventId: Schema.NonEmptyString,
  status: Schema.Literal("attending", "declined", "maybe"),
  dietary: Schema.optionalWith(DietaryText, { default: () => "" }),
});
export type RsvpBody = Schema.Schema.Type<typeof RsvpBody>;

export const BulkRsvpBody = Schema.Struct({
  rsvps: Schema.Array(
    Schema.Struct({
      guestId: Schema.NonEmptyString,
      eventId: Schema.NonEmptyString,
      status: Schema.Literal("attending", "declined", "maybe"),
      dietary: Schema.optionalWith(DietaryText, { default: () => "" }),
    }),
  ).pipe(Schema.maxItems(MAX_RSVP_BATCH)),
});
export type BulkRsvpBody = Schema.Schema.Type<typeof BulkRsvpBody>;

export const RsvpRecord = Schema.Struct({
  guestId: Schema.String,
  eventId: Schema.String,
  status: Schema.String,
  dietary: Schema.String,
});
export type RsvpRecord = Schema.Schema.Type<typeof RsvpRecord>;
