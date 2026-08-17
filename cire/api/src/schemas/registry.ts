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
 * Parse an absolute `https:` URL, or `null` if the string is not one.
 *
 * Embedded credentials are rejected outright (S-M5). `https://host.example@evil.example/`
 * is a valid URL whose authority is `evil.example`, and every UI that shows an
 * item's link shows a truncated form of it — so the one part a guest reads is
 * exactly the part the syntax lets an attacker choose. Nothing legitimate puts a
 * userinfo section in a gift-registry link.
 */
function parseHttpsUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed;
}

/**
 * An absolute `https:` URL, stored in its parsed form.
 *
 * Scheme-checked, not merely shape-checked. `external_url` is rendered into an
 * `<a href>` on the guest site, and an unvalidated URL there is a same-origin
 * script sink — precedent CON-S-L2, where `vendor.privacyUrl` reached an `href`
 * with no scheme check and a `javascript:` value added later would have executed.
 * The guest renderer re-checks rather than trusting this, because a row can also
 * arrive from a migration or a fixture.
 *
 * The transform stores `URL.href` rather than the raw input (S-M5), so what the
 * column holds is what the parser saw — one normal form per link, and no gap
 * between the string that passed validation and the string that gets rendered.
 */
export const HttpsUrl = Schema.String.pipe(
  Schema.maxLength(MAX_URL_CHARS),
  Schema.filter((value) => parseHttpsUrl(value) !== null, {
    message: () => "must be an absolute https:// URL without embedded credentials",
  }),
  Schema.transform(Schema.String, {
    strict: true,
    // The filter above already rejected anything unparseable, so the fallback is
    // unreachable — it exists only to keep this total.
    decode: (value) => parseHttpsUrl(value)?.href ?? value,
    encode: (value) => value,
  }),
);

const Title = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_TITLE_CHARS));
const Headline = Schema.String.pipe(Schema.maxLength(MAX_HEADLINE_CHARS));
const Description = Schema.String.pipe(Schema.maxLength(MAX_DESCRIPTION_CHARS));
const Message = Schema.String.pipe(Schema.maxLength(MAX_MESSAGE_CHARS));
const Note = Schema.String.pipe(Schema.maxLength(MAX_NOTE_CHARS));
const DisplayName = Schema.String.pipe(Schema.maxLength(MAX_DISPLAY_NAME_CHARS));
const Category = Schema.String.pipe(Schema.maxLength(MAX_CATEGORY_CHARS));
const ShippingAddress = Schema.String.pipe(Schema.maxLength(MAX_ADDRESS_CHARS));
/**
 * A calendar date (`YYYY-MM-DD` from a date input), stored as text.
 *
 * Checked as a real date, not merely a bounded string (S-M2). This column gates
 * when the couple's HOME ADDRESS becomes visible to guests, and the comparison
 * that reads it treats an unparseable value as "no embargo" — so a garbage date
 * publishes the address immediately. Mirrors `CalendarDate` in `schemas/settings.ts`:
 * the pattern admits impossible days (2026-02-31), so the filter round-trips
 * through `Date` and requires the same calendar day back.
 */
const IsoDate = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter(
    (s) => {
      const t = Date.parse(`${s}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
    },
    { message: () => "not a real calendar date" },
  ),
);

/**
 * R2 object key for an image already uploaded through the assets pipeline.
 *
 * Shape-checked here and OWNERSHIP-checked in the service (S-H1). Every other
 * cire image key is minted server-side — `services/invite-assets.ts` builds
 * `assets/<weddingId>/<slot>-<uuid>` and the client never names one — so this is
 * the first key a client gets to choose. A free-form string would let an editor
 * of wedding A point an item at wedding B's object, which the serve path would
 * then honour. The pattern pins the namespace and a safe charset (no `..`, no
 * slashes past the two segments); `registryService` additionally requires the
 * middle segment to be the caller's own `weddingId`.
 */
const ImageKey = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^assets\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,256}$/),
);

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
