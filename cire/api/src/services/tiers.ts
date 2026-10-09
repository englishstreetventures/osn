import { families, guests, weddingEntitlements, weddings } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, type Column, eq, getTableName, inArray, ne, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { type Db, DbService, dbQuery } from "../db";

/**
 * The plan tiers, lowest first. The order IS the ranking: {@link tierAtLeast}
 * compares positions in this list, so a tier added between two others is
 * ranked by where it is written.
 *
 * - `ivory` — free: the invite, the guest list, RSVPs and import.
 * - `gold` — adds budget, the checklist and the gift registry.
 * - `crimson` — adds vendors (the CRM, the directory and enquiries) and every
 *   premium invite template.
 */
export const TIERS = ["ivory", "gold", "crimson"] as const;
export type Tier = (typeof TIERS)[number];

/** A tier above the free one — what can be bought or granted. */
export type PaidTier = Exclude<Tier, "ivory">;
export const PAID_TIERS = ["gold", "crimson"] as const satisfies readonly PaidTier[];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function isPaidTier(value: unknown): value is PaidTier {
  return typeof value === "string" && (PAID_TIERS as readonly string[]).includes(value);
}

/**
 * A stored tier as the app reads it. Anything that is not a known tier reads as
 * `ivory`, the tier that unlocks nothing — a value this code does not recognise
 * must never open a paid module.
 */
export function normaliseTier(value: unknown): Tier {
  return isTier(value) ? value : "ivory";
}

/** Whether a wedding on `held` has everything `min` includes. */
export function tierAtLeast(held: Tier, min: Tier): boolean {
  return TIERS.indexOf(held) >= TIERS.indexOf(min);
}

/** Every tier ranked strictly below `tier`, lowest first. */
export function tiersBelow(tier: Tier): Tier[] {
  return TIERS.slice(0, TIERS.indexOf(tier));
}

/**
 * A stored tier's place in {@link TIERS}, as a SQL value, so a statement can
 * compare two tiers the way {@link tierAtLeast} does. A value that is not a
 * known tier ranks as `ivory`, as {@link normaliseTier} reads it.
 */
export function tierRankSql(tier: Column | SQL): SQL<number> {
  const ranks = TIERS.map((name, rank) => sql`WHEN ${name} THEN ${rank}`);
  return sql<number>`(CASE ${tier} ${sql.join(ranks, sql` `)} ELSE ${TIERS.indexOf("ivory")} END)`;
}

/** The guest ceiling each tier gives a wedding. Real guests only: the
 *  host-preview household never counts, and a plus-one always does. */
export const TIER_GUEST_CAP = {
  ivory: 100,
  gold: 500,
  crimson: 1000,
} as const satisfies Record<Tier, number>;

/**
 * The ceiling every wedding starts at, and the lowest any wedding can have.
 * `diffAgainstDb` skips its capacity read when an import cannot pass it, so it
 * must be the floor of {@link TIER_GUEST_CAP}, which it is by construction.
 */
export const BASE_GUEST_CAP = TIER_GUEST_CAP.ivory;

export function capForTier(tier: Tier): number {
  return TIER_GUEST_CAP[tier];
}

/** The lowest tier whose ceiling holds `guestCount` guests, or `null` when
 *  even the top tier's does not. */
export function tierForGuests(guestCount: number): Tier | null {
  return TIERS.find((tier) => TIER_GUEST_CAP[tier] >= guestCount) ?? null;
}

/**
 * How many people each tier lets a wedding hold besides the couple: every seat
 * below owner, plus every owner beyond the first {@link EXEMPT_OWNER_SEATS}.
 * `services/hosts.ts` counts them, and checks the limit inside each statement
 * that could raise the count.
 */
export const TIER_PEOPLE_LIMIT = {
  ivory: 6,
  gold: 15,
  crimson: 40,
} as const satisfies Record<Tier, number>;

/**
 * Owner seats that never count towards the people limit: the couple. A third
 * or later owner counts like a co-host, so promoting a co-host to owner frees
 * no place.
 */
export const EXEMPT_OWNER_SEATS = 2;

/** The lowest tier whose people limit holds `people`, or `null` when even the
 *  top tier's does not. */
