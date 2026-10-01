import { describe, it, expect } from "bun:test";

import { families, guests, weddings } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import {
  entitlementPresent,
  entitlementService,
  CapacityExceeded,
  roomForOneMoreGuest,
} from "../../src/services/entitlements";
import type { EntitlementKey } from "../../src/services/entitlements";

const run = <A, E>(db: ReturnType<typeof createDb>, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)) as Effect.Effect<A, E, never>);

// deriveCap is pure — table-test it directly.
describe("deriveCap", () => {
  it("returns 100 with no capacity row", () => {
    expect(entitlementService.deriveCap([])).toBe(100);
    expect(entitlementService.deriveCap(["vendors", "ai"])).toBe(100);
  });
  it("returns 500 with capacity_500", () => {
    expect(entitlementService.deriveCap(["capacity_500"])).toBe(500);
  });
  it("returns 1000 with capacity_1000, even alongside 500", () => {
    expect(entitlementService.deriveCap(["capacity_1000"])).toBe(1000);
    expect(entitlementService.deriveCap(["capacity_500", "capacity_1000"])).toBe(1000);
  });
});

function seedWedding(db: ReturnType<typeof createDb>, id = "wed_test") {
  const now = new Date();
  db.$client.exec(
    `INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, code_style, currency, created_at, updated_at)
     VALUES ('${id}', '${id}-slug', 'Test', 'usr_owner', 'secure', 'AUD', ${now.getTime()}, ${now.getTime()});`,
  );
  return id;
}

describe("entitlementPresent", () => {
  // The column both role-gate folds read. Every gated organiser route trusts
  // it, so it must answer for the wedding it names and no other: one couple's
  // purchase unlocking every wedding would pass every single-wedding test.
  it("answers for the named wedding and key only", async () => {
    const db = createDb();
    const unpaid = seedWedding(db, "wed_unpaid");
    const paid = seedWedding(db, "wed_paid");
    await run(
      db,
      entitlementService.grant(paid, "vendors", { source: "comp", grantedBy: "usr_owner" }),
    );
    const present = (weddingId: string, key: EntitlementKey) =>
      db
        .select({ v: entitlementPresent(weddingId, key) })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .get()?.v;

    expect(present(paid, "vendors")).toBe(1);
    expect(present(unpaid, "vendors")).toBe(0);
    expect(present(paid, "registry")).toBe(0);
  });

  it("correlates to the outer row when given a column instead of an id", async () => {
    const db = createDb();
    seedWedding(db, "wed_unpaid");
    const paid = seedWedding(db, "wed_paid");
    await run(
      db,
      entitlementService.grant(paid, "registry", { source: "comp", grantedBy: "usr_owner" }),
    );
    // One table, so Drizzle writes a column placed directly in a selected `sql`
    // field bare. The outer reference must still name `weddings`, or inside the
    // subquery it could bind to the inner table's own column of that name.
    const query = db
      .select({ id: weddings.id, v: entitlementPresent(weddings.id, "registry") })
      .from(weddings);
    expect(query.toSQL().sql).toContain(`= "weddings"."id"`);
    expect(query.all().toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "wed_paid", v: 1 },
      { id: "wed_unpaid", v: 0 },
    ]);
  });
});

