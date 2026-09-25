/**
 * Gift registry (platform Phase 4, [[registry]]) — the couple's gift list, the
 * households that claim from it, and the gift log they thank people from.
 *
 * LOCKED BY DEFAULT: every organiser route that reaches this service sits behind
 * `weddingEntitlement(db, "registry")`, and the `registry` entitlement is granted
 * to no wedding. Nothing here runs in production until someone grants it.
 *
 * TENANCY: the route gate proves the caller may touch `weddingId`. Every read and
 * write here ADDITIONALLY scopes by `wedding_id`, so an editor of wedding A can
 * never reach wedding B's item even with a leaked id — a mismatch fails
 * `RegistryItemNotInWedding` rather than touching a row.
 *
 * MONEY: the wedding has ONE primary currency (`weddings.currency`). Everything
 * the organiser authors — `registry_items.price_minor` — is denominated in it and
 * carries no currency code of its own. Only RECEIVED money can be foreign, and a
 * contribution stores both the as-given amount and its primary-currency
 * equivalent, each snapshotted once at charge time (see `giftLog`).
 */
import {
  families,
  registryClaims,
  registryContributions,
  registryItems,
  registrySettings,
  weddings,
} from "@cire/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitGroupedBatches, DbService, dbQuery } from "../db";
import { entitlementService } from "./entitlements";
import { REGISTRY_IMAGE_NAME } from "./invite-assets";
// Type only — `./retention` owns the shape, this module only reads it back.
// Nothing at runtime crosses between them, so no import cycle.
import type { GiftSummary } from "./retention";

/** No item with this id under this wedding (missing or another wedding's). 404-class. */
export class RegistryItemNotInWedding extends Data.TaggedError("RegistryItemNotInWedding") {}
/** The claim would take the item past `quantity_wanted`. 409-class. */
export class ItemFullyClaimed extends Data.TaggedError("ItemFullyClaimed") {}
/** No claim/contribution with this id under this wedding. 404-class. */
export class GiftNotInWedding extends Data.TaggedError("GiftNotInWedding") {}
/** The claiming household is not on this wedding's guest list. 404-class. */
export class FamilyNotInWedding extends Data.TaggedError("FamilyNotInWedding") {}
/** The image key names another wedding's object. 400-class. */
export class ImageKeyNotInWedding extends Data.TaggedError("ImageKeyNotInWedding") {}
/** Cash gifts asked for without a Stripe account that can take charges. 409-class. */
export class StripeNotReady extends Data.TaggedError("StripeNotReady") {}
/**
 * Cash gifts asked for in a currency the connected account cannot settle.
 * 409-class.
 */
export class CurrencyMismatch extends Data.TaggedError("CurrencyMismatch") {}
/**
 * A settings write whose `expected` values no longer match the row: someone
 * else saved one of the same fields since this caller read it. 409-class.
 * Carries the row as it stands, so the caller can show what changed.
 */
export class SettingsChanged extends Data.TaggedError("SettingsChanged")<{
  readonly current: RegistrySettingsDto;
}> {}
/** A guest asked to give money to a couple who are not taking it. 409-class. */
export class CashGiftsUnavailable extends Data.TaggedError("CashGiftsUnavailable") {}
/** The wedding is at its item ceiling. 409-class. */
export class RegistryItemLimitReached extends Data.TaggedError("RegistryItemLimitReached") {}
/**
 * A quantity outside the range the CHECK constraints allow (S-M1). The service
 * refuses it so the caller gets a tagged error rather than a raw D1 constraint
 * throw, which surfaces as a 500 and says nothing useful.
 */
export class InvalidQuantity extends Data.TaggedError("InvalidQuantity") {}
/**
 * No registry a guest may see at this slug. 404-class, and DELIBERATELY one error
 * for four different causes: unknown slug, wedding without the `registry`
 * entitlement, registry never opened, registry opened but unpublished.
 *
 * Telling them apart would tell an unauthenticated caller which weddings exist
 * and which of them are drafting a gift list — so the guest surface answers all
 * four the same way, the same posture the session-gated invite image slots take
 * (404, not 401/403).
 */
export class RegistryNotVisible extends Data.TaggedError("RegistryNotVisible") {}

/** One page of the gift log. A wedding's log is unbounded; a snapshot is not. */
const GIFT_LOG_PAGE = 50;
/**
 * How deep `offset` may go. The merge reads `offset + limit` rows from BOTH
 * tables to serve one page, so an unbounded offset is an unbounded read by
 * another name — the thing the pagination exists to stop.
 */
const MAX_GIFT_LOG_OFFSET = 500;
/**
 * Ceiling on items per wedding (S-L4). `reorderItems` already caps its id list at
 * 500; without a matching cap on creation the two disagree, and a list past the
 * reorder cap becomes unorderable.
 */
const MAX_ITEMS_PER_WEDDING = 500;
/** Range the `registry_claims.quantity` CHECK allows. Kept in step with the DDL. */
const MIN_CLAIM_QUANTITY = 1;
const MAX_CLAIM_QUANTITY = 99;

export type RegistryItemKind = "product" | "cash_fund";
export type RegistryClaimStatus = "reserved" | "purchased" | "released";
/**
 * A contribution's lifecycle, mirroring `registry_contributions.status`.
 *
 * Every one of the five is written, and each by exactly one kind of Stripe
 * event:
 *
 *  - `pending` — the row the guest's own request writes, before they are handed
 *    a payment page. Also where a completed session whose money has not moved
 *    yet stays: a delayed bank debit completes the session and settles days
 *    later.
 *  - `succeeded` — the money moved. `checkout.session.completed` with
 *    `payment_status: "paid"`, or the `async_payment_succeeded` that follows a
 *    delayed debit.
 *  - `failed` — it never will. The delayed debit bounced
 *    (`async_payment_failed`), or the guest walked away and Stripe expired the
 *    session. A failed row is kept rather than deleted — a webhook that deletes
 *    is a webhook a forged event can use to erase a gift — but it is not a gift
 *    and the couple's log does not show it.
 *  - `refunded` — it moved and went back. A `charge.refunded` for the FULL
 *    amount; a partial refund leaves the row `succeeded`, because the couple
 *    did keep part of it and the log would otherwise say a gift never arrived.
 *  - `disputed` — the guest's bank has taken it back while it decides
 *    (`charge.dispute.created`). The one status that is a HOLD rather than an
 *    ending: `charge.dispute.closed` moves it on, to `succeeded` if the couple
 *    won and `refunded` if they lost. It stays in the gift log — the couple
 *    needs to see it — and out of the received total, which filters on
 *    `succeeded`, because today the money is not theirs.
 *
 * The transitions are one-way and guarded in the service, not here: `pending` is
 * the only status that may fail or settle, `succeeded` the only one that may
 * refund or open a dispute, and only a dispute may leave `disputed`. Stripe
 * delivers at least once, out of order, and retries for days, so every one of
 * these events arrives twice sooner or later.
 */
export type RegistryContributionStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "refunded"
  | "disputed";
/** Which table a gift-log row came from — the discriminator the portal reads. */
export type GiftKind = "claim" | "contribution";

/**
 * The settings row as the server reads it, Stripe account id and payouts flag
 * included. Server-side only: the Stripe routes and the guest gates read it.
 * Never a response body — the organiser surfaces send `RegistrySettingsDto`.
 */
export interface RegistrySettingsRecord {
  weddingId: string;
  published: boolean;
  headline: string | null;
  message: string | null;
  cashGiftsEnabled: boolean;
  shippingAddress: string | null;
  shippingVisibleFrom: string | null;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  updatedAt: number | null;
}

/**
 * The settings as the organiser API sends them — the registry snapshot and the
 * settings PUT. Every co-host with read access receives this, so it carries only
 * what the settings view shows: whether an account is connected, not its id, and
 * whether it can charge, not whether it pays out.
 */
export interface RegistrySettingsDto {
  weddingId: string;
  published: boolean;
  headline: string | null;
  message: string | null;
  cashGiftsEnabled: boolean;
  shippingAddress: string | null;
  shippingVisibleFrom: string | null;
  stripeConnected: boolean;
  stripeChargesEnabled: boolean;
  updatedAt: number | null;
}

