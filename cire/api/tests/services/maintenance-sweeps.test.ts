import { describe, expect, it } from "bun:test";

import {
  directoryVendors,
  families,
  imports,
  registryContributions,
  registryRetiredAccounts,
  registrySettings,
  vendorClaims,
  BOOTSTRAP_WEDDING_ID,
} from "@cire/db";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import type { Db } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { maintenanceSweeps, PREVIEW_STALE_AFTER_MS } from "../../src/services/maintenance-sweeps";
import type { DeletableBucket } from "../../src/services/r2-cleanup";
import { StripeError } from "../../src/services/stripe";
import { failStatements } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

const NOW = new Date("2026-07-30T04:00:00.000Z");

function makeDb(): { db: TestDb; layer: Layer.Layer<DbService> } {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  return { db, layer: Layer.succeed(DbService, db) };
}

function seedListing(db: TestDb, id: string): void {
  db.insert(directoryVendors)
    .values({ id, name: "Vendor", listed: "draft", createdAt: NOW, updatedAt: NOW })
    .run();
}

function seedClaim(db: TestDb, id: string, expiresAt: Date, consumedAt: Date | null = null): void {
  db.insert(vendorClaims)
    .values({
      id,
      directoryVendorId: "dv_1",
      tokenHash: `hash-${id}`,
      email: "v@example.com",
      createdAt: NOW,
      expiresAt,
      consumedAt,
    })
    .run();
}

function seedImport(
  db: TestDb,
  id: string,
  status: "preview" | "applied",
  uploadedAt: number,
): void {
  db.insert(imports)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      uploadedAt,
      format: "csv",
      eventsR2Key: `sheets/${id}/events.csv`,
      guestsR2Key: `sheets/${id}/guests.csv`,
      summary: "{}",
      status,
    })
    .run();
}

describe("maintenanceSweeps.sweepExpiredVendorClaims", () => {
  it("deletes expired claims (consumed or not) and keeps live ones", async () => {
    const { db, layer } = makeDb();
    seedListing(db, "dv_1");
    seedClaim(db, "vc_expired", new Date(NOW.getTime() - 1000));
    seedClaim(db, "vc_expired_consumed", new Date(NOW.getTime() - 1000), NOW);
    seedClaim(db, "vc_live", new Date(NOW.getTime() + 1000));
    // Consumed but unexpired: kept until expiry (audit value).
    seedClaim(db, "vc_live_consumed", new Date(NOW.getTime() + 1000), NOW);

    const deleted = await Effect.runPromise(
      maintenanceSweeps.sweepExpiredVendorClaims(NOW).pipe(Effect.provide(layer)),
    );
    expect(deleted).toBe(2);
    const left = db
      .select({ id: vendorClaims.id })
      .from(vendorClaims)
      .all()
      .map((r) => r.id)
      .toSorted();
    expect(left).toEqual(["vc_live", "vc_live_consumed"]);
  });
});

describe("maintenanceSweeps.sweepStalePreviews", () => {
  it("deletes stale previews + reaps their sheets; keeps fresh previews and applied rows", async () => {
    const { db, layer } = makeDb();
    const staleAt = NOW.getTime() - PREVIEW_STALE_AFTER_MS - 1000;
    seedImport(db, "imp_stale", "preview", staleAt);
    seedImport(db, "imp_fresh", "preview", NOW.getTime() - 1000);
    // Applied rows are the change history — never swept here, however old.
    seedImport(db, "imp_applied_old", "applied", staleAt);

    const reaped: string[] = [];
    const bucket: DeletableBucket = {
      delete: (keys) => {
        reaped.push(...(Array.isArray(keys) ? keys : [keys]));
      },
    };

    const deleted = await Effect.runPromise(
      maintenanceSweeps.sweepStalePreviews(NOW, { sheets: bucket }).pipe(Effect.provide(layer)),
    );
    expect(deleted).toBe(1);
    const left = db
      .select({ id: imports.id })
      .from(imports)
      .all()
      .map((r) => r.id)
      .toSorted();
    expect(left).toEqual(["imp_applied_old", "imp_fresh"]);
    expect(reaped.toSorted()).toEqual([
      "sheets/imp_stale/events.csv",
      "sheets/imp_stale/guests.csv",
    ]);
  });

  it("is a no-op with nothing stale", async () => {
    const { layer } = makeDb();
    const deleted = await Effect.runPromise(
      maintenanceSweeps.sweepStalePreviews(NOW).pipe(Effect.provide(layer)),
    );
    expect(deleted).toBe(0);
  });
});

