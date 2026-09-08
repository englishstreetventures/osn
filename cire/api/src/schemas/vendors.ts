import { Schema } from "effect";

import { SERVICE_CATEGORIES } from "../lib/service-categories";

/** Vendor CRM lifecycle statuses, display order. */
export const VENDOR_STATUSES = [
  "researching",
  "contacted",
  "quoted",
  "booked",
  "declined",
] as const;

const CategoryKey = Schema.Literals(SERVICE_CATEGORIES.map((c) => c.key));
const Status = Schema.Literals(VENDOR_STATUSES);
const NonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const OptText = Schema.optional(
  Schema.Union([Schema.String.check(Schema.isMaxLength(2000)), Schema.Null]),
);
const Email = Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(200));
const Minor = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(9_000_000_000_000),
);
const OptMinor = Schema.optional(Schema.Union([Minor, Schema.Null]));
const PriceBand = Schema.optional(
  Schema.Union([Schema.Literals(["$", "$$", "$$$", "$$$$"]), Schema.Null]),
);

// --- Organiser CRM ---
export const CreateVendorBody = Schema.Struct({
  name: NonEmpty,
  category: CategoryKey,
  status: Schema.optional(Status),
  contactName: OptText,
  email: OptText,
  phone: OptText,
  notes: OptText,
  quotedMinor: OptMinor,
});

export const UpdateVendorBody = Schema.Struct({
  name: Schema.optional(NonEmpty),
  category: Schema.optional(CategoryKey),
  status: Schema.optional(Status),
  contactName: OptText,
  email: OptText,
  phone: OptText,
  notes: OptText,
  quotedMinor: OptMinor,
});

export const ReorderVendorsBody = Schema.Struct({
  status: Status,
  // Capped like tasks/budget: the reorder builds one UPDATE per id, so an
  // unbounded array is an unbounded write set.
  orderedIds: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMaxLength(500),
  ),
});

/** Organiser seeds a directory listing + invites a vendor by email to claim it. */
export const SeedListingBody = Schema.Struct({
  name: NonEmpty,
  email: Email,
  categories: Schema.Array(CategoryKey).check(Schema.isMinLength(1)),
  description: OptText,
  phone: OptText,
  website: OptText,
  instagram: OptText,
  locationText: OptText,
});

/** Vendor create/update of their own listing (one per org). */
export const UpsertListingBody = Schema.Struct({
  name: NonEmpty,
  categories: Schema.Array(CategoryKey).check(Schema.isMinLength(1)),
  description: OptText,
  email: OptText,
  phone: OptText,
  website: OptText,
  instagram: OptText,
  locationText: OptText,
  priceBand: PriceBand,
  priceMinMinor: OptMinor,
  priceMaxMinor: OptMinor,
});

/** Vendor consumes a claim token, binding the listing to their chosen org. */
export const ConsumeClaimBody = Schema.Struct({
  orgId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});

/** Organiser adds a directory listing to their wedding CRM under one category. */
export const AddFromDirectoryBody = Schema.Struct({
  category: CategoryKey,
});
