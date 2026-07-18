import { families, guests, weddingEntitlements } from "@cire/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { type Db, DbService, dbQuery } from "../db";

export const ENTITLEMENT_KEYS = [
  "premium_templates",
  "vendors",
  "ai",
  "capacity_500",
  "capacity_1000",
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/** Raised when a guest-adding write would breach the wedding's derived cap. */
export class CapacityExceeded extends Data.TaggedError("CapacityExceeded")<{
  limit: number;
  current: number;
}> {}

/** Effective guest ceiling from the entitlement set. Pure. */
function deriveCap(keys: readonly string[]): number {
  if (keys.includes("capacity_1000")) return 1000;
  if (keys.includes("capacity_500")) return 500;
  return 100;
}

/** Count real guests on a wedding, EXCLUDING the synthetic host-preview family. */
function countGuests(db: Db, weddingId: string): Effect.Effect<number, never, never> {
  return dbQuery(() =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
      .all(),
  ).pipe(Effect.map((rows) => (rows[0]?.n as number) ?? 0));
}

export const entitlementService = {
  deriveCap,

  has(weddingId: string, key: EntitlementKey): Effect.Effect<boolean, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({ e: weddingEntitlements.entitlement })
          .from(weddingEntitlements)
          .where(
            and(
              eq(weddingEntitlements.weddingId, weddingId),
              eq(weddingEntitlements.entitlement, key),
            ),
          )
          .all(),
      );
      return rows.length > 0;
    }).pipe(Effect.withSpan("cire.entitlements.has"));
  },

  setsForWeddings(
    weddingIds: string[],
  ): Effect.Effect<Map<string, EntitlementKey[]>, never, DbService> {
    return Effect.gen(function* () {
      const map = new Map<string, EntitlementKey[]>();
      if (weddingIds.length === 0) return map;
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            weddingId: weddingEntitlements.weddingId,
            entitlement: weddingEntitlements.entitlement,
          })
          .from(weddingEntitlements)
          .where(inArray(weddingEntitlements.weddingId, weddingIds))
          .all(),
      );
      for (const r of rows as { weddingId: string; entitlement: EntitlementKey }[]) {
        const list = map.get(r.weddingId) ?? [];
        list.push(r.entitlement);
        map.set(r.weddingId, list);
      }
      return map;
    }).pipe(Effect.withSpan("cire.entitlements.setsForWeddings"));
  },

  grant(
    weddingId: string,
    key: EntitlementKey,
    opts: { source: "purchase" | "comp"; grantedBy: string; providerRef?: string | null },
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* dbQuery(() =>
        db
          .insert(weddingEntitlements)
          .values({
            weddingId,
            entitlement: key,
            source: opts.source,
            grantedAt: new Date(),
            grantedBy: opts.grantedBy,
            providerRef: opts.providerRef ?? null,
          })
          .onConflictDoNothing()
          .run(),
      );
    }).pipe(Effect.withSpan("cire.entitlements.grant"));
  },

  assertGuestCapacity(
    weddingId: string,
    incomingNewGuests: number,
  ): Effect.Effect<void, CapacityExceeded, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({ e: weddingEntitlements.entitlement })
          .from(weddingEntitlements)
          .where(eq(weddingEntitlements.weddingId, weddingId))
          .all(),
      );
      const cap = deriveCap((rows as { e: string }[]).map((r) => r.e));
      const current = yield* countGuests(db, weddingId);
      if (current + incomingNewGuests > cap) {
        return yield* Effect.fail(new CapacityExceeded({ limit: cap, current }));
      }
    }).pipe(Effect.withSpan("cire.entitlements.assertGuestCapacity"));
  },
};