export function tierForPeople(people: number): Tier | null {
  return TIERS.find((tier) => TIER_PEOPLE_LIMIT[tier] >= people) ?? null;
}

/**
 * A wedding's people count against its tier's limit.
 *
 * `tier` is the lowest tier, at or above the one the wedding holds, whose limit
 * has room for one more person: the wedding's own tier while it has room, the
 * tier to upgrade to once it is at or over its limit, and `null` when no tier
 * has room. It means what `tier` means on the guest-cap 402: the tier that lets
 * the next write through.
 */
export interface PeopleLimit {
  used: number;
  limit: number;
  tier: Tier | null;
}

/** The one place a {@link PeopleLimit} is built: from the tier the wedding
 *  holds and the count `services/hosts.ts` read in the same statement. */
export function peopleLimitOf(held: Tier, used: number): PeopleLimit {
  const needed = tierForPeople(used + 1);
  return {
    used,
    limit: TIER_PEOPLE_LIMIT[held],
    tier: needed === null ? null : tierAtLeast(needed, held) ? needed : held,
  };
}

/**
 * The wedding's people limit as a scalar SQL subquery, read from its tier in
 * the statement that uses it, so a tier changed by a concurrent request is the
 * one the write is checked against. Keyed by the bound `weddingId`, not by the
 * row of the statement around it, and its columns are qualified, so it reads
 * the same in a WHERE and in a select list. A tier this code does not know
 * reads as Ivory's limit, as {@link normaliseTier} reads the tier.
 */
export function peopleLimitSql(weddingId: string): SQL<number> {
  const limits = TIERS.filter((tier) => tier !== "ivory").map(
    (tier) => sql`WHEN ${tier} THEN ${TIER_PEOPLE_LIMIT[tier]}`,
  );
  return sql<number>`(SELECT CASE ${qualified(weddings, weddings.tier)} ${sql.join(limits, sql` `)} ELSE ${TIER_PEOPLE_LIMIT.ivory} END FROM ${weddings} WHERE ${qualified(weddings, weddings.id)} = ${weddingId})`;
}

/** Raised when a guest-adding write would breach the wedding's tier cap. */
export class CapacityExceeded extends Data.TaggedError("CapacityExceeded")<{
  limit: number;
  current: number;
  /** The lowest tier that would hold the write, or `null` when none would. */
  requiredTier: Tier | null;
}> {}

/**
 * The wedding's guest cap as a scalar SQL subquery, read from its tier in the
 * statement that uses it. `weddings` is named by its own table, so the
 * subquery reads the same row whatever the statement around it selects from.
 */
function guestCapSql(weddingId: string): SQL<number> {
  const ceilings = TIERS.filter((tier) => tier !== "ivory").map(
    (tier) => sql`WHEN ${tier} THEN ${TIER_GUEST_CAP[tier]}`,
  );
  return sql<number>`(SELECT CASE ${weddings.tier} ${sql.join(ceilings, sql` `)} ELSE ${BASE_GUEST_CAP} END FROM ${weddings} WHERE ${weddings.id} = ${weddingId})`;
}

/**
 * "The wedding has room for one more guest", as a SQL condition: its real
 * guests (the host-preview family excluded, as {@link countGuests} counts them)
 * number fewer than the cap its tier gives it now. For a write that adds a
 * guest and must check the cap in the same statement, so two writes in flight
 * at once cannot each see the last place free: D1 runs them one after the
 * other, and the second sees the first's row.
 *
 * Raw `sql` over `guests`, `families` and `weddings` by their own names, so it
 * reads the same tables whatever alias the statement around it gives them. Use
 * it in a WHERE: in a select list Drizzle writes its columns without their
 * table, and `id` then names more than one table.
 */
export function roomForOneMoreGuest(weddingId: string): SQL {
  return sql`${realGuestCountSql(weddingId)} < ${guestCapSql(weddingId)}`;
}

/**
 * `table.column`, spelled out. Drizzle writes a column interpolated into `sql`
 * without its table when the fragment sits in a select list, and `id` then
 * names more than one table; a qualified name reads the same column wherever
 * the fragment is used.
 */
function qualified(table: SQLiteTable, column: Column): SQL {
  return sql`${sql.identifier(getTableName(table))}.${sql.identifier(column.name)}`;
}