export interface RegistryItemDto {
  id: string;
  weddingId: string;
  kind: RegistryItemKind;
  title: string;
  description: string | null;
  imageKey: string | null;
  imageCrop: string | null;
  externalUrl: string | null;
  priceMinor: number | null;
  quantityWanted: number;
  /** Sum of non-released claim quantities. Derived, never stored. */
  quantityClaimed: number;
  allowPartial: boolean;
  targetMinor: number | null;
  category: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * One row of the couple's gift log — a claim or a contribution, flattened into a
 * shape the portal renders uniformly.
 *
 * `amountMinor`/`currency` are AS GIVEN. `primaryAmountMinor`/`primaryCurrency`
 * are the primary-currency equivalent and are non-null ONLY when the gift arrived
 * in some other currency; the portal shows the as-given figure as the primary
 * visual with the primary line underneath, and a single figure otherwise.
 */
export interface GiftLogEntryDto {
  kind: GiftKind;
  id: string;
  itemId: string | null;
  itemTitle: string | null;
  familyId: string;
  familyName: string;
  displayName: string | null;
  /** Claims only. */
  quantity: number | null;
  status: string;
  note: string | null;
  amountMinor: number | null;
  currency: string | null;
  primaryAmountMinor: number | null;
  primaryCurrency: string | null;
  fxRate: string | null;
  thankedAt: number | null;
  createdAt: number;
}

export interface RegistrySnapshot {
  settings: RegistrySettingsDto;
  items: RegistryItemDto[];
  gifts: GiftLogEntryDto[];
  /** Whether another page of gift-log rows sits past `gifts`. */
  giftsHasMore: boolean;
  /**
   * The aggregates the retention sweep left behind, or null.
   *
   * Non-null means the sweep has run and the per-guest detail is DELETED — so
   * `gifts` above is empty not because nothing arrived but because we erased
   * it, and the portal has to say which. Null is the ordinary case: the gift
   * log is still the record.
   */
  giftSummary: GiftSummary | null;
  /** The wedding's primary currency — what every authored figure is in. */
  currency: string;
  /**
   * Sum of the succeeded contributions that are IN the primary currency, and
   * only those. A row that arrived in some other currency and carries no
   * conversion is counted by `contributionsOtherCurrencyCount` instead of being
   * added in, because a sum across currencies is not an amount of money.
   *
   * Still APPROXIMATE where a row does carry a conversion: that row was
   * converted at its own snapshotted rate, so this is a sum of historical
   * conversions, not a live valuation. The portal must label it as such.
   */
  contributionsPrimaryMinor: number;
  /**
   * How many succeeded contributions this total leaves out — rows whose
   * currency, after the primary-currency snapshot is taken into account, is not
   * the wedding's. Non-zero means the figure above is not the whole of the
   * money, and the portal has to say so rather than showing one total.
   */
  contributionsOtherCurrencyCount: number;
}

/** The six fields the settings view edits. */
export interface RegistrySettingsFields {
  published: boolean;
  headline: string | null;
  message: string | null;
  cashGiftsEnabled: boolean;
  shippingAddress: string | null;
  shippingVisibleFrom: string | null;
}

/** Every key of `RegistrySettingsFields`, each also a `registry_settings` column. */
const SETTINGS_FIELDS = [
  "published",
  "headline",
  "message",
  "cashGiftsEnabled",
  "shippingAddress",
  "shippingVisibleFrom",
] as const satisfies readonly (keyof RegistrySettingsFields)[];

export interface UpdateRegistrySettingsPatch extends Partial<RegistrySettingsFields> {
  /**
   * What the caller last saw for a field it is changing. A field named here is
   * written only if the row still holds that value, or already holds the new
   * one; otherwise the write fails `SettingsChanged` and changes nothing.
   * Optional: a caller that leaves it out gets last-writer-wins.
   */
  expected?: Partial<RegistrySettingsFields>;
}

export interface CreateRegistryItemInput {
  weddingId: string;
  kind?: RegistryItemKind;
  title: string;
  description: string | null;
  imageKey: string | null;
  externalUrl: string | null;
  priceMinor: number | null;
  quantityWanted: number;
  category: string | null;
}

export interface UpdateRegistryItemPatch {
  title?: string;
  description?: string | null;
  imageKey?: string | null;
  imageCrop?: string | null;
  externalUrl?: string | null;
  priceMinor?: number | null;
  quantityWanted?: number;
  category?: string | null;
}

interface SettingsRow {
  weddingId: string;
  published: boolean;
  headline: string | null;
  message: string | null;
  cashGiftsEnabled: boolean;
  shippingAddress: string | null;
  shippingVisibleFrom: string | null;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  stripeAccountUpdatedAt: Date | null;
  /** Written by the retention sweep, never from the portal. Both or neither. */
  giftSummaryJson: string | null;
  giftSummaryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ItemRow {
  id: string;
  weddingId: string;
  kind: RegistryItemKind;
  title: string;
  description: string | null;
  imageKey: string | null;
  imageCrop: string | null;
  externalUrl: string | null;
  priceMinor: number | null;
  quantityWanted: number;
  allowPartial: boolean;
  targetMinor: number | null;
  category: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How drizzle-sqlite stores `integer({ mode: "timestamp" })` — epoch SECONDS,
 * not milliseconds. Only `claim` needs it (it writes the columns through a raw
 * conditional statement rather than a Date-valued insert); exported so the test
 * can pin the unit against what a normal drizzle insert produces, since the two
 * disagreeing is silent — the row still writes, just dated wildly wrong.
 */
export const toEpochSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

/** What an absent `registry_settings` row means — never opened reads as "off". */
const defaultSettings = (weddingId: string): RegistrySettingsRecord => ({
  weddingId,
  published: false,
  headline: null,
  message: null,
  cashGiftsEnabled: false,
  shippingAddress: null,
  shippingVisibleFrom: null,
  stripeAccountId: null,
  stripeChargesEnabled: false,
  stripePayoutsEnabled: false,
  updatedAt: null,
});

const toSettingsRecord = (r: SettingsRow): RegistrySettingsRecord => ({
  weddingId: r.weddingId,
  published: r.published,
  headline: r.headline,
  message: r.message,
  cashGiftsEnabled: r.cashGiftsEnabled,
  shippingAddress: r.shippingAddress,
  shippingVisibleFrom: r.shippingVisibleFrom,
  stripeAccountId: r.stripeAccountId,
  stripeChargesEnabled: r.stripeChargesEnabled,
  stripePayoutsEnabled: r.stripePayoutsEnabled,
  updatedAt: r.updatedAt.getTime(),
});

/** The organiser-facing view of a settings record — see `RegistrySettingsDto`. */
const toSettingsDto = (s: RegistrySettingsRecord): RegistrySettingsDto => ({
  weddingId: s.weddingId,
  published: s.published,
  headline: s.headline,
  message: s.message,
  cashGiftsEnabled: s.cashGiftsEnabled,
  shippingAddress: s.shippingAddress,
  shippingVisibleFrom: s.shippingVisibleFrom,
  stripeConnected: s.stripeAccountId !== null,
  stripeChargesEnabled: s.stripeChargesEnabled,
  updatedAt: s.updatedAt,
});

/** One per-currency line of a stored summary, checked rather than trusted. */
const isCurrencyTotal = (value: unknown): value is { currency: string; amountMinor: number } =>
  typeof value === "object" &&
  value !== null &&
  "currency" in value &&
  typeof value.currency === "string" &&
  "amountMinor" in value &&
  typeof value.amountMinor === "number" &&
  Number.isFinite(value.amountMinor);

/** Both halves of a stored summary's claim counts, present and finite. */
const isClaimCounts = (value: unknown): value is { reserved: number; purchased: number } =>
  typeof value === "object" &&
  value !== null &&
  "reserved" in value &&
  typeof value.reserved === "number" &&
  Number.isFinite(value.reserved) &&
  "purchased" in value &&
  typeof value.purchased === "number" &&
  Number.isFinite(value.purchased);

const isContributionTotals = (
  value: unknown,
): value is { count: number; totals: { currency: string; amountMinor: number }[] } =>
  typeof value === "object" &&
  value !== null &&
  "count" in value &&
  typeof value.count === "number" &&
  Number.isFinite(value.count) &&
  "totals" in value &&
  Array.isArray(value.totals) &&
  value.totals.every(isCurrencyTotal);

const isGiftSummary = (value: unknown): value is GiftSummary =>
  typeof value === "object" &&
  value !== null &&
  "sweptOn" in value &&
  typeof value.sweptOn === "string" &&
  "firstGiftOn" in value &&
  typeof value.firstGiftOn === "string" &&
  "lastGiftOn" in value &&
  typeof value.lastGiftOn === "string" &&
  "claims" in value &&
  isClaimCounts(value.claims) &&
  "contributions" in value &&
  isContributionTotals(value.contributions);

/**
 * Decode `registry_settings.gift_summary_json` — the aggregates the retention
 * sweep leaves behind a year after the last event, in the same pass that deletes
 * the households every claim and contribution hangs off (`GiftSummary` in
 * `./retention`).
 *
 * Both columns or neither. `gift_summary_at` is set by the same UPDATE, so JSON
 * without it is a half-written row rather than a record, and a timestamp without
 * JSON has nothing to say.
 *
 * Copied field by field, never the parsed object whole — the rule `decodePalette`
 * follows in `./claim`. This blob is the one part of the organiser snapshot not
 * built out of typed columns, and spreading it would let anything a later writer
 * (or a hand-edited row) puts in there ride out to the portal. Malformed reads as
 * ABSENT rather than throwing: a bad blob then costs the couple one band on a
 * page, where a throw costs them the whole registry screen.
 */
function decodeGiftSummary(raw: string | null, at: Date | null): GiftSummary | null {
  if (raw === null || at === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isGiftSummary(parsed)) return null;
  return {
    sweptOn: parsed.sweptOn,
    firstGiftOn: parsed.firstGiftOn,
    lastGiftOn: parsed.lastGiftOn,
    claims: { reserved: parsed.claims.reserved, purchased: parsed.claims.purchased },
    contributions: {
      count: parsed.contributions.count,
      totals: parsed.contributions.totals.map((total) => ({
        currency: total.currency,
        amountMinor: total.amountMinor,
      })),
    },
  };
}

const toItemDto = (r: ItemRow, quantityClaimed: number): RegistryItemDto => ({
  id: r.id,
  weddingId: r.weddingId,
  kind: r.kind,
  title: r.title,
  description: r.description,
  imageKey: r.imageKey,
  imageCrop: r.imageCrop,
  externalUrl: r.externalUrl,
  priceMinor: r.priceMinor,
  quantityWanted: r.quantityWanted,
  quantityClaimed,
  allowPartial: r.allowPartial,
  targetMinor: r.targetMinor,
  category: r.category,
  sortOrder: r.sortOrder,
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
});

/** Read the wedding's primary currency. Mirrors budgetService.get's fallback. */
function primaryCurrency(weddingId: string): Effect.Effect<string, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select({ currency: weddings.currency })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    return (row as { currency: string } | undefined)?.currency ?? "AUD";
  });
}

/** Non-released claimed quantity per item, for every item on the wedding. */
function claimedByItem(weddingId: string): Effect.Effect<Map<string, number>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({
          itemId: registryClaims.itemId,
          claimed: sql<number>`coalesce(sum(${registryClaims.quantity}), 0)`,
        })
        .from(registryClaims)
        .where(
          and(eq(registryClaims.weddingId, weddingId), sql`${registryClaims.status} <> 'released'`),
        )
        .groupBy(registryClaims.itemId)
        .all(),
    );
    const map = new Map<string, number>();
    for (const r of rows as { itemId: string; claimed: number }[]) {
      map.set(r.itemId, Number(r.claimed) || 0);
    }
    return map;
  });
}

/** One currency's worth of settled gift money. */
interface CurrencyTotal {
  /** Upper-case ISO code, as `RegistrySnapshot.currency` is. */
  currency: string;
  totalMinor: number;
  count: number;
}

/**
 * Succeeded contributions totalled PER CURRENCY, computed IN SQL.
 *
 * It used to be a JS loop over the gift log, which quietly made the total a
 * function of how many rows the log happened to return — so paginating the log
 * would have started under-reporting the money. One query, whatever the page
 * size.
 *
 * A same-currency row has no primary snapshot (the FX columns are NULL) and so
 * contributes its as-given amount; that is the `coalesce` pair.
 *
 * GROUPED, because adding two currencies together produces a number that is not
 * an amount of anything. The caller takes the wedding's own currency out of this
 * and reports the rest as a count. `retention.ts` groups the same way for the
 * same reason.
 *
 * The key is upper-cased: authored currencies are upper case and the ones the
 * settle path writes come from Stripe in lower case, so the raw column values
 * would split one currency across two groups.
 */
function contributionsByCurrency(
  weddingId: string,
): Effect.Effect<CurrencyTotal[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const key = sql<string>`upper(coalesce(${registryContributions.primaryCurrency}, ${registryContributions.currency}))`;
    const rows = yield* dbQuery(() =>
      db
        .select({
          currency: key,
          totalMinor: sql<number>`coalesce(sum(coalesce(${registryContributions.primaryAmountMinor}, ${registryContributions.amountMinor})), 0)`,
          count: sql<number>`count(*)`,
        })
        .from(registryContributions)
        .where(
          and(
            eq(registryContributions.weddingId, weddingId),
            eq(registryContributions.status, "succeeded"),
          ),
        )
        .groupBy(key)
        .all(),
    );
    return (rows as CurrencyTotal[]).map((row) => ({
      currency: String(row.currency ?? "").toUpperCase(),
      totalMinor: Number(row.totalMinor ?? 0) || 0,
      count: Number(row.count ?? 0) || 0,
    }));
  });
}

/**
 * Whether a household belongs to a wedding.
 *
 * Its own function because THREE gates now depend on it and they must not
 * drift: the list read, this household's read, and the claim/release writes. A
 * `cire_session` names a household and nothing else, so without this check one
 * leaked code reaches every couple's list on the platform.
 *
 * A primary-key point read — `families.id` is the PK — so the cost is one hop,
 * not one per row.
 */
function familyInWedding(
  weddingId: string,
  familyId: string,
): Effect.Effect<boolean, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ id: families.id })
        .from(families)
        .where(and(eq(families.id, familyId), eq(families.weddingId, weddingId)))
        .all(),
    );
    return (rows as Array<{ id: string }>).length > 0;
  });
}

/**
 * Whether an item id is one of this wedding's.
 *
 * A free function for the same reason `familyInWedding` is one: a cash gift
 * needs it at the same moment it needs the family check, and the two are then
 * one `Effect.all` rather than two serial D1 hops.
 */
function itemInWedding(
  weddingId: string,
  itemId: string,
): Effect.Effect<boolean, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ id: registryItems.id })
        .from(registryItems)
        .where(and(eq(registryItems.id, itemId), eq(registryItems.weddingId, weddingId)))
        .all(),
    );
    return (rows as Array<{ id: string }>).length > 0;
  });
}

/**
 * The row a Stripe event names, and whether the account it arrived on may move
 * it — in ONE read.
 *
 * Every webhook path needs the same two facts, and asking for them separately
 * cost two serial D1 round trips inside a handler Stripe times out at 20
 * seconds and retries for days. The join is LEFT on purpose: an account that
 * does not own the row must still come back WITH the row, so the caller can
 * tell "no such contribution" (acknowledge, nothing a retry fixes) from "not
 * yours" (reject, and worth an operator's attention).
 *
 * The `where` is the caller's because the two lookups differ: a checkout
 * session event names the contribution id we minted, and a refund names only
 * the payment intent.
 */
interface WebhookContributionRow {
  id: string;
  status: RegistryContributionStatus;
  /**
   * NULL while the row exists but Stripe has not answered yet — the window the
   * route opens deliberately. A webhook that names such a
   * row by `client_reference_id` is the first news of which session it was.
   */
  sessionId: string | null;
  /** What the guest was shown and agreed to, for the settle-time check. */
  amountMinor: number;
  currency: string;
  /**
   * What Stripe has sent back so far, or NULL where no refund has been seen.
   * Read so a refund write can be monotonic: Stripe's `amount_refunded` is
   * cumulative, and two deliveries can arrive out of order.
   */
  refundedAmountMinor: number | null;
  /** Non-null exactly when the row's wedding owns the account the event came on. */
  ownedAccountId: string | null;
}

function contributionsOnAccount(
  where: SQL,
  stripeAccountId: string,
  limit: number,
): Effect.Effect<WebhookContributionRow[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({
          id: registryContributions.id,
          status: registryContributions.status,
          sessionId: registryContributions.stripeCheckoutSessionId,
          amountMinor: registryContributions.amountMinor,
          currency: registryContributions.currency,
          refundedAmountMinor: registryContributions.refundedAmountMinor,
          ownedAccountId: registrySettings.stripeAccountId,
        })
        .from(registryContributions)
        .leftJoin(
          registrySettings,
          and(
            eq(registrySettings.weddingId, registryContributions.weddingId),
            eq(registrySettings.stripeAccountId, stripeAccountId),
          ),
        )
        .where(where)
        .limit(limit)
        .all(),
    );
    return rows as WebhookContributionRow[];
  });
}

/**
 * The columns a Stripe account-state write touches.
 *
 * `stripeDefaultCurrency` is optional because a caller that read a payload
 * which never mentioned the settlement currency must leave the stored value
 * alone rather than write null over what Stripe told us earlier.
 */
interface StripeAccountStatePatch {
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  stripeDefaultCurrency?: string | null;
  stripeAccountUpdatedAt: Date;
  updatedAt: Date;
}

/**
 * The columns a settle or an expiry writes.
 *
 * `stripeCheckoutSessionId` is optional because it is written ONLY while
 * adopting — a row that already holds its session id must not have the column
 * named in the UPDATE at all, since that write is the one carrying the
 * uniqueness guard.
 */
interface ContributionPatch {
  status: RegistryContributionStatus;
  updatedAt: Date;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string | null;
  // The four currency columns, which move together or not at all: a row either
  // carries a complete primary-currency snapshot or none of one. They are
  // optional for the same reason the session id is — a settle that has nothing
  // to say about currency must not name them in the UPDATE and overwrite a
  // snapshot some earlier event wrote.
  primaryAmountMinor?: number;
  primaryCurrency?: string;
  fxRate?: string;
  fxRateAt?: Date;
}

/** The columns a refund writes. Both are optional: a refund may move only one. */
interface RefundPatch {
  updatedAt: Date;
  status?: RegistryContributionStatus;
  refundedAmountMinor?: number;
}

/**
 * A refunded amount worth writing, or `null`.
 *
 * Stripe sends whole minor units, so anything fractional, negative, absent or
 * not a number at all is an event this product cannot honestly record. Zero is
 * excluded too: it is what a charge with no refund on it reports, and writing
 * it would turn "nothing went back" into a recorded refund of nothing.
 */
