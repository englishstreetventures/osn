import { describe, expect, it } from "bun:test";

import { unlockCodeRedemptions, unlockCodes, weddings, weddingUpgradePurchases } from "@cire/db";
import { hashRecoveryCode } from "@shared/crypto/recovery";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { runCire } from "../../src/observability";
import type { PaidTier, Tier } from "../../src/services/tiers";
import { unlockCodeService } from "../../src/services/unlock-codes";
import { recordStatements, setTier } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

type TestDb = ReturnType<typeof createDb>;

const OWNER = "usr_owner";
const CODE = "3f9a-0c1e-b7d2-48aa";
const OTHER_CODE = "0000-1111-2222-3333";
const NOW = new Date("2026-10-08T00:00:00.000Z");
const METRIC = "cire.tier.unlock_code.redemptions";

function fresh(): TestDb {
  return createDb(":memory:");
}

function seedWedding(db: TestDb, id: string, tier: Tier = "ivory") {
  insertWedding(db, {
    id,
    slug: `${id}-slug`,
    displayName: "Test",
    owners: [OWNER],
    createdAt: NOW,
  });
  setTier(db, id, tier);
  return id;
}

function seedCode(
  db: TestDb,
  opts: {
    id?: string;
    code?: string;
    tier?: PaidTier;
    max?: number;
    used?: number;
    expiresAt?: Date | null;
  } = {},
) {
  const id = opts.id ?? "ulc_a";
  db.insert(unlockCodes)
    .values({
      id,
      codeHash: hashRecoveryCode(opts.code ?? CODE),
      tier: opts.tier ?? "gold",
      maxRedemptions: opts.max ?? 1,
      redeemedCount: opts.used ?? 0,
      expiresAt: opts.expiresAt ?? null,
      createdBy: "script:ops",
      createdAt: NOW,
    })
    .run();
  return id;
}

