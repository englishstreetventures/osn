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
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitGroupedBatches, DbService, dbQuery } from "../db";

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
/** The wedding is at its item ceiling. 409-class. */
export class RegistryItemLimitReached extends Data.TaggedError("RegistryItemLimitReached") {}
/**
 * A quantity outside the range the CHECK constraints allow (S-M1). The service
 * refuses it so the caller gets a tagged error rather than a raw D1 constraint
 * throw, which surfaces as a 500 and says nothing useful.
 */
export class InvalidQuantity extends Data.TaggedError("InvalidQuantity") {}

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
/** Which table a gift-log row came from — the discriminator the portal reads. */
export type GiftKind = "claim" | "contribution";

export interface RegistrySettingsDto {
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
  /** The wedding's primary currency — what every authored figure is in. */
  currency: string;
  /**
   * Sum of succeeded contributions expressed in the primary currency. APPROXIMATE
   * by construction: each foreign-currency row was converted at its own
   * snapshotted rate, so this is a sum of historical conversions, not a live
   * valuation. The portal must label it as such.
   */
  contributionsPrimaryMinor: number;
}

export interface UpdateRegistrySettingsPatch {
  published?: boolean;
  headline?: string | null;
  message?: string | null;
  cashGiftsEnabled?: boolean;
  shippingAddress?: string | null;
  shippingVisibleFrom?: string | null;
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
const defaultSettings = (weddingId: string): RegistrySettingsDto => ({
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

const toSettingsDto = (r: SettingsRow): RegistrySettingsDto => ({
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

/**
 * Sum of succeeded contributions in the primary currency, computed IN SQL.
 *
 * It used to be a JS loop over the gift log, which quietly made the total a
 * function of how many rows the log happened to return — so paginating the log
 * would have started under-reporting the money. One row out of the database,
 * whatever the page size.
 *
 * A same-currency row has no primary snapshot (the FX columns are NULL) and so
 * contributes its as-given amount; that is the `coalesce` pair.
 */
function contributionsPrimaryTotal(weddingId: string): Effect.Effect<number, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select({
          total: sql<number>`coalesce(sum(coalesce(${registryContributions.primaryAmountMinor}, ${registryContributions.amountMinor})), 0)`,
        })
        .from(registryContributions)
        .where(
          and(
            eq(registryContributions.weddingId, weddingId),
            eq(registryContributions.status, "succeeded"),
          ),
        )
        .all(),
    );
    return Number((row as { total: number } | undefined)?.total ?? 0) || 0;
  });
}

/**
 * Does this R2 key name an object under this wedding? (S-H1)
 *
 * `ImageKey` in the HTTP schema pins the SHAPE — `assets/<segment>/<segment>` —
 * but shape alone lets an editor of wedding A point an item at wedding B's
 * upload, which the guest site would then serve. The middle segment IS the
 * wedding id, so ownership is a string compare, not a query.
 */
function imageKeyBelongsTo(weddingId: string, key: string): boolean {
  const parts = key.split("/");
  return parts.length === 3 && parts[0] === "assets" && parts[1] === weddingId;
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
      const { claimed, contributionsPrimaryMinor, currency, gifts, itemRows, settingsRows } =
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
            contributionsPrimaryMinor: contributionsPrimaryTotal(weddingId),
          },
          { concurrency: "unbounded" },
        );
      const [settingsRow] = settingsRows;

      return {
        settings: settingsRow
          ? toSettingsDto(settingsRow as SettingsRow)
          : defaultSettings(weddingId),
        items: (itemRows as ItemRow[]).map((r) => toItemDto(r, claimed.get(r.id) ?? 0)),
        gifts: gifts.entries,
        giftsHasMore: gifts.hasMore,
        currency,
        contributionsPrimaryMinor,
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
          .where(eq(registryContributions.weddingId, weddingId))
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
   */
  updateSettings(
    weddingId: string,
    patch: UpdateRegistrySettingsPatch,
  ): Effect.Effect<RegistrySettingsDto, StripeNotReady, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();

      if (patch.cashGiftsEnabled === true) {
        // One PK-indexed read, and only on the write that asks for it. An absent
        // row means the registry was never opened, so certainly no Stripe.
        const [existing] = yield* dbQuery(() =>
          db
            .select({ chargesEnabled: registrySettings.stripeChargesEnabled })
            .from(registrySettings)
            .where(eq(registrySettings.weddingId, weddingId))
            .all(),
        );
        if (!(existing as { chargesEnabled: boolean } | undefined)?.chargesEnabled) {
          return yield* Effect.fail(new StripeNotReady());
        }
      }

      const set: Record<string, unknown> = { updatedAt: now };
      if (patch.published !== undefined) set.published = patch.published;
      if (patch.headline !== undefined) set.headline = patch.headline;
      if (patch.message !== undefined) set.message = patch.message;
      if (patch.cashGiftsEnabled !== undefined) set.cashGiftsEnabled = patch.cashGiftsEnabled;
      if (patch.shippingAddress !== undefined) set.shippingAddress = patch.shippingAddress;
      if (patch.shippingVisibleFrom !== undefined) {
        set.shippingVisibleFrom = patch.shippingVisibleFrom;
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
          .onConflictDoUpdate({ target: registrySettings.weddingId, set })
          .returning()
          .all(),
      );
      return toSettingsDto(row as SettingsRow);
    }).pipe(Effect.withSpan("cire.registry.updateSettings"));
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

      const set: Record<string, unknown> = { updatedAt: new Date() };
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

  removeItem(
    weddingId: string,
    itemId: string,
  ): Effect.Effect<void, RegistryItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Claims cascade with the item; contributions do NOT — their `item_id` is
      // ON DELETE SET NULL, so removing a listing never erases a record of money
      // someone actually sent.
      const [removed] = yield* dbQuery(() =>
        db
          .delete(registryItems)
          .where(and(eq(registryItems.id, itemId), eq(registryItems.weddingId, weddingId)))
          .returning({ id: registryItems.id })
          .all(),
      );
      if (!removed) return yield* Effect.fail(new RegistryItemNotInWedding());
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
      if (!itemRows[0]) return yield* Effect.fail(new RegistryItemNotInWedding());
      if (!familyRows[0]) return yield* Effect.fail(new FamilyNotInWedding());
      return yield* Effect.fail(new ItemFullyClaimed());
    }).pipe(Effect.withSpan("cire.registry.claim"));
  },

  /** Release a household's claim, freeing its quantity for someone else. */
  releaseClaim(input: {
    weddingId: string;
    itemId: string;
    familyId: string;
  }): Effect.Effect<void, RegistryItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // No family/wedding cross-check needed here (unlike `claim`): the WHERE
      // matches an EXISTING claim row, which `claim` already refused to write
      // unless the household belonged to the wedding. A foreign family id simply
      // matches nothing.
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
      if (!released) return yield* Effect.fail(new RegistryItemNotInWedding());
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
