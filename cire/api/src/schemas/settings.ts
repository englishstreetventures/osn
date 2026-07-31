import { Schema } from "effect";

import { canonicalTimeZone } from "../lib/rsvp-deadline";
import { MAX_DISPLAY_NAME } from "../services/weddings";

/** Trim then require non-empty — same idiom as `CreateWeddingBody.displayName`. */
const trimmed = (max: number) =>
  Schema.String.pipe(
    Schema.transform(Schema.String, {
      strict: true,
      decode: (s) => s.trim(),
      encode: (s) => s,
    }),
    Schema.minLength(1),
    Schema.maxLength(max),
  );

/**
 * Date-only ISO string (`YYYY-MM-DD`). The pattern alone admits impossible
 * days (2026-02-31), so the filter round-trips through `Date` and requires the
 * same calendar day back — engine-lenient parses that silently roll over are
 * rejected too. Shared by the wedding date and the RSVP deadline.
 */
const CalendarDate = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter(
    (s) => {
      const t = Date.parse(`${s}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
    },
    { message: () => "not a real calendar date" },
  ),
);

/** ISO 4217 alpha code. Uppercase-only — the form normalises before submit. */
const Currency = Schema.String.pipe(Schema.pattern(/^[A-Z]{3}$/));

/**
 * IANA time-zone identifier (`Australia/Sydney`), validated against the
 * runtime's own ICU data rather than a pattern — a zone this Worker can't
 * resolve would silently degrade the RSVP deadline to UTC at read time, and a
 * deadline the organiser can't predict is worse than none.
 *
 * CANONICALISED, not merely accepted (S-L2). `Intl` also constructs for
 * `"+05:30"`, `"utc"` and `"AUSTRALIA/sydney"`; storing those verbatim would
 * mean a fixed-offset deadline that never applies DST (drifting an hour across
 * a transition) and one zone spelled several ways in the column. The
 * `maxLength` runs FIRST and Effect Schema short-circuits on it, so an
 * oversized blob never reaches the ICU lookup.
 */
const TimeZone = Schema.String.pipe(
  Schema.maxLength(64),
  Schema.filter((s) => canonicalTimeZone(s) !== null, { message: () => "not a known time zone" }),
  Schema.transform(Schema.String, {
    strict: true,
    // The filter above already rejected anything unresolvable, so the fallback
    // is unreachable — it exists only to keep this total.
    decode: (s) => canonicalTimeZone(s) ?? s,
    encode: (s) => s,
  }),
);

const GuestCountEstimate = Schema.Number.pipe(Schema.int(), Schema.between(1, 10_000));

/** Budget in MINOR units. Bounded well past any real wedding ($1B in cents)
 *  but inside the integer-safe range. */
const BudgetTotalMinor = Schema.Number.pipe(Schema.int(), Schema.between(0, 100_000_000_000));

/**
 * Body for `PUT /api/organiser/weddings/:weddingId/settings`. PATCH semantics
 * over PUT (the app's CORS method list has no PATCH): omitted fields keep
 * their stored value, an explicit `null` clears a nullable field. `displayName`
 * and `currency` are NOT NULL columns, so they can be replaced but never
 * cleared. Location is deliberately absent — an event's place is its free-text
 * `address` (the sole location source); the wedding holds only the MAIN
 * currency + budget.
 * The SLUG is deliberately absent too (read-only in Settings): renaming frees
 * the old slug for another organiser to claim, and printed invite links can't
 * be recalled — a rename feature needs slug tombstoning first (S-M1, tracked
 * in cire wiki/todo/security.md).
 *
 * `rsvpDeadline` is the one field here that guests feel: past it the invite
 * stops accepting RSVPs. `rsvpDeadlineTimezone` names the zone that day is
 * measured in (the portal sends the organiser's own). The service pairs them —
 * clearing the date clears the zone — so a zone can never outlive its date.
 */
export const UpdateSettingsBody = Schema.Struct({
  displayName: Schema.optional(trimmed(MAX_DISPLAY_NAME)),
  weddingDate: Schema.optional(Schema.NullOr(CalendarDate)),
  guestCountEstimate: Schema.optional(Schema.NullOr(GuestCountEstimate)),
  currency: Schema.optional(Currency),
  budgetTotalMinor: Schema.optional(Schema.NullOr(BudgetTotalMinor)),
  rsvpDeadline: Schema.optional(Schema.NullOr(CalendarDate)),
  rsvpDeadlineTimezone: Schema.optional(Schema.NullOr(TimeZone)),
});
export type UpdateSettingsBody = Schema.Schema.Type<typeof UpdateSettingsBody>;
