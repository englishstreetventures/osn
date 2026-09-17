import { DIETARY_PRESETS } from "@cire/dietary";
import { Effect, Schema } from "effect";

// Free-text + array bounds. `dietary` is stored unbounded otherwise, and
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
//
// Three other places hold this value and move with it in the same commit:
// `cire/db/seed/data/rsvps.ts`, the generated `cire/db/seed/dev-seed.sql`
// (regenerate with `bun run --cwd cire/db seed:generate`, or the seed drift test
// fails), and `wiki/compliance/data-map.md`.
//
// See [[wiki/compliance/dpia/cire-guest-data]].
export const DIETARY_CONSENT_VERSION = "2026-09-17";

// Free-text dietary field, capped at MAX_DIETARY_CHARS. Carries what the guest
// typed under "Other"; everything nameable is a key in `dietaryPresets`.
const DietaryText = Schema.String.check(Schema.isMaxLength(MAX_DIETARY_CHARS));

// The guest's picks from the closed vocabulary in `@cire/dietary`.
//
// The length cap bounds the payload but cannot bound the CONTENTS — nothing here
// rejects `["nuts", "nuts"]`. That is deliberate: `serialisePresets` deduplicates
// and canonicalises, and the server stores what it serialises, so a repeat is
// normalised rather than 422'd. An unknown key IS rejected, because the literal
// union is the vocabulary.
const DietaryPresets = Schema.Array(Schema.Literals(DIETARY_PRESETS)).check(
  Schema.isMaxLength(DIETARY_PRESETS.length),
);

// Per-RSVP shape shared by the single + bulk bodies. `dietaryConsent` is the
// guest's explicit opt-in for the special-category dietary data — presets and
// free text alike; the route rejects (422) any request carrying either without
// it. A preset is not the safe half of the pair: `halal` and `kosher` reveal
// religious belief, `nuts` and `shellfish` reveal health.
const RsvpItem = Schema.Struct({
  guestId: Schema.NonEmptyString,
  eventId: Schema.NonEmptyString,
  status: Schema.Literals(["attending", "declined", "maybe"]),
  dietary: DietaryText.pipe(Schema.withDecodingDefaultType(Effect.succeed(""))),
  dietaryPresets: DietaryPresets.pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
  dietaryConsent: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
});

export const RsvpBody = RsvpItem;
export type RsvpBody = Schema.Schema.Type<typeof RsvpBody>;

export const BulkRsvpBody = Schema.Struct({
  rsvps: Schema.Array(RsvpItem).check(Schema.isMaxLength(MAX_RSVP_BATCH)),
});
export type BulkRsvpBody = Schema.Schema.Type<typeof BulkRsvpBody>;

// Body for the organiser-recorded RSVP endpoint
// (PUT .../guests/:guestId/rsvps/:eventId). `guestId`/`eventId` are path
// params, so the body carries only the answer. `dietaryConsent` is the
// organiser's ATTESTATION that the guest consented to storing the dietary
// data (the Art. 9(2)(a) evidence for `consent_source='organiser_attested'`
// — see [[wiki/compliance/dpia/cire-guest-data]], organiser-attested
// variant). Same caps and consent gate as the guest path.
export const OrganiserRsvpBody = Schema.Struct({
  status: Schema.Literals(["attending", "declined", "maybe"]),
  dietary: DietaryText.pipe(Schema.withDecodingDefaultType(Effect.succeed(""))),
  dietaryPresets: DietaryPresets.pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
  dietaryConsent: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
});
export type OrganiserRsvpBody = Schema.Schema.Type<typeof OrganiserRsvpBody>;

export const RsvpRecord = Schema.Struct({
  guestId: Schema.String,
  eventId: Schema.String,
  status: Schema.String,
  dietary: Schema.String,
  dietaryPresets: Schema.Array(Schema.Literals(DIETARY_PRESETS)),
  // Whether this row's Art. 9(2)(a) consent was given against the copy that is
  // current NOW — not merely whether a record exists.
  //
  // The sheet needs it to decide whether its single consent checkbox may open
  // ticked. A stored consent against superseded wording is not consent to the
  // current wording, and a pre-ticked box is not consent at all (Art. 4(11)),
  // so a version change must re-ask rather than inherit.
  //
  // A boolean rather than the timestamp and version themselves: the client only
  // ever branches on it, and the comparison belongs on the server that owns
  // `DIETARY_CONSENT_VERSION` anyway. It also keeps a millisecond-precision
  // "when this guest last recorded dietary data" off a credential the whole
  // household shares.
  dietaryConsentCurrent: Schema.Boolean,
});
export type RsvpRecord = Schema.Schema.Type<typeof RsvpRecord>;
