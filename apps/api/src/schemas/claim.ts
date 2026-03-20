import { Schema } from "effect"

// ── Request bodies ────────────────────────────────────────────────────────────

export const ClaimBody = Schema.Struct({
  code: Schema.NonEmptyString,
})
export type ClaimBody = Schema.Schema.Type<typeof ClaimBody>

// ── Response shapes ───────────────────────────────────────────────────────────

export const EventSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  date: Schema.String,
  location: Schema.String,
  description: Schema.String,
})
export type EventSummary = Schema.Schema.Type<typeof EventSummary>

export const ClaimResponse = Schema.Struct({
  guestName: Schema.String,
  events: Schema.Array(EventSummary),
})
export type ClaimResponse = Schema.Schema.Type<typeof ClaimResponse>

export const GuestWithEvents = Schema.Struct({
  name: Schema.String,
  code: Schema.String,
  claimed: Schema.Boolean,
  events: Schema.Array(Schema.String),
})
export type GuestWithEvents = Schema.Schema.Type<typeof GuestWithEvents>