function refundedAmountOf(value: number | null): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The `where` that lets a session-less row adopt a session id without ever
 * risking the UNIQUE.
 *
 * `dbQuery` is `Effect.promise`, so a constraint violation is a DEFECT — a 500
 * inside a webhook Stripe will then retry for three days. So the check has to
 * live in the predicate rather than in a catch: the row still has no session,
 * and no other row has claimed this one. If either stopped being true between
 * the read and the write, the update matches nothing and the caller sees it.
 */
function sessionAdoptionGuard(contributionId: string, checkoutSessionId: string): SQL {
  return and(
    eq(registryContributions.id, contributionId),
    isNull(registryContributions.stripeCheckoutSessionId),
    sql`not exists (select 1 from ${registryContributions} other where other.stripe_checkout_session_id = ${checkoutSessionId})`,
  ) as SQL;
}

/** The single row a lookup on a unique column names, or nothing. */
function contributionOnAccount(
  where: SQL,
  stripeAccountId: string,
): Effect.Effect<WebhookContributionRow | undefined, never, DbService> {
  return contributionsOnAccount(where, stripeAccountId, 1).pipe(Effect.map((rows) => rows[0]));
}

/**
 * Does this R2 key name a REGISTRY object under this wedding? (S-H1, S-M1)
 *
 * `ImageKey` in the HTTP schema pins the SHAPE — `assets/<wedding>/registry-…` —
 * but shape alone lets an editor of wedding A point an item at wedding B's
 * upload, which the guest site would then serve. The middle segment IS the
 * wedding id, so ownership is a string compare, not a query.
 *
 * The slot prefix is checked here too, not only in the schema, because deleting
 * an item REAPS the object it names: a key of `assets/<own-wedding>/hero-<uuid>`
 * owns the same wedding, so ownership alone would let an editor destroy their
 * own invite hero through the registry. Both halves of the key have to be
 * earned.
 */
function imageKeyBelongsTo(weddingId: string, key: string): boolean {
  const parts = key.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "assets" &&
    parts[1] === weddingId &&
    REGISTRY_IMAGE_NAME.test(parts[2] ?? "")
  );
}

/** Integer in `[min, max]`? The guard behind the quantity CHECK constraints. */
const inQuantityRange = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

/** Clamp a caller-supplied paging number into a range. NaN reads as the floor. */
const clamp = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;

