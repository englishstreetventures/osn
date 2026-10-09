import { describe, expect, it } from "bun:test";

import { families, guests, weddingEntitlements, weddings } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import {
  BASE_GUEST_CAP,
  CapacityExceeded,
  capForTier,
  EXEMPT_OWNER_SEATS,
  isPaidTier,
  isTier,
  legacyEntitlementKeys,
  normaliseTier,
  peopleLimitOf,
  peopleLimitSql,
  roomForOneMoreGuest,
  TIER_GUEST_CAP,
  TIER_PEOPLE_LIMIT,
  TIERS,
  tierAtLeast,
  tierForGuests,
  tierForPeople,
  tierRankSql,
  tierService,
  tiersBelow,
} from "../../src/services/tiers";
import type { Tier } from "../../src/services/tiers";
import { boundParameterCount, recordStatements, setTier } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

type TestDb = ReturnType<typeof createDb>;

const run = <A, E>(db: TestDb, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)) as Effect.Effect<A, E, never>);

function seedWedding(db: TestDb, id = "wed_test", tier: Tier = "ivory") {
  const now = new Date();
  insertWedding(db, {
    id,
    slug: `${id}-slug`,
    displayName: "Test",
    owners: ["usr_owner"],
    createdAt: now,
  });
  setTier(db, id, tier);
  return id;
}

function grantPremiumTemplates(db: TestDb, weddingId: string) {
  db.insert(weddingEntitlements)
    .values({
      weddingId,
      entitlement: "premium_templates",
      source: "comp",
      grantedAt: new Date(),
      grantedBy: "x",
    })
    .run();
}

function tierRow(db: TestDb, id: string) {
  return db
    .select({
      tier: weddings.tier,
      tierSource: weddings.tierSource,
      tierGrantedBy: weddings.tierGrantedBy,
    })
    .from(weddings)
    .where(eq(weddings.id, id))
    .get();
}

