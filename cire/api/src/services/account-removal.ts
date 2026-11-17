/**
 * What a host's removal of their Cire data would do, as the portal's
 * "Remove my Cire data" screen lists it: every wedding a profile of the
 * account holds a seat on, with the seat's role and whether the wedding is
 * already deleted. Which of them the person alone owns comes from
 * `accountErasureService.preview`, the rule the removal itself refuses on, so
 * the list and the refusal cannot disagree. The removal runs the account
 * erasure (`services/account-erasure.ts`) with the `host` scope; the route is
 * `routes/organiser-account.ts`.
 */
import { weddingHosts, weddings } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";

/** Weddings the screen lists one by one; past it, it says how many more. */
export const MAX_LISTED_SEATS = 200;

/** A seat's role as the screen shows it, the strongest the profiles hold on the wedding. */
export type SeatRole = "owner" | "editor" | "viewer" | "helper";

export interface RemovalSeat {
  readonly weddingId: string;
  readonly name: string;
  readonly role: SeatRole;
  /** The wedding is soft-deleted: the removal takes the last seat, and the purge then takes it. */
  readonly deleted: boolean;
}

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
        deleted: row.deletedAt !== null,
      })),
      more: Math.max(0, total - rows.length),
    };
  }).pipe(Effect.withSpan("cire.account_removal.seats"));
}

export const accountRemovalService = { seats };