export const registryService = {
  /** The organiser-facing snapshot: settings, items with claim counts, gift log. */
  get(
    weddingId: string,
    options?: { giftsOffset?: number },
  ): Effect.Effect<RegistrySnapshot, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Five independent reads (P-W1). Each is a separate D1 round trip and none
      // depends on another's result, so issuing them together overlaps the
      // latency instead of stacking it — the same shape claimService.get uses.
      // On bun:sqlite the concurrency is a no-op; on D1 it is most of the
      // endpoint's wall clock.
      const { claimed, contributionTotals, currency, gifts, itemRows, settingsRows } =
        yield* Effect.all(
          {
            settingsRows: dbQuery(() =>
              db
                .select()
                .from(registrySettings)
                .where(eq(registrySettings.weddingId, weddingId))
                .all(),
            ),
            itemRows: dbQuery(() =>
              db
                .select()
                .from(registryItems)
                .where(eq(registryItems.weddingId, weddingId))
                .orderBy(asc(registryItems.sortOrder), asc(registryItems.id))
                .all(),
            ),
            claimed: claimedByItem(weddingId),
            gifts: registryService.giftLog(weddingId, { offset: options?.giftsOffset }),
            currency: primaryCurrency(weddingId),
            contributionTotals: contributionsByCurrency(weddingId),
          },
          { concurrency: "unbounded" },
        );
      const settingsRow = settingsRows[0] as SettingsRow | undefined;
      // Split here rather than in SQL: the wedding's currency comes from its own
      // read, and the two run together above. Passing one into the other would
      // serialise two D1 round trips that currently overlap, to save a filter
      // over at most a handful of rows.
      const primary = currency.toUpperCase();
      const contributionsPrimaryMinor =
        contributionTotals.find((total) => total.currency === primary)?.totalMinor ?? 0;
      const contributionsOtherCurrencyCount = contributionTotals.reduce(
        (count, total) => (total.currency === primary ? count : count + total.count),
        0,
      );

      return {
        settings: toSettingsDto(
          settingsRow ? toSettingsRecord(settingsRow) : defaultSettings(weddingId),
        ),
        items: (itemRows as ItemRow[]).map((r) => toItemDto(r, claimed.get(r.id) ?? 0)),
        gifts: gifts.entries,
        giftsHasMore: gifts.hasMore,
        // Read off the settings row already in hand. The sweep writes the summary
        // onto the one registry row it keeps, so this costs no extra D1 round
        // trip, and a wedding that was never swept simply has nothing here.
        giftSummary: settingsRow
          ? decodeGiftSummary(settingsRow.giftSummaryJson, settingsRow.giftSummaryAt)
          : null,
        currency,
        contributionsPrimaryMinor,
        contributionsOtherCurrencyCount,
      };
    }).pipe(Effect.withSpan("cire.registry.get"));
  },

  /**
   * Claims and contributions, merged and newest-first — the view the couple works
   * from after the day. Two queries rather than a SQL UNION: the tables carry
   * different columns, and the merge is a sort over one page's worth of rows.
   *
   * PAGINATED (P-C1). A wedding's gift log is unbounded — every household may
   * claim every item and contribute on top — so an unpaged read is an unbounded
   * response and an unbounded D1 result set.
   *
   * OFFSET, not keyset, deliberately. `created_at` is epoch SECONDS, so several
   * gifts sharing a timestamp is ordinary rather than exotic (a couple opening
   * the registry to a mailing list produces exactly that). A keyset cursor of
   * `created_at < :last` silently DROPS every row tied with the page boundary,
   * and the usual fix — an id tie-break — has nothing to break on here, because
   * the two id spaces come from different tables and have no shared order. The
   * offset ceiling (`MAX_GIFT_LOG_OFFSET`) is what keeps the read bounded.
   *
   * Each side reads `offset + limit + 1` rows: enough that the merge can serve
   * the requested window whichever table the newest rows came from, plus one to
   * decide `hasMore` without a count.
   */
  giftLog(
    weddingId: string,
    options?: { limit?: number; offset?: number },
  ): Effect.Effect<{ entries: GiftLogEntryDto[]; hasMore: boolean }, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const limit = clamp(options?.limit ?? GIFT_LOG_PAGE, 1, GIFT_LOG_PAGE);
      const offset = clamp(options?.offset ?? 0, 0, MAX_GIFT_LOG_OFFSET);
      const readAhead = offset + limit + 1;
      const claimRows = yield* dbQuery(() =>
        db
          .select({
            id: registryClaims.id,
            itemId: registryClaims.itemId,
            itemTitle: registryItems.title,
            familyId: registryClaims.familyId,
            familyName: families.familyName,
            displayName: registryClaims.displayName,
            quantity: registryClaims.quantity,
            status: registryClaims.status,
            note: registryClaims.note,
            thankedAt: registryClaims.thankedAt,
            createdAt: registryClaims.createdAt,
          })
          .from(registryClaims)
          .innerJoin(registryItems, eq(registryClaims.itemId, registryItems.id))
          .innerJoin(families, eq(registryClaims.familyId, families.id))
          .where(eq(registryClaims.weddingId, weddingId))
          .orderBy(desc(registryClaims.createdAt))
          .limit(readAhead)
          .all(),
      );
      const contributionRows = yield* dbQuery(() =>
        db
          .select({
            id: registryContributions.id,
            itemId: registryContributions.itemId,
            itemTitle: registryItems.title,
            familyId: registryContributions.familyId,
            familyName: families.familyName,
            displayName: registryContributions.displayName,
            status: registryContributions.status,
            note: registryContributions.message,
            amountMinor: registryContributions.amountMinor,
            currency: registryContributions.currency,
            primaryAmountMinor: registryContributions.primaryAmountMinor,
            primaryCurrency: registryContributions.primaryCurrency,
            fxRate: registryContributions.fxRate,
            thankedAt: registryContributions.thankedAt,
            createdAt: registryContributions.createdAt,
          })
          .from(registryContributions)
          // LEFT: a general cash gift has no item, and an item deleted after the
          // fact sets `item_id` NULL rather than erasing the gift.
          .leftJoin(registryItems, eq(registryContributions.itemId, registryItems.id))
          .innerJoin(families, eq(registryContributions.familyId, families.id))
          .where(
            and(
              eq(registryContributions.weddingId, weddingId),
              // A gift whose money never moved is not a gift. A bounced
              // bank debit or a session the guest abandoned leaves a `failed`
              // row, which is kept for the audit trail and the idempotency
              // anchor — but showing it to the couple would be telling them
              // somebody gave them money that nobody gave them, and inviting a
              // thank-you note for it. `refunded` is NOT hidden: that one did
              // happen, and then went back, and the couple should see both.
              ne(registryContributions.status, "failed"),
            ),
          )
          .orderBy(desc(registryContributions.createdAt))
          .limit(readAhead)
          .all(),
      );

      const claims: GiftLogEntryDto[] = (
        claimRows as Array<{
          id: string;
          itemId: string;
          itemTitle: string;
          familyId: string;
          familyName: string;
          displayName: string | null;
          quantity: number;
          status: string;
          note: string | null;
          thankedAt: Date | null;
          createdAt: Date;
        }>
      ).map((r) => ({
        kind: "claim" as const,
        id: r.id,
        itemId: r.itemId,
        itemTitle: r.itemTitle,
        familyId: r.familyId,
        familyName: r.familyName,
        displayName: r.displayName,
        quantity: r.quantity,
        status: r.status,
        note: r.note,
        amountMinor: null,
        currency: null,
        primaryAmountMinor: null,
        primaryCurrency: null,
        fxRate: null,
        thankedAt: r.thankedAt ? r.thankedAt.getTime() : null,
        createdAt: r.createdAt.getTime(),
      }));

      const contributions: GiftLogEntryDto[] = (
        contributionRows as Array<{
          id: string;
          itemId: string | null;
          itemTitle: string | null;
          familyId: string;
          familyName: string;
          displayName: string | null;
          status: string;
          note: string | null;
          amountMinor: number;
          currency: string;
          primaryAmountMinor: number | null;
          primaryCurrency: string | null;
          fxRate: string | null;
          thankedAt: Date | null;
          createdAt: Date;
        }>
      ).map((r) => ({
        kind: "contribution" as const,
        id: r.id,
        itemId: r.itemId,
        itemTitle: r.itemTitle,
        familyId: r.familyId,
        familyName: r.familyName,
        displayName: r.displayName,
        quantity: null,
        status: r.status,
        note: r.note,
        amountMinor: r.amountMinor,
        currency: r.currency,
        primaryAmountMinor: r.primaryAmountMinor,
        primaryCurrency: r.primaryCurrency,
        fxRate: r.fxRate,
        thankedAt: r.thankedAt ? r.thankedAt.getTime() : null,
        createdAt: r.createdAt.getTime(),
      }));

      // `merged` is built here and returned to nobody else, so sorting it in
      // place is not the shared-array aliasing hazard oxlint's `no-array-sort`
      // guards against — and `toSorted` is ES2023, past this package's ES2022 lib.
      const merged: GiftLogEntryDto[] = [...claims, ...contributions];
      merged.sort((a, b) => b.createdAt - a.createdAt);

      return {
        entries: merged.slice(offset, offset + limit),
        hasMore: merged.length > offset + limit,
      };
    }).pipe(Effect.withSpan("cire.registry.giftLog"));
  },

  /**
   * Upsert the settings row. Creates it on first write (absent row = defaults).
   *
   * Owns the cash-gifts invariant (S-M3): the switch that shows guests a
   * contribute button cannot be turned on unless Stripe can actually take a
   * charge. Enforcing it here rather than in the route means every caller gets
   * it — a guest paying into an account that cannot receive money is a refund
   * and a support case, not a validation nit.
   *
   * The same switch also owns the currency invariant. Charges are taken on the
   * connected account, so Stripe settles them in THAT account's currency, and a
   * session priced in anything else is converted on Stripe's terms or refused
   * outright. Turning cash gifts on while the two disagree would look fine in
   * the portal and then fail at Checkout, in front of a guest.
   *
   * Two organisers can have the settings open at once. `patch.expected` is how
   * a write says what it was looking at: each field named there must still hold
   * that value — or already hold the new one, so two people making the same
   * change, or a retried save whose first answer was lost, both go through —
   * or the whole write fails `SettingsChanged` and touches nothing. The check
   * sits in the upsert's own `WHERE`, so it is one statement and cannot race.
   * It keys on the fields' values rather than on `updated_at`, because the
   * Stripe writers and the retention sweep also bump `updated_at` and would
   * otherwise refuse a couple's save for a change they never made. A row that
   * does not exist yet takes the insert arm and is not checked: an absent row
   * reads as the defaults, and settings rows are never deleted short of the
   * wedding itself. A caller that sends no `expected` gets last-writer-wins.
   */
  updateSettings(
    weddingId: string,
    patch: UpdateRegistrySettingsPatch,
  ): Effect.Effect<
    RegistrySettingsDto,
    StripeNotReady | CurrencyMismatch | SettingsChanged,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();

      if (patch.cashGiftsEnabled === true) {
        // One PK-indexed read, and only on the write that asks for it. An absent
        // row means the registry was never opened, so certainly no Stripe.
        const [existing] = yield* dbQuery(() =>
          db
            .select({
              chargesEnabled: registrySettings.stripeChargesEnabled,
              defaultCurrency: registrySettings.stripeDefaultCurrency,
            })
            .from(registrySettings)
            .where(eq(registrySettings.weddingId, weddingId))
            .all(),
        );
        const stripe = existing as
          | { chargesEnabled: boolean; defaultCurrency: string | null }
          | undefined;
        if (!stripe?.chargesEnabled) {
          return yield* Effect.fail(new StripeNotReady());
        }
        // A null settlement currency means Stripe has not said yet, not that it
        // disagrees — an account can take charges before Stripe settles on one.
        // Only two known, different currencies are a refusal.
        if (stripe.defaultCurrency) {
          const wedding = yield* primaryCurrency(weddingId);
          if (stripe.defaultCurrency.toUpperCase() !== wedding.toUpperCase()) {
            return yield* Effect.fail(new CurrencyMismatch());
          }
        }
      }

      // The columns the conflict branch writes, typed off the table itself — a
      // partial insert IS an update set, so a key that isn't a column (or a
      // value the column can't hold) fails here rather than at the D1 boundary.
      const set: Partial<typeof registrySettings.$inferInsert> = { updatedAt: now };
      if (patch.published !== undefined) set.published = patch.published;
      if (patch.headline !== undefined) set.headline = patch.headline;
      if (patch.message !== undefined) set.message = patch.message;
      if (patch.cashGiftsEnabled !== undefined) set.cashGiftsEnabled = patch.cashGiftsEnabled;
      if (patch.shippingAddress !== undefined) set.shippingAddress = patch.shippingAddress;
      if (patch.shippingVisibleFrom !== undefined) {
        set.shippingVisibleFrom = patch.shippingVisibleFrom;
      }

      // A save that changes nothing and expects nothing reads the row instead
      // of writing it. The answer is the same, and an absent row already reads
      // as the defaults.
      const expectsSomething = SETTINGS_FIELDS.some(
        (field) => patch.expected?.[field] !== undefined,
      );
      if (Object.keys(set).length === 1 && !expectsSomething) {
        return toSettingsDto(yield* registryService.settingsOnly(weddingId));
      }

      // `IS` is SQLite's null-safe equality, so a field the caller saw as empty
      // matches a NULL column. Each value is bound through its column, which is
      // what turns a boolean into the 0/1 the column stores.
      const unchanged: SQL[] = [];
      for (const field of SETTINGS_FIELDS) {
        const seen = patch.expected?.[field];
        if (seen === undefined) continue;
        const column = registrySettings[field];
        const next = patch[field];
        unchanged.push(
          next === undefined
            ? sql`${column} is ${sql.param(seen, column)}`
            : sql`(${column} is ${sql.param(seen, column)} or ${column} is ${sql.param(next, column)})`,
        );
      }

      const [row] = yield* dbQuery(() =>
        db
          .insert(registrySettings)
          .values({
            weddingId,
            published: patch.published ?? false,
            headline: patch.headline ?? null,
            message: patch.message ?? null,
            cashGiftsEnabled: patch.cashGiftsEnabled ?? false,
            shippingAddress: patch.shippingAddress ?? null,
            shippingVisibleFrom: patch.shippingVisibleFrom ?? null,
            createdAt: now,
            updatedAt: now,
          })
          // `and()` of nothing is undefined, which drizzle writes as no WHERE.
          .onConflictDoUpdate({
            target: registrySettings.weddingId,
            set,
            setWhere: and(...unchanged),
          })
          .returning()
          .all(),
      );
      // No row back means the conflict arm's `WHERE` refused it: the row
      // exists and a field moved under the caller. The insert arm always
      // returns its row.
      if (!row) {
        const current = yield* registryService.settingsOnly(weddingId);
        return yield* Effect.fail(new SettingsChanged({ current: toSettingsDto(current) }));
      }
      return toSettingsDto(toSettingsRecord(row as SettingsRow));
    }).pipe(Effect.withSpan("cire.registry.updateSettings"));
  },

  /**
   * The settings row alone — one PK-indexed read, and the defaults when there
   * is no row.
   *
   * `get` returns the whole snapshot: every item, a page of the gift log, the
   * currency. Reading all of that to look at two Stripe booleans is the waste
   * this avoids — a caller that only needs the settings asks for the settings.
   */
  settingsOnly(weddingId: string): Effect.Effect<RegistrySettingsRecord, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).all(),
      );
      return row ? toSettingsRecord(row as SettingsRow) : defaultSettings(weddingId);
    }).pipe(Effect.withSpan("cire.registry.settingsOnly"));
  },

  /**
   * Remember the connected account this wedding just got, and its capabilities
   * as Stripe reported them at creation.
   *
   * `stripe_account_id` is written ONLY when the column is null. A wedding's
   * connected account is the couple's bank account by another name: overwriting
   * it would silently point every future gift at a different one, and the row it
   * replaced is the only record of where the last ones went. A wedding that
   * already has an account never reaches Stripe again — the caller reads this
   * row first and mints a fresh onboarding link for the account it finds.
   */
  attachStripeAccount(
    weddingId: string,
    account: {
      id: string;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      /** Upper-case ISO, or null when Stripe has not settled on one yet. */
      defaultCurrency?: string | null;
    },
  ): Effect.Effect<RegistrySettingsRecord, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();
      const [row] = yield* dbQuery(() =>
        db
          .insert(registrySettings)
          .values({
            weddingId,
            stripeAccountId: account.id,
            stripeChargesEnabled: account.chargesEnabled,
            stripePayoutsEnabled: account.payoutsEnabled,
            stripeDefaultCurrency: account.defaultCurrency ?? null,
            stripeAccountUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: registrySettings.weddingId,
            set: {
              // `coalesce` on the EXISTING value, so a second create can only
              // ever fill a null — never repoint a couple's payouts.
              stripeAccountId: sql`coalesce(${registrySettings.stripeAccountId}, ${account.id})`,
              // And the capabilities follow the id. Writing them
              // unconditionally would leave a row describing account A's id
              // beside account B's capabilities — the invariant that saves that
              // today lives in the caller, and a caller that does not exist yet
              // cannot be relied on to repeat it.
              stripeChargesEnabled: sql`case when ${registrySettings.stripeAccountId} is null then ${account.chargesEnabled} else ${registrySettings.stripeChargesEnabled} end`,
              stripePayoutsEnabled: sql`case when ${registrySettings.stripeAccountId} is null then ${account.payoutsEnabled} else ${registrySettings.stripePayoutsEnabled} end`,
              // And so does the settlement currency, for the same reason: it
              // describes the account the id names, and the two have to agree.
              stripeDefaultCurrency: sql`case when ${registrySettings.stripeAccountId} is null then ${account.defaultCurrency ?? null} else ${registrySettings.stripeDefaultCurrency} end`,
              stripeAccountUpdatedAt: now,
              updatedAt: now,
            },
          })
          .returning()
          .all(),
      );
      return toSettingsRecord(row as SettingsRow);
    }).pipe(Effect.withSpan("cire.registry.attachStripeAccount"));
  },

  /**
   * Cache what an `account.updated` webhook said about a connected account.
   *
   * Keyed on the ACCOUNT, not the wedding: the webhook names an account and
   * nothing else, and resolving it through metadata would trust a field the
   * couple's own onboarding can rewrite. Returns whether a row matched, so the
   * route can answer 200 either way (an event for an account we do not know is
   * not an error — it is a webhook endpoint shared with whatever else the
   * platform account does) while still saying so in a span.
   *
   * `cash_gifts_enabled` is deliberately NOT touched. That column is the
   * couple's INTENT; `stripe_charges_enabled` is Stripe's CAPABILITY. Clearing
   * intent because a capability lapsed would quietly turn the feature off for
   * good, and turning it back on when the capability returns would be us making
   * a decision they never made. The guest surface reads both.
   */
  applyStripeAccountState(account: {
    id: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    /**
     * The currency Stripe settles this account in, upper-case ISO, or null when
     * Stripe has not decided one yet. `undefined` means the caller read a
     * payload that did not mention it at all, and the stored value is left
     * exactly as it is.
     */
    defaultCurrency?: string | null;
    /**
     * When STRIPE said it, in seconds — the event's own `created`, never our
     * clock. Absent only for the live `…/stripe/refresh` read, which is by
     * definition current.
     */
    observedAt?: number;
  }): Effect.Effect<boolean, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();
      const observed = account.observedAt === undefined ? now : new Date(account.observedAt * 1000);
      const patch: StripeAccountStatePatch = {
        stripeChargesEnabled: account.chargesEnabled,
        stripePayoutsEnabled: account.payoutsEnabled,
        stripeAccountUpdatedAt: observed,
        updatedAt: now,
      };
      // Named only when the caller actually read a settlement currency off the
      // payload. A caller that saw no such field says nothing here rather than
      // writing null over what Stripe told us earlier.
      if (account.defaultCurrency !== undefined) {
        patch.stripeDefaultCurrency = account.defaultCurrency;
      }
      const rows = yield* dbQuery(() =>
        db
          .update(registrySettings)
          .set(patch)
          .where(
            and(
              eq(registrySettings.stripeAccountId, account.id),
              // MONOTONIC, and this is the whole point. Stripe does not
              // guarantee order and retries a failed delivery for three days,
              // so an older event carrying `charges_enabled: true` can arrive
              // after Stripe has disabled the account — and this column is the
              // only gate on whether a couple may show guests a contribute
              // button. Applying it would re-open a payment surface Stripe has
              // shut. A row is written only by something Stripe said LATER than
              // what it already holds.
              or(
                isNull(registrySettings.stripeAccountUpdatedAt),
                lte(registrySettings.stripeAccountUpdatedAt, observed),
              ),
            ),
          )
          .returning({ weddingId: registrySettings.weddingId })
          .all(),
      );
      return (rows as Array<{ weddingId: string }>).length > 0;
    }).pipe(Effect.withSpan("cire.registry.applyStripeAccountState"));
  },

  /**
   * The couple revoked cire's access to their connected account, from their own
   * Stripe dashboard. Stripe says so once, as `account.application.deauthorized`.
   *
   * Everything the platform could do with that account is gone with it: no
   * charge, no account link, not even a capability read. So the id is CLEARED
   * rather than flagged. Two things follow from that, and both are the point:
   *
   *  - the guest gate needs an account id, so the contribute button disarms in
   *    the same write. Left alone, a guest would reach a Checkout that refuses;
   *  - `attachStripeAccount` only ever fills a NULL id, so clearing it is also
   *    what lets the couple reconnect. A flag beside a stale id would wedge them
   *    on a dead account with no way back.
   *
   * `cash_gifts_enabled` is left alone, for the same reason `account.updated`
   * leaves it alone: it is the couple's intent, and revoking a key is not the
   * same as saying they never want gifts again. With no account the guest
   * surface is closed regardless, and reconnecting restores what they chose.
   *
   * NO monotonic guard, unlike `applyStripeAccountState`, and deliberately.
   * Deauthorization is terminal — after it, no `account.updated` can match a row
   * whose id is now NULL — so the ordering hazard runs one way only: a stale
   * `charges_enabled: true` arriving late must never re-open the surface, while
   * a deauthorization arriving late must always close it. Gating this write on a
   * timestamp would invert exactly that.
   *
   * Returns whether a row matched, so the caller can 200 either way: an event
   * for an account this platform does not know is not an error.
   */
  detachStripeAccount(input: {
    accountId: string;
    /** Stripe's own `created`, in seconds. Recorded, never used as a gate. */
    observedAt?: number;
  }): Effect.Effect<boolean, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();
      const observed = input.observedAt === undefined ? now : new Date(input.observedAt * 1000);
      const rows = yield* dbQuery(() =>
        db
          .update(registrySettings)
          .set({
            stripeAccountId: null,
            // What the cleared id leaves behind — see the column comments.
            stripeDeauthorizedAccountId: input.accountId,
            stripeDeauthorizedAt: observed,
            stripeChargesEnabled: false,
            stripePayoutsEnabled: false,
            stripeAccountUpdatedAt: observed,
            updatedAt: now,
          })
          .where(eq(registrySettings.stripeAccountId, input.accountId))
          .returning({ weddingId: registrySettings.weddingId })
          .all(),
      );
      return (rows as Array<{ weddingId: string }>).length > 0;
    }).pipe(Effect.withSpan("cire.registry.detachStripeAccount"));
  },

  /**
   * Everything a guest's "give money" request needs before it may reach Stripe:
   * the wedding, the account the charge belongs to, and the currency it is in.
   *
   * The gates are all here, in one read, because each of them is the difference
   * between a payment and a refund:
   *
   *  - the registry must be visible (published, entitled, real slug);
   *  - the family must belong to THIS wedding — a session names a household,
   *    not a wedding;
   *  - the couple must have said yes (`cash_gifts_enabled`) AND Stripe must be
   *    able to take the charge today (`stripe_charges_enabled`) AND there must
   *    be an account to take it into. All three, or the guest is sent away
   *    before their card is.
   *
   * A missing registry and a foreign family both fail as `RegistryNotVisible`,
   * which the route answers as the same 404 everything else does. Only the
   * cash-specific refusal is its own failure, because it is the one a guest
   * looking at a contribute button can actually act on.
   */
  contributionContext(input: {
    slug: string;
    familyId: string;
    /**
     * The line the guest aimed the money at, if they picked one. Checked here
     * rather than by the caller so it rides along with the family check instead
     * of costing a round trip of its own; an id that is not this wedding's
     * comes back as `null` rather than as a refusal.
     */
    itemId?: string | null;
  }): Effect.Effect<
    { weddingId: string; stripeAccountId: string; currency: string; itemId: string | null },
    RegistryNotVisible | CashGiftsUnavailable,
    DbService
  > {
    return Effect.gen(function* () {
      const { settings, weddingId, currency } = yield* resolveVisibleRegistry(input.slug);
      // Two independent point reads against the same wedding, so they go
      // together. The item check runs even on a request the family check is
      // about to turn away — one extra indexed read on a request that was never
      // going to charge, against a round trip saved on every one that does.
      const gates = yield* Effect.all(
        {
          familyBelongs: familyInWedding(weddingId, input.familyId),
          itemBelongs: input.itemId
            ? itemInWedding(weddingId, input.itemId)
            : Effect.succeed(false),
        },
        { concurrency: "unbounded" },
      );
      // The same shared check the list read and the writes use, so the three
      // gates cannot drift.
      if (!gates.familyBelongs) {
        return yield* Effect.fail(new RegistryNotVisible());
      }
      if (!settings.cashGiftsEnabled || !settings.stripeChargesEnabled) {
        return yield* Effect.fail(new CashGiftsUnavailable());
      }
      const stripeAccountId = settings.stripeAccountId;
      if (!stripeAccountId) return yield* Effect.fail(new CashGiftsUnavailable());
      return {
        weddingId,
        stripeAccountId,
        currency,
        // An item id that is not this wedding's is dropped, not refused: what
        // the guest is doing is giving money, and which line they aimed it at
        // is the smaller half of that.
        itemId: gates.itemBelongs ? (input.itemId ?? null) : null,
      };
    }).pipe(Effect.withSpan("cire.registry.contributionContext"));
  },

  /** Whether an item id is one of this wedding's — for a contribution TOWARDS a gift. */
  itemBelongsToWedding(input: {
    weddingId: string;
    itemId: string;
  }): Effect.Effect<boolean, never, DbService> {
    return itemInWedding(input.weddingId, input.itemId).pipe(
      Effect.withSpan("cire.registry.itemBelongsToWedding"),
    );
  },

  /**
   * Write the gift a completed Checkout Session paid for.
   *
   * IDEMPOTENT ON THE SESSION ID, which is `unique` on the column: Stripe
   * retries a delivery until it gets a 2xx, and at-least-once means a duplicate
   * is the ordinary case, not the edge. A second delivery of the same session
   * writes nothing and reports `false`.
   *
   * THE METADATA IS NOT TRUSTED ON ITS OWN. We wrote it at session creation, but
   * the event arrives on a webhook endpoint that also hears about sessions the
   * connected account created for itself — where the metadata is whatever the
   * account owner typed. So the wedding must actually own the account the event
   * came from, and the family must belong to that wedding. Either failing means
   * the row is not written and the caller is told, rather than a gift being
   * recorded against a household that never gave one.
   *
   * FX IS LEFT NULL, deliberately. The primary-currency equivalent comes from
   * the balance transaction's `exchange_rate`, which is not on this event; the
   * schema's four FX columns are all-or-nothing and null is the honest state
   * until that read lands. A gift in the wedding's own currency — the common
   * case — never needs them at all.
   */
  /**
   * The gift this guest already has a payment page open for, if there is one.
   *
   * WHY THIS EXISTS, and why a time bucket was not enough. The Stripe
   * idempotency key is derived from the request plus a coarse wall-clock
   * bucket, and a bucket has edges: two presses a second apart can land either
   * side of one, get different keys, and become two sessions and two charges
   * for one gift. This read has no edges. It asks D1 what we actually wrote,
   * scoped to the same household, the same wedding, the same item and the same
   * amount and words, and still `pending` — an attempt the guest has not
   * finished. The bucket stays as the second belt for the truly simultaneous
   * double-tap, where no row exists yet for either request to find.
   *
   * ONLY `pending` ROWS, and only recent ones: a settled gift must never hand
   * back a payment page, and an abandoned attempt from last week is a new gift
   * today, not a resumed one.
   */
  findReusableContribution(input: {
    weddingId: string;
    familyId: string;
    itemId: string | null;
    amountMinor: number;
    message: string | null;
    displayName: string | null;
    since: Date;
  }): Effect.Effect<{ sessionId: string } | null, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({ sessionId: registryContributions.stripeCheckoutSessionId })
          .from(registryContributions)
          .where(
            and(
              eq(registryContributions.weddingId, input.weddingId),
              eq(registryContributions.familyId, input.familyId),
              eq(registryContributions.status, "pending"),
              eq(registryContributions.amountMinor, input.amountMinor),
              input.itemId
                ? eq(registryContributions.itemId, input.itemId)
                : isNull(registryContributions.itemId),
              input.message === null
                ? isNull(registryContributions.message)
                : eq(registryContributions.message, input.message),
              input.displayName === null
                ? isNull(registryContributions.displayName)
                : eq(registryContributions.displayName, input.displayName),
              gte(registryContributions.createdAt, input.since),
              // A row whose session id is still NULL is an attempt that never
              // reached Stripe — there is no payment page to send anyone back
              // to, so it cannot be reused.
              isNotNull(registryContributions.stripeCheckoutSessionId),
            ),
          )
          // Newest first: if a guest somehow has two open attempts of the same
          // shape, the one they were just sent to is the one to send them back.
          .orderBy(desc(registryContributions.createdAt))
          .limit(1)
          .all(),
      );
      const rowsTyped = rows as Array<{ sessionId: string }>;
      return rowsTyped.length > 0 ? { sessionId: rowsTyped[0].sessionId } : null;
    }).pipe(Effect.withSpan("cire.registry.findReusableContribution"));
  },

  /**
   * Write the gift a guest is ABOUT to pay for, as `pending`.
   *
   * WHY THE ROW COMES FIRST, before Stripe is ever told anything about it.
   * Three findings pointed at the same shape:
   *
   *  - **Nothing a connected account can forge.** The webhook endpoint
   *    also hears about sessions the couple's own account created for itself,
   *    where every metadata field is whatever its owner typed. Settling against
   *    a row WE wrote means a forged session settles nothing: there is no row
   *    with that id, and one cannot be conjured from the event.
   *  - **Nothing personal in Stripe's metadata.** The guest's note and
   *    the name they chose stay in D1 under a basis we have declared. Stripe is
   *    told an opaque id and the money; it needs nothing else to reconcile.
   *  - **Somewhere for a status to go.** A refund or a failed delayed
   *    debit has a row to move, instead of an insert that can only ever add.
   *
   * AND BEFORE STRIPE, not after it. The id is minted here, handed to Stripe
   * as `client_reference_id`, and the session attached afterwards by
   * `attachCheckoutSession`. Waiting for Stripe to hand back a session id would
   * leave a window in which a session exists at Stripe that we have never heard
   * of: evict the Worker between the two and the settle webhook names a row
   * that does not exist, so a gift that was actually paid is a gift we cannot
   * show anyone.
   *
   * `onConflictDoNothing` is on the PRIMARY KEY, which is not idempotency —
   * the id is fresh per request, so a conflict means a collision, and the
   * honest answer is `false` and no payment page. Retry safety comes from
   * Stripe's own idempotency key plus the reuse lookup above. Never a throw.
   */
  createPendingContribution(input: {
    id: string;
    weddingId: string;
    familyId: string;
    itemId: string | null;
    amountMinor: number;
    currency: string;
    message: string | null;
    displayName: string | null;
  }): Effect.Effect<boolean, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();
      const inserted = yield* dbQuery(() =>
        db
          .insert(registryContributions)
          .values({
            id: input.id,
            weddingId: input.weddingId,
            itemId: input.itemId,
            familyId: input.familyId,
            status: "pending",
            amountMinor: input.amountMinor,
            currency: input.currency,
            // Nothing to write yet — Stripe has not been asked.
            stripeCheckoutSessionId: null,
            stripePaymentIntentId: null,
            message: input.message,
            displayName: input.displayName,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: registryContributions.id })
          .returning({ id: registryContributions.id })
          .all(),
      );
      return (inserted as Array<{ id: string }>).length > 0;
    }).pipe(Effect.withSpan("cire.registry.createPendingContribution"));
  },

  /**
   * Record which Checkout session the gift row above ended up as.
   *
   * The second half of the inverted order. Between the insert and this call the
   * row is a gift attempt with no session — visible to the couple, ignored by
   * the reuse lookup, and closed by the route if Stripe never answers.
   *
   * Three outcomes, and the interesting one is `duplicate`. The session id is
   * UNIQUE, so if some other row already holds it this row must not: that
   * happens when two requests raced, Stripe's idempotency handed both the SAME
   * session, and only one of them can be the gift. The loser closes ITSELF as
   * `failed` — it is an attempt whose money will move under the winner's row —
   * and the guest is still sent to the same payment page, because it is the
   * same session either way.
   *
   * Calling it twice with the same pair is `attached` both times: the second
   * call's guarded update matches nothing, and the re-read finds the session
   * already on the row.
   */
  attachCheckoutSession(input: {
    contributionId: string;
    checkoutSessionId: string;
  }): Effect.Effect<"attached" | "duplicate" | "missing", never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const attached = yield* dbQuery(() =>
        db
          .update(registryContributions)
          .set({ stripeCheckoutSessionId: input.checkoutSessionId, updatedAt: new Date() })
          .where(sessionAdoptionGuard(input.contributionId, input.checkoutSessionId))
          .returning({ id: registryContributions.id })
          .all(),
      );
      if ((attached as Array<{ id: string }>).length > 0) return "attached";

      // The guard refused. Which of its three clauses failed decides the
      // answer, so read the row back rather than guess.
      const rows = yield* dbQuery(() =>
        db
          .select({
            id: registryContributions.id,
            sessionId: registryContributions.stripeCheckoutSessionId,
          })
          .from(registryContributions)
          .where(eq(registryContributions.id, input.contributionId))
          .limit(1)
          .all(),
      );
      const row = (rows as Array<{ id: string; sessionId: string | null }>)[0];
      if (!row) return "missing";
      if (row.sessionId === input.checkoutSessionId) return "attached";

      yield* Effect.logWarning("checkout session already belongs to another gift", {
        contributionId: input.contributionId,
        heldSessionId: row.sessionId,
      });
      // Close the loser, but only while it is still session-less: a row that
      // has since acquired a session of its own is somebody's live attempt.
      yield* dbQuery(() =>
        db
          .update(registryContributions)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(registryContributions.id, input.contributionId),
              eq(registryContributions.status, "pending"),
              isNull(registryContributions.stripeCheckoutSessionId),
            ),
          )
          .run(),
      );
      return "duplicate";
    }).pipe(Effect.withSpan("cire.registry.attachCheckoutSession"));
  },

  /**
   * Close a gift attempt that never reached Stripe.
   *
   * The other end of the window `createPendingContribution` opens: the row is
   * written, Stripe refuses, and the guest gets a 502. Without this the row
   * would sit `pending` — carrying the note and the name they typed — until the
   * retention sweep a year later, and would be counted as an open attempt by
   * anything that counts them.
   *
   * Guarded on `pending` AND on a NULL session, so it can only ever close a row
   * that is still in that window. Never a throw; nothing to report.
   */
  abandonPendingContribution(input: {
    contributionId: string;
  }): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* dbQuery(() =>
        db
          .update(registryContributions)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(registryContributions.id, input.contributionId),
              eq(registryContributions.status, "pending"),
              isNull(registryContributions.stripeCheckoutSessionId),
            ),
          )
          .run(),
      );
    }).pipe(Effect.withSpan("cire.registry.abandonPendingContribution"));
  },

  /**
   * Settle the gift a completed Checkout Session paid for.
   *
   * Moves a `pending` row and only a `pending` row. Stripe delivers at least
   * once and retries until it gets a 2xx, so a second delivery finding the row
   * already settled is the ordinary case, not an error — it answers
   * `duplicate` and writes nothing.
   *
   * THREE THINGS ARE CHECKED, and none of them trusts the event's metadata
   * beyond the id it carries:
   *
   *  - a row with that id exists (so a session we never created settles
   *    nothing);
   *  - the session id on the row is the one that just completed (so one
   *    contribution cannot be settled by another session's event);
   *  - the row's wedding owns the connected account the event arrived on (so
   *    an account cannot settle another couple's gift).
   *
   * FX IS LEFT NULL, deliberately: the primary-currency equivalent comes from
   * the balance transaction, which is not on this event, and the schema's four
   * FX columns are all-or-nothing.
   */
  settleContribution(input: {
    contributionId: string;
    checkoutSessionId: string;
    stripeAccountId: string;
    paymentIntentId: string | null;
    paid: boolean;
    /** What Stripe says was actually charged, when the event carries it. */
    paidAmountMinor: number | null;
    paidCurrency: string | null;
  }): Effect.Effect<"settled" | "duplicate" | "unknown" | "rejected", never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const pending = yield* contributionOnAccount(
        eq(registryContributions.id, input.contributionId),
        input.stripeAccountId,
      );
      if (!pending) return "unknown";
      // A NULL session id is not a mismatch: it is a row written before Stripe
      // answered, and this event is the first news of which session it became.
      // Any OTHER session id still means one gift is being settled by another
      // gift's event.
      if (pending.sessionId !== null && pending.sessionId !== input.checkoutSessionId) {
        return "rejected";
      }
      if (!pending.ownedAccountId) return "rejected";
      if (pending.status !== "pending") return "duplicate";

      // The row's amount is what the guest was shown; the session's is
      // what Stripe charged. Nothing in the checkout we build can make them
      // disagree — one fixed line item, no promotion codes, no adjustable
      // quantity — so a disagreement means something changed that we do not
      // model, and the gift log would quietly record a figure nobody paid.
      //
      // It is logged, not corrected and not refused. The money has moved
      // either way, and a row the couple can see beats a webhook we keep
      // rejecting; the as-given figure stays as given, because that is the
      // number the guest agreed to.
      const amountDiffers =
        input.paidAmountMinor !== null && input.paidAmountMinor !== pending.amountMinor;
      const currencyDiffers =
        input.paidCurrency !== null &&
        input.paidCurrency.toUpperCase() !== pending.currency.toUpperCase();
      if (amountDiffers || currencyDiffers) {
        yield* Effect.logWarning("contribution settled at an amount it was not opened at", {
          contributionId: pending.id,
          expectedMinor: pending.amountMinor,
          expectedCurrency: pending.currency,
          paidMinor: input.paidAmountMinor,
          paidCurrency: input.paidCurrency,
        });
      }

      // Adopting means writing the UNIQUE column, so the write carries the
      // guard and its result is checked; the ordinary settle does not.
      const adopting = pending.sessionId === null;
      const patch: ContributionPatch = {
        // `paid` is the only status that means the money moved. A completed
        // session that is not paid yet (a delayed bank debit) stays pending
        // so the couple see it without being told it has landed — the
        // `async_payment_succeeded` or `async_payment_failed` that follows
        // days later is what moves it off pending.
        status: input.paid ? "succeeded" : "pending",
        stripePaymentIntentId: input.paymentIntentId,
        updatedAt: new Date(),
      };
      if (adopting) patch.stripeCheckoutSessionId = input.checkoutSessionId;
      const updated = yield* dbQuery(() =>
        db
          .update(registryContributions)
          .set(patch)
          .where(
            adopting
              ? sessionAdoptionGuard(pending.id, input.checkoutSessionId)
              : eq(registryContributions.id, pending.id),
          )
          .returning({ id: registryContributions.id })
          .all(),
      );
      if ((updated as Array<{ id: string }>).length === 0) {
        // Only reachable while adopting: another row claimed this session id
        // between the read and the write, so this row is not the one that was
        // paid. Nothing is written, and Stripe is still answered — a retry
        // would only lose the same race again.
        yield* Effect.logError("settle lost the race to adopt a checkout session", {
          contributionId: pending.id,
          checkoutSessionId: input.checkoutSessionId,
        });
        return "rejected";
      }
      return input.paid ? "settled" : "duplicate";
    }).pipe(Effect.withSpan("cire.registry.settleContribution"));
  },

  /**
   * Close a gift whose money is never going to move.
   *
   * Two Stripe events land here, and they are the same fact twice: a delayed
   * bank debit that bounced (`checkout.session.async_payment_failed`), and a
   * session the guest walked away from that Stripe eventually expired
   * (`checkout.session.expired`). Both leave a `pending` row that would
   * otherwise sit in the table forever, and — until the sweep a year later —
   * carry the guest's note and chosen name for a gift that never happened.
   *
   * ONLY A PENDING ROW MOVES. A settled gift cannot be un-settled by a late or
   * replayed expiry, which is the shape that matters: `expired` is a plausible
   * thing for a hostile connected account to send, and a webhook that could
   * turn `succeeded` into `failed` on receipt of it would be a way to make a
   * couple's gift vanish. The same three checks the settle path runs — row
   * exists, session matches, account owns the row's wedding — run here.
   *
   * The row is kept, not deleted. A delete would be the same forged-event
   * problem with no way back, and the row is also the idempotency anchor: the
   * `unique` session id is what makes the second delivery a no-op rather than a
   * second gift.
   */
  failContribution(input: {
    contributionId: string;
    checkoutSessionId: string;
    stripeAccountId: string;
  }): Effect.Effect<"failed" | "ignored" | "unknown" | "rejected", never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const row = yield* contributionOnAccount(
        eq(registryContributions.id, input.contributionId),
        input.stripeAccountId,
      );
      if (!row) return "unknown";
      // As in the settle path: NULL is a row that never heard back from Stripe,
      // and an `expired` naming it is exactly how such a row gets closed.
      if (row.sessionId !== null && row.sessionId !== input.checkoutSessionId) return "rejected";
      if (!row.ownedAccountId) return "rejected";
      // Already settled, already failed, already refunded: nothing to move, and
      // a redelivery of an event we acted on weeks ago is the ordinary case.
      if (row.status !== "pending") return "ignored";

      const adopting = row.sessionId === null;
      const patch: ContributionPatch = { status: "failed", updatedAt: new Date() };
      if (adopting) patch.stripeCheckoutSessionId = input.checkoutSessionId;
      const updated = yield* dbQuery(() =>
        db
          .update(registryContributions)
          .set(patch)
          .where(
            adopting
              ? sessionAdoptionGuard(row.id, input.checkoutSessionId)
              : eq(registryContributions.id, row.id),
          )
          .returning({ id: registryContributions.id })
          .all(),
      );
      if ((updated as Array<{ id: string }>).length === 0) {
        // Adopting only, same race as settle: the session belongs to another
        // row, so closing this one against it would be closing the wrong gift.
        yield* Effect.logError("expiry lost the race to adopt a checkout session", {
          contributionId: row.id,
          checkoutSessionId: input.checkoutSessionId,
        });
        return "rejected";
      }
      return "failed";
    }).pipe(Effect.withSpan("cire.registry.failContribution"));
  },

  /**
   * Record money that went back.
   *
   * FOUND BY PAYMENT INTENT, because that is all a refund event carries. Stripe
   * does not thread the checkout session through to `charge.refunded`, and the
   * connected account's own metadata is not evidence of anything — so the
   * payment intent the settle path wrote is the link, and migration 0058 is the
   * index that keeps this read off a full scan.
   *
   * ONLY A SUCCEEDED ROW MOVES: a refund of something never settled is either a
   * replay or an event about a charge that is not a wedding gift at all, and
   * neither should write.
   *
   * AND ONLY WHEN THERE IS EXACTLY ONE. The intent column is
   * indexed, not unique — 0058 argues why, and the argument holds: a UNIQUE
   * would turn a future basket or a retried intent into an insert that fails at
   * 2 a.m. inside a webhook, on a gift that was actually paid. What that leaves
   * is a read that can come back with two rows, and this one refuses them:
   * `ambiguous`, an error in the log naming both ids, and nothing written.
   *
   * PARTIAL AND FULL REFUNDS BOTH LAND HERE, and they part company only at the
   * status. A full refund moves the row to `refunded`, which is what takes it
   * out of the settled total. A partial one leaves the status at `succeeded`,
   * because the couple did receive the rest — but it still records
   * `refunded_amount_minor`, so the row stops claiming the whole gift survived.
   * Routing both through one lookup is also what gives a partial refund the
   * ownership and ambiguity checks.
   *
   * `amount_minor` is never rewritten, either way: it is what the guest gave,
   * and netting it off would rewrite history in the couple's own record.
   *
   * THE RECORDED AMOUNT ONLY EVER GROWS. Stripe's `amount_refunded` is the
   * running total across every refund on the charge, and two deliveries can
   * arrive out of order, so a figure at or below what the row already holds is
   * an older event and is not written.
   *
   * An event carrying no usable amount still moves the status on a full refund;
   * the column stays NULL, which reads as "not recorded" rather than as zero.
   */
  refundContribution(input: {
    paymentIntentId: string;
    stripeAccountId: string;
    /**
     * Stripe's `charge.amount_refunded`, in the charge's own currency — the one
     * `coalesce(primary_currency, currency)` names, since a refund is always
     * denominated in what the account settled. `null` where the event carried
     * no usable number.
     */
    refundedAmountMinor: number | null;
    /** Stripe's `charge.refunded`: the whole charge went back, not part of it. */
    fullyRefunded: boolean;
  }): Effect.Effect<
    "refunded" | "partial" | "ignored" | "unknown" | "rejected" | "ambiguous",
    never,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* contributionsOnAccount(
        and(
          eq(registryContributions.stripePaymentIntentId, input.paymentIntentId),
          // Defensive, not decorative: the column is nullable, and a NULL never
          // equals anything in SQL, but the intent is that a pending row with no
          // intent yet can never be matched by a refund.
          ne(registryContributions.status, "pending"),
        ) as SQL,
        input.stripeAccountId,
        // Two, because two is all it takes to know the answer is not one.
        2,
      );
      if (rows.length > 1) {
        // The column is indexed, not unique, and deliberately so — see
        // migration 0058. So the read has to carry the check the constraint
        // does not: more than one gift on this intent means the refund names a
        // row we cannot pick, and picking the first would move somebody's gift
        // to `refunded` on the strength of an ORDER BY nobody wrote.
        //
        // Nothing is written. The event is still acknowledged, because a 500
        // would only buy the same undecidable read on Stripe's retry schedule
        // for the next three days; the log is the thing that wants a human.
        yield* Effect.logError("refund names more than one contribution", {
          paymentIntentId: input.paymentIntentId,
          stripeAccountId: input.stripeAccountId,
          contributionIds: rows.map((candidate) => candidate.id),
        });
        return "ambiguous";
      }
      const row = rows[0];
      if (!row) return "unknown";
      if (!row.ownedAccountId) return "rejected";
      if (row.status !== "succeeded") return "ignored";

      const refunded = refundedAmountOf(input.refundedAmountMinor);
      // Cumulative and monotonic: anything at or below what the row already
      // holds is an older delivery of a total already recorded.
      const advances = refunded !== null && refunded > (row.refundedAmountMinor ?? 0);
      if (!input.fullyRefunded && !advances) {
        yield* Effect.logWarning("partial refund carried no new amount", {
          paymentIntentId: input.paymentIntentId,
          stripeAccountId: input.stripeAccountId,
          contributionId: row.id,
          recordedAmountMinor: row.refundedAmountMinor,
        });
        return "partial";
      }

      const patch: RefundPatch = { updatedAt: new Date() };
      if (advances) patch.refundedAmountMinor = refunded;
      if (input.fullyRefunded) patch.status = "refunded";

      yield* dbQuery(() =>
        db
          .update(registryContributions)
          .set(patch)
          .where(eq(registryContributions.id, row.id))
          .run(),
      );
      return input.fullyRefunded ? "refunded" : "partial";
    }).pipe(Effect.withSpan("cire.registry.refundContribution"));
  },

  /**
   * A guest's bank pulled a gift back while it decides whether to keep it.
   *
   * Found by payment intent, exactly as a refund is, and carrying the same
   * ambiguity check for the same reason: the column is indexed and not unique,
   * so two gifts on one intent means the event names a row nothing here can
   * pick, and picking one would move somebody else's gift.
   *
   * The three transitions, and why each is the one it is:
   *
   *  - `opened` moves a `succeeded` gift to `disputed`. The money is out of the
   *    couple's balance today, so a log still reading "Received" is telling them
   *    something untrue about their own bank account.
   *  - `won` moves it back to `succeeded`. The bank sided with the couple and
   *    the money returns; a gift that survived a dispute is a gift.
   *  - `lost` moves it to `refunded`, which is what it has become — the guest
   *    has their money and the couple does not.
   *
   * A `lost` may act on a `succeeded` row as well as a `disputed` one, because
   * the `created` delivery can be the one that failed while `closed` got
   * through, and a gift the couple no longer has must not stay in their total on
   * the strength of a missed webhook. Nothing else moves: a `refunded` or
   * `failed` row is already at an ending, and `pending` never held any money.
   */
  disputeContribution(input: {
    paymentIntentId: string;
    stripeAccountId: string;
    resolution: "opened" | "won" | "lost";
  }): Effect.Effect<
    "disputed" | "restored" | "refunded" | "ignored" | "unknown" | "rejected" | "ambiguous",
    never,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* contributionsOnAccount(
        and(
          eq(registryContributions.stripePaymentIntentId, input.paymentIntentId),
          ne(registryContributions.status, "pending"),
        ) as SQL,
        input.stripeAccountId,
        2,
      );
      if (rows.length > 1) {
        yield* Effect.logError("dispute names more than one contribution", {
          paymentIntentId: input.paymentIntentId,
          stripeAccountId: input.stripeAccountId,
          contributionIds: rows.map((candidate) => candidate.id),
        });
        return "ambiguous";
      }
      const row = rows[0];
      if (!row) return "unknown";
      // The join found no settings row holding this account, so the gift does
      // not belong to the account the event came from. Same refusal a refund
      // makes, and for the same reason.
      if (!row.ownedAccountId) return "rejected";

      const next =
        input.resolution === "opened"
          ? row.status === "succeeded"
            ? "disputed"
            : null
          : input.resolution === "won"
            ? row.status === "disputed"
              ? "succeeded"
              : null
            : row.status === "disputed" || row.status === "succeeded"
              ? "refunded"
              : null;
      if (!next) return "ignored";

      yield* dbQuery(() =>
        db
          .update(registryContributions)
          .set({ status: next, updatedAt: new Date() })
          // The status is re-checked in the predicate, not just read above: two
          // dispute deliveries for one charge can be in flight together, and the
          // read has already happened by the time either writes.
          .where(
            and(eq(registryContributions.id, row.id), eq(registryContributions.status, row.status)),
          )
          .run(),
      );
      return next === "disputed" ? "disputed" : next === "refunded" ? "refunded" : "restored";
    }).pipe(Effect.withSpan("cire.registry.disputeContribution"));
  },

  createItem(
    input: CreateRegistryItemInput,
  ): Effect.Effect<
    RegistryItemDto,
    ImageKeyNotInWedding | InvalidQuantity | RegistryItemLimitReached,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      if (input.imageKey && !imageKeyBelongsTo(input.weddingId, input.imageKey)) {
        return yield* Effect.fail(new ImageKeyNotInWedding());
      }
      if (!inQuantityRange(input.quantityWanted, 1, Number.MAX_SAFE_INTEGER)) {
        return yield* Effect.fail(new InvalidQuantity());
      }
      // One aggregate, not a full column scan (P-W3), and it answers both
      // questions the insert has: is the wedding at its ceiling, and what is the
      // next sort_order. Reading every row's sort_order to take a max was the
      // whole list on every create (S-L4 added the ceiling that made it worse).
      const [agg] = yield* dbQuery(() =>
        db
          .select({
            count: sql<number>`count(*)`,
            maxSort: sql<number>`coalesce(max(${registryItems.sortOrder}), -1)`,
          })
          .from(registryItems)
          .where(eq(registryItems.weddingId, input.weddingId))
          .all(),
      );
      const { count, maxSort } = (agg as { count: number; maxSort: number } | undefined) ?? {
        count: 0,
        maxSort: -1,
      };
      if (Number(count) >= MAX_ITEMS_PER_WEDDING) {
        return yield* Effect.fail(new RegistryItemLimitReached());
      }
      const now = new Date();
      const row: ItemRow = {
        id: `reg_${crypto.randomUUID()}`,
        weddingId: input.weddingId,
        kind: input.kind ?? "product",
        title: input.title,
        description: input.description,
        imageKey: input.imageKey,
        imageCrop: null,
        externalUrl: input.externalUrl,
        priceMinor: input.priceMinor,
        quantityWanted: input.quantityWanted,
        allowPartial: false,
        targetMinor: null,
        category: input.category,
        sortOrder: Number(maxSort) + 1,
        createdAt: now,
        updatedAt: now,
      };
      yield* dbQuery(() => db.insert(registryItems).values(row).run());
      return toItemDto(row, 0);
    }).pipe(Effect.withSpan("cire.registry.createItem"));
  },

  updateItem(input: {
    weddingId: string;
    itemId: string;
    patch: UpdateRegistryItemPatch;
  }): Effect.Effect<
    RegistryItemDto,
    ImageKeyNotInWedding | InvalidQuantity | RegistryItemNotInWedding,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, patch } = input;

      if (patch.imageKey && !imageKeyBelongsTo(weddingId, patch.imageKey)) {
        return yield* Effect.fail(new ImageKeyNotInWedding());
      }
      if (patch.quantityWanted !== undefined) {
        if (!inQuantityRange(patch.quantityWanted, 1, Number.MAX_SAFE_INTEGER)) {
          return yield* Effect.fail(new InvalidQuantity());
        }
      }

      // Typed off the table, as in `updateSettings` above.
      const set: Partial<typeof registryItems.$inferInsert> = { updatedAt: new Date() };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.imageKey !== undefined) set.imageKey = patch.imageKey;
      if (patch.imageCrop !== undefined) set.imageCrop = patch.imageCrop;
      if (patch.externalUrl !== undefined) set.externalUrl = patch.externalUrl;
      if (patch.priceMinor !== undefined) set.priceMinor = patch.priceMinor;
      if (patch.quantityWanted !== undefined) set.quantityWanted = patch.quantityWanted;
      if (patch.category !== undefined) set.category = patch.category;

      // One round trip (as budgetService.updateItem): RETURNING reports whether
      // an (item, wedding) row existed, so there is no separate existence SELECT.
      const [updated] = yield* dbQuery(() =>
        db
          .update(registryItems)
          .set(set)
          .where(and(eq(registryItems.id, itemId), eq(registryItems.weddingId, weddingId)))
          .returning()
          .all(),
      );
      if (!updated) return yield* Effect.fail(new RegistryItemNotInWedding());
      // The claimed sum for the ONE item that changed (P-W4). The wedding-wide
      // GROUP BY this used to call built a map of every item's claims to read a
      // single key out of it.
      const [claimedRow] = yield* dbQuery(() =>
        db
          .select({ claimed: sql<number>`coalesce(sum(${registryClaims.quantity}), 0)` })
          .from(registryClaims)
          .where(
            and(
              eq(registryClaims.weddingId, weddingId),
              eq(registryClaims.itemId, itemId),
              sql`${registryClaims.status} <> 'released'`,
            ),
          )
          .all(),
      );
      const claimed = Number((claimedRow as { claimed: number } | undefined)?.claimed ?? 0) || 0;
      return toItemDto(updated as ItemRow, claimed);
    }).pipe(Effect.withSpan("cire.registry.updateItem"));
  },

  /**
   * Delete an item and report the R2 key it was holding, and whether that key
   * is now unreferenced.
   *
   * The ROUTE reaps the object (best-effort, outside this Effect's requirements)
   * — this service stays DB-only, exactly as `eventImageService` keeps its R2
   * work in the module that owns the bucket. But whether the object may be
   * reaped is a DB question, so it is answered here, right after the delete
   * (S-M1): nothing stops two items naming the same key — duplicate an item,
   * or paste the same shop link twice and save it once — and reaping on the
   * first delete would blank the survivor's picture. Counting AFTER the delete
   * and in the same step is what makes the answer true at reap time.
   *
   * The count is scoped to the wedding, which is complete rather than merely
   * cheap: `imageKeyBelongsTo` refuses any key whose middle segment is another
   * wedding, so no row outside this wedding can hold this key. It also lets the
   * `wedding_id` index do the work.
   */
  removeItem(
    weddingId: string,
    itemId: string,
  ): Effect.Effect<
    { imageKey: string | null; imageKeyOrphaned: boolean },
    RegistryItemNotInWedding,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Claims cascade with the item; contributions do NOT — their `item_id` is
      // ON DELETE SET NULL, so removing a listing never erases a record of money
      // someone actually sent.
      const [removed] = yield* dbQuery(() =>
        db
          .delete(registryItems)
          .where(and(eq(registryItems.id, itemId), eq(registryItems.weddingId, weddingId)))
          .returning({ id: registryItems.id, imageKey: registryItems.imageKey })
          .all(),
      );
      if (!removed) return yield* Effect.fail(new RegistryItemNotInWedding());
      const imageKey = (removed as { imageKey: string | null }).imageKey;
      if (!imageKey) return { imageKey: null, imageKeyOrphaned: false };
      const [row] = yield* dbQuery(() =>
        db
          .select({ total: sql<number>`count(*)` })
          .from(registryItems)
          .where(and(eq(registryItems.weddingId, weddingId), eq(registryItems.imageKey, imageKey)))
          .all(),
      );
      const remaining = Number((row as { total: number } | undefined)?.total ?? 0) || 0;
      return { imageKey, imageKeyOrphaned: remaining === 0 };
    }).pipe(Effect.withSpan("cire.registry.removeItem"));
  },

  reorderItems(
    weddingId: string,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Each id gets its array index as sort_order, scoped to the wedding so a
      // foreign id is a no-op UPDATE rather than a write. commitGroupedBatches,
      // not db.transaction(): D1's only atomic primitive is batch(), and the
      // write set scales with the list length so it must chunk under the
      // 50-statement cap. Singleton groups — each UPDATE is independent.
      yield* dbQuery(() =>
        commitGroupedBatches(
          db,
          orderedIds.map((id, index) => [
            db
              .update(registryItems)
              .set({ sortOrder: index })
              .where(and(eq(registryItems.id, id), eq(registryItems.weddingId, weddingId))),
          ]),
        ),
      );
    }).pipe(Effect.withSpan("cire.registry.reorderItems"));
  },

  /**
   * Claim (or re-claim) an item for a household.
   *
   * ONE statement, deliberately. SQLite has no row lock a read-then-write can
   * rely on, and two guests clicking the last item at the same moment is the
   * ordinary case for a registry, not an edge case. The INSERT..SELECT's WHERE
   * re-evaluates the remaining quantity as part of the write, so a claim that
   * would take the item past `quantity_wanted` inserts zero rows instead of
   * over-subscribing it.
   *
   * The subquery excludes THIS household's own row (`family_id <> ?`), so a
   * household raising its own quantity is measured against everyone else's
   * claims — which is what makes the same statement serve both the first claim
   * and a later change, via the ON CONFLICT arm.
   *
   * The same WHERE also proves the household belongs to this wedding (S-H2). A
   * guest session names a `family_id`; without the EXISTS, a leaked id from
   * another wedding would write a claim row carrying THIS wedding's `wedding_id`
   * and a foreign family's — a cross-tenant row that then shows up in the
   * couple's gift log under a household they have never heard of.
   */
  claim(input: {
    weddingId: string;
    itemId: string;
    familyId: string;
    quantity: number;
    status: Exclude<RegistryClaimStatus, "released">;
    note: string | null;
    displayName: string | null;
  }): Effect.Effect<
    void,
    FamilyNotInWedding | InvalidQuantity | ItemFullyClaimed | RegistryItemNotInWedding,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, familyId, quantity, status, note, displayName } = input;
      if (!inQuantityRange(quantity, MIN_CLAIM_QUANTITY, MAX_CLAIM_QUANTITY)) {
        return yield* Effect.fail(new InvalidQuantity());
      }
      const id = `rcl_${crypto.randomUUID()}`;
      // `integer({ mode: "timestamp" })` is epoch SECONDS in drizzle-sqlite. This
      // statement writes those columns directly rather than through a Date-valued
      // insert, so it must use the same unit — pinned by a test, because getting
      // it wrong stores milliseconds and dates the gift log to the year 58000.
      const now = toEpochSeconds(new Date());

      const written = yield* dbQuery(() =>
        db.all(sql`
          INSERT INTO ${registryClaims}
            (id, wedding_id, item_id, family_id, quantity, status, note, display_name,
             created_at, updated_at)
          SELECT ${id}, ri.wedding_id, ri.id, ${familyId}, ${quantity}, ${status},
                 ${note}, ${displayName}, ${now}, ${now}
          FROM ${registryItems} ri
          WHERE ri.id = ${itemId}
            AND ri.wedding_id = ${weddingId}
            AND EXISTS (
                  SELECT 1 FROM ${families} f
                  WHERE f.id = ${familyId} AND f.wedding_id = ${weddingId}
                )
            AND ${quantity} + coalesce((
                  SELECT sum(rc.quantity) FROM ${registryClaims} rc
                  WHERE rc.item_id = ri.id
                    AND rc.status <> 'released'
                    AND rc.family_id <> ${familyId}
                ), 0) <= ri.quantity_wanted
          ON CONFLICT (item_id, family_id) DO UPDATE SET
            quantity = excluded.quantity,
            status = excluded.status,
            note = excluded.note,
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
          RETURNING id
        `),
      );
      // RETURNING is what makes this decidable: an empty result means the guard
      // refused the write. Re-reading the (item, family) row instead would be
      // WRONG — a household that had released this item still has a row, so a
      // refused re-claim would read as a success.
      if ((written as unknown[]).length > 0) return;

      // Nothing written means one of three things; only the failure path pays
      // for telling them apart.
      const { familyRows, itemRows } = yield* Effect.all(
        {
          itemRows: dbQuery(() =>
            db
              .select({ id: registryItems.id })
              .from(registryItems)
              .where(and(eq(registryItems.id, itemId), eq(registryItems.weddingId, weddingId)))
              .all(),
          ),
          familyRows: dbQuery(() =>
            db
              .select({ id: families.id })
              .from(families)
              .where(and(eq(families.id, familyId), eq(families.weddingId, weddingId)))
              .all(),
          ),
        },
        { concurrency: "unbounded" },
      );
      // FAMILY FIRST, and the order is the security property (S-M1). A cookie
      // names a household, not a wedding, so a holder of ANY valid session can
      // point it at any slug. Answering `RegistryItemNotInWedding` first told
      // them whether the item id they guessed exists on a wedding they cannot
      // read; answering `FamilyNotInWedding` first tells them only what they
      // already knew — that this cookie is not for this wedding — and the route
      // maps it to the same `registry_not_found` an invisible registry gives.
      if (!familyRows[0]) return yield* Effect.fail(new FamilyNotInWedding());
      if (!itemRows[0]) return yield* Effect.fail(new RegistryItemNotInWedding());
      return yield* Effect.fail(new ItemFullyClaimed());
    }).pipe(Effect.withSpan("cire.registry.claim"));
  },

  /** Release a household's claim, freeing its quantity for someone else. */
  releaseClaim(input: {
    weddingId: string;
    itemId: string;
    familyId: string;
  }): Effect.Effect<void, RegistryItemNotInWedding | FamilyNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // The WHERE matches an EXISTING claim row, which `claim` already refused
      // to write unless the household belonged to the wedding — so a foreign
      // family id simply matches nothing. What that leaves is the S-M1 problem:
      // "matched nothing" would answer `registry_item_not_found` to a foreign
      // cookie on a visible registry and `registry_not_found` on an invisible
      // one, which is a probe for which weddings have a list. The failure path
      // below tells the two apart so both answer the same thing.
      const [released] = yield* dbQuery(() =>
        db
          .update(registryClaims)
          .set({ status: "released", updatedAt: new Date() })
          .where(
            and(
              eq(registryClaims.weddingId, input.weddingId),
              eq(registryClaims.itemId, input.itemId),
              eq(registryClaims.familyId, input.familyId),
            ),
          )
          .returning({ id: registryClaims.id })
          .all(),
      );
      if (!released) {
        // One extra point read, and only ever on the failure path.
        return yield* (yield* familyInWedding(input.weddingId, input.familyId))
          ? Effect.fail(new RegistryItemNotInWedding())
          : Effect.fail(new FamilyNotInWedding());
      }
    }).pipe(Effect.withSpan("cire.registry.releaseClaim"));
  },

  /** Flip a gift's thank-you status. `kind` picks the table. */
  setThanked(input: {
    weddingId: string;
    kind: GiftKind;
    giftId: string;
    thanked: boolean;
    actorOsnProfileId: string;
  }): Effect.Effect<void, GiftNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, kind, giftId, thanked, actorOsnProfileId } = input;
      const set = {
        thankedAt: thanked ? new Date() : null,
        thankedBy: thanked ? actorOsnProfileId : null,
        updatedAt: new Date(),
      };
      const [updated] = yield* dbQuery(() =>
        kind === "claim"
          ? db
              .update(registryClaims)
              .set(set)
              .where(and(eq(registryClaims.id, giftId), eq(registryClaims.weddingId, weddingId)))
              .returning({ id: registryClaims.id })
              .all()
          : db
              .update(registryContributions)
              .set(set)
              .where(
                and(
                  eq(registryContributions.id, giftId),
                  eq(registryContributions.weddingId, weddingId),
                ),
              )
              .returning({ id: registryContributions.id })
              .all(),
      );
      if (!updated) return yield* Effect.fail(new GiftNotInWedding());
    }).pipe(Effect.withSpan("cire.registry.setThanked"));
  },

  /** Does this wedding have any registry rows? Gates the currency-change confirm. */
  hasRows(weddingId: string): Effect.Effect<boolean, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Both probes always (P-I5): the short-circuit saved a round trip only for
      // weddings that HAVE items, and cost a serial second one for every wedding
      // that does not — which is every wedding, since the feature ships locked.
      const [itemRows, contributionRows] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({ id: registryItems.id })
              .from(registryItems)
              .where(eq(registryItems.weddingId, weddingId))
              .limit(1)
              .all(),
          ),
          dbQuery(() =>
            db
              .select({ id: registryContributions.id })
              .from(registryContributions)
              .where(eq(registryContributions.weddingId, weddingId))
              .limit(1)
              .all(),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return itemRows.length > 0 || contributionRows.length > 0;
    }).pipe(Effect.withSpan("cire.registry.hasRows"));
  },
};