const redeem = (
  db: TestDb,
  weddingId: string,
  unlockCode: string = CODE,
  now: Date = NOW,
): Promise<{ ok: true; tier: PaidTier } | { ok: false; tag: string; tier?: Tier }> =>
  Effect.runPromise(
    unlockCodeService.redeem({ weddingId, osnProfileId: OWNER, unlockCode, now }).pipe(
      Effect.map((r) => ({ ok: true as const, tier: r.tier })),
      Effect.catchTags({
        UnlockCodeRefused: (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
        UnlockCodeTierHeld: (e) =>
          Effect.succeed({ ok: false as const, tag: e._tag, tier: e.tier }),
        UnlockCodePurchaseInFlight: (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
      }),
      Effect.provideService(DbService, db),
    ),
  );

function weddingRow(db: TestDb, id: string) {
  return db
    .select({
      tier: weddings.tier,
      source: weddings.tierSource,
      grantedBy: weddings.tierGrantedBy,
    })
    .from(weddings)
    .where(eq(weddings.id, id))
    .get();
}

const spent = (db: TestDb, id = "ulc_a") =>
  db.select({ n: unlockCodes.redeemedCount }).from(unlockCodes).where(eq(unlockCodes.id, id)).get()
    ?.n;

const redemptions = (db: TestDb) => db.select().from(unlockCodeRedemptions).all();

describe("unlockCodeService.redeem", () => {
  it("raises an Ivory wedding to the code's tier and records who redeemed it", async () => {
    const db = fresh();
    seedWedding(db, "wed_a");
    seedCode(db);

    expect(await redeem(db, "wed_a")).toEqual({ ok: true, tier: "gold" });

    expect(weddingRow(db, "wed_a")).toEqual({
      tier: "gold",
      source: "code",
      grantedBy: "code:ulc_a",
    });
    expect(spent(db)).toBe(1);
    const [row] = redemptions(db);
    expect(row).toMatchObject({
      codeId: "ulc_a",
      weddingId: "wed_a",
      redeemedByOsnProfileId: OWNER,
      redeemedAt: NOW,
    });
    expect(row!.id).toStartWith("ulr_");
  });

  it.each([
    ["upper case", CODE.toUpperCase()],
    ["no dashes", CODE.replaceAll("-", "")],
    ["spaces instead of dashes", ` ${CODE.replaceAll("-", " ")} `],
  ])("takes the code typed in %s", async (_label, typed) => {
    const db = fresh();
    seedWedding(db, "wed_a");
    seedCode(db);
    expect(await redeem(db, "wed_a", typed)).toEqual({ ok: true, tier: "gold" });
  });

  it("lifts a Gold wedding to Crimson with a Crimson code", async () => {
    const db = fresh();
    seedWedding(db, "wed_a", "gold");
    seedCode(db, { tier: "crimson" });
    expect(await redeem(db, "wed_a")).toEqual({ ok: true, tier: "crimson" });
    expect(weddingRow(db, "wed_a")?.tier).toBe("crimson");
  });

  describe("gives the same refusal for every code that cannot be used, and writes nothing", () => {
    it.each([
      ["an unknown code", {}, OTHER_CODE],
      ["an expired code", { expiresAt: NOW }, CODE],
      ["an expired code, long past", { expiresAt: new Date("2026-01-01T00:00:00Z") }, CODE],
      ["a used-up code", { max: 2, used: 2 }, CODE],
    ] as const)("%s", async (_label, code, typed) => {
      const db = fresh();
      seedWedding(db, "wed_a");
      seedCode(db, code);
      const before = spent(db);

      expect(await redeem(db, "wed_a", typed)).toEqual({ ok: false, tag: "UnlockCodeRefused" });
      expect(weddingRow(db, "wed_a")).toEqual({ tier: "ivory", source: null, grantedBy: null });
      expect(spent(db)).toBe(before);
      expect(redemptions(db)).toEqual([]);
    });

    it("a code this wedding has already redeemed, even after its tier was lowered", async () => {
      const db = fresh();
      seedWedding(db, "wed_a");
      seedWedding(db, "wed_b");
      seedCode(db, { max: 3 });
      // Another wedding's redemption first, so the lookup must read the code's
      // own rows for THIS wedding and not merely any row.
      expect(await redeem(db, "wed_b")).toMatchObject({ ok: true });
      expect(await redeem(db, "wed_a")).toMatchObject({ ok: true });
      setTier(db, "wed_a", "ivory");

      expect(await redeem(db, "wed_a")).toEqual({ ok: false, tag: "UnlockCodeRefused" });
      expect(spent(db)).toBe(2);
      expect(redemptions(db)).toHaveLength(2);
    });

    it("a soft-deleted wedding", async () => {
      const db = fresh();
      seedWedding(db, "wed_a");
      db.update(weddings).set({ deletedAt: NOW }).where(eq(weddings.id, "wed_a")).run();
      seedCode(db);
      expect(await redeem(db, "wed_a")).toEqual({ ok: false, tag: "UnlockCodeRefused" });
      expect(spent(db)).toBe(0);
    });

    // A paid wedding typing a bad code gets the 404 too, never "already on
    // Gold": the tier-held answer is only for a code that is live.
    it.each([
      ["an unknown code", {}, OTHER_CODE],
      ["an expired code", { expiresAt: NOW }, CODE],
      ["a used-up code", { max: 2, used: 2 }, CODE],
    ] as const)("%s, on a wedding already on Gold", async (_label, code, typed) => {
      const db = fresh();
      seedWedding(db, "wed_gold", "gold");
      seedCode(db, { ...code, tier: "crimson" });
      const before = spent(db);
      expect(await redeem(db, "wed_gold", typed)).toEqual({ ok: false, tag: "UnlockCodeRefused" });
      expect(spent(db)).toBe(before);
    });
  });

  it("still takes a code in its last second", async () => {
    const db = fresh();
    seedWedding(db, "wed_a");
    seedCode(db, { expiresAt: new Date(NOW.getTime() + 1000) });
    expect(await redeem(db, "wed_a")).toEqual({ ok: true, tier: "gold" });
  });

  it("never lowers or repeats a tier: it names the wedding's tier and spends nothing", async () => {
    const db = fresh();
    seedWedding(db, "wed_crimson", "crimson");
    seedWedding(db, "wed_gold", "gold");
    seedCode(db, { tier: "gold", max: 5 });

    expect(await redeem(db, "wed_crimson")).toEqual({
      ok: false,
      tag: "UnlockCodeTierHeld",
      tier: "crimson",
    });
    expect(await redeem(db, "wed_gold")).toEqual({
      ok: false,
      tag: "UnlockCodeTierHeld",
      tier: "gold",
    });
    expect(weddingRow(db, "wed_crimson")?.tier).toBe("crimson");
    expect(spent(db)).toBe(0);
    expect(redemptions(db)).toEqual([]);
  });

  describe("while an upgrade checkout can still be paid", () => {
    function pendingPurchase(db: TestDb, createdAt: Date) {
      db.insert(weddingUpgradePurchases)
        .values({
          id: "upg_open",
          weddingId: "wed_a",
          entitlement: "gold",
          fromTier: "ivory",
          status: "pending",
          checkoutSessionId: "cs_open",
          createdByOsnProfileId: OWNER,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
    }

    it("refuses, so the payment cannot land on a tier the code already gave", async () => {
      const db = fresh();
      seedWedding(db, "wed_a");
      seedCode(db);
      pendingPurchase(db, new Date(NOW.getTime() - 60_000));

      expect(await redeem(db, "wed_a")).toEqual({ ok: false, tag: "UnlockCodePurchaseInFlight" });
      expect(weddingRow(db, "wed_a")?.tier).toBe("ivory");
      expect(spent(db)).toBe(0);
    });

    it("lets the code through once that checkout can no longer be paid", async () => {
      const db = fresh();
      seedWedding(db, "wed_a");
      seedCode(db);
      pendingPurchase(db, new Date(NOW.getTime() - 25 * 60 * 60 * 1000));
      expect(await redeem(db, "wed_a")).toEqual({ ok: true, tier: "gold" });
    });

    it("still gives an unusable code the one refusal", async () => {
      const db = fresh();
      seedWedding(db, "wed_a");
      seedCode(db);
      pendingPurchase(db, NOW);
      expect(await redeem(db, "wed_a", OTHER_CODE)).toEqual({
        ok: false,
        tag: "UnlockCodeRefused",
      });
    });
  });

  it("serves as many weddings as the code has uses, then refuses the next", async () => {
    const db = fresh();
    for (const id of ["wed_a", "wed_b", "wed_c"]) seedWedding(db, id);
    seedCode(db, { max: 2 });

    expect(await redeem(db, "wed_a")).toMatchObject({ ok: true });
    expect(await redeem(db, "wed_b")).toMatchObject({ ok: true });
    expect(await redeem(db, "wed_c")).toEqual({ ok: false, tag: "UnlockCodeRefused" });
    expect(spent(db)).toBe(2);
    expect(weddingRow(db, "wed_c")?.tier).toBe("ivory");
  });

  it("keeps two codes apart: one wedding's redemption spends nothing of another code", async () => {
    const db = fresh();
    seedWedding(db, "wed_a");
    seedWedding(db, "wed_b");
    seedCode(db, { id: "ulc_a", code: CODE, tier: "gold" });
    seedCode(db, { id: "ulc_b", code: OTHER_CODE, tier: "crimson" });

    expect(await redeem(db, "wed_a", CODE)).toEqual({ ok: true, tier: "gold" });
    expect(await redeem(db, "wed_b", OTHER_CODE)).toEqual({ ok: true, tier: "crimson" });
    expect(weddingRow(db, "wed_b")?.grantedBy).toBe("code:ulc_b");
    expect(spent(db, "ulc_a")).toBe(1);
    expect(spent(db, "ulc_b")).toBe(1);
  });

  it("costs four statements, sent as one batch on D1", async () => {
    const db = fresh();
    seedWedding(db, "wed_a");
    seedCode(db);
    const statements = recordStatements(db);
    await redeem(db, "wed_a");
    expect(statements).toHaveLength(4);
  });

  it("counts each outcome", async () => {
    const db = fresh();
    seedWedding(db, "wed_a");
    seedWedding(db, "wed_crimson", "crimson");
    seedWedding(db, "wed_open");
    db.insert(weddingUpgradePurchases)
      .values({
        id: "upg_open",
        weddingId: "wed_open",
        entitlement: "gold",
        fromTier: "ivory",
        status: "pending",
        checkoutSessionId: "cs_open",
        createdByOsnProfileId: OWNER,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    seedCode(db, { max: 5 });
    const before = {
      redeemed: await counterValue(METRIC, { outcome: "redeemed" }),
      refused: await counterValue(METRIC, { outcome: "refused" }),
      held: await counterValue(METRIC, { outcome: "already_held" }),
      open: await counterValue(METRIC, { outcome: "purchase_in_flight" }),
    };

    await redeem(db, "wed_a");
    await redeem(db, "wed_a", OTHER_CODE);
    await redeem(db, "wed_crimson");
    await redeem(db, "wed_open");

    expect(await counterValue(METRIC, { outcome: "redeemed" })).toBe(before.redeemed + 1);
    expect(await counterValue(METRIC, { outcome: "refused" })).toBe(before.refused + 1);
    expect(await counterValue(METRIC, { outcome: "already_held" })).toBe(before.held + 1);
    expect(await counterValue(METRIC, { outcome: "purchase_in_flight" })).toBe(before.open + 1);
  });

  describe("when a write fails", () => {
    /** Make raising the tier fail as a driver error would, after the code's
     *  row has been read. */
    function failTierWrites(db: TestDb) {
      db.$client.exec(
        "CREATE TRIGGER fail_tier_update BEFORE UPDATE OF tier ON weddings BEGIN SELECT RAISE(ABORT, 'boom'); END;",
      );
    }

    it("fails with UnlockCodeWriteError, never as a refusal of a good code", async () => {
      const db = fresh();
      seedWedding(db, "wed_a");
      seedCode(db);
      failTierWrites(db);
      const failure = await Effect.runPromise(
        unlockCodeService
          .redeem({ weddingId: "wed_a", osnProfileId: OWNER, unlockCode: CODE, now: NOW })
          .pipe(Effect.flip, Effect.provideService(DbService, db)),
      );
      expect(failure._tag).toBe("UnlockCodeWriteError");
    });

    it("logs the failure without the code or its hash", async () => {
      const db = fresh();
      seedWedding(db, "wed_a");
      seedCode(db);
      failTierWrites(db);
      const logs = await captureLogs(() =>
        runCire(
          unlockCodeService
            .redeem({ weddingId: "wed_a", osnProfileId: OWNER, unlockCode: CODE, now: NOW })
            .pipe(Effect.ignore, Effect.provideService(DbService, db)),
        ),
      );
      expect(logs).toContain("unlock code redemption failed");
      expect(logs).not.toContain(CODE);
      expect(logs).not.toContain(hashRecoveryCode(CODE));
    });
  });

  it("never writes the code, or its hash, to a log line", async () => {
    const db = fresh();
    seedWedding(db, "wed_a");
    seedCode(db);
    const logs = await captureLogs(async () => {
      for (const typed of [CODE, OTHER_CODE]) {
        await runCire(
          unlockCodeService
            .redeem({ weddingId: "wed_a", osnProfileId: OWNER, unlockCode: typed, now: NOW })
            .pipe(Effect.ignore, Effect.provideService(DbService, db)),
        );
      }
    });
    expect(logs).toContain("wed_a");
    for (const secret of [CODE, OTHER_CODE, hashRecoveryCode(CODE), hashRecoveryCode(OTHER_CODE)]) {
      expect(logs).not.toContain(secret);
    }
  });
});
