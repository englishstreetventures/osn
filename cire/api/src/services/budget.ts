/**
 * Budget v1 (platform Phase 1, [[platform-plan]] §4.2) — per-row CRUD over a
 * wedding's budget items + their payment schedule. Its OWN service, NOT routed
 * through `changes/*`: budget sits outside the guest/schedule reconcile pipeline.
 *
 * TENANCY: the route gate proves the caller may touch `weddingId`. Every write
 * here ADDITIONALLY scopes by `wedding_id` (payments re-scope through their
 * parent item's `wedding_id`), so an editor of wedding A can never mutate wedding
 * B's item or payment even with a leaked id — a mismatch fails
 * `BudgetItemNotInWedding` / `PaymentNotInItem` rather than touching a row.
 *
 * MONEY: every `*_minor` is an integer in the wedding's single `currency`. The
 * rollup's spend rule is `actual ?? quoted ?? estimate ?? 0` per item, shared
 * with the client via the exported `computeRollup`.
 *
 * PER HEAD: a line with a `unitPriceMinor` is priced per guest. Its estimate is
 * that price times the guests at its events, counted from the RSVPs on every
 * read (`countHeads`) and never stored. While RSVPs are open it prices the
 * guests EXPECTED to come; once the wedding's RSVP deadline has passed, the
 * guests CONFIRMED (`perHeadMinor`).
 */
import {
  budgetItems,
  events,
  families,
  guestEvents,
  guests,
  payments,
  rsvps,
  weddings,
} from "@cire/db";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { DbService, commitGroupedBatches, dbQuery } from "../db";
import { isRsvpClosed } from "../lib/rsvp-deadline";
import type { ServiceCategory } from "../lib/service-categories";

/** No item with this id under this wedding (missing or another wedding's). 404-class. */
export class BudgetItemNotInWedding extends Data.TaggedError("BudgetItemNotInWedding") {}
/** No payment with this id under this item (missing or another item's). 404-class. */
export class PaymentNotInItem extends Data.TaggedError("PaymentNotInItem") {}
/** A per-head line names an event that is not one of this wedding's. 400-class. */
export class EventNotInWedding extends Data.TaggedError("EventNotInWedding") {}

/** Guests at a per-head line's events. */
export interface Headcount {
  /** Invited and not declined: attending, maybe, or no reply yet. */
  expected: number;
  /** Replied "attending". */
  confirmed: number;
}

export interface BudgetItemDto {
  id: string;
  weddingId: string;
  category: string;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  notes: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** Price per guest. Non-null marks a per-head line. */
  unitPriceMinor: number | null;
  /**
   * The events a per-head line counts. `null` means every event, and is always
   * `null` on a fixed line. A list holds the picked events that still exist, so
   * it is empty once every one of them has been deleted, and the line then
   * counts nobody.
   */
  eventIds: string[] | null;
  /** Guests at the line's events. `null` on a fixed line. */
  headcount: Headcount | null;
}

/** One of the wedding's events, as the per-head event picker lists it. */
export interface BudgetEventDto {
  id: string;
  name: string;
}

export interface PaymentDto {
  id: string;
  budgetItemId: string;
  label: string;
  amountMinor: number;
  dueAt: string | null;
  paidAt: number | null;
  createdAt: number;
}

export interface BudgetRollup {
  byCategory: {
    category: string;
    estimateMinor: number;
    quotedMinor: number;
    actualMinor: number;
    itemCount: number;
  }[];
  totals: { estimateMinor: number; quotedMinor: number; actualMinor: number };
  spentSoFarMinor: number;
}

export interface BudgetSnapshot {
  items: BudgetItemDto[];
  payments: PaymentDto[];
  rollup: BudgetRollup;
  budgetTotalMinor: number | null;
  currency: string;
  /** The wedding's events in the portal's order (`sort_order`). */
  events: BudgetEventDto[];
  /** The RSVP deadline has passed, so a per-head line prices confirmed guests. */
  rsvpsClosed: boolean;
}

/** A per-head line's settings on a write. `eventIds` absent keeps the line's
 *  current events; `null` counts every event; a list counts only those. */
export interface PerHeadInput {
  unitPriceMinor: number;
  eventIds?: readonly string[] | null;
}

export interface CreateBudgetItemInput {
  weddingId: string;
  category: ServiceCategory;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  notes: string | null;
  /** Absent or `null`: a fixed line. */
  perHead?: PerHeadInput | null;
}

