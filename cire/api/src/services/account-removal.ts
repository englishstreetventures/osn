/**
 * What a host's removal of their Cire data would do, as the portal's
 * "Remove my Cire data" screen lists it: every wedding a profile of the
 * account holds a seat on, with the seat's role, whether the person alone
 * owns it, and whether it is already deleted. Sole ownership is read by the
 * same predicate the account deletion's preview reads it by (`otherOwnerOn`),
 * so the list and the refusal cannot disagree, past the preview's hundred
 * too. The removal runs the account
 * erasure (`services/account-erasure.ts`) with the `host` scope; the route is
 * `routes/organiser-account.ts`.
 */
import { weddingHosts, weddings } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery, outerColumn } from "../db";
import { otherOwnerOn, payoutHeldSeat } from "./account-erasure";

/** Weddings the screen lists one by one; past it, it says how many more. */
export const MAX_LISTED_SEATS = 200;

/** A seat's role as the screen shows it, the strongest the profiles hold on the wedding. */
export type SeatRole = "owner" | "editor" | "viewer" | "helper";

export interface RemovalSeat {
  readonly weddingId: string;
  readonly name: string;
  readonly role: SeatRole;
  /** A live wedding whose every owner seat is one of the account's profiles: the removal deletes it. */
  readonly soleOwner: boolean;
  /** The wedding is soft-deleted: the removal takes the last seat, and the purge then takes it. */
  readonly deleted: boolean;
  /**
   * A profile of the account holds the Stripe account the wedding's money
   * gifts are paid into, as one of its owners beside another owner
   * (`payoutHeldSeat`): the removal is refused until they hand it over or
   * disconnect it.
   */
  readonly payoutHolder: boolean;
}

/** A wedding whose payout account the removal is refused for, as the refusal lists it. */
export interface HeldPayoutWedding {
  readonly weddingId: string;
  readonly name: string;
}

/** Weddings the refusal lists; a person holds the account of a handful at most. */
export const MAX_LISTED_HOLDS = 50;

/**
 * The order a seat's role ranks in: an owner seat outranks every other. A
 * stray legacy `host` seat reads as `editor`, as `mapStoredRole`
 * (`services/hosts.ts`) reads it.
 */
const RANK = sql<number>`min(CASE ${weddingHosts.role} WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 WHEN 'host' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END)`;

const ROLE_OF_RANK = ["owner", "editor", "viewer", "helper"] as const satisfies readonly SeatRole[];

/**
 * Every wedding the profiles hold a seat on, one row each, by name: at most
 * {@link MAX_LISTED_SEATS}, and how many more there are. One statement.
 */
function seats(
  profileIds: ReadonlyArray<string>,
): Effect.Effect<{ readonly seats: RemovalSeat[]; readonly more: number }, never, DbService> {
  return Effect.gen(function* () {
    if (profileIds.length === 0) return { seats: [], more: 0 };
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({
          weddingId: weddings.id,
          name: weddings.displayName,
          deletedAt: weddings.deletedAt,
          rank: RANK,
          soleOwner: sql<number>`CASE WHEN ${RANK} = 1 AND ${weddings.deletedAt} IS NULL AND NOT ${otherOwnerOn(outerColumn(weddings.id), profileIds)} THEN 1 ELSE 0 END`,
          payoutHolder: sql<number>`max(CASE WHEN ${weddingHosts.role} = 'owner' AND ${payoutHeldSeat(outerColumn(weddings.id), outerColumn(weddingHosts.osnProfileId), profileIds)} THEN 1 ELSE 0 END)`,
          total: sql<number>`count(*) OVER ()`,
        })
        .from(weddingHosts)
        .innerJoin(weddings, eq(weddings.id, weddingHosts.weddingId))
        .where(inArray(weddingHosts.osnProfileId, jsonEachIn(profileIds)))
        .groupBy(weddings.id)
        .orderBy(asc(weddings.displayName), asc(weddings.id))
        .limit(MAX_LISTED_SEATS)
        .all(),
    );
    const total = Number(rows[0]?.total ?? 0);
    return {
      seats: rows.map((row) => ({
        weddingId: row.weddingId,
        name: row.name,
        role: ROLE_OF_RANK[Number(row.rank) - 1] ?? "helper",
        soleOwner: Number(row.soleOwner) === 1,
        deleted: row.deletedAt !== null,
        payoutHolder: Number(row.payoutHolder) === 1,
      })),
      more: Math.max(0, total - rows.length),
    };
  }).pipe(Effect.withSpan("cire.account_removal.seats"));
}

/**
 * The live weddings on which a profile of the account sits as an owner and
 * holds the Stripe account money gifts are paid into, beside another owner
 * ({@link payoutHeldSeat}): what the removal refuses on, by name, at most
 * {@link MAX_LISTED_HOLDS}. One statement.
 */
function payoutHolds(
  profileIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<HeldPayoutWedding>, never, DbService> {
  return Effect.gen(function* () {
    if (profileIds.length === 0) return [];
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ weddingId: weddings.id, name: weddings.displayName })
        .from(weddingHosts)
        .innerJoin(weddings, eq(weddings.id, weddingHosts.weddingId))
        .where(
          and(
            inArray(weddingHosts.osnProfileId, jsonEachIn(profileIds)),
            eq(weddingHosts.role, "owner"),
            payoutHeldSeat(
              outerColumn(weddings.id),
              outerColumn(weddingHosts.osnProfileId),
              profileIds,
            ),
          ),
        )
        .groupBy(weddings.id)
        .orderBy(asc(weddings.displayName), asc(weddings.id))
        .limit(MAX_LISTED_HOLDS)
        .all(),
    );
    return rows.map((row) => ({ weddingId: row.weddingId, name: row.name }));
  }).pipe(Effect.withSpan("cire.account_removal.payout_holds"));
}

export const accountRemovalService = { seats, payoutHolds };