describe("the tier ladder", () => {
  it("ranks ivory below gold below crimson", () => {
    expect(TIERS).toEqual(["ivory", "gold", "crimson"]);
    expect(tierAtLeast("ivory", "gold")).toBe(false);
    expect(tierAtLeast("gold", "gold")).toBe(true);
    expect(tierAtLeast("crimson", "gold")).toBe(true);
    expect(tierAtLeast("gold", "crimson")).toBe(false);
    expect(tierAtLeast("ivory", "ivory")).toBe(true);
    expect(tiersBelow("crimson")).toEqual(["ivory", "gold"]);
    expect(tiersBelow("ivory")).toEqual([]);
  });

  it("caps guests at 100, 500 and 1000", () => {
    expect(TIER_GUEST_CAP).toEqual({ ivory: 100, gold: 500, crimson: 1000 });
    expect(BASE_GUEST_CAP).toBe(100);
    expect(TIERS.map(capForTier)).toEqual([100, 500, 1000]);
  });

  it("names the lowest tier that holds a guest count, or none", () => {
    expect(tierForGuests(0)).toBe("ivory");
    expect(tierForGuests(100)).toBe("ivory");
    expect(tierForGuests(101)).toBe("gold");
    expect(tierForGuests(500)).toBe("gold");
    expect(tierForGuests(501)).toBe("crimson");
    expect(tierForGuests(1000)).toBe("crimson");
    expect(tierForGuests(1001)).toBeNull();
  });

  it("limits people to 6, 15 and 40, and exempts two owners", () => {
    expect(TIER_PEOPLE_LIMIT).toEqual({ ivory: 6, gold: 15, crimson: 40 });
    expect(EXEMPT_OWNER_SEATS).toBe(2);
  });

  it("names the lowest tier whose people limit holds a count, or none", () => {
    expect(tierForPeople(0)).toBe("ivory");
    expect(tierForPeople(6)).toBe("ivory");
    expect(tierForPeople(7)).toBe("gold");
    expect(tierForPeople(15)).toBe("gold");
    expect(tierForPeople(16)).toBe("crimson");
    expect(tierForPeople(40)).toBe("crimson");
    expect(tierForPeople(41)).toBeNull();
  });

  describe("peopleLimitOf", () => {
    it("reports the tier's limit and the count it was given", () => {
      expect(peopleLimitOf("ivory", 4)).toMatchObject({ used: 4, limit: 6 });
      expect(peopleLimitOf("gold", 4)).toMatchObject({ used: 4, limit: 15 });
      expect(peopleLimitOf("crimson", 4)).toMatchObject({ used: 4, limit: 40 });
    });

    it("names the wedding's own tier while it has room, never a lower one", () => {
      // Gold with 3 people: Ivory would hold a fourth, but the wedding holds Gold.
      expect(peopleLimitOf("gold", 3).tier).toBe("gold");
      expect(peopleLimitOf("ivory", 5).tier).toBe("ivory");
      expect(peopleLimitOf("crimson", 0).tier).toBe("crimson");
    });

    it("names the tier to upgrade to at the limit", () => {
      expect(peopleLimitOf("ivory", 6).tier).toBe("gold");
      expect(peopleLimitOf("gold", 15).tier).toBe("crimson");
    });

    it("names the lowest tier that holds one more when the wedding is over its limit", () => {
      // Lowered from Crimson to Ivory with 20 people: Gold's 15 cannot hold 21.
      expect(peopleLimitOf("ivory", 20)).toEqual({ used: 20, limit: 6, tier: "crimson" });
      expect(peopleLimitOf("ivory", 10)).toEqual({ used: 10, limit: 6, tier: "gold" });
    });

    it("names no tier when even the top one cannot hold one more", () => {
      expect(peopleLimitOf("crimson", 40)).toEqual({ used: 40, limit: 40, tier: null });
      expect(peopleLimitOf("ivory", 45).tier).toBeNull();
    });
  });

  it("reads each wedding's people limit in SQL as TIER_PEOPLE_LIMIT does, and an unknown tier as Ivory's", () => {
    const db = createDb(":memory:");
    const stored = { wed_i: "ivory", wed_g: "gold", wed_c: "crimson", wed_x: "platinum" } as const;
    for (const [id, tier] of Object.entries(stored)) {
      seedWedding(db, id);
      db.update(weddings)
        .set({ tier: tier as Tier })
        .where(eq(weddings.id, id))
        .run();
    }
    const limits = Object.fromEntries(
      Object.keys(stored).map((id) => [
        id,
        Number(
          db
            .select({ limit: peopleLimitSql(id) })
            .from(weddings)
            .where(eq(weddings.id, id))
            .get()?.limit,
        ),
      ]),
    );
    expect(limits).toEqual({
      wed_i: TIER_PEOPLE_LIMIT.ivory,
      wed_g: TIER_PEOPLE_LIMIT.gold,
      wed_c: TIER_PEOPLE_LIMIT.crimson,
      wed_x: TIER_PEOPLE_LIMIT.ivory,
    });
  });

  it("reads anything it does not recognise as ivory", () => {
    expect(normaliseTier("gold")).toBe("gold");
    expect(normaliseTier("platinum")).toBe("ivory");
    expect(normaliseTier(null)).toBe("ivory");
    expect(normaliseTier(undefined)).toBe("ivory");
    expect(isTier("crimson")).toBe(true);
    expect(isTier("vendors")).toBe(false);
    expect(isPaidTier("ivory")).toBe(false);
    expect(isPaidTier("gold")).toBe(true);
  });

  it("ranks a stored tier in SQL as the list does, and anything unknown as ivory", () => {
    const db = createDb(":memory:");
    for (const [id, tier] of [
      ["wed_i", "ivory"],
      ["wed_g", "gold"],
      ["wed_c", "crimson"],
      ["wed_x", "platinum"],
    ] as const) {
      seedWedding(db, id);
      db.update(weddings)
        .set({ tier: tier as Tier })
        .where(eq(weddings.id, id))
        .run();
    }
    const ranks = db
      .select({ id: weddings.id, rank: tierRankSql(weddings.tier) })
      .from(weddings)
      .all();
    expect(Object.fromEntries(ranks.map((r) => [r.id, Number(r.rank)]))).toEqual({
      wed_i: TIERS.indexOf("ivory"),
      wed_g: TIERS.indexOf("gold"),
      wed_c: TIERS.indexOf("crimson"),
      wed_x: TIERS.indexOf("ivory"),
    });
  });
});

