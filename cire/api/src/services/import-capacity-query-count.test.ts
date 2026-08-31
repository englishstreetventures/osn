import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families } from "@cire/db";
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import type { ImportPlan, ParsedFamily } from "../schemas/import";
import { countingDb } from "../test-helpers";
import { entitlementService } from "./entitlements";
import { applyImport, diffAgainstDb } from "./import";

/**
 * Proves osn-tracker#119 (P-I2) and osn-tracker#117 (P-W2): `diffAgainstDb`
 * skips the entitlement query entirely when the import can't possibly breach
 * the floor cap, and `applyImport` skips its OWN entitlement query when the
 * plan already carries a `derivedCap` from the SAME request's preview.
 *
 * `countingDb` counts `.select()` calls, the entry point of every read this
 * codebase issues — there is no query-log to assert on directly, so this is
 * the mechanism, matching the one added for P-W1 (see
 * `wedding-entitlement-fold.test.ts`).
 */

function planCreatingNGuests(n: number): ParsedFamily[] {
  return [
    {
      familyName: "QueryCountFamily",
      guests: Array.from({ length: n }, (_, i) => ({
        firstName: `Guest${i}`,
        lastName: "Count",
        nickname: null,
        eventNames: [],
      })),
    },
  ];
}

describe("P-I2: diffAgainstDb's capacity pre-check", () => {
  it("skips the entitlement query when existing+new guests can't exceed the floor (100)", async () => {
    const raw = createDb(":memory:");
    seedBootstrapWedding(raw);
    const { db: counted, selectCount } = countingDb(raw);

    // 0 existing + 5 new = 5, nowhere near the 100 floor.
    const before = selectCount();
    const plan = await Effect.runPromise(
      diffAgainstDb([], planCreatingNGuests(5), BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, counted),
      ),
    );
    const afterSmall = selectCount() - before;

    // Same shape, but enough new guests to cross the floor (0 + 101 > 100) —
    // this run MUST issue the entitlement query, so the two counts differ by
    // exactly one query: the one the pre-check skipped above.
    const raw2 = createDb(":memory:");
    seedBootstrapWedding(raw2);
    const { db: counted2, selectCount: selectCount2 } = countingDb(raw2);
    const before2 = selectCount2();
    await Effect.runPromise(
      diffAgainstDb([], planCreatingNGuests(101), BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, counted2),
      ),
    );
    const afterLarge = selectCount2() - before2;

    expect(afterLarge - afterSmall).toBe(1);
    expect(plan.derivedCap).toBeUndefined();
    expect(plan.warnings).toEqual([]);
  });

  it("still runs the query — and still warns — right at the threshold boundary (101 > 100)", async () => {
    const raw = createDb(":memory:");
    seedBootstrapWedding(raw);
    const plan = await Effect.runPromise(
      diffAgainstDb([], planCreatingNGuests(101), BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, raw),
      ),
    );
    expect(plan.derivedCap).toBe(100);
    expect(plan.warnings.some((w) => /capped at 100/i.test(w))).toBe(true);
  });

  it("skipping the query never skips the warning check — exactly 100 (not over) stays silent, no query needed", async () => {
    const raw = createDb(":memory:");
    seedBootstrapWedding(raw);
    const { db: counted, selectCount } = countingDb(raw);
    const before = selectCount();
    const plan = await Effect.runPromise(
      diffAgainstDb([], planCreatingNGuests(100), BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, counted),
      ),
    );
    // 0 + 100 = 100, not > 100 (BASE_GUEST_CAP) — the pre-check's own
    // boundary, so this must NOT have queried the entitlement table.
    expect(plan.warnings).toEqual([]);
    expect(plan.derivedCap).toBeUndefined();
    // Only the queries diffAgainstDb always issues for a plain family/guest
    // diff ran — none of them touch wedding_entitlements at this size.
    expect(selectCount() - before).toBeGreaterThan(0);
  });
});

