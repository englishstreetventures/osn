import { Effect, Schema } from "effect";

import { SERVICE_CATEGORIES } from "../lib/service-categories";
import type { ServiceCategory } from "../lib/service-categories";

const MAX_NAME_CHARS = 200;
const MAX_LABEL_CHARS = 80;
const MAX_NOTES_CHARS = 2000;
// Guard against absurd figures (SQLite INTEGER is 64-bit; this is a sanity cap,
// ~ 9 trillion in minor units). Keeps a fat-fingered paste from overflowing UI.
const MAX_MINOR = 9_000_000_000_000;

// The category enum, sourced from the single list so the two never drift.
const categoryKeys = SERVICE_CATEGORIES.map((c) => c.key) as [
  ServiceCategory,
  ...ServiceCategory[],
];
const CategorySchema = Schema.Literals(categoryKeys);

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NAME_CHARS));
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LABEL_CHARS));
const Notes = Schema.String.check(Schema.isMaxLength(MAX_NOTES_CHARS));
// A loose ISO date string (YYYY-MM-DD from the date input). Stored as text.
const DueAt = Schema.String.check(Schema.isMaxLength(32));
// A money amount in minor units: a non-negative integer, capped for sanity.
const Minor = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_MINOR),
);

// A price per guest. Capped at the budget total's own ceiling (below), so the
// price times any real headcount stays far inside Number.MAX_SAFE_INTEGER.
const UnitPrice = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 100_000_000_000 }),
);
// Event ids are UUIDs; the bound keeps a body from carrying junk.
const EventId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
// At least one id: "every event" is spelled `null`, never `[]`, so an empty
// list cannot widen a line by accident. At most 50: the ownership check binds
// every id in one `IN (…)`, and D1 allows 100 bound parameters per query.
const EventIds = Schema.Array(EventId).check(Schema.isMinLength(1), Schema.isMaxLength(50));

// A per-head line: a price per guest, and the events whose guests it counts.
// `eventIds` absent keeps the line's current events (a fixed line has none, so
// it counts every event); `null` counts every event; a list counts only those.
const PerHead = Schema.Struct({
  unitPriceMinor: UnitPrice,
  eventIds: Schema.optional(Schema.NullOr(EventIds)),
});
export type PerHeadBody = Schema.Schema.Type<typeof PerHead>;

// A per-head line's estimate is computed from the RSVPs, so a body that makes a
// line per head and also names a fixed estimate contradicts itself.
const noEstimateWithPerHead = Schema.makeFilter(
  (body: { perHead?: PerHeadBody | null; estimateMinor?: number | null }) =>
    body.perHead != null && body.estimateMinor != null
      ? "A per-head line has no fixed estimate"
      : undefined,
);

// Create item: category + name required; the three money figures, notes and the
// per-head settings are optional, absent → null.
export const CreateBudgetItemBody = Schema.Struct({
  category: CategorySchema,
  name: Name,
  estimateMinor: Schema.NullOr(Minor).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  quotedMinor: Schema.NullOr(Minor).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  actualMinor: Schema.NullOr(Minor).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  notes: Schema.NullOr(Notes).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  perHead: Schema.NullOr(PerHead).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
}).check(noEstimateWithPerHead);
export type CreateBudgetItemBody = Schema.Schema.Type<typeof CreateBudgetItemBody>;

// Update item: every field optional (a partial patch). Absent field ⇒ unchanged;
// an explicit null on a money field or notes clears it.
export const UpdateBudgetItemBody = Schema.Struct({
  category: Schema.optional(CategorySchema),
  name: Schema.optional(Name),
  estimateMinor: Schema.optional(Schema.NullOr(Minor)),
  quotedMinor: Schema.optional(Schema.NullOr(Minor)),
  actualMinor: Schema.optional(Schema.NullOr(Minor)),
  notes: Schema.optional(Schema.NullOr(Notes)),
  // `null` makes the line fixed again; an object makes it (or keeps it) per head.
  perHead: Schema.optional(Schema.NullOr(PerHead)),
}).check(noEstimateWithPerHead);
export type UpdateBudgetItemBody = Schema.Schema.Type<typeof UpdateBudgetItemBody>;

// Reorder: the new order of item ids within one category.
export const ReorderBudgetItemsBody = Schema.Struct({
  category: CategorySchema,
  orderedIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(500)),
});
export type ReorderBudgetItemsBody = Schema.Schema.Type<typeof ReorderBudgetItemsBody>;

// Create payment: label + amount required; dueAt optional, absent → null.
export const CreatePaymentBody = Schema.Struct({
  label: Label,
  amountMinor: Minor,
  dueAt: Schema.NullOr(DueAt).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
});
export type CreatePaymentBody = Schema.Schema.Type<typeof CreatePaymentBody>;

// Update payment: partial patch. `paid` toggles the paid stamp (true → now,
// false → clear).
export const UpdatePaymentBody = Schema.Struct({
  label: Schema.optional(Label),
  amountMinor: Schema.optional(Minor),
  dueAt: Schema.optional(Schema.NullOr(DueAt)),
  paid: Schema.optional(Schema.Boolean),
});
export type UpdatePaymentBody = Schema.Schema.Type<typeof UpdatePaymentBody>;

// Set the wedding's overall budget cap (delegates to the settings service).
// The bound MATCHES the settings schema's BudgetTotalMinor (0..100_000_000_000)
// because the settings service does not re-validate the delegated patch — the
// two writers of weddings.budget_total_minor must accept the exact same range.
const BudgetTotal = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 100_000_000_000 }),
);
export const SetBudgetTotalBody = Schema.Struct({
  budgetTotalMinor: Schema.NullOr(BudgetTotal),
});
export type SetBudgetTotalBody = Schema.Schema.Type<typeof SetBudgetTotalBody>;
