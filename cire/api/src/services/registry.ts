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

export const registryService = {
  /** The organiser-facing snapshot: settings, items with claim counts, gift log. */
  get(weddingId: string): Effect.Effect<RegistrySnapshot, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [settingsRow] = yield* dbQuery(() =>
        db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).all(),
      );
      const itemRows = yield* dbQuery(() =>
        db
          .select()
          .from(registryItems)
          .where(eq(registryItems.weddingId, weddingId))
          .orderBy(asc(registryItems.sortOrder), asc(registryItems.id))
          .all(),
      );
      const claimed = yield* claimedByItem(weddingId);
      const gifts = yield* registryService.giftLog(weddingId);
      const currency = yield* primaryCurrency(weddingId);

      // Sum in the primary currency only — a column of mixed currencies cannot be
      // added up in any other one. A same-currency row has no primary snapshot
      // (the four FX columns are NULL), so it contributes its as-given amount.
      let contributionsPrimaryMinor = 0;
      for (const g of gifts) {
        if (g.kind !== "contribution" || g.status !== "succeeded") continue;
        contributionsPrimaryMinor += g.primaryAmountMinor ?? g.amountMinor ?? 0;
      }

      return {
        settings: settingsRow
          ? toSettingsDto(settingsRow as SettingsRow)
          : defaultSettings(weddingId),
        items: (itemRows as ItemRow[]).map((r) => toItemDto(r, claimed.get(r.id) ?? 0)),
        gifts,
        currency,
        contributionsPrimaryMinor,
      };
    }).pipe(Effect.withSpan("cire.registry.get"));
  },

  /**
   * Claims and contributions, merged and newest-first — the view the couple works
   * from after the day. Two queries rather than a SQL UNION: the tables carry
   * different columns, and the merge is a sort over at most a wedding's worth of
   * gifts.
   */
  giftLog(weddingId: string): Effect.Effect<GiftLogEntryDto[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
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

      return [...claims, ...contributions].toSorted((a, b) => b.createdAt - a.createdAt);
    }).pipe(Effect.withSpan("cire.registry.giftLog"));
  },

  /** Upsert the settings row. Creates it on first write (absent row = defaults). */
  updateSettings(
    weddingId: string,
    patch: UpdateRegistrySettingsPatch,
  ): Effect.Effect<RegistrySettingsDto, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();
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

  createItem(input: CreateRegistryItemInput): Effect.Effect<RegistryItemDto, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Append to the end of the wedding's list: next sort_order = max + 1.
      const existing = yield* dbQuery(() =>
        db
          .select({ sortOrder: registryItems.sortOrder })
          .from(registryItems)
          .where(eq(registryItems.weddingId, input.weddingId))
          .all(),
      );
      const maxSort = (existing as { sortOrder: number }[]).reduce(
        (m, r) => Math.max(m, r.sortOrder),
        -1,
      );
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
        sortOrder: maxSort + 1,
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
  }): Effect.Effect<RegistryItemDto, RegistryItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, patch } = input;

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
      const claimed = yield* claimedByItem(weddingId);
      return toItemDto(updated as ItemRow, claimed.get(itemId) ?? 0);
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
   */
  claim(input: {
    weddingId: string;
    itemId: string;
    familyId: string;
    quantity: number;
    status: Exclude<RegistryClaimStatus, "released">;
    note: string | null;
    displayName: string | null;
  }): Effect.Effect<void, RegistryItemNotInWedding | ItemFullyClaimed, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, familyId, quantity, status, note, displayName } = input;
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

      // Nothing written means one of two things; only the failure path pays for
      // telling them apart.
      const [item] = yield* dbQuery(() =>
        db
          .select({ id: registryItems.id })
          .from(registryItems)
          .where(and(eq(registryItems.id, itemId), eq(registryItems.weddingId, weddingId)))
          .all(),
      );
      return yield* Effect.fail(item ? new ItemFullyClaimed() : new RegistryItemNotInWedding());
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
      const [item] = yield* dbQuery(() =>
        db
          .select({ id: registryItems.id })
          .from(registryItems)
          .where(eq(registryItems.weddingId, weddingId))
          .limit(1)
          .all(),
      );
      if (item) return true;
      const [contribution] = yield* dbQuery(() =>
        db
          .select({ id: registryContributions.id })
          .from(registryContributions)
          .where(eq(registryContributions.weddingId, weddingId))
          .limit(1)
          .all(),
      );
      return Boolean(contribution);
    }).pipe(Effect.withSpan("cire.registry.hasRows"));
  },
};