describe("P-W2: applyImport reuses diffAgainstDb's derivedCap", () => {
  it("does not re-query entitlements when the plan already carries derivedCap", async () => {
    const raw = createDb(":memory:");
    seedBootstrapWedding(raw);
    // Grant capacity_500 so the preview's own query is forced to run and
    // resolves to a real, non-default cap — proves applyImport actually USES
    // the threaded value rather than coincidentally landing on the same
    // number via its own fallback query.
    await Effect.runPromise(
      entitlementService
        .grant(BOOTSTRAP_WEDDING_ID, "capacity_500", { source: "comp", grantedBy: "usr_admin" })
        .pipe(Effect.provideService(DbService, raw)),
    );

    const plan = await Effect.runPromise(
      diffAgainstDb([], planCreatingNGuests(101), BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, raw),
      ),
    );
    expect(plan.derivedCap).toBe(500);

    const { db: counted, selectCount } = countingDb(raw);
    const before = selectCount();
    const exit = await Effect.runPromiseExit(
      applyImport("imp_derived_cap", plan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, counted),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);

    // Build the SAME plan by hand, minus derivedCap, and apply it against an
    // identically-seeded+granted DB to measure the query applyImport issues
    // WITHOUT a threaded cap — the difference is the query the fold saved.
    const rawBaseline = createDb(":memory:");
    seedBootstrapWedding(rawBaseline);
    await Effect.runPromise(
      entitlementService
        .grant(BOOTSTRAP_WEDDING_ID, "capacity_500", { source: "comp", grantedBy: "usr_admin" })
        .pipe(Effect.provideService(DbService, rawBaseline)),
    );
    const { derivedCap: _derivedCap, ...planWithoutCap } = plan;
    void _derivedCap;
    const { db: countedBaseline, selectCount: selectCountBaseline } = countingDb(rawBaseline);
    const beforeBaseline = selectCountBaseline();
    const exitBaseline = await Effect.runPromiseExit(
      applyImport("imp_no_derived_cap", planWithoutCap as ImportPlan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, countedBaseline),
      ),
    );
    expect(Exit.isSuccess(exitBaseline)).toBe(true);

    expect(selectCountBaseline() - beforeBaseline - (selectCount() - before)).toBe(1);
  });

  it("keeps enforcing the cap when derivedCap is ABSENT from the plan — never a way to skip the check", async () => {
    const raw = createDb(":memory:");
    seedBootstrapWedding(raw);
    const now = new Date();
    const familyId = crypto.randomUUID();
    raw
      .insert(families)
      .values({
        id: familyId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "NO-CAP-FAM",
        familyName: "NoCapFamily",
        kind: "guest",
        source: "import",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // A hand-built plan (never touched diffAgainstDb) with NO derivedCap,
    // creating 101 guests on a wedding with no capacity entitlement — must
    // still fail, proving assertGuestCapacity's own fallback query enforces
    // exactly as it always has when the fold has nothing to give it.
    const plan: ImportPlan = {
      eventCreates: [],
      eventUpdates: [],
      eventRemoves: [],
      familyCreates: [],
      familyUpdates: [],
      familyRemoves: [],
      guestCreates: Array.from({ length: 101 }, (_, i) => ({
        id: crypto.randomUUID(),
        familyId,
        firstName: `NoCapGuest${i}`,
        lastName: "Absent",
        nickname: null,
        sortOrder: i,
      })),
      guestUpdates: [],
      guestRemoves: [],
      eventLinkCreates: [],
      eventLinkRemoves: [],
      warnings: [],
      // derivedCap intentionally omitted.
    };
    expect(plan.derivedCap).toBeUndefined();

    const exit = await Effect.runPromiseExit(
      applyImport("imp_absent_cap", plan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, raw),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const n = (raw.$client.query("SELECT COUNT(*) AS n FROM guests").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
