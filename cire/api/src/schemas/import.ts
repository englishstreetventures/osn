import { Schema } from "effect";

// ── Parsed sheet shapes ───────────────────────────────────────────────────────

export const PaletteSwatch = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
});
export type PaletteSwatch = Schema.Schema.Type<typeof PaletteSwatch>;

export const ParsedEvent = Schema.Struct({
  /**
   * Optional stable id, honoured from the `Event ID` fidelity column when a
   * `?fidelity=full` export is re-imported (E2). Absent (the default for a
   * hand-authored or standard-export sheet) ⇒ the diff matches by name, exactly
   * today's behaviour. Present ⇒ the diff matches by id, so a rename is an
   * update rather than remove+create.
   */
  id: Schema.optional(Schema.String),
  name: Schema.String,
  startAt: Schema.String,
  /** Optional in the sheet; "" ⇒ no stated end (matches the DB's "" sentinel). */
  endAt: Schema.String,
  timezone: Schema.String,
  /** Optional venue name; only used as the address fallback at import-write time. */
  location: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  dressCodeDescription: Schema.NullOr(Schema.String),
  dressCodePalette: Schema.Array(PaletteSwatch),
  pinterestUrl: Schema.NullOr(Schema.String),
  mapsUrl: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
});
export type ParsedEvent = Schema.Schema.Type<typeof ParsedEvent>;

export const ParsedGuest = Schema.Struct({
  /** Optional stable id from the `Guest ID` fidelity column (E2). Absent ⇒
   *  match by `(family, firstName)` as today; present ⇒ match by id, so a
   *  first-name fix is an update, not remove+create. */
  id: Schema.optional(Schema.String),
  firstName: Schema.String,
  lastName: Schema.String,
  /** Optional informal name for the single-guest greeting; null ⇒ use firstName. */
  nickname: Schema.NullOr(Schema.String),
  /** Names of events the guest is invited to. */
  eventNames: Schema.Array(Schema.String),
});
export type ParsedGuest = Schema.Schema.Type<typeof ParsedGuest>;

export const ParsedFamily = Schema.Struct({
  /** Optional stable id — the internal family id from the full-fidelity
   *  `Family ID` column (E2). Absent ⇒ match by name; present ⇒ match by id so
   *  a household rename preserves the row (and its claim code). */
  id: Schema.optional(Schema.String),
  /** Optional claim code / `publicId` from the `Family Code` fidelity column.
   *  Carried through so a full-fidelity round trip preserves invite codes; the
   *  households-always-coded model means every household has one. */
  publicId: Schema.optional(Schema.String),
  familyName: Schema.String,
  guests: Schema.Array(ParsedGuest),
});
export type ParsedFamily = Schema.Schema.Type<typeof ParsedFamily>;

// ── Desired state ─────────────────────────────────────────────────────────────

/**
 * The canonical desired-state both front doors of the reconcile pipeline funnel
 * into (see [[guest-event-editor]] §3). The CSV parser produces it (ids absent
 * ⇒ name matching, exactly today's import); the editor's draft-save (E5/E6) will
 * produce it directly (ids present for existing rows, absent for new ones).
 * `diffAgainstDb` consumes exactly `{ events, families }`, so this is just the
 * named tuple of the two parser outputs — the type the diff reconciles TO.
 *
 * Model note: households ALWAYS carry a `publicId` (the "households ≠ codes"
 * work was reversed), so a full-fidelity DesiredState carries a code per
 * household; there is no code-less household path.
 */
export const DesiredState = Schema.Struct({
  events: Schema.Array(ParsedEvent),
  families: Schema.Array(ParsedFamily),
});
export type DesiredState = Schema.Schema.Type<typeof DesiredState>;

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
  nickname: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
});
export type GuestCreate = Schema.Schema.Type<typeof GuestCreate>;

export const GuestUpdate = Schema.Struct({
  id: Schema.String,
  /**
   * Present ONLY for an id-matched first-name RENAME (E2) — the write set then
   * updates `first_name`. Omitted on the name-matched path (a name match means
   * the first name is unchanged by definition), so a no-id import emits exactly
   * today's shape and stays byte-identical.
   */
  firstName: Schema.optional(Schema.String),
  lastName: Schema.String,
  nickname: Schema.NullOr(Schema.String),
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
