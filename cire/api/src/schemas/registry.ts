import { Schema } from "effect";

const MAX_TITLE_CHARS = 200;
const MAX_HEADLINE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_MESSAGE_CHARS = 2000;
const MAX_NOTE_CHARS = 1000;
const MAX_DISPLAY_NAME_CHARS = 120;
const MAX_CATEGORY_CHARS = 60;
const MAX_ADDRESS_CHARS = 500;
const MAX_URL_CHARS = 2048;
/** Sanity cap on quantity — a registry line is a gift, not a wholesale order. */
const MAX_QUANTITY = 99;
// Same sanity ceiling the budget schema uses (~9 trillion in minor units): SQLite
// INTEGER is 64-bit, so this only stops a fat-fingered paste from reaching the UI.
const MAX_MINOR = 9_000_000_000_000;

/**
 * An absolute `https:` URL.
 *
 * Scheme-checked, not merely shape-checked. `external_url` is rendered into an
 * `<a href>` on the guest site, and an unvalidated URL there is a same-origin
 * script sink — precedent CON-S-L2, where `vendor.privacyUrl` reached an `href`
 * with no scheme check and a `javascript:` value added later would have executed.
 * The guest renderer re-checks rather than trusting this, because a row can also
 * arrive from a migration or a fixture.
 */
export const HttpsUrl = Schema.String.pipe(
  Schema.maxLength(MAX_URL_CHARS),
  Schema.filter(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      return parsed.protocol === "https:";
    },
    { message: () => "must be an absolute https:// URL" },
  ),
);

const Title = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_TITLE_CHARS));
const Headline = Schema.String.pipe(Schema.maxLength(MAX_HEADLINE_CHARS));
const Description = Schema.String.pipe(Schema.maxLength(MAX_DESCRIPTION_CHARS));
const Message = Schema.String.pipe(Schema.maxLength(MAX_MESSAGE_CHARS));
const Note = Schema.String.pipe(Schema.maxLength(MAX_NOTE_CHARS));
const DisplayName = Schema.String.pipe(Schema.maxLength(MAX_DISPLAY_NAME_CHARS));
const Category = Schema.String.pipe(Schema.maxLength(MAX_CATEGORY_CHARS));
const ShippingAddress = Schema.String.pipe(Schema.maxLength(MAX_ADDRESS_CHARS));
/** A loose ISO date string (YYYY-MM-DD from a date input). Stored as text. */
const IsoDate = Schema.String.pipe(Schema.maxLength(32));
/** R2 object key for an image already uploaded through the assets pipeline. */
const ImageKey = Schema.String.pipe(Schema.maxLength(512));

const Minor = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(MAX_MINOR),
);
const Quantity = Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_QUANTITY));

/**
 * Settings patch. Every field optional; an absent field is unchanged.
 *
 * `cashGiftsEnabled` is accepted here but the service is not the last word on it
 * — the route refuses to turn it on without a Stripe account that can actually
 * take charges, so the flag can never claim a capability the wedding lacks.
 */
export const UpdateRegistrySettingsBody = Schema.Struct({
  published: Schema.optional(Schema.Boolean),
  headline: Schema.optional(Schema.NullOr(Headline)),
  message: Schema.optional(Schema.NullOr(Message)),
  cashGiftsEnabled: Schema.optional(Schema.Boolean),
  shippingAddress: Schema.optional(Schema.NullOr(ShippingAddress)),
  shippingVisibleFrom: Schema.optional(Schema.NullOr(IsoDate)),
});
export type UpdateRegistrySettingsBody = Schema.Schema.Type<typeof UpdateRegistrySettingsBody>;

/**
 * Create item. Only the title is required — a registry entry with nothing but a
 * name ("a good bottle of something") is a legitimate thing to list.
 *
 * `priceMinor` has NO currency field: it is denominated in the wedding's primary
 * currency (`weddings.currency`) by definition. Accepting a per-item currency
 * here is exactly the mistake that makes a gift list unreadable.
 */
export const CreateRegistryItemBody = Schema.Struct({
  title: Title,
  description: Schema.optionalWith(Schema.NullOr(Description), { default: () => null }),
  imageKey: Schema.optionalWith(Schema.NullOr(ImageKey), { default: () => null }),
  externalUrl: Schema.optionalWith(Schema.NullOr(HttpsUrl), { default: () => null }),
  priceMinor: Schema.optionalWith(Schema.NullOr(Minor), { default: () => null }),
  quantityWanted: Schema.optionalWith(Quantity, { default: () => 1 }),
  category: Schema.optionalWith(Schema.NullOr(Category), { default: () => null }),
});
export type CreateRegistryItemBody = Schema.Schema.Type<typeof CreateRegistryItemBody>;

/** Update item: partial patch. Absent ⇒ unchanged; explicit null clears. */
export const UpdateRegistryItemBody = Schema.Struct({
  title: Schema.optional(Title),
  description: Schema.optional(Schema.NullOr(Description)),
  imageKey: Schema.optional(Schema.NullOr(ImageKey)),
  externalUrl: Schema.optional(Schema.NullOr(HttpsUrl)),
  priceMinor: Schema.optional(Schema.NullOr(Minor)),
  quantityWanted: Schema.optional(Quantity),
  category: Schema.optional(Schema.NullOr(Category)),
});
export type UpdateRegistryItemBody = Schema.Schema.Type<typeof UpdateRegistryItemBody>;

/** Reorder: the new order of item ids across the whole wedding's list. */
export const ReorderRegistryItemsBody = Schema.Struct({
  orderedIds: Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(500)),
});
export type ReorderRegistryItemsBody = Schema.Schema.Type<typeof ReorderRegistryItemsBody>;

/** Thank-you toggle. `kind` picks which table the id lives in. */
export const SetThankedBody = Schema.Struct({
  thanked: Schema.Boolean,
});
export type SetThankedBody = Schema.Schema.Type<typeof SetThankedBody>;

export const GiftKindSchema = Schema.Literal("claim", "contribution");

/** Guest claim — the honour-system "we've got this". */
export const ClaimItemBody = Schema.Struct({
  quantity: Schema.optionalWith(Quantity, { default: () => 1 }),
  // `purchased` is the "I already bought it elsewhere" path; `reserved` is the
  // intent to. Both hold quantity, so both count against `quantity_wanted`.
  status: Schema.optionalWith(Schema.Literal("reserved", "purchased"), {
    default: () => "reserved" as const,
  }),
  note: Schema.optionalWith(Schema.NullOr(Note), { default: () => null }),
  displayName: Schema.optionalWith(Schema.NullOr(DisplayName), { default: () => null }),
});
export type ClaimItemBody = Schema.Schema.Type<typeof ClaimItemBody>;
