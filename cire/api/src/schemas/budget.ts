import { Schema } from "effect";

import { SERVICE_CATEGORIES } from "../lib/service-categories";

const MAX_NAME_CHARS = 200;
const MAX_LABEL_CHARS = 80;
const MAX_NOTES_CHARS = 2000;
// Guard against absurd figures (SQLite INTEGER is 64-bit; this is a sanity cap,
// ~ 9 trillion in minor units). Keeps a fat-fingered paste from overflowing UI.
const MAX_MINOR = 9_000_000_000_000;

// The category enum, sourced from the single list so the two never drift.
const categoryKeys = SERVICE_CATEGORIES.map((c) => c.key) as [string, ...string[]];
const CategorySchema = Schema.Literal(...categoryKeys);

const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_NAME_CHARS));
const Label = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_LABEL_CHARS));
const Notes = Schema.String.pipe(Schema.maxLength(MAX_NOTES_CHARS));
// A loose ISO date string (YYYY-MM-DD from the date input). Stored as text.
const DueAt = Schema.String.pipe(Schema.maxLength(32));
// A money amount in minor units: a non-negative integer, capped for sanity.
const Minor = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(MAX_MINOR),
);

// Create item: category + name required; the three money figures + notes are
// optional, absent → null.
export const CreateBudgetItemBody = Schema.Struct({
  category: CategorySchema,
  name: Name,
  estimateMinor: Schema.optionalWith(Schema.NullOr(Minor), { default: () => null }),
  quotedMinor: Schema.optionalWith(Schema.NullOr(Minor), { default: () => null }),
  actualMinor: Schema.optionalWith(Schema.NullOr(Minor), { default: () => null }),
  notes: Schema.optionalWith(Schema.NullOr(Notes), { default: () => null }),
});
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
});
export type UpdateBudgetItemBody = Schema.Schema.Type<typeof UpdateBudgetItemBody>;

// Reorder: the new order of item ids within one category.
export const ReorderBudgetItemsBody = Schema.Struct({
  category: CategorySchema,
  orderedIds: Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(500)),
});
export type ReorderBudgetItemsBody = Schema.Schema.Type<typeof ReorderBudgetItemsBody>;

// Create payment: label + amount required; dueAt optional, absent → null.
export const CreatePaymentBody = Schema.Struct({
  label: Label,
  amountMinor: Minor,
  dueAt: Schema.optionalWith(Schema.NullOr(DueAt), { default: () => null }),
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
const BudgetTotal = Schema.Number.pipe(Schema.int(), Schema.between(0, 100_000_000_000));
export const SetBudgetTotalBody = Schema.Struct({
  budgetTotalMinor: Schema.NullOr(BudgetTotal),
});
export type SetBudgetTotalBody = Schema.Schema.Type<typeof SetBudgetTotalBody>;