// ── Guest surface ─────────────────────────────────────────────────────────────
//
// Everything below serves the GUEST site, off a wedding slug rather than a
// `:weddingId` path segment, behind no organiser role gate. It is a separate
// export rather than more methods on `registryService` because the audience —
// and therefore what may leave the process — is different: `registryService.get`
// returns the gift log, Stripe account state and the shipping address to a
// caller the route already proved owns the wedding, and none of that may reach a
// guest. Two objects means the narrow DTOs cannot be widened by accident.

/**
 * One item as a guest sees it.
 *
 * `imageName` is the LAST SEGMENT of the R2 key, not the key — the guest image
 * route rebuilds `assets/<weddingId>/<name>` server-side, so the payload has no
 * reason to carry the wedding id, and a key shaped wrongly (or naming another
 * wedding's object) resolves to null rather than a URL the serve route would
 * refuse anyway.
 *
 * No `weddingId`, no `imageKey`, no timestamps: nothing a guest renders needs
 * them, and every field here is public bytes the moment the registry publishes.
 */
export interface PublicRegistryItemDto {
  id: string;
  kind: RegistryItemKind;
  title: string;
  description: string | null;
  imageName: string | null;
  imageCrop: string | null;
  externalUrl: string | null;
  priceMinor: number | null;
  quantityWanted: number;
  /** Everyone's non-released claims, summed. An aggregate — never who claimed. */
  quantityClaimed: number;
  category: string | null;
  sortOrder: number;
}

