import { Schema } from "effect";

// ── Parsed sheet shapes ───────────────────────────────────────────────────────

export const PaletteSwatch = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
});
export type PaletteSwatch = Schema.Schema.Type<typeof PaletteSwatch>;

export const ParsedEvent = Schema.Struct({
  name: Schema.String,
  startAt: Schema.String,
  endAt: Schema.String,
  timezone: Schema.String,
  location: Schema.String,
  address: Schema.NullOr(Schema.String),
  dressCodeDescription: Schema.NullOr(Schema.String),
  dressCodePalette: Schema.Array(PaletteSwatch),
  pinterestUrl: Schema.NullOr(Schema.String),
  mapsUrl: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
});
export type ParsedEvent = Schema.Schema.Type<typeof ParsedEvent>;

export const ParsedGuest = Schema.Struct({
  firstName: Schema.String,
  lastName: Schema.String,
  /** Names of events the guest is invited to. */
  eventNames: Schema.Array(Schema.String),
});
export type ParsedGuest = Schema.Schema.Type<typeof ParsedGuest>;

export const ParsedFamily = Schema.Struct({
  familyName: Schema.String,
  guests: Schema.Array(ParsedGuest),
});
export type ParsedFamily = Schema.Schema.Type<typeof ParsedFamily>;

// ── Diff plan ─────────────────────────────────────────────────────────────────

export const EventCreate = Schema.Struct({
  id: Schema.String,
  event: ParsedEvent,
});
export type EventCreate = Schema.Schema.Type<typeof EventCreate>;

export const EventUpdate = Schema.Struct({
  id: Schema.String,
  event: ParsedEvent,
});
export type EventUpdate = Schema.Schema.Type<typeof EventUpdate>;

export const EventRemove = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type EventRemove = Schema.Schema.Type<typeof EventRemove>;

export const FamilyCreate = Schema.Struct({
  id: Schema.String,
  publicId: Schema.String,
  familyName: Schema.String,
});
export type FamilyCreate = Schema.Schema.Type<typeof FamilyCreate>;

export const FamilyRemove = Schema.Struct({
  id: Schema.String,
  familyName: Schema.String,
});
export type FamilyRemove = Schema.Schema.Type<typeof FamilyRemove>;

export const GuestCreate = Schema.Struct({
  id: Schema.String,
  familyId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  sortOrder: Schema.Number,
});
export type GuestCreate = Schema.Schema.Type<typeof GuestCreate>;

export const GuestUpdate = Schema.Struct({
  id: Schema.String,
  lastName: Schema.String,
  sortOrder: Schema.Number,
});
export type GuestUpdate = Schema.Schema.Type<typeof GuestUpdate>;

export const GuestRemove = Schema.Struct({
  id: Schema.String,
  firstName: Schema.String,
});
export type GuestRemove = Schema.Schema.Type<typeof GuestRemove>;

export const EventLink = Schema.Struct({
  guestId: Schema.String,
  eventId: Schema.String,
});
export type EventLink = Schema.Schema.Type<typeof EventLink>;

export const ImportPlan = Schema.Struct({
  eventCreates: Schema.Array(EventCreate),
  eventUpdates: Schema.Array(EventUpdate),
  eventRemoves: Schema.Array(EventRemove),
  familyCreates: Schema.Array(FamilyCreate),
  familyRemoves: Schema.Array(FamilyRemove),
  guestCreates: Schema.Array(GuestCreate),
  guestUpdates: Schema.Array(GuestUpdate),
  guestRemoves: Schema.Array(GuestRemove),
  eventLinkCreates: Schema.Array(EventLink),
  eventLinkRemoves: Schema.Array(EventLink),
  warnings: Schema.Array(Schema.String),
});
export type ImportPlan = Schema.Schema.Type<typeof ImportPlan>;

export const ImportSummary = Schema.Struct({
  importId: Schema.String,
  eventsCreated: Schema.Number,
  eventsUpdated: Schema.Number,
  eventsRemoved: Schema.Number,
  familiesCreated: Schema.Number,
  familiesRemoved: Schema.Number,
  guestsCreated: Schema.Number,
  guestsUpdated: Schema.Number,
  guestsRemoved: Schema.Number,
  warnings: Schema.Array(Schema.String),
});
export type ImportSummary = Schema.Schema.Type<typeof ImportSummary>;

// ── Request bodies ────────────────────────────────────────────────────────────

export const PreviewBody = Schema.Struct({
  eventsCsv: Schema.String,
  guestsCsv: Schema.String,
});
export type PreviewBody = Schema.Schema.Type<typeof PreviewBody>;

export const ApplyBody = Schema.Struct({
  importId: Schema.String,
});
export type ApplyBody = Schema.Schema.Type<typeof ApplyBody>;

export const RevertBody = Schema.Struct({
  importId: Schema.String,
});
export type RevertBody = Schema.Schema.Type<typeof RevertBody>;
