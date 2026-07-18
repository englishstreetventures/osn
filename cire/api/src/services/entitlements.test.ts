import { describe, it, expect } from "bun:test";

import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb } from "../db/setup";
import { entitlementService, CapacityExceeded } from "./entitlements";

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
});