describe("maintenanceSweeps — error channel", () => {
  // The cron handler catches MaintenanceSweepError via Effect.catch; a throw
  // that escaped as a defect would slip past it. These pin the typed mapping.
  const throwingDb = {
    delete: () => {
      throw new Error("boom: delete");
    },
    select: () => {
      throw new Error("boom: select");
    },
  } as unknown as Db;
  const throwingLayer = Layer.succeed(DbService, throwingDb);

  it("sweepExpiredVendorClaims fails with MaintenanceSweepError op=vendor_claims", async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        maintenanceSweeps.sweepExpiredVendorClaims(NOW).pipe(Effect.provide(throwingLayer)),
      ),
    );
    expect(err._tag).toBe("MaintenanceSweepError");
    expect(err.op).toBe("vendor_claims");
    expect(err.reason).toContain("boom: delete");
  });

  it("handBackRetiredAccounts fails with MaintenanceSweepError op=hand_back_retired_accounts", async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        maintenanceSweeps
          .handBackRetiredAccounts(NOW, {
            deauthorize: () => Effect.void,
            retrieveAccount: () => Effect.void,
          })
          .pipe(Effect.provide(throwingLayer)),
      ),
    );
    expect(err._tag).toBe("MaintenanceSweepError");
    expect(err.op).toBe("hand_back_retired_accounts");
    expect(err.reason).toContain("boom: select");
  });

  it("sweepStalePreviews fails with MaintenanceSweepError op=stale_previews", async () => {
    const err = await Effect.runPromise(
      Effect.flip(maintenanceSweeps.sweepStalePreviews(NOW).pipe(Effect.provide(throwingLayer))),
    );
    expect(err._tag).toBe("MaintenanceSweepError");
    expect(err.op).toBe("stale_previews");
    expect(err.reason).toContain("boom: select");
  });
});

// ---------------------------------------------------------------------------
// Handing a retired Standard account back
// ---------------------------------------------------------------------------

/**
 * A retired Standard account stays connected 120 days, then the daily sweep
 * hands it back with `POST /oauth/deauthorize`, judged per account over every
 * unreleased retired row naming it.
 */