describe("legacyEntitlementKeys", () => {
  it("stands each tier in for the keys it replaced", () => {
    expect(legacyEntitlementKeys("ivory", false)).toEqual([]);
    expect(legacyEntitlementKeys("gold", false)).toEqual(["registry", "capacity_500"]);
    expect(legacyEntitlementKeys("crimson", false)).toEqual([
      "vendors",
      "registry",
      "capacity_1000",
      "premium_templates",
    ]);
  });

  it("adds a held premium_templates row below Crimson, once", () => {
    expect(legacyEntitlementKeys("ivory", true)).toEqual(["premium_templates"]);
    expect(legacyEntitlementKeys("gold", true)).toEqual([
      "registry",
      "capacity_500",
      "premium_templates",
    ]);
    expect(
      legacyEntitlementKeys("crimson", true).filter((k) => k === "premium_templates"),
    ).toHaveLength(1);
  });
});

describe("tierService.grant", () => {
  it("raises a wedding and records who did it", async () => {
    const db = createDb();
    const w = seedWedding(db);
    await run(db, tierService.grant(w, "gold", { source: "purchase", grantedBy: "stripe:upg_1" }));
    expect(tierRow(db, w)).toEqual({
      tier: "gold",
      tierSource: "purchase",
      tierGrantedBy: "stripe:upg_1",
    });
    await run(db, tierService.grant(w, "crimson", { source: "comp", grantedBy: "script:ops" }));
    expect(tierRow(db, w)).toEqual({
      tier: "crimson",
      tierSource: "comp",
      tierGrantedBy: "script:ops",
    });
  });

  it("never lowers a wedding, and leaves its attribution alone", async () => {
    const db = createDb();
    const w = seedWedding(db);
    await run(db, tierService.grant(w, "crimson", { source: "comp", grantedBy: "script:ops" }));
    await run(db, tierService.grant(w, "gold", { source: "purchase", grantedBy: "stripe:upg_2" }));
    expect(tierRow(db, w)).toEqual({
      tier: "crimson",
      tierSource: "comp",
      tierGrantedBy: "script:ops",
    });
  });

  it("is a no-op when replayed", async () => {
    const db = createDb();
    const w = seedWedding(db);
    const grant = { source: "purchase" as const, grantedBy: "stripe:upg_1" };
    await run(db, tierService.grant(w, "gold", grant));
    await run(db, tierService.grant(w, "gold", { ...grant, grantedBy: "stripe:upg_9" }));
    expect(tierRow(db, w)?.tierGrantedBy).toBe("stripe:upg_1");
  });

  it("touches only the wedding it names", async () => {
    const db = createDb();
    const a = seedWedding(db, "wed_a");
    const b = seedWedding(db, "wed_b");
    await run(db, tierService.grant(a, "crimson", { source: "comp", grantedBy: "script:ops" }));
    expect(tierRow(db, b)?.tier).toBe("ivory");
  });
});