export interface UpdateBudgetItemPatch {
  category?: ServiceCategory;
  name?: string;
  estimateMinor?: number | null;
  quotedMinor?: number | null;
  actualMinor?: number | null;
  notes?: string | null;
  /** `null` makes the line fixed; an object makes it, or keeps it, per head. */
  perHead?: PerHeadInput | null;
}

/** One invitation of a guest to an event, with their reply to it if any. */
export interface Invitation {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe" | null;
}

interface ItemRow {
  id: string;
  weddingId: string;
  category: string;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  unitPriceMinor: number | null;
  perHeadEventIds: string | null;
  notes: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The per-head half of an item's DTO. */
interface PerHeadFields {
  eventIds: string[] | null;
  headcount: Headcount | null;
}

const FIXED_LINE: PerHeadFields = { eventIds: null, headcount: null };

interface PaymentRow {
  id: string;
  budgetItemId: string;
  label: string;
  amountMinor: number;
  dueAt: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

const toItemDto = (r: ItemRow, perHead: PerHeadFields): BudgetItemDto => ({
  id: r.id,
  weddingId: r.weddingId,
  category: r.category,
  name: r.name,
  estimateMinor: r.estimateMinor,
  quotedMinor: r.quotedMinor,
  actualMinor: r.actualMinor,
  notes: r.notes,
  sortOrder: r.sortOrder,
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
  unitPriceMinor: r.unitPriceMinor,
  eventIds: perHead.eventIds,
  headcount: perHead.headcount,
});

const toPaymentDto = (r: PaymentRow): PaymentDto => ({
  id: r.id,
  budgetItemId: r.budgetItemId,
  label: r.label,
  amountMinor: r.amountMinor,
  dueAt: r.dueAt,
  paidAt: r.paidAt ? r.paidAt.getTime() : null,
  createdAt: r.createdAt.getTime(),
});

/**
 * Guests at a per-head line's events (`eventIds`, or every event when `null`).
 * A guest invited to several of them counts once. Confirmed: replied
 * "attending" to at least one. Expected: has not declined every one, so a
 * "maybe" and a guest who has not replied yet both count.
 *
 * Counted here rather than in SQL because each line scopes its own set of
 * events and a guest counts once across them, so one read of the wedding's
 * invitations serves every line. A SQL port must keep unanswered invitations:
 * `status != 'declined'` is unknown, not true, for their NULL.
 */
export function countHeads(
  invitations: readonly Invitation[],
  eventIds: readonly string[] | null,
): Headcount {
  const scope = eventIds === null ? null : new Set(eventIds);
  const expected = new Set<string>();
  const confirmed = new Set<string>();
  for (const invitation of invitations) {
    if (scope !== null && !scope.has(invitation.eventId)) continue;
    if (invitation.status !== "declined") expected.add(invitation.guestId);
    if (invitation.status === "attending") confirmed.add(invitation.guestId);
  }
  return { expected: expected.size, confirmed: confirmed.size };
}

/** A per-head line's amount: the expected guests while RSVPs are open, the
 *  confirmed ones after. */
export function perHeadMinor(
  unitPriceMinor: number,
  headcount: Headcount,
  rsvpsClosed: boolean,
): number {
  return unitPriceMinor * (rsvpsClosed ? headcount.confirmed : headcount.expected);
}

/** What stands in a line's estimate column: the computed amount on a per-head
 *  line, the stored figure on a fixed one. */
export function lineEstimate(
  item: Pick<BudgetItemDto, "estimateMinor" | "unitPriceMinor" | "headcount">,
  rsvpsClosed: boolean,
): number | null {
  if (item.unitPriceMinor === null || item.headcount === null) return item.estimateMinor;
  return perHeadMinor(item.unitPriceMinor, item.headcount, rsvpsClosed);
}

/**
 * The stored event list. `null` is every event. Anything this service did not
 * write, such as text that is not a JSON list, counts nobody rather than
 * everybody: a line must never widen by accident.
 */
function parseEventIds(stored: string | null): string[] | null {
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Each id once, in the order given. */
const uniqueIds = (ids: readonly string[]): string[] => [...new Set(ids)];

/** The per-head fields of one row, given the wedding's event ids and invitations. */
function perHeadFields(
  row: ItemRow,
  weddingEventIds: ReadonlySet<string>,
  invitations: readonly Invitation[],
): PerHeadFields {
  if (row.unitPriceMinor === null) return FIXED_LINE;
  const picked = parseEventIds(row.perHeadEventIds);
  // A picked event that has since been deleted drops out here, so the portal
  // never shows an id it cannot name.
  const eventIds = picked === null ? null : picked.filter((id) => weddingEventIds.has(id));
  return { eventIds, headcount: countHeads(invitations, eventIds) };
}

/**
 * Every invitation to one of the wedding's events, with the guest's reply to
 * it. Starts from `guest_events`, so an RSVP left on an event the guest is no
 * longer invited to is not counted. The host preview household and households
 * whose invite has been withdrawn are left out: neither is coming.
 */
function loadInvitations(weddingId: string): Effect.Effect<Invitation[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    return yield* dbQuery(() =>
      db
        .select({
          guestId: guestEvents.guestId,
          eventId: guestEvents.eventId,
          status: rsvps.status,
        })
        .from(guestEvents)
        .innerJoin(guests, eq(guestEvents.guestId, guests.id))
        .innerJoin(families, eq(guests.familyId, families.id))
        .leftJoin(
          rsvps,
          and(eq(rsvps.guestId, guestEvents.guestId), eq(rsvps.eventId, guestEvents.eventId)),
        )
        .where(
          and(
            eq(families.weddingId, weddingId),
            ne(families.kind, "host"),
            isNull(families.deactivatedAt),
          ),
        )
        .all(),
    );
  }).pipe(Effect.withSpan("cire.budget.headcount"));
}

/** The wedding's events in the portal's order. */
function loadEvents(weddingId: string): Effect.Effect<BudgetEventDto[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    return yield* dbQuery(() =>
      db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.weddingId, weddingId))
        .orderBy(asc(events.sortOrder), asc(events.id))
        .all(),
    );
  });
}

