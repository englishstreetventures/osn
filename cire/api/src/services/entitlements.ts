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
  // Gift registry. Deliberately granted to NO wedding — the module ships built
  // but locked, so every organiser sees the nav tab and an upsell panel, and
  // every registry route answers 402. Grant it with scripts/grant-entitlement.ts
  // to open the feature for one wedding.
  "registry",
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/**
 * The only two rows that can ever raise `deriveCap`'s result above the floor.
 * Narrows the capacity-check queries (`assertGuestCapacity`, and
 * `diffAgainstDb`'s preview warning) to `WHERE entitlement IN (...)` instead
 * of fetching every entitlement row on the wedding — P-I3. NOT used by
 * `setsForWeddings`, which feeds feature display and `deriveCap` in
 * `organiser-weddings.ts` and must keep returning the full set.
 */
export const CAPACITY_ENTITLEMENT_KEYS = ["capacity_500", "capacity_1000"] as const;

/** Raised when a guest-adding write would breach the wedding's derived cap. */
export class CapacityExceeded extends Data.TaggedError("CapacityExceeded")<{
  limit: number;
  current: number;
}> {}

/**
 * Guest ceiling for a wedding holding neither capacity entitlement — the
 * floor every wedding starts at. Named (not inlined) so `diffAgainstDb`'s
 * pre-check (P-I2: skip the capacity query when the post-import guest count
 * can't possibly exceed this floor) can never drift from what `deriveCap`
 * actually falls back to.
 */
export const BASE_GUEST_CAP = 100;

/** Effective guest ceiling from the entitlement set. Pure. */
function deriveCap(keys: readonly string[]): number {
  if (keys.includes("capacity_1000")) return 1000;
  if (keys.includes("capacity_500")) return 500;
  return BASE_GUEST_CAP;
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

  /**
   * `precomputedCap`, when given, skips this function's own entitlement query
   * entirely and enforces against that cap instead (P-W2) — the caller
   * (`applyImport`) already has it from `diffAgainstDb`'s preview, which ran
   * in the SAME request, so re-fetching the same rows here would just be a
   * second scan of data already in hand. Omitted (the common case for any
   * caller besides `applyImport`, and `applyImport` itself whenever the plan
   * carries no cap — see `import.ts:713-716`'s "hard atomic block" comment),
   * this runs its own query and enforces exactly as it always has. A given
   * cap is NEVER a way to skip the check, only to skip re-deriving it.
   */
  assertGuestCapacity(
    weddingId: string,
    incomingNewGuests: number,
    precomputedCap?: number,
  ): Effect.Effect<void, CapacityExceeded, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      let cap = precomputedCap;
      if (cap === undefined) {
        const rows = yield* dbQuery(() =>
          db
            .select({ e: weddingEntitlements.entitlement })
            .from(weddingEntitlements)
            .where(
              and(
                eq(weddingEntitlements.weddingId, weddingId),
                inArray(weddingEntitlements.entitlement, CAPACITY_ENTITLEMENT_KEYS),
              ),
            )
            .all(),
        );
        cap = deriveCap((rows as { e: string }[]).map((r) => r.e));
      }
      const current = yield* countGuests(db, weddingId);
      if (current + incomingNewGuests > cap) {
        return yield* Effect.fail(new CapacityExceeded({ limit: cap, current }));
      }
    }).pipe(Effect.withSpan("cire.entitlements.assertGuestCapacity"));
  },
};
