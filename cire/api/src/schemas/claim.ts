import { Schema } from "effect";

// ── Request bodies ────────────────────────────────────────────────────────────

export const ClaimBody = Schema.Struct({
  publicId: Schema.NonEmptyString,
});
export type ClaimBody = Schema.Schema.Type<typeof ClaimBody>;

// ── Response shapes ───────────────────────────────────────────────────────────

export const DressSwatch = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
});
export type DressSwatch = Schema.Schema.Type<typeof DressSwatch>;

export const EventSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  // Deprecated: prefer startAt / endAt. Kept for one release while consumers
  // migrate.
  date: Schema.String,
  // Deprecated: prefer address. Kept while organiser portal still writes it.
  location: Schema.String,
  description: Schema.String,
  startAt: Schema.String,
  endAt: Schema.String,
  timezone: Schema.String,
  address: Schema.NullOr(Schema.String),
  dressCodeDescription: Schema.NullOr(Schema.String),
  dressCodePalette: Schema.NullOr(Schema.Array(DressSwatch)),
  pinterestUrl: Schema.NullOr(Schema.String),
  mapsUrl: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
});
export type EventSummary = Schema.Schema.Type<typeof EventSummary>;

export const FamilyMember = Schema.Struct({
  guestId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  eventIds: Schema.Array(Schema.String),
});
export type FamilyMember = Schema.Schema.Type<typeof FamilyMember>;

export const RsvpSummary = Schema.Struct({
  guestId: Schema.String,
  eventId: Schema.String,
  status: Schema.String,
  dietary: Schema.String,
});
export type RsvpSummary = Schema.Schema.Type<typeof RsvpSummary>;

export const ClaimResponse = Schema.Struct({
  // Internal/operational. The frontend uses the session cookie for follow-up
  // calls and never echoes this back, but exposing it keeps `/api/claim` a
  // useful self-describing payload for organiser tooling and integration tests.
  familyId: Schema.String,
  publicId: Schema.String,
  familyName: Schema.String,
  members: Schema.Array(FamilyMember),
  events: Schema.Array(EventSummary),
  rsvps: Schema.Array(RsvpSummary),
});
export type ClaimResponse = Schema.Schema.Type<typeof ClaimResponse>;

export const OrganiserGuestRow = Schema.Struct({
  guestId: Schema.String,
  publicId: Schema.String,
  familyName: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  events: Schema.Array(Schema.String),
});
export type OrganiserGuestRow = Schema.Schema.Type<typeof OrganiserGuestRow>;