/**
 * Real guests on a wedding as a scalar SQL subquery: the synthetic host-preview
 * family is excluded, and a plus-one counts. Its columns are qualified, so it
 * is safe in a select list as well as a WHERE.
 */
function realGuestCountSql(weddingId: string): SQL<number> {
  return sql<number>`(SELECT count(*) FROM ${guests} INNER JOIN ${families} ON ${qualified(guests, guests.familyId)} = ${qualified(families, families.id)} WHERE ${qualified(families, families.weddingId)} = ${weddingId} AND ${qualified(families, families.kind)} <> 'host')`;
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

/** The wedding's tier and its real guest count, in one statement. A wedding
 *  that does not exist reads as Ivory with no guests. */
function tierAndGuestCount(
  db: Db,
  weddingId: string,
): Effect.Effect<{ tier: Tier; current: number }, never, never> {
  return dbQuery(() =>
    db
      .select({ tier: weddings.tier, n: realGuestCountSql(weddingId) })
      .from(weddings)
      .where(eq(weddings.id, weddingId))
      .all(),
  ).pipe(
    Effect.map((rows) => ({
      tier: normaliseTier(rows[0]?.tier),
      current: Number(rows[0]?.n ?? 0),
    })),
  );
}

/** Who moved a wedding to a tier, as `weddings.tier_source` and
 *  `weddings.tier_granted_by` record it. */
export interface TierGrant {
  source: "purchase" | "comp";
  /** `stripe:<purchase id>` for a purchase, `script:<operator>` for a comp. */
  grantedBy: string;
}

/**
 * The grant as a STATEMENT, for a caller folding it into a batch. The upgrade
 * settle commits it with its sales row and status flip in one D1 round trip;
 * `grant` runs exactly this, so the two cannot drift.
 *
 * ONLY EVER UP. The UPDATE matches a wedding only while its tier ranks below
 * `tier`, so a Crimson wedding granted Gold — a late webhook for an older
 * purchase, or an operator's mistake — keeps Crimson and its attribution, and
 * a replayed grant changes nothing. Lowering a tier is a deliberate operator
 * decision, made with `scripts/grant-tier.ts --lower`.
 *
 * `heldAtLeast` also requires the wedding to hold that tier now: a purchase
 * priced as an upgrade from Gold raises only a wedding still on Gold, checked
 * in the same statement that raises it.
 */
function tierGrantStatement(
  db: Db,
  weddingId: string,
  tier: PaidTier,
  grant: TierGrant,
  heldAtLeast?: Tier,
) {
  const from = tiersBelow(tier).filter(
    (held) => heldAtLeast === undefined || tierAtLeast(held, heldAtLeast),
  );
  return (
    db
      .update(weddings)
      .set({ tier, tierSource: grant.source, tierGrantedBy: grant.grantedBy })
      // oxlint-disable-next-line house/no-unbounded-in-array -- at most two values: `from` is drawn from TIERS, below `tier`
      .where(and(eq(weddings.id, weddingId), inArray(weddings.tier, from)))
  );
}

/**
 * The legacy entitlement keys a tier stands for, plus `premium_templates`
 * when the wedding holds that row. The wedding list still carries them so a
 * portal build that reads keys rather than `tier` locks exactly what the tier
 * leaves locked.
 */
// Removed by englishstventures/osn#1315.
export function legacyEntitlementKeys(tier: Tier, holdsPremiumTemplates: boolean): string[] {
  const keys: string[] =
    tier === "crimson"
      ? ["vendors", "registry", "capacity_1000", "premium_templates"]
      : tier === "gold"
        ? ["registry", "capacity_500"]
        : [];
  if (holdsPremiumTemplates && !keys.includes("premium_templates")) {
    keys.push("premium_templates");
  }
  return keys;
}

export const tierService = {
  tierGrantStatement,

  /** Read a wedding's tier. A wedding that does not exist reads as `ivory`. */
  tierOf(weddingId: string): Effect.Effect<Tier, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db.select({ tier: weddings.tier }).from(weddings).where(eq(weddings.id, weddingId)).all(),
      );
      return normaliseTier(rows[0]?.tier);
    }).pipe(Effect.withSpan("cire.tier.tierOf"));
  },

  grant(
    weddingId: string,
    tier: PaidTier,
    grant: TierGrant,
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* dbQuery(() => tierGrantStatement(db, weddingId, tier, grant).run());
    }).pipe(Effect.withSpan("cire.tier.grant"));
  },

  /**
   * Whether the wedding may use a premium invite template: Crimson includes
   * them, and a wedding below it may hold the one-off `premium_templates`
   * entitlement.
   *
   * `knownTier` is the tier a role gate already read from the wedding row in
   * the same request. Given it, a Crimson wedding costs no statement, and one
   * below Crimson costs only the probe of its entitlement row. Without it, the
   * tier and the probe come back in one statement.
   */
  hasPremiumTemplates(
    weddingId: string,
    knownTier?: Tier,
  ): Effect.Effect<boolean, never, DbService> {
    return Effect.gen(function* () {
      if (knownTier !== undefined && tierAtLeast(knownTier, "crimson")) return true;
      const db = yield* DbService;
      if (knownTier !== undefined) {
        const held = yield* dbQuery(() =>
          db
            .select({ weddingId: weddingEntitlements.weddingId })
            .from(weddingEntitlements)
            .where(
              and(
                eq(weddingEntitlements.weddingId, weddingId),
                eq(weddingEntitlements.entitlement, "premium_templates"),
              ),
            )
            .all(),
        );
        return held.length > 0;
      }
      const rows = yield* dbQuery(() =>
        db
          .select({
            tier: weddings.tier,
            held: sql<number>`EXISTS (SELECT 1 FROM ${weddingEntitlements} WHERE ${weddingEntitlements.weddingId} = ${weddingId} AND ${weddingEntitlements.entitlement} = 'premium_templates')`,
          })
          .from(weddings)
          .where(eq(weddings.id, weddingId))
          .all(),
      );
      const row = rows[0];
      if (!row) return false;
      return tierAtLeast(normaliseTier(row.tier), "crimson") || Boolean(row.held);
    }).pipe(Effect.withSpan("cire.tier.hasPremiumTemplates"));
  },

  /**
   * Which of `weddingIds` hold a `premium_templates` row. Reads that key alone:
   * every other entitlement key is answered by the tier now.
   */
  premiumTemplateHolders(weddingIds: string[]): Effect.Effect<Set<string>, never, DbService> {
    return Effect.gen(function* () {
      const holders = new Set<string>();
      if (weddingIds.length === 0) return holders;
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({ weddingId: weddingEntitlements.weddingId })
          .from(weddingEntitlements)
          .where(
            and(
              inArray(weddingEntitlements.weddingId, jsonEachIn(weddingIds)),
              eq(weddingEntitlements.entitlement, "premium_templates"),
            ),
          )
          .all(),
      );
      for (const r of rows) holders.add(r.weddingId);
      return holders;
    }).pipe(Effect.withSpan("cire.tier.premiumTemplateHolders"));
  },

  /**
   * Fail with {@link CapacityExceeded} when `incomingNewGuests` more real
   * guests would take the wedding past its tier's cap.
   *
   * `precomputedCap`, when given, skips reading the tier and enforces against
   * that cap instead — `applyImport` already has it from `diffAgainstDb`'s
   * preview in the same request — so the check is a count alone. A given cap
   * is NEVER a way to skip the check, only to skip re-reading the tier;
   * omitted, the tier and the count come back in one statement and the check
   * is exactly the same.
   */
  assertGuestCapacity(
    weddingId: string,
    incomingNewGuests: number,
    precomputedCap?: number,
  ): Effect.Effect<void, CapacityExceeded, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      let cap: number;
      let current: number;
      if (precomputedCap === undefined) {
        const read = yield* tierAndGuestCount(db, weddingId);
        cap = capForTier(read.tier);
        current = read.current;
      } else {
        cap = precomputedCap;
        current = yield* countGuests(db, weddingId);
      }
      if (current + incomingNewGuests > cap) {
        return yield* Effect.fail(
          new CapacityExceeded({
            limit: cap,
            current,
            requiredTier: tierForGuests(current + incomingNewGuests),
          }),
        );
      }
    }).pipe(Effect.withSpan("cire.tier.assertGuestCapacity"));
  },
};