describe("tierService.tierGrantStatement with a tier the wedding must hold", () => {
  const grant = { source: "purchase" as const, grantedBy: "stripe:upg_1" };
  const raise = (db: TestDb, w: string, heldAtLeast?: Tier) =>
    tierService.tierGrantStatement(db, w, "crimson", grant, heldAtLeast).run();

  it("raises only a wedding that holds it now, in the one statement", () => {
    const db = createDb();
    const ivory = seedWedding(db, "wed_i", "ivory");
    const gold = seedWedding(db, "wed_g", "gold");
    raise(db, ivory, "gold");
    raise(db, gold, "gold");
    expect(tierRow(db, ivory)?.tier).toBe("ivory");
    expect(tierRow(db, gold)?.tier).toBe("crimson");
  });

  it("without one, raises from any tier below", () => {
    const db = createDb();
    const ivory = seedWedding(db, "wed_i", "ivory");
    raise(db, ivory);
    expect(tierRow(db, ivory)?.tier).toBe("crimson");
  });

  it("matches nothing when the required tier is the target itself", () => {
    // A purchase can never be priced from the tier it buys; if a row ever
    // claimed it, the grant must change nothing rather than fail.
    const db = createDb();
    const gold = seedWedding(db, "wed_g", "gold");
    tierService.tierGrantStatement(db, gold, "gold", grant, "gold").run();
    expect(tierRow(db, gold)).toEqual({ tier: "gold", tierSource: null, tierGrantedBy: null });
  });
});

describe("tierService.tierOf", () => {
  it("reads the wedding's tier, and an unknown wedding as ivory", async () => {
    const db = createDb();
    const w = seedWedding(db, "wed_g", "gold");
    expect(await run(db, tierService.tierOf(w))).toBe("gold");
    expect(await run(db, tierService.tierOf("wed_missing"))).toBe("ivory");
  });
});

describe("tierService.hasPremiumTemplates", () => {
  it("is true on Crimson with no row, and below it only with the row", async () => {
    const db = createDb();
    const crimson = seedWedding(db, "wed_c", "crimson");
    const gold = seedWedding(db, "wed_g", "gold");
    const bought = seedWedding(db, "wed_b", "ivory");
    grantPremiumTemplates(db, bought);
    expect(await run(db, tierService.hasPremiumTemplates(crimson))).toBe(true);
    expect(await run(db, tierService.hasPremiumTemplates(gold))).toBe(false);
    expect(await run(db, tierService.hasPremiumTemplates(bought))).toBe(true);
    expect(await run(db, tierService.hasPremiumTemplates("wed_missing"))).toBe(false);
  });

  it("answers for the named wedding only", async () => {
    const db = createDb();
    const holder = seedWedding(db, "wed_holder");
    const other = seedWedding(db, "wed_other");
    grantPremiumTemplates(db, holder);
    expect(await run(db, tierService.hasPremiumTemplates(other))).toBe(false);
  });

  describe("with the tier a role gate already read", () => {
    it("answers Crimson without a statement", async () => {
      const db = createDb();
      const w = seedWedding(db, "wed_c", "crimson");
      const statements = recordStatements(db);
      expect(await run(db, tierService.hasPremiumTemplates(w, "crimson"))).toBe(true);
      expect(statements).toEqual([]);
    });

    it("below Crimson, reads only the entitlement row", async () => {
      const db = createDb();
      const bought = seedWedding(db, "wed_b", "gold");
      const plain = seedWedding(db, "wed_p", "gold");
      grantPremiumTemplates(db, bought);
      const statements = recordStatements(db);
      expect(await run(db, tierService.hasPremiumTemplates(bought, "gold"))).toBe(true);
      expect(await run(db, tierService.hasPremiumTemplates(plain, "ivory"))).toBe(false);
      expect(statements).toHaveLength(2);
      for (const s of statements) {
        expect(s.sql).toContain('"wedding_entitlements"');
        expect(s.sql).not.toContain('from "weddings"');
      }
    });
  });
});

