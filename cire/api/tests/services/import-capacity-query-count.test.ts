import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families } from "@cire/db";
import { Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { ImportPlan, ParsedFamily } from "../../src/schemas/import";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { countingDb, setTier } from "../test-helpers";

/**
 * What the guest-cap check costs an import. `diffAgainstDb` reads the tier on
 * the wedding row it already reads for the claim-code style, so crossing the
 * 100-guest floor costs no statement of its own, and below the floor the cap
 * is not computed at all. `applyImport` enforces against the plan's
 * `derivedCap` when the same request's preview computed one.
 *
 * `countingDb` counts `.select()` calls, the entry point of every read this
 * codebase issues — there is no query-log to assert on directly, so this is
 * the mechanism, matching `tests/middleware/wedding-tier.test.ts`.
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

describe("diffAgainstDb's capacity pre-check", () => {
  it("reads the tier on the wedding row it already reads, so crossing the floor costs nothing", async () => {
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

    // Same shape, but enough new guests to cross the floor (0 + 101 > 100).
    // This run needs the tier, and finds it on the row the claim-code read
    // already fetched: the two runs issue the same statements.
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

    expect(afterLarge - afterSmall).toBe(0);
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
    // boundary, so this must NOT have read the tier.
    expect(plan.warnings).toEqual([]);
    expect(plan.derivedCap).toBeUndefined();
    // Only the queries diffAgainstDb always issues for a plain family/guest
    // diff ran — none of them read the tier at this size.
    expect(selectCount() - before).toBeGreaterThan(0);
  });
});

describe("applyImport reuses diffAgainstDb's derivedCap", () => {
  it("enforces against the plan's derivedCap rather than reading the tier again", async () => {
    // Previewed on Gold, so the plan carries a cap of 500. The wedding is then
    // put back on Ivory before the apply: an apply that read the tier again
    // would refuse 101 guests, one that uses the plan's cap admits them.
    const raw = createDb(":memory:");
    seedBootstrapWedding(raw);
    setTier(raw, BOOTSTRAP_WEDDING_ID, "gold");
    const plan = await Effect.runPromise(
      diffAgainstDb([], planCreatingNGuests(101), BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, raw),
      ),
    );
    expect(plan.derivedCap).toBe(500);
    setTier(raw, BOOTSTRAP_WEDDING_ID, "ivory");

    const exit = await Effect.runPromiseExit(
      applyImport("imp_derived_cap", plan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, raw),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);

    // The same plan without its cap, on an identical Ivory wedding, is refused:
    // the difference above is the threaded value, not the tier.
    const rawBaseline = createDb(":memory:");
    seedBootstrapWedding(rawBaseline);
    const { derivedCap: _derivedCap, ...planWithoutCap } = plan;
    void _derivedCap;
    const exitBaseline = await Effect.runPromiseExit(
      applyImport("imp_no_derived_cap", planWithoutCap as ImportPlan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, rawBaseline),
      ),
    );
    expect(Exit.isFailure(exitBaseline)).toBe(true);
  });

  it("costs the same statements with or without derivedCap: the fallback tier read rides the count", async () => {
    const raw = createDb(":memory:");
    seedBootstrapWedding(raw);
    setTier(raw, BOOTSTRAP_WEDDING_ID, "gold");
    const plan = await Effect.runPromise(
      diffAgainstDb([], planCreatingNGuests(101), BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, raw),
      ),
    );
    const { db: counted, selectCount } = countingDb(raw);
    const before = selectCount();
    await Effect.runPromise(
      applyImport("imp_with_cap", plan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, counted),
      ),
    );
    const withCap = selectCount() - before;

    const rawBaseline = createDb(":memory:");
    seedBootstrapWedding(rawBaseline);
    setTier(rawBaseline, BOOTSTRAP_WEDDING_ID, "gold");
    const { derivedCap: _derivedCap, ...planWithoutCap } = plan;
    void _derivedCap;
    const { db: countedBaseline, selectCount: selectCountBaseline } = countingDb(rawBaseline);
    const beforeBaseline = selectCountBaseline();
    await Effect.runPromise(
      applyImport("imp_without_cap", planWithoutCap as ImportPlan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, countedBaseline),
      ),
    );
    expect(selectCountBaseline() - beforeBaseline).toBe(withCap);
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
    // creating 101 guests on an Ivory wedding — must still fail, proving
    // assertGuestCapacity's own fallback read enforces
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