/**
 * The published registry as a guest sees it: the couple's copy and the list.
 *
 * What is ABSENT is the point — no gift log, no Stripe identifiers, no
 * `familyId`, no claimant name or note, no shipping address. A guest may learn
 * that two of three pans are spoken for; never by whom.
 */
export interface PublicRegistryDto {
  headline: string | null;
  message: string | null;
  /**
   * Whether a guest may give money RIGHT NOW — the couple's intent AND Stripe's
   * capability, ANDed here so the guest surface never has to reason about the
   * two separately. A contribute button the couple meant to offer but Stripe
   * cannot honour is a refund and a support case; one they never meant to offer
   * is worse.
   */
  cashGiftsEnabled: boolean;
  /** The wedding's primary currency — what every `priceMinor` is denominated in. */
  currency: string;
  items: PublicRegistryItemDto[];
}

/** One of THIS household's live claims. */
export interface HouseholdClaimDto {
  itemId: string;
  quantity: number;
  status: Exclude<RegistryClaimStatus, "released">;
  note: string | null;
  displayName: string | null;
}

/**
 * What a signed-in household may see beyond the public list.
 *
 * `shippingAddress` is OPTIONAL rather than nullable: absent means "you may not
 * see it", and there is no second field saying why. A household that has claimed
 * nothing, or one reading before the couple's embargo date, gets the same shape
 * as a couple who set no address at all.
 */