describe("grant + has", () => {
  it("grant makes has() true; absent key is false", async () => {
    const db = createDb();
    const w = seedWedding(db);
    expect(await run(db, entitlementService.has(w, "vendors"))).toBe(false);
    await run(
      db,
      entitlementService.grant(w, "vendors", { source: "comp", grantedBy: "usr_owner" }),
    );
    expect(await run(db, entitlementService.has(w, "vendors"))).toBe(true);
  });

  it("grant is idempotent — a second grant is a no-op, one row", async () => {
    const db = createDb();
    const w = seedWedding(db);
    await run(db, entitlementService.grant(w, "ai", { source: "comp", grantedBy: "usr_owner" }));
    await run(db, entitlementService.grant(w, "ai", { source: "comp", grantedBy: "usr_owner" }));
    const rows = db.$client
      .query(
        `SELECT COUNT(*) AS n FROM wedding_entitlements WHERE wedding_id = ? AND entitlement = 'ai'`,
      )
      .get(w) as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("setsForWeddings", () => {
  it("batch-returns each wedding's key set", async () => {
    const db = createDb();
    const a = seedWedding(db, "wed_a");
    const b = seedWedding(db, "wed_b");
    await run(db, entitlementService.grant(a, "vendors", { source: "comp", grantedBy: "x" }));
    await run(db, entitlementService.grant(a, "capacity_500", { source: "comp", grantedBy: "x" }));
    const map = await run(db, entitlementService.setsForWeddings([a, b]));
    expect(new Set(map.get("wed_a"))).toEqual(new Set(["vendors", "capacity_500"]));
    expect(map.get("wed_b") ?? []).toEqual([]);
  });
});

describe("assertGuestCapacity", () => {
  it("passes when current + incoming <= cap", async () => {
    const db = createDb();
    const w = seedWedding(db);
    // cap 100, no guests, adding 10 → ok
    const exit = await Effect.runPromiseExit(
      entitlementService.assertGuestCapacity(w, 10).pipe(Effect.provideService(DbService, db)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails with CapacityExceeded when the addition breaches the derived cap", async () => {
    const db = createDb();
    const w = seedWedding(db);
    const exit = await Effect.runPromiseExit(
      entitlementService.assertGuestCapacity(w, 101).pipe(Effect.provideService(DbService, db)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("upgraded wedding (capacity_500) allows more", async () => {
    const db = createDb();
    const w = seedWedding(db);
    await run(db, entitlementService.grant(w, "capacity_500", { source: "comp", grantedBy: "x" }));
    const exit = await Effect.runPromiseExit(
      entitlementService.assertGuestCapacity(w, 400).pipe(Effect.provideService(DbService, db)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  // The fallback query only reads capacity_500/capacity_1000. A wedding
  // holding every OTHER entitlement must still land on the 100 floor.
  it("non-capacity entitlements (vendors, ai, registry, premium_templates) never raise the cap", async () => {
    const db = createDb();
    const w = seedWedding(db);
    await run(db, entitlementService.grant(w, "vendors", { source: "comp", grantedBy: "x" }));
    await run(db, entitlementService.grant(w, "ai", { source: "comp", grantedBy: "x" }));
    await run(db, entitlementService.grant(w, "registry", { source: "comp", grantedBy: "x" }));
    await run(
      db,
      entitlementService.grant(w, "premium_templates", { source: "comp", grantedBy: "x" }),
    );
    const exit = await Effect.runPromiseExit(
      entitlementService.assertGuestCapacity(w, 101).pipe(Effect.provideService(DbService, db)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  // precomputedCap, when given, is trusted outright — no query runs, no
  // re-derivation from the entitlement table happens. Proven here at the
  // service boundary; import.ts's own test proves the actual query-count
  // saving end to end.
  describe("precomputedCap", () => {
    it("enforces against the given cap, ignoring what the entitlement table would derive", async () => {
      const db = createDb();
      const w = seedWedding(db);
      // Wedding actually holds capacity_1000 (real cap 1000), but a caller
      // hands assertGuestCapacity a stale/smaller precomputedCap of 50 — the
      // function must trust it, not re-derive and override it.
      await run(
        db,
        entitlementService.grant(w, "capacity_1000", { source: "comp", grantedBy: "x" }),
      );
      const err = await run(
        db,
        entitlementService.assertGuestCapacity(w, 51, 50).pipe(Effect.flip),
      );
      expect(err).toBeInstanceOf(CapacityExceeded);
      expect(err.limit).toBe(50);
    });

    it("a generous precomputedCap admits guests the wedding's real entitlements would have refused", async () => {
      const db = createDb();
      const w = seedWedding(db);
      // No capacity entitlement (real cap 100), but precomputedCap says 500.
      const exit = await Effect.runPromiseExit(
        entitlementService
          .assertGuestCapacity(w, 400, 500)
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("undefined precomputedCap falls back to the entitlement query — unchanged behaviour", async () => {
      const db = createDb();
      const w = seedWedding(db);
      const exit = await Effect.runPromiseExit(
        entitlementService
          .assertGuestCapacity(w, 101, undefined)
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});

describe("roomForOneMoreGuest", () => {
  // The cap a write checks inside its own statement. It must agree with
  // `deriveCap` and `countGuests` at every ceiling, or a naming could pass (or
  // fail) the cap the read before it applied.
  function seedGuests(db: ReturnType<typeof createDb>, w: string, count: number, kind = "guest") {
    const now = new Date();
    const familyId = `fam_${kind}_${count}`;
    db.insert(families)
      .values({
        id: familyId,
        weddingId: w,
        publicId: familyId.toUpperCase(),
        familyName: "Filler",
        kind: kind as "guest" | "host",
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
  const room = (db: ReturnType<typeof createDb>, w: string) =>
    db
      .select({ id: weddings.id })
      .from(weddings)
      .where(and(eq(weddings.id, w), roomForOneMoreGuest(w)))
      .get() === undefined
      ? 0
      : 1;

  it("has room below the base cap and none at it", () => {
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

  it("lifts the ceiling to 500 with capacity_500, and to 1000 with capacity_1000", async () => {
    const db = createDb();
    const w = seedWedding(db);
    seedGuests(db, w, 500);
    expect(room(db, w)).toBe(0);
    await run(db, entitlementService.grant(w, "capacity_500", { source: "comp", grantedBy: "x" }));
    expect(room(db, w)).toBe(0);
    await run(db, entitlementService.grant(w, "capacity_1000", { source: "comp", grantedBy: "x" }));
    expect(room(db, w)).toBe(1);
  });

  it("stops at 500 with capacity_500 alone", async () => {
    const db = createDb();
    const w = seedWedding(db);
    seedGuests(db, w, 499);
    await run(db, entitlementService.grant(w, "capacity_500", { source: "comp", grantedBy: "x" }));
    expect(room(db, w)).toBe(1);
  });
});
