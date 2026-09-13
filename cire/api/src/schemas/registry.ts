import { Effect, Schema, SchemaTransformation } from "effect";

import { REGISTRY_IMAGE_KEY } from "../services/invite-assets";

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
export const HttpsUrl = Schema.String.check(
  Schema.isMaxLength(MAX_URL_CHARS),
  Schema.makeFilter((value) =>
    parseHttpsUrl(value) !== null
      ? undefined
      : "must be an absolute https:// URL without embedded credentials",
  ),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      // The filter above already rejected anything unparseable, so the fallback is
      // unreachable — it exists only to keep this total.
      decode: (value) => parseHttpsUrl(value)?.href ?? value,
      encode: (value) => value,
    }),
  ),
);

const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TITLE_CHARS));
const Headline = Schema.String.check(Schema.isMaxLength(MAX_HEADLINE_CHARS));
const Description = Schema.String.check(Schema.isMaxLength(MAX_DESCRIPTION_CHARS));
const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_CHARS));
const Note = Schema.String.check(Schema.isMaxLength(MAX_NOTE_CHARS));
const DisplayName = Schema.String.check(Schema.isMaxLength(MAX_DISPLAY_NAME_CHARS));
const Category = Schema.String.check(Schema.isMaxLength(MAX_CATEGORY_CHARS));
const ShippingAddress = Schema.String.check(Schema.isMaxLength(MAX_ADDRESS_CHARS));
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
const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
      ? undefined
      : "not a real calendar date";
  }),
);

/**
 * R2 object key for an image already uploaded through the assets pipeline.
 *
 * Shape-checked here and OWNERSHIP-checked in the service (S-H1). Every other
 * cire image key is minted server-side — `services/invite-assets.ts` builds
 * `assets/<weddingId>/<slot>-<uuid>` and the client never names one — so this is
 * the first key a client gets to choose. A free-form string would let an editor
 * of wedding A point an item at wedding B's object, which the serve path would
 * then honour. The pattern pins the namespace, the SLOT and a safe charset (no
 * `..`, no slashes past the two segments); `registryService` additionally
 * requires the middle segment to be the caller's own `weddingId`.
 *
 * The slot half matters as much as the wedding half (S-M1). Without it, an
 * editor could name their own wedding's invite hero here and have deleting the
 * item reap the hero's object — same wedding, so the ownership check passes.
 * {@link REGISTRY_IMAGE_KEY} is the one definition of that shape, exported from
 * the module that mints these keys, so the schema, the ownership check and the
 * serve route cannot drift apart.
 */
const ImageKey = Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(REGISTRY_IMAGE_KEY));

const Minor = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_MINOR),
);
const Quantity = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: MAX_QUANTITY }),
);

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
  description: Schema.NullOr(Description).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  imageKey: Schema.NullOr(ImageKey).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  externalUrl: Schema.NullOr(HttpsUrl).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  priceMinor: Schema.NullOr(Minor).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  quantityWanted: Quantity.pipe(Schema.withDecodingDefaultType(Effect.succeed(1))),
  category: Schema.NullOr(Category).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
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

/**
 * Link preview request — the URL of a shop page the organiser wants scraped.
 *
 * Reuses `HttpsUrl`, so the scheme and credential checks happen at the boundary
 * before the service ever sees the string. That is the OUTER of two identical
 * gates, not the only one: `services/link-preview.ts` re-checks the scheme on
 * the input and on every redirect hop, because a `Location` header never passes
 * through here.
 */
export const RegistryLinkPreviewBody = Schema.Struct({
  url: HttpsUrl,
});
export type RegistryLinkPreviewBody = Schema.Schema.Type<typeof RegistryLinkPreviewBody>;

/**
 * Save-from-URL request — the ONE candidate the organiser picked out of the
 * preview, whose bytes get copied into R2.
 *
 * Same `HttpsUrl` as the preview above, and for the same reason: this is the
 * outer of two gates. It is tempting to treat this URL as already-vetted since
 * we emitted it a moment ago, but it arrives in a request body — a client can
 * post any URL here, in any order, without ever calling the preview — so the
 * service re-runs the full SSRF guard on it regardless of what this schema says.
 */
export const RegistrySaveImageFromUrlBody = Schema.Struct({
  url: HttpsUrl,
});
export type RegistrySaveImageFromUrlBody = Schema.Schema.Type<typeof RegistrySaveImageFromUrlBody>;

/** Reorder: the new order of item ids across the whole wedding's list. */
export const ReorderRegistryItemsBody = Schema.Struct({
  orderedIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(500)),
});
export type ReorderRegistryItemsBody = Schema.Schema.Type<typeof ReorderRegistryItemsBody>;

/** Thank-you toggle. `kind` picks which table the id lives in. */
export const SetThankedBody = Schema.Struct({
  thanked: Schema.Boolean,
});
export type SetThankedBody = Schema.Schema.Type<typeof SetThankedBody>;

export const GiftKindSchema = Schema.Literals(["claim", "contribution"]);

/**
 * A money gift, in the wedding's own minor units.
 *
 * The floor exists because Stripe's own minimum charge is around 50 cents and a
 * fee-eaten gift helps nobody; the ceiling because a guest fat-fingering an
 * extra zero should hit a validation error rather than a card charge. Both are
 * in MINOR units of whatever the wedding's currency is — 500 is $5.00 in a
 * two-exponent currency and ¥500 in yen, and that asymmetry is deliberate: the
 * alternative is a per-currency table nobody would keep current.
 */
const MIN_CONTRIBUTION_MINOR = 500;
const MAX_CONTRIBUTION_MINOR = 1_000_000;

export const ContributionAmount = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: MIN_CONTRIBUTION_MINOR, maximum: MAX_CONTRIBUTION_MINOR }),
);

/**
 * Body of a guest's "give money" request. Everything but the amount is
 * optional, and both free-text fields are bounded here rather than at Stripe:
 * they ride along as checkout METADATA, which Stripe caps at 500 characters per
 * value and rejects — as a 400 the guest would meet in the middle of paying —
 * anything longer.
 */
export const ContributeBody = Schema.Struct({
  amountMinor: ContributionAmount,
  /** Contributing TOWARDS a listed gift, rather than in general. */
  itemId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  message: Schema.NullOr(Schema.String.check(Schema.isMaxLength(400))).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  displayName: Schema.NullOr(DisplayName).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
});
export type ContributeBody = Schema.Schema.Type<typeof ContributeBody>;

export const ClaimItemBody = Schema.Struct({
  quantity: Quantity.pipe(Schema.withDecodingDefaultType(Effect.succeed(1))),
  // `purchased` is the "I already bought it elsewhere" path; `reserved` is the
  // intent to. Both hold quantity, so both count against `quantity_wanted`.
  status: Schema.Literals(["reserved", "purchased"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("reserved" as const)),
  ),
  note: Schema.NullOr(Note).pipe(Schema.withDecodingDefaultType(Effect.succeed(null))),
  displayName: Schema.NullOr(DisplayName).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
});
export type ClaimItemBody = Schema.Schema.Type<typeof ClaimItemBody>;