/** Fail unless every picked id is one of the wedding's events, checked against
 *  the event list the write reads anyway, so the check costs no query. */
function requirePickedEvents(
  weddingEvents: readonly BudgetEventDto[],
  eventIds: readonly string[],
): Effect.Effect<void, EventNotInWedding> {
  const known = new Set(weddingEvents.map((e) => e.id));
  return eventIds.every((id) => known.has(id)) ? Effect.void : Effect.fail(new EventNotInWedding());
}

/** A written per-head row as a DTO, from the events and invitations already read. */
const describePerHead = (
  row: ItemRow,
  weddingEvents: readonly BudgetEventDto[],
  invitations: readonly Invitation[],
): BudgetItemDto =>
  toItemDto(row, perHeadFields(row, new Set(weddingEvents.map((e) => e.id)), invitations));

/** One written row as a DTO. A fixed line costs no query; a per-head line reads
 *  the wedding's events and invitations to fill in its headcount. */
function describeItem(
  weddingId: string,
  row: ItemRow,
): Effect.Effect<BudgetItemDto, never, DbService> {
  return Effect.gen(function* () {
    if (row.unitPriceMinor === null) return toItemDto(row, FIXED_LINE);
    const [weddingEvents, invitations] = yield* Effect.all(
      [loadEvents(weddingId), loadInvitations(weddingId)],
      { concurrency: 2 },
    );
    return describePerHead(row, weddingEvents, invitations);
  });
}

/** The spend rule + subtotals, pure so the client mirror and the test agree. */
export function computeRollup(
  items: Pick<BudgetItemDto, "category" | "estimateMinor" | "quotedMinor" | "actualMinor">[],
): BudgetRollup {
  const byKey = new Map<string, BudgetRollup["byCategory"][number]>();
  let spentSoFarMinor = 0;
  const totals = { estimateMinor: 0, quotedMinor: 0, actualMinor: 0 };
  for (const it of items) {
    let bucket = byKey.get(it.category);
    if (!bucket) {
      bucket = {
        category: it.category,
        estimateMinor: 0,
        quotedMinor: 0,
        actualMinor: 0,
        itemCount: 0,
      };
      byKey.set(it.category, bucket);
    }
    bucket.itemCount += 1;
    bucket.estimateMinor += it.estimateMinor ?? 0;
    bucket.quotedMinor += it.quotedMinor ?? 0;
    bucket.actualMinor += it.actualMinor ?? 0;
    totals.estimateMinor += it.estimateMinor ?? 0;
    totals.quotedMinor += it.quotedMinor ?? 0;
    totals.actualMinor += it.actualMinor ?? 0;
    spentSoFarMinor += it.actualMinor ?? it.quotedMinor ?? it.estimateMinor ?? 0;
  }
  return { byCategory: [...byKey.values()], totals, spentSoFarMinor };
}

/** Load the item, scoped to the wedding, or fail 404-class. Shared by the
 *  payment writes (which must prove the parent item belongs to the wedding). */
