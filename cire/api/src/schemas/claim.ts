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
  // First-party public path to this event's ONE optional image (migration 0019),
  // or null when the event has no image uploaded. The path carries a server-
  // derived `?v=` cache-buster (from `versionFromKey(event_image_key)`); the
  // guest site prepends its API origin. Not run through `safeHttpUrl` like the
  // pinterest/maps links — this is a same-origin API path we mint ourselves,
  // never a stored external URL.
  imageUrl: Schema.NullOr(Schema.String),
  // Normalised crop rectangle `{x,y,w,h}` (0..1 source fractions, migration 0021)
  // the organiser chose for this event's image, or null for the default centre
  // `object-cover`. The guest site applies it in CSS; validated on write + decoded
  // defensively on read, so only a well-formed in-bounds rectangle reaches here.
  // `natW`/`natH` (optional) are the source image's natural pixel dimensions —
  // present on crops saved by the current editor, absent on legacy crops. They
  // give the guest box the crop's true pixel aspect so the image fills it with no
  // distortion; an absent pair falls back to the event card's default 4∶3.
  imageCrop: Schema.NullOr(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      w: Schema.Number,
      h: Schema.Number,
      natW: Schema.optional(Schema.Number),
      natH: Schema.optional(Schema.Number),
    }),
  ),
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
  // True only for the synthetic per-wedding host family (organiser preview).
  // The guest web app shows a "preview" banner and disables RSVP when set.
  preview: Schema.Boolean,
  members: Schema.Array(FamilyMember),
  events: Schema.Array(EventSummary),
  rsvps: Schema.Array(RsvpSummary),
});
export type ClaimResponse = Schema.Schema.Type<typeof ClaimResponse>;

export const OrganiserGuestRow = Schema.Struct({
  guestId: Schema.String,
  // The family DB id (`families.id`) — the organiser dashboard targets the
  // per-family `regenerate-code` / `mark-shared` endpoints by this id.
  familyId: Schema.String,
  publicId: Schema.String,
  familyName: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  events: Schema.Array(Schema.String),
  // Epoch-ms timestamp the organiser last copied this family's invite message
  // (the per-family "Copy message" button), or `null` if never shared. Drives
  // the dashboard's "Sent" indicator + the remint "already sent out" warning.
  // Per-guest rows in the same family carry the same value (it's a family-level
  // column); the UI dedupes by family.
  codeSharedAt: Schema.NullOr(Schema.Number),
  // Epoch-ms timestamp a guest FIRST opened this family's invite with its
  // current code (an actual claim, host-preview excluded), or `null` if never
  // opened. Drives the dashboard's reliable "Opened" status — distinct from the
  // copy-only `codeSharedAt` "Sent" — and is counted alongside it by the remint
  // "already sent out" warning. Same family-level dedupe as `codeSharedAt`.
  firstOpenedAt: Schema.NullOr(Schema.Number),
  // Epoch-ms timestamp the organiser DEACTIVATED this family (cut off a
  // withdrawn invite's claim code), or `null` when the family is active. A
  // non-null value means the family's code no longer claims — the dashboard
  // mutes the row + offers a Reactivate toggle. Family-level, so per-guest rows
  // in the same family carry the same value; the UI dedupes by family.
  deactivatedAt: Schema.NullOr(Schema.Number),
});
export type OrganiserGuestRow = Schema.Schema.Type<typeof OrganiserGuestRow>;