export interface HouseholdRegistryDto {
  claims: HouseholdClaimDto[];
  shippingAddress?: string;
}

/** Today in the same `YYYY-MM-DD` shape `shipping_visible_from` is stored in. */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Has the couple's shipping-address embargo lifted?
 *
 * A NULL date means no embargo, and so does an unparseable one — the write
 * schema validates the shape (S-M2), so a value that got past it is corruption,
 * and failing open here matches what `schemas/registry.ts` documents. Comparing
 * `YYYY-MM-DD` strings lexicographically IS a date comparison for that shape, and
 * avoids inventing a timezone the couple never chose.
 */
function embargoLifted(visibleFrom: string | null): boolean {
  if (!visibleFrom || !ISO_DATE.test(visibleFrom)) return true;
  return visibleFrom <= todayIso();
}

const toPublicItemDto = (
  weddingId: string,
  r: ItemRow,
  quantityClaimed: number,
): PublicRegistryItemDto => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  description: r.description,
  imageName:
    r.imageKey && imageKeyBelongsTo(weddingId, r.imageKey)
      ? (r.imageKey.split("/")[2] ?? null)
      : null,
  imageCrop: r.imageCrop,
  externalUrl: r.externalUrl,
  priceMinor: r.priceMinor,
  quantityWanted: r.quantityWanted,
  quantityClaimed,
  category: r.category,
  sortOrder: r.sortOrder,
});

