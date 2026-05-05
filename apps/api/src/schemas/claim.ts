import { Schema } from "effect";

// ── Request bodies ────────────────────────────────────────────────────────────

export const ClaimBody = Schema.Struct({
  publicId: Schema.NonEmptyString,
});
export type ClaimBody = Schema.Schema.Type<typeof ClaimBody>;

// ── Response shapes ───────────────────────────────────────────────────────────

export const EventSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  date: Schema.String,
  location: Schema.String,
  description: Schema.String,
});
export type EventSummary = Schema.Schema.Type<typeof EventSummary>;

export const FamilyMember = Schema.Struct({
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
  publicId: Schema.String,
  familyName: Schema.String,
  members: Schema.Array(FamilyMember),
  events: Schema.Array(EventSummary),
  rsvps: Schema.Array(RsvpSummary),
});
export type ClaimResponse = Schema.Schema.Type<typeof ClaimResponse>;

export const OrganiserGuestRow = Schema.Struct({
  publicId: Schema.String,
  familyName: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  events: Schema.Array(Schema.String),
});
export type OrganiserGuestRow = Schema.Schema.Type<typeof OrganiserGuestRow>;
