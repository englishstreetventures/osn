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

const CategoryKey = Schema.Literal(...SERVICE_CATEGORIES.map((c) => c.key));
const Status = Schema.Literal(...VENDOR_STATUSES);
const NonEmpty = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200));
const OptText = Schema.optional(
  Schema.Union(Schema.String.pipe(Schema.maxLength(2000)), Schema.Null),
);
const Email = Schema.String.pipe(Schema.minLength(3), Schema.maxLength(200));
const Minor = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(9_000_000_000_000),
);
const OptMinor = Schema.optional(Schema.Union(Minor, Schema.Null));
const PriceBand = Schema.optional(
  Schema.Union(Schema.Literal("$", "$$", "$$$", "$$$$"), Schema.Null),
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
  orderedIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
});

/** Organiser seeds a directory listing + invites a vendor by email to claim it. */
export const SeedListingBody = Schema.Struct({
  name: NonEmpty,
  email: Email,
  categories: Schema.Array(CategoryKey).pipe(Schema.minItems(1)),
  description: OptText,
  phone: OptText,
  website: OptText,
  instagram: OptText,
  locationText: OptText,
});

/** Vendor create/update of their own listing (one per org). */
export const UpsertListingBody = Schema.Struct({
  name: NonEmpty,
  categories: Schema.Array(CategoryKey).pipe(Schema.minItems(1)),
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
  orgId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(50)),
});