describe("tierService.premiumTemplateHolders", () => {
  it("returns the weddings holding a premium_templates row, and reads no other key", async () => {
    const db = createDb();
    const a = seedWedding(db, "wed_a");
    const b = seedWedding(db, "wed_b");
    const c = seedWedding(db, "wed_c");
    grantPremiumTemplates(db, a);
    db.insert(weddingEntitlements)
      .values({
        weddingId: b,
        entitlement: "vendors",
        source: "comp",
        grantedAt: new Date(),
        grantedBy: "x",
      })
      .run();
    const holders = await run(db, tierService.premiumTemplateHolders([a, b, c]));
    expect([...holders]).toEqual([a]);
    expect((await run(db, tierService.premiumTemplateHolders([]))).size).toBe(0);
  });

  it("binds the wedding ids as one parameter, however many the organiser has", async () => {
    // The organiser wedding list reads up to 200 weddings, and D1 refuses a
    // statement over 100 parameters.
    const db = createDb();
    const a = seedWedding(db, "wed_a");
    grantPremiumTemplates(db, a);
    const ids = [a, ...Array.from({ length: 150 }, (_, i) => `wed_absent_${i}`)];

    const statements = recordStatements(db);
    const holders = await run(db, tierService.premiumTemplateHolders(ids));

    expect([...holders]).toEqual([a]);
    const reads = statements.filter((s) => s.sql.includes('from "wedding_entitlements"'));
    expect(reads).toHaveLength(1);
    // The id list, and the entitlement key.
    expect(boundParameterCount(reads[0]!.sql)).toBe(2);
  });
});