describe("maintenanceSweeps.handBackRetiredAccounts", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const OLD = new Date(NOW.getTime() - 121 * DAY_MS);
  const YOUNG = new Date(NOW.getTime() - 10 * DAY_MS);
  const OWNER = "usr_owner";

  function setup() {
    const db = createDb(":memory:");
    insertWedding(db, { id: "w1", slug: "w1", displayName: "One", owners: [OWNER] });
    insertWedding(db, { id: "w2", slug: "w2", displayName: "Two", owners: [OWNER] });
    db.insert(families)
      .values({
        id: "fam_1",
        weddingId: "w1",
        publicId: "pub_1",
        familyName: "Guests",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    return { db, layer: Layer.succeed(DbService, db) };
  }

  let rowId = 0;
  function retire(
    db: TestDb,
    account: string,
    over: {
      wedding?: string;
      type?: "express" | "standard" | null;
      retiredAt?: Date;
      releasedAt?: Date | null;
      lastHandBackAt?: Date | null;
    } = {},
  ) {
    rowId += 1;
    db.insert(registryRetiredAccounts)
      .values({
        id: `rra_${rowId}`,
        weddingId: over.wedding ?? "w1",
        stripeAccountId: account,
        stripeAccountType: over.type === undefined ? "standard" : over.type,
        stripeConnectedAt: new Date(NOW.getTime() - 400 * DAY_MS),
        retiredAt: over.retiredAt ?? OLD,
        reason: "replaced",
        releasedAt: over.releasedAt ?? null,
        lastHandBackAt: over.lastHandBackAt ?? null,
      })
      .run();
  }

  /** `weddingId`'s settings name `account`, connected at `connectedAt`. */
  function names(db: TestDb, weddingId: string, account: string, connectedAt = NOW) {
    db.insert(registrySettings)
      .values({
        weddingId,
        stripeAccountId: account,
        stripeConnectedAt: connectedAt,
        stripeAccountUpdatedAt: connectedAt,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .onConflictDoUpdate({
        target: registrySettings.weddingId,
        set: { stripeAccountId: account, stripeConnectedAt: connectedAt },
      })
      .run();
  }

  function gift(
    db: TestDb,
    id: string,
    account: string,
    status: "pending" | "disputed" | "succeeded",
    createdAt: Date,
    session: string | null = `cs_${id}`,
  ) {
    db.insert(registryContributions)
      .values({
        id,
        weddingId: "w1",
        familyId: "fam_1",
        status,
        amountMinor: 5000,
        currency: "AUD",
        stripeCheckoutSessionId: session,
        stripeAccountId: account,
        stripeAccountType: "standard",
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  }

  const refused = (status: number, code?: string) =>
    Effect.fail(new StripeError({ reason: "refused", status, ...(code ? { code } : {}) }));

  /** A Stripe stand-in that records each call; by default every call succeeds. */
  function stripe(
    opts: {
      deauthorize?: (id: string) => Effect.Effect<void, StripeError>;
      retrieve?: (id: string) => Effect.Effect<unknown, StripeError>;
    } = {},
  ) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        deauthorize: (id: string) =>
          Effect.suspend(() => {
            calls.push(`deauthorize ${id}`);
            return opts.deauthorize?.(id) ?? Effect.void;
          }),
        retrieveAccount: (id: string) =>
          Effect.suspend(() => {
            calls.push(`retrieve ${id}`);
            return opts.retrieve?.(id) ?? Effect.succeed({ id });
          }),
      },
    };
  }

  const sweep = (
    layer: Layer.Layer<DbService>,
    client: ReturnType<typeof stripe>["client"],
    now = NOW,
  ) =>
    Effect.runPromise(
      maintenanceSweeps.handBackRetiredAccounts(now, client).pipe(Effect.provide(layer)),
    );

  const rows = (db: TestDb) =>
    db
      .select({
        account: registryRetiredAccounts.stripeAccountId,
        released: registryRetiredAccounts.releasedAt,
        tried: registryRetiredAccounts.lastHandBackAt,
      })
      .from(registryRetiredAccounts)
      .orderBy(registryRetiredAccounts.id)
      .all();

  it("calls no one while a settings row names the account", async () => {
    const { db, layer } = setup();
    retire(db, "acct_a");
    names(db, "w2", "acct_a");
    const s = stripe();
    await sweep(layer, s.client);
    expect(s.calls).toEqual([]);
  });

  it("calls no one while any unreleased row naming the account is under 120 days, whatever its type", async () => {
    const { db, layer } = setup();
    retire(db, "acct_a");
    retire(db, "acct_a", { wedding: "w2", retiredAt: YOUNG });
    retire(db, "acct_b");
    retire(db, "acct_b", { wedding: "w2", retiredAt: YOUNG, type: null });
    const s = stripe();
    await sweep(layer, s.client);
    expect(s.calls).toEqual([]);
  });

  it("holds for a pending gift with a session under 14 days, and not for an older or session-less one", async () => {
    const { db, layer } = setup();
    retire(db, "acct_held");
    gift(db, "g_recent", "acct_held", "pending", new Date(NOW.getTime() - 13 * DAY_MS));
    retire(db, "acct_free");
    gift(db, "g_stale", "acct_free", "pending", new Date(NOW.getTime() - 15 * DAY_MS));
    gift(db, "g_no_session", "acct_free", "pending", NOW, null);
    gift(db, "g_settled", "acct_free", "succeeded", NOW);
    const s = stripe();
    await sweep(layer, s.client);
    expect(s.calls).toEqual(["deauthorize acct_free"]);
  });

  it("holds for a disputed gift however old: once handed back, its close would never arrive", async () => {
    const { db, layer } = setup();
    retire(db, "acct_a");
    gift(db, "g_disputed", "acct_a", "disputed", new Date(NOW.getTime() - 300 * DAY_MS));
    const s = stripe();
    await sweep(layer, s.client);
    expect(s.calls).toEqual([]);
  });

  it("never hands back an Express account", async () => {
    const { db, layer } = setup();
    retire(db, "acct_express", { type: "express" });
    retire(db, "acct_null", { type: null });
    const s = stripe();
    await sweep(layer, s.client);
    expect(s.calls).toEqual([]);
  });

  it("hands back an account every rule allows, an older released row beside it, and releases every row naming it", async () => {
    const { db, layer } = setup();
    const earlier = new Date(NOW.getTime() - 200 * DAY_MS);
    retire(db, "acct_a", {
      releasedAt: earlier,
      retiredAt: new Date(NOW.getTime() - 300 * DAY_MS),
    });
    retire(db, "acct_a");
    retire(db, "acct_a", { wedding: "w2" });
    const s = stripe();
    const counted = () =>
      counterValue(CIRE_METRICS.registryStripeHandBack, { result: "handed_back" });
    const before = await counted();
    expect(await sweep(layer, s.client)).toEqual({
      handedBack: 1,
      released: 0,
      failed: 0,
      more: false,
    });
    expect(await counted()).toBe(before + 1);
    expect(s.calls).toEqual(["deauthorize acct_a"]);
    const after = rows(db);
    expect(after[0]?.released).toEqual(earlier);
    expect(after.slice(1).every((row) => row.released !== null && row.tried === null)).toBe(true);
  });

  it("says nothing more is due when exactly three are", async () => {
    const { db, layer } = setup();
    for (const account of ["acct_1", "acct_2", "acct_3"]) retire(db, account);
    expect(await sweep(layer, stripe().client)).toMatchObject({ handedBack: 3, more: false });
  });

  it("counts a retire exactly 120 days old as due, and one a second younger as not", async () => {
    const { db, layer } = setup();
    retire(db, "acct_due", { retiredAt: new Date(NOW.getTime() - 120 * DAY_MS) });
    retire(db, "acct_young", { retiredAt: new Date(NOW.getTime() - 120 * DAY_MS + 1000) });
    const s = stripe();
    await sweep(layer, s.client);
    expect(s.calls).toEqual(["deauthorize acct_due"]);
  });

  it("holds for a pending gift a second under 14 days old, and not for one exactly 14 days old", async () => {
    const { db, layer } = setup();
    retire(db, "acct_held");
    gift(db, "g_held", "acct_held", "pending", new Date(NOW.getTime() - 14 * DAY_MS + 1000));
    retire(db, "acct_free");
    gift(db, "g_free", "acct_free", "pending", new Date(NOW.getTime() - 14 * DAY_MS));
    const s = stripe();
    await sweep(layer, s.client);
    expect(s.calls).toEqual(["deauthorize acct_free"]);
  });

  it("hands back at most three accounts a run, and says more are due", async () => {
    const { db, layer } = setup();
    for (const account of ["acct_1", "acct_2", "acct_3", "acct_4"]) retire(db, account);
    const s = stripe();
    const result = await sweep(layer, s.client);
    expect(s.calls.filter((c) => c.startsWith("deauthorize"))).toHaveLength(3);
    expect(result).toMatchObject({ handedBack: 3, more: true });
  });

  it("releases an account Stripe no longer reaches, once a control account proves the key reaches this platform", async () => {
    const { db, layer } = setup();
    retire(db, "acct_gone");
    names(db, "w2", "acct_live");
    const s = stripe({
      deauthorize: () => refused(400, "invalid_client"),
      retrieve: (id) =>
        id === "acct_gone" ? refused(403, "account_invalid") : Effect.succeed({ id }),
    });
    expect(await sweep(layer, s.client)).toMatchObject({ released: 1, failed: 0 });
    expect(s.calls).toEqual(["deauthorize acct_gone", "retrieve acct_gone", "retrieve acct_live"]);
    expect(rows(db).map((row) => [row.released !== null, row.tried])).toEqual([[true, null]]);
  });

  it.each([
    ["the control account is refused too (a key from another platform)", true],
    ["no settings row names any account", false],
  ])("releases nothing when the key's reach cannot be proved: %s", async (_label, withControl) => {
    const { db, layer } = setup();
    retire(db, "acct_gone");
    if (withControl) names(db, "w2", "acct_live");
    const s = stripe({
      deauthorize: () => refused(400, "invalid_client"),
      retrieve: () => refused(403, "account_invalid"),
    });
    expect(await sweep(layer, s.client)).toMatchObject({ released: 0, failed: 1 });
    expect(rows(db)).toEqual([{ account: "acct_gone", released: null, tried: NOW }]);
  });

  it("reads the control account once a run, however many accounts it needs it for", async () => {
    const { db, layer } = setup();
    retire(db, "acct_gone_1");
    retire(db, "acct_gone_2");
    names(db, "w2", "acct_live");
    const s = stripe({
      deauthorize: () => refused(400, "invalid_client"),
      retrieve: (id) =>
        id === "acct_live" ? Effect.succeed({ id }) : refused(403, "account_invalid"),
    });
    expect(await sweep(layer, s.client)).toMatchObject({ released: 2 });
    expect(s.calls.filter((c) => c === "retrieve acct_live")).toHaveLength(1);
  });

  it("releases nothing when a refused hand-back's account still reads (a bad client id), and tries a never-tried account first next run", async () => {
    const { db, layer } = setup();
    retire(db, "acct_a");
    names(db, "w2", "acct_live");
    const failing = stripe({ deauthorize: () => refused(400, "invalid_client") });
    const before = await counterValue(CIRE_METRICS.registryStripeHandBack, { result: "failed" });
    let result: unknown;
    const logs = await captureLogs(async () => {
      result = await sweep(layer, failing.client);
    });
    expect(result).toMatchObject({ released: 0, failed: 1 });
    expect(rows(db)).toEqual([{ account: "acct_a", released: null, tried: NOW }]);
    // The account's id, for a hand fix.
    expect(logs).toMatch(/stripe account not handed back[\s\S]*acct_a/);
    expect(await counterValue(CIRE_METRICS.registryStripeHandBack, { result: "failed" })).toBe(
      before + 1,
    );

    // A newer retire, never tried, goes before the account that failed.
    retire(db, "acct_b", { retiredAt: new Date(OLD.getTime() + DAY_MS) });
    const next = stripe({ deauthorize: () => refused(400, "invalid_client") });
    await sweep(layer, next.client, new Date(NOW.getTime() + DAY_MS));
    expect(next.calls.filter((c) => c.startsWith("deauthorize"))).toEqual([
      "deauthorize acct_b",
      "deauthorize acct_a",
    ]);
  });

  it.each([
    ["a bad secret key", { status: 401 }],
    ["Stripe failing", { status: 500 }],
    ["a permission refusal", { status: 403, code: "permission_denied" }],
    ["account_invalid without a 403", { status: 400, code: "account_invalid" }],
    ["no answer at all", {}],
  ] as const)(
    "releases nothing when the account read fails any other way (%s), even with the control account reading",
    async (_label, failure) => {
      const { db, layer } = setup();
      retire(db, "acct_a");
      names(db, "w2", "acct_live");
      const s = stripe({
        deauthorize: () => refused(400, "invalid_client"),
        retrieve: (id) =>
          id === "acct_live"
            ? Effect.succeed({ id })
            : Effect.fail(new StripeError({ reason: "refused", ...failure })),
      });
      expect(await sweep(layer, s.client)).toMatchObject({ released: 0, failed: 1 });
      expect(rows(db)).toEqual([{ account: "acct_a", released: null, tried: NOW }]);
    },
  );

  it("clears a wedding that connected the account before Stripe answered, and leaves one connected after", async () => {
    const { db, layer } = setup();
    retire(db, "acct_a");
    // The run's own clock is long past; Stripe answers now.
    const before = new Date(NOW.getTime() + 1000);
    const after = new Date(Date.now() + 60_000);
    const s = stripe({
      deauthorize: () =>
        Effect.sync(() => {
          names(db, "w1", "acct_a", before);
          names(db, "w2", "acct_a", after);
        }),
    });
    const logs = await captureLogs(() => sweep(layer, s.client));
    const named = db
      .select({ wedding: registrySettings.weddingId, account: registrySettings.stripeAccountId })
      .from(registrySettings)
      .orderBy(registrySettings.weddingId)
      .all();
    expect(named).toEqual([
      { wedding: "w1", account: null },
      { wedding: "w2", account: "acct_a" },
    ]);
    expect(logs).toContain("stripe account handed back while a wedding connected it");
  });

  it("a D1 failure on one account is logged and counted, the next account goes on, and the next run releases it", async () => {
    const { db, layer } = setup();
    retire(db, "acct_a");
    retire(db, "acct_b", { retiredAt: new Date(OLD.getTime() + DAY_MS) });
    let hit = false;
    const failing = failStatements(db, (statement) => {
      if (hit || !/^update "registry_settings"/i.test(statement)) return false;
      hit = true;
      return true;
    });
    const s = stripe();
    let result: unknown;
    const logs = await captureLogs(async () => {
      result = await sweep(layer, s.client);
    });
    expect(result).toMatchObject({ handedBack: 1, failed: 1 });
    failing.restore();
    expect(logs).toMatch(/stripe account hand-back failed[\s\S]*acct_a/);
    // The write that would mark the attempt may be what failed, so none is
    // made: the account stays first in line.
    expect(rows(db).map((row) => [row.account, row.released !== null, row.tried])).toEqual([
      ["acct_a", false, null],
      ["acct_b", true, null],
    ]);

    // Stripe let acct_a go on that first call; now it refuses it, and the
    // control account proves the key still reaches the platform.
    names(db, "w2", "acct_live");
    const next = stripe({
      deauthorize: () => refused(400, "invalid_client"),
      retrieve: (id) =>
        id === "acct_a" ? refused(403, "account_invalid") : Effect.succeed({ id }),
    });
    expect(await sweep(layer, next.client)).toMatchObject({ released: 1 });
    expect(rows(db)[0]?.released).not.toBeNull();
  });
});