function requireItem(
  weddingId: string,
  itemId: string,
): Effect.Effect<ItemRow, BudgetItemNotInWedding, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select()
        .from(budgetItems)
        .where(and(eq(budgetItems.id, itemId), eq(budgetItems.weddingId, weddingId)))
        .all(),
    );
    if (!row) return yield* Effect.fail(new BudgetItemNotInWedding());
    return row as ItemRow;
  });
}

export const budgetService = {
  get(weddingId: string): Effect.Effect<BudgetSnapshot, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Four independently wedding-scoped reads, so they go out together.
      const [itemRows, paymentRows, weddingRows, weddingEvents] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select()
              .from(budgetItems)
              .where(eq(budgetItems.weddingId, weddingId))
              .orderBy(asc(budgetItems.category), asc(budgetItems.sortOrder))
              .all(),
          ),
          // Payments for this wedding's items (join through the item's wedding_id).
          dbQuery(() =>
            db
              .select({
                id: payments.id,
                budgetItemId: payments.budgetItemId,
                label: payments.label,
                amountMinor: payments.amountMinor,
                dueAt: payments.dueAt,
                paidAt: payments.paidAt,
                createdAt: payments.createdAt,
              })
              .from(payments)
              .innerJoin(budgetItems, eq(payments.budgetItemId, budgetItems.id))
              .where(eq(budgetItems.weddingId, weddingId))
              .all(),
          ),
          dbQuery(() =>
            db
              .select({
                budgetTotalMinor: weddings.budgetTotalMinor,
                currency: weddings.currency,
                rsvpDeadline: weddings.rsvpDeadline,
                rsvpDeadlineTimezone: weddings.rsvpDeadlineTimezone,
              })
              .from(weddings)
              .where(eq(weddings.id, weddingId))
              .all(),
          ),
          loadEvents(weddingId),
        ],
        { concurrency: 4 },
      );
      const rows = itemRows as ItemRow[];
      // Only a wedding with a per-head line pays for the invitation read.
      const invitations = rows.some((r) => r.unitPriceMinor !== null)
        ? yield* loadInvitations(weddingId)
        : [];
      const weddingEventIds = new Set(weddingEvents.map((e) => e.id));
      const items = rows.map((r) => toItemDto(r, perHeadFields(r, weddingEventIds, invitations)));
      const [wedding] = weddingRows;
      const rsvpsClosed = isRsvpClosed(
        wedding?.rsvpDeadline,
        wedding?.rsvpDeadlineTimezone,
        new Date(),
      );
      return {
        items,
        payments: (paymentRows as PaymentRow[]).map(toPaymentDto),
        // A per-head line's computed amount stands in its estimate column.
        rollup: computeRollup(
          items.map((it) => ({
            category: it.category,
            estimateMinor: lineEstimate(it, rsvpsClosed),
            quotedMinor: it.quotedMinor,
            actualMinor: it.actualMinor,
          })),
        ),
        budgetTotalMinor: wedding?.budgetTotalMinor ?? null,
        currency: wedding?.currency ?? "AUD",
        events: weddingEvents,
        rsvpsClosed,
      };
    }).pipe(Effect.withSpan("cire.budget.get"));
  },

  createItem(
    input: CreateBudgetItemInput,
  ): Effect.Effect<BudgetItemDto, EventNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const perHead = input.perHead ?? null;
      const eventIds = perHead?.eventIds ?? null;
      // Append to the end of the category: next sort_order = current max + 1.
      // A per-head line also needs the wedding's events, for the picked-event
      // check and its headcount, so the two reads go out together.
      const [existing, weddingEvents] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({ sortOrder: budgetItems.sortOrder })
              .from(budgetItems)
              .where(
                and(
                  eq(budgetItems.weddingId, input.weddingId),
                  eq(budgetItems.category, input.category),
                ),
              )
              .all(),
          ),
          perHead === null ? Effect.succeed(null) : loadEvents(input.weddingId),
        ],
        { concurrency: 2 },
      );
      if (weddingEvents !== null && eventIds !== null) {
        yield* requirePickedEvents(weddingEvents, eventIds);
      }
      const maxSort = (existing as { sortOrder: number }[]).reduce(
        (m, r) => Math.max(m, r.sortOrder),
        -1,
      );
      const id = `bit_${crypto.randomUUID()}`;
      const now = new Date();
      const row: ItemRow = {
        id,
        weddingId: input.weddingId,
        category: input.category,
        name: input.name,
        // A per-head line's estimate is computed, never stored.
        estimateMinor: perHead === null ? input.estimateMinor : null,
        quotedMinor: input.quotedMinor,
        actualMinor: input.actualMinor,
        unitPriceMinor: perHead?.unitPriceMinor ?? null,
        perHeadEventIds: eventIds === null ? null : JSON.stringify(uniqueIds(eventIds)),
        notes: input.notes,
        sortOrder: maxSort + 1,
        createdAt: now,
        updatedAt: now,
      };
      if (weddingEvents === null) {
        yield* dbQuery(() => db.insert(budgetItems).values(row).run());
        return toItemDto(row, FIXED_LINE);
      }
      // The invitation read does not depend on the insert, so it rides alongside.
      const [, invitations] = yield* Effect.all(
        [dbQuery(() => db.insert(budgetItems).values(row).run()), loadInvitations(input.weddingId)],
        { concurrency: 2 },
      );
      return describePerHead(row, weddingEvents, invitations);
    }).pipe(Effect.withSpan("cire.budget.createItem"));
  },

  updateItem(input: {
    weddingId: string;
    itemId: string;
    patch: UpdateBudgetItemPatch;
  }): Effect.Effect<BudgetItemDto, BudgetItemNotInWedding | EventNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, patch } = input;

      const set: SQLiteUpdateSetSource<typeof budgetItems> = { updatedAt: new Date() };
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.quotedMinor !== undefined) set.quotedMinor = patch.quotedMinor;
      if (patch.actualMinor !== undefined) set.actualMinor = patch.actualMinor;
      if (patch.notes !== undefined) set.notes = patch.notes;

      // A per-head line never stores an estimate, so a switch back to a fixed
      // line cannot bring back a figure the organiser has not seen for months.
      if (patch.perHead === null) {
        set.unitPriceMinor = null;
        set.perHeadEventIds = null;
        if (patch.estimateMinor !== undefined) set.estimateMinor = patch.estimateMinor;
      } else if (patch.perHead !== undefined) {
        set.unitPriceMinor = patch.perHead.unitPriceMinor;
        set.estimateMinor = null;
        const eventIds = patch.perHead.eventIds;
        if (eventIds === null) set.perHeadEventIds = null;
        else if (eventIds !== undefined) set.perHeadEventIds = JSON.stringify(uniqueIds(eventIds));
      } else if (patch.estimateMinor === null) {
        set.estimateMinor = null;
      } else if (patch.estimateMinor !== undefined) {
        // Decided by the row as stored, in the same statement: an estimate sent
        // for a line that is per head is dropped, not kept out of sight.
        set.estimateMinor = sql`CASE WHEN ${budgetItems.unitPriceMinor} IS NULL THEN ${patch.estimateMinor} ELSE NULL END`;
      }

      // Single round trip (as hosts.setRole): RETURNING reports whether an
      // (item, wedding) row existed — zero rows maps to BudgetItemNotInWedding
      // with no separate existence SELECT.
      const update = dbQuery(() =>
        db
          .update(budgetItems)
          .set(set)
          .where(and(eq(budgetItems.id, itemId), eq(budgetItems.weddingId, weddingId)))
          .returning()
          .all(),
      );

      if (patch.perHead == null) {
        // Only the returned row says whether the line is per head, so its
        // headcount has to wait for the write.
        const [updated] = yield* update;
        if (!updated) return yield* Effect.fail(new BudgetItemNotInWedding());
        return yield* describeItem(weddingId, updated as ItemRow);
      }

      // The patch makes the line per head, so its events and invitations are
      // needed whatever the write returns. Picked events are checked before
      // anything is written; the invitation read rides alongside the write.
      const pickedIds = patch.perHead.eventIds;
      const checkedEvents =
        pickedIds == null
          ? null
          : yield* loadEvents(weddingId).pipe(
              Effect.tap((weddingEvents) => requirePickedEvents(weddingEvents, pickedIds)),
            );
      const [[updated], weddingEvents, invitations] = yield* Effect.all(
        [
          update,
          checkedEvents === null ? loadEvents(weddingId) : Effect.succeed(checkedEvents),
          loadInvitations(weddingId),
        ],
        { concurrency: 3 },
      );
      if (!updated) return yield* Effect.fail(new BudgetItemNotInWedding());
      return describePerHead(updated as ItemRow, weddingEvents, invitations);
    }).pipe(Effect.withSpan("cire.budget.updateItem"));
  },

  removeItem(
    weddingId: string,
    itemId: string,
  ): Effect.Effect<void, BudgetItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Payments cascade via the FK ON DELETE CASCADE. Single round trip:
      // DELETE .. RETURNING reports whether a row existed.
      const [removed] = yield* dbQuery(() =>
        db
          .delete(budgetItems)
          .where(and(eq(budgetItems.id, itemId), eq(budgetItems.weddingId, weddingId)))
          .returning({ id: budgetItems.id })
          .all(),
      );
      if (!removed) return yield* Effect.fail(new BudgetItemNotInWedding());
    }).pipe(Effect.withSpan("cire.budget.removeItem"));
  },

  reorderItems(
    weddingId: string,
    category: ServiceCategory,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Each id gets its array index as sort_order, scoped to (wedding, category)
      // so a foreign or wrong-category id is a no-op UPDATE rather than a write.
      // commitGroupedBatches, not db.transaction(): D1 has no BEGIN/COMMIT —
      // batch() is its only atomic primitive — and the body allows up to 500
      // ids, so the write set must chunk under the 50-statement batch cap.
      // Singleton groups: each row's UPDATE is independent (a re-sent reorder
      // converges), so chunking loses nothing.
      yield* dbQuery(() =>
        commitGroupedBatches(
          db,
          orderedIds.map((id, index) => [
            db
              .update(budgetItems)
              .set({ sortOrder: index })
              .where(
                and(
                  eq(budgetItems.id, id),
                  eq(budgetItems.weddingId, weddingId),
                  eq(budgetItems.category, category),
                ),
              ),
          ]),
        ),
      );
    }).pipe(Effect.withSpan("cire.budget.reorderItems"));
  },

  addPayment(input: {
    weddingId: string;
    itemId: string;
    label: string;
    amountMinor: number;
    dueAt: string | null;
  }): Effect.Effect<PaymentDto, BudgetItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* requireItem(input.weddingId, input.itemId);
      const id = `pay_${crypto.randomUUID()}`;
      const now = new Date();
      const row: PaymentRow = {
        id,
        budgetItemId: input.itemId,
        label: input.label,
        amountMinor: input.amountMinor,
        dueAt: input.dueAt,
        paidAt: null,
        createdAt: now,
      };
      yield* dbQuery(() => db.insert(payments).values(row).run());
      return toPaymentDto(row);
    }).pipe(Effect.withSpan("cire.budget.addPayment"));
  },

  updatePayment(input: {
    weddingId: string;
    itemId: string;
    paymentId: string;
    patch: { label?: string; amountMinor?: number; dueAt?: string | null; paid?: boolean };
  }): Effect.Effect<PaymentDto, BudgetItemNotInWedding | PaymentNotInItem, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, paymentId, patch } = input;
      // The item read stays: it is the tenancy gate (payments carry no
      // wedding_id of their own). The payment SELECT + UPDATE + re-SELECT
      // collapse to one UPDATE .. RETURNING round trip.
      yield* requireItem(weddingId, itemId);

      const set: Partial<PaymentRow> = {};
      if (patch.label !== undefined) set.label = patch.label;
      if (patch.amountMinor !== undefined) set.amountMinor = patch.amountMinor;
      if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
      if (patch.paid !== undefined) set.paidAt = patch.paid ? new Date() : null;

      // An empty patch degrades to a plain read (drizzle rejects an empty SET).
      const [updated] = yield* dbQuery(() =>
        Object.keys(set).length === 0
          ? db
              .select()
              .from(payments)
              .where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId)))
              .all()
          : db
              .update(payments)
              .set(set)
              .where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId)))
              .returning()
              .all(),
      );
      if (!updated) return yield* Effect.fail(new PaymentNotInItem());
      return toPaymentDto(updated as PaymentRow);
    }).pipe(Effect.withSpan("cire.budget.updatePayment"));
  },

  removePayment(input: {
    weddingId: string;
    itemId: string;
    paymentId: string;
  }): Effect.Effect<void, BudgetItemNotInWedding | PaymentNotInItem, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, paymentId } = input;
      // Tenancy gate as in updatePayment; the delete itself is one
      // DELETE .. RETURNING round trip.
      yield* requireItem(weddingId, itemId);
      const [removed] = yield* dbQuery(() =>
        db
          .delete(payments)
          .where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId)))
          .returning({ id: payments.id })
          .all(),
      );
      if (!removed) return yield* Effect.fail(new PaymentNotInItem());
    }).pipe(Effect.withSpan("cire.budget.removePayment"));
  },
};
