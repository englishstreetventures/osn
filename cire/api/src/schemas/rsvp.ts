import { Schema } from "effect";

// S-L2: free-text + array bounds. `dietary` is stored unbounded otherwise, and
// the batch array had no length cap — a single request could push an arbitrary
// payload. 500 chars is generous for dietary notes; 200 RSVPs comfortably
// covers the largest realistic family-batch submit.
const MAX_DIETARY_CHARS = 500;
const MAX_RSVP_BATCH = 200;

// Privacy-notice / consent-copy version the dietary opt-in agrees to. The
// server stamps THIS value (never a client-supplied one) into
// `rsvps.dietary_consent_version`, so the stored Art. 9(2)(a) evidence always
// pins the copy actually shown. Bump (date-stamped, matching the wiki
// `last-reviewed` convention) whenever the consent wording materially changes.
// See [[wiki/compliance/dpia/cire-guest-data]] → C-H2.
export const DIETARY_CONSENT_VERSION = "2026-06-17";

// Free-text dietary field, capped at MAX_DIETARY_CHARS.
const DietaryText = Schema.String.pipe(Schema.maxLength(MAX_DIETARY_CHARS));

// Per-RSVP shape shared by the single + bulk bodies. `dietaryConsent` is the
// guest's explicit opt-in for the special-category dietary field; the route
// rejects (422) any non-empty `dietary` submitted without it.
const RsvpItem = Schema.Struct({
  guestId: Schema.NonEmptyString,
  eventId: Schema.NonEmptyString,
  status: Schema.Literal("attending", "declined", "maybe"),
  dietary: Schema.optionalWith(DietaryText, { default: () => "" }),
  dietaryConsent: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});

export const RsvpBody = RsvpItem;
export type RsvpBody = Schema.Schema.Type<typeof RsvpBody>;

export const BulkRsvpBody = Schema.Struct({
  rsvps: Schema.Array(RsvpItem).pipe(Schema.maxItems(MAX_RSVP_BATCH)),
});
export type BulkRsvpBody = Schema.Schema.Type<typeof BulkRsvpBody>;

export const RsvpRecord = Schema.Struct({
  guestId: Schema.String,
  eventId: Schema.String,
  status: Schema.String,
  dietary: Schema.String,
});
export type RsvpRecord = Schema.Schema.Type<typeof RsvpRecord>;