/**
 * Slug → wedding id, but ONLY when a guest may see this wedding's registry.
 *
 * Two independent gates, both of which must hold: the wedding carries the
 * `registry` entitlement, and `registry_settings.published` is 1. Either one
 * missing fails `RegistryNotVisible`, which every guest route turns into the
 * same 404 — so an unentitled wedding, an unpublished one and a slug nobody
 * registered are indistinguishable from outside.
 *
 * The settings row travels back with the id because every caller that needs the
 * gate also needs the settings, and re-reading it per route would be a second
 * round trip for a row already in hand.
 */
function resolveVisibleRegistry(
  slug: string,
): Effect.Effect<
  { weddingId: string; settings: RegistrySettingsRecord; currency: string },
  RegistryNotVisible,
  DbService
> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    // The CURRENCY rides along: SQLite reads the whole row for the slug
    // lookup regardless, so the extra column is free — and it saves
    // `primaryCurrency` a second read of the same row, one round trip down, on
    // the read a guest waits on to reach a payment page.
    const [weddingRow] = yield* dbQuery(() =>
      db
        .select({ id: weddings.id, currency: weddings.currency })
        .from(weddings)
        .where(eq(weddings.slug, slug))
        .all(),
    );
    const wedding = weddingRow as { id: string; currency: string } | undefined;
    const weddingId = wedding?.id;
    if (!weddingId) return yield* Effect.fail(new RegistryNotVisible());

    // Both gates read together: neither answer depends on the other, and the
    // common case (locked feature, no settings row) pays one round trip's
    // latency rather than two.
    const { entitled, settingsRows } = yield* Effect.all(
      {
        entitled: entitlementService.has(weddingId, "registry"),
        settingsRows: dbQuery(() =>
          db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).all(),
        ),
      },
      { concurrency: "unbounded" },
    );
    const settings = settingsRows[0]
      ? toSettingsRecord(settingsRows[0] as SettingsRow)
      : defaultSettings(weddingId);
    if (!entitled || !settings.published) return yield* Effect.fail(new RegistryNotVisible());
    // Same fallback `primaryCurrency` has always used.
    return { weddingId, settings, currency: wedding?.currency ?? "AUD" };
  });
}

export const registryGuestService = {
  /**
   * The wedding a guest route may act on, or `RegistryNotVisible`.
   *
   * The write routes resolve the wedding from the SLUG and hand the id to
   * `registryService.claim` / `releaseClaim`, so a `cire_session` cookie minted
   * for wedding A carries no authority on wedding B's slug: the claim statement
   * proves the household belongs to the wedding it names (S-H2) and fails
   * `FamilyNotInWedding` when it does not.
   */
  visibleWeddingId(slug: string): Effect.Effect<string, RegistryNotVisible, DbService> {
    return resolveVisibleRegistry(slug).pipe(
      Effect.map((r) => r.weddingId),
      Effect.withSpan("cire.registry.visibleWeddingId"),
    );
  },

  /**
   * The published list for one of THIS wedding's households, with per-item
   * claimed totals. No identities, ever.
   *
   * **It takes a `familyId` because the list is not public.** A gift list names
   * what a couple want and what they cost, and they only ever showed it to the
   * people they invited — so it is gated on the same `cire_session` the rest of
   * the invitation is, and a guest who has not entered their code gets a 401
   * rather than the list.
   *
   * The family is checked against the WEDDING, not merely required to exist: a
   * `cire_session` names a household, not a wedding, so without this one
   * leaked code would open every couple's list on the platform. A family from
   * another wedding fails `RegistryNotVisible` — the same failure, and so the
   * same 404, as a registry that is unpublished or unentitled. A distinct code
   * would confirm to any cookie-holder which weddings have a list.
   */
  guestView(input: {
    slug: string;
    familyId: string;
  }): Effect.Effect<PublicRegistryDto, RegistryNotVisible, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { settings, weddingId } = yield* resolveVisibleRegistry(input.slug);
      if (!(yield* familyInWedding(weddingId, input.familyId))) {
        return yield* Effect.fail(new RegistryNotVisible());
      }
      const { claimed, currency, itemRows } = yield* Effect.all(
        {
          itemRows: dbQuery(() =>
            db
              .select()
              .from(registryItems)
              .where(eq(registryItems.weddingId, weddingId))
              .orderBy(asc(registryItems.sortOrder), asc(registryItems.id))
              .all(),
          ),
          claimed: claimedByItem(weddingId),
          currency: primaryCurrency(weddingId),
        },
        { concurrency: "unbounded" },
      );
      return {
        headline: settings.headline,
        message: settings.message,
        // Intent AND capability. See the DTO.
        cashGiftsEnabled: settings.cashGiftsEnabled && settings.stripeChargesEnabled,
        currency,
        items: (itemRows as ItemRow[]).map((r) =>
          toPublicItemDto(weddingId, r, claimed.get(r.id) ?? 0),
        ),
      };
    }).pipe(Effect.withSpan("cire.registry.guestView"));
  },

  /**
   * This household's own claims, plus the shipping address when it has earned it.
   *
   * RELEASED claims are left out. The row survives release as a tombstone so a
   * re-claim can reuse it (the unique `(item_id, family_id)` index), but to a
   * guest a released claim means "you have not claimed this" — returning it would
   * have the UI show a claim that is not one.
   *
   * The address ships only to a household with something live on the list, and
   * only once the couple's date has passed. It is the one piece of the couple's
   * own PII this surface hands out, so both conditions are checked here rather
   * than in the route: every caller gets them.
   */
  householdView(input: {
    slug: string;
    familyId: string;
  }): Effect.Effect<HouseholdRegistryDto, RegistryNotVisible, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { settings, weddingId } = yield* resolveVisibleRegistry(input.slug);
      // The same gate the list read keeps (S-M1). Without it this route answered
      // 200 `{claims: []}` for a visible registry and 404 for an invisible one —
      // so anyone holding any valid session could walk slugs and learn which
      // weddings have a published gift list, which is the exact fact the single
      // 404 code exists to hide.
      if (!(yield* familyInWedding(weddingId, input.familyId))) {
        return yield* Effect.fail(new RegistryNotVisible());
      }
      const rows = yield* dbQuery(() =>
        db
          .select({
            itemId: registryClaims.itemId,
            quantity: registryClaims.quantity,
            status: registryClaims.status,
            note: registryClaims.note,
            displayName: registryClaims.displayName,
          })
          .from(registryClaims)
          .where(
            and(
              eq(registryClaims.weddingId, weddingId),
              eq(registryClaims.familyId, input.familyId),
              sql`${registryClaims.status} <> 'released'`,
            ),
          )
          .orderBy(asc(registryClaims.itemId))
          .all(),
      );
      const claims = (
        rows as Array<{
          itemId: string;
          quantity: number;
          status: Exclude<RegistryClaimStatus, "released">;
          note: string | null;
          displayName: string | null;
        }>
      ).map((r) => ({
        itemId: r.itemId,
        quantity: r.quantity,
        status: r.status,
        note: r.note,
        displayName: r.displayName,
      }));

      const showAddress =
        settings.shippingAddress !== null &&
        claims.length > 0 &&
        embargoLifted(settings.shippingVisibleFrom);
      return showAddress
        ? { claims, shippingAddress: settings.shippingAddress as string }
        : { claims };
    }).pipe(Effect.withSpan("cire.registry.householdView"));
  },
};