describe("tierService.assertGuestCapacity", () => {
  const assert = (db: TestDb, w: string, incoming: number, precomputed?: number) =>
    Effect.runPromiseExit(
      tierService
        .assertGuestCapacity(w, incoming, precomputed)
        .pipe(Effect.provideService(DbService, db)),
    );

  it("passes when current + incoming fits the tier's cap", async () => {
    const db = createDb();
    expect(Exit.isSuccess(await assert(db, seedWedding(db), 100))).toBe(true);
  });

  it("fails on Ivory past 100, naming Gold as the tier that would hold it", async () => {
    const db = createDb();
    const w = seedWedding(db);
    const err = await run(db, tierService.assertGuestCapacity(w, 101).pipe(Effect.flip));
    expect(err).toBeInstanceOf(CapacityExceeded);
    expect({ limit: err.limit, current: err.current, requiredTier: err.requiredTier }).toEqual({
      limit: 100,
      current: 0,
      requiredTier: "gold",
    });
  });

  it("follows the tier: Gold holds 500, Crimson 1000, and past that no tier will", async () => {
    const db = createDb();
    const gold = seedWedding(db, "wed_g", "gold");
    const crimson = seedWedding(db, "wed_c", "crimson");
    expect(Exit.isSuccess(await assert(db, gold, 500))).toBe(true);
    expect(Exit.isFailure(await assert(db, gold, 501))).toBe(true);
    expect(Exit.isSuccess(await assert(db, crimson, 1000))).toBe(true);
    const err = await run(db, tierService.assertGuestCapacity(crimson, 1001).pipe(Effect.flip));
    expect(err.requiredTier).toBeNull();
  });

  it("ignores every legacy entitlement row: only the tier sets the cap", async () => {
    const db = createDb();
    const w = seedWedding(db);
    for (const entitlement of ["capacity_500", "capacity_1000", "vendors", "registry"] as const) {
      db.insert(weddingEntitlements)
        .values({
          weddingId: w,
          entitlement,
          source: "comp",
          grantedAt: new Date(),
          grantedBy: "x",
        })
        .run();
    }
    expect(Exit.isFailure(await assert(db, w, 101))).toBe(true);
  });

  it("reads the tier and counts the guests in one statement", async () => {
    const db = createDb();
    const w = seedWedding(db);
    const now = new Date();
    db.insert(families)
      .values([
        {
          id: "fam_guest",
          weddingId: w,
          publicId: "G-1",
          familyName: "G",
          kind: "guest",
          source: "import",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "fam_host",
          weddingId: w,
          publicId: "H-1",
          familyName: "H",
          kind: "host",
          source: "import",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(guests)
      .values([
        {
          id: "g_1",
          familyId: "fam_guest",
          firstName: "A",
          lastName: "G",
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "g_2",
          familyId: "fam_guest",
          firstName: "B",
          lastName: "G",
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "g_h",
          familyId: "fam_host",
          firstName: "H",
          lastName: "H",
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const statements = recordStatements(db);
    expect(Exit.isSuccess(await assert(db, w, 98))).toBe(true);
    expect(statements).toHaveLength(1);

    // The host-preview household still does not count: two real guests.
    const err = await run(db, tierService.assertGuestCapacity(w, 99).pipe(Effect.flip));
    expect({ limit: err.limit, current: err.current }).toEqual({ limit: 100, current: 2 });
  });

  describe("precomputedCap", () => {
    it("enforces against the given cap, ignoring the tier", async () => {
      const db = createDb();
      const w = seedWedding(db, "wed_c", "crimson");
      const err = await run(db, tierService.assertGuestCapacity(w, 51, 50).pipe(Effect.flip));
      expect(err.limit).toBe(50);
    });

    it("a generous precomputedCap admits what the tier would have refused", async () => {
      const db = createDb();
      expect(Exit.isSuccess(await assert(db, seedWedding(db), 400, 500))).toBe(true);
    });

    it("undefined falls back to reading the tier", async () => {
      const db = createDb();
      expect(Exit.isFailure(await assert(db, seedWedding(db), 101, undefined))).toBe(true);
    });
  });
});

describe("roomForOneMoreGuest", () => {
  // The cap a write checks inside its own statement. It must agree with
  // `capForTier` and `countGuests` at every ceiling, or a naming could pass (or
  // fail) the cap the read before it applied.
  let households = 0;
  function seedGuests(db: TestDb, w: string, count: number, kind: "guest" | "host" = "guest") {
    const now = new Date();
    const familyId = `fam_${w}_${kind}_${++households}`;
    db.insert(families)
      .values({
        id: familyId,
        weddingId: w,
        publicId: familyId.toUpperCase(),
        familyName: "Filler",
        kind,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (let i = 0; i < count; i++) {
      db.insert(guests)
        .values({
          id: `${familyId}_${i}`,
          familyId,
          firstName: `G${i}`,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  /** 1 when the condition holds, 0 when not — read in a WHERE, where it is used. */
  const room = (db: TestDb, w: string) =>
    db
      .select({ id: weddings.id })
      .from(weddings)
      .where(and(eq(weddings.id, w), roomForOneMoreGuest(w)))
      .get() === undefined
      ? 0
      : 1;

  it("has room below the Ivory cap and none at it", () => {
    const db = createDb();
    const w = seedWedding(db);
    seedGuests(db, w, 99);
    expect(room(db, w)).toBe(1);
    seedGuests(db, w, 1);
    expect(room(db, w)).toBe(0);
  });

  it("does not count the host-preview household", () => {
    const db = createDb();
    const w = seedWedding(db);
    seedGuests(db, w, 99);
    seedGuests(db, w, 5, "host");
    expect(room(db, w)).toBe(1);
  });

  it("lifts the ceiling to 500 on Gold and to 1000 on Crimson", () => {
    const db = createDb();
    const w = seedWedding(db);
    seedGuests(db, w, 500);
    expect(room(db, w)).toBe(0);
    setTier(db, w, "gold");
    expect(room(db, w)).toBe(0);
    setTier(db, w, "crimson");
    expect(room(db, w)).toBe(1);
  });

  it("stops at 500 on Gold", () => {
    const db = createDb();
    const w = seedWedding(db, "wed_g", "gold");
    seedGuests(db, w, 499);
    expect(room(db, w)).toBe(1);
    seedGuests(db, w, 1);
    expect(room(db, w)).toBe(0);
  });

  it("reads its own wedding's tier, not a neighbour's", () => {
    const db = createDb();
    const w = seedWedding(db);
    seedWedding(db, "wed_rich", "crimson");
    seedGuests(db, w, 100);
    expect(room(db, w)).toBe(0);
  });
});
