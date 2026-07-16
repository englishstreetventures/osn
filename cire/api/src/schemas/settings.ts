import { Schema } from "effect";

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
 * rejected too.
 */
const WeddingDate = Schema.String.pipe(
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
 */
export const UpdateSettingsBody = Schema.Struct({
  displayName: Schema.optional(trimmed(MAX_DISPLAY_NAME)),
  weddingDate: Schema.optional(Schema.NullOr(WeddingDate)),
  guestCountEstimate: Schema.optional(Schema.NullOr(GuestCountEstimate)),
  currency: Schema.optional(Currency),
  budgetTotalMinor: Schema.optional(Schema.NullOr(BudgetTotalMinor)),
});
export type UpdateSettingsBody = Schema.Schema.Type<typeof UpdateSettingsBody>;
