import { describe, expect, it } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import type { PlatformSessionState, StripeClient } from "../../src/services/stripe";
import { StripeError } from "../../src/services/stripe";
import type { Tier } from "../../src/services/tiers";
import { createUpgradeCatalogue } from "../../src/services/upgrade-catalogue";
import {
  createUpgradeService,
  STALE_PENDING_MS,
  tierForProduct,
  UpgradeConflict,
  upgradeConflictReason,
} from "../../src/services/upgrades";
import { counterValue } from "../test-helpers/metrics-harness";

/**
 * Two failures are being defended against, and both are invisible to a
 * happy-path test: charging twice for one tier, and taking money while
 * granting nothing. Nearly every case below is one crash point or one race.
 */

type Db = ReturnType<typeof createDb>;

const run = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)) as Effect.Effect<A, E, never>);

const runExit = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(
    eff.pipe(Effect.provideService(DbService, db)) as Effect.Effect<A, E, never>,
  );

/** The reason a refused start gave, or `null` when it did not refuse with a conflict. */
async function conflictOf<A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) {
  const exit = await runExit(db, eff);
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.findErrorOption(exit.cause);
  return error._tag === "Some" && error.value instanceof UpgradeConflict
    ? error.value.reason
    : null;
}

/**
 * Timestamp columns are drizzle `mode: "timestamp"`, which is epoch SECONDS —
 * while the injected clock, like `Date.now()`, is milliseconds. Every raw SQL
 * insert below goes through this so the two cannot be mixed up silently; the
 * staleness window is measured in the difference, so a 1000x error there reads
 * as "not stale" forever.
 */
const BASE_MS = 1_700_000_000_000;
const secondsAt = (ms: number) => Math.floor(ms / 1000);

function seedWedding(db: Db, id = "wed_test", tier: Tier = "ivory") {
  const t = Date.now();
  db.$client.exec(
    `INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, code_style, currency, tier, created_at, updated_at)
     VALUES ('${id}', '${id}-slug', 'Test', 'usr_owner', 'secure', 'AUD', '${tier}', ${t}, ${t});`,
  );
  return id;
}

/** A purchase row written directly, as an earlier request or Worker left it. */
function seedPurchase(
  db: Db,
  row: {
    id: string;
    product: string;
    fromTier?: "ivory" | "gold" | null;
    status?: string;
    sessionId?: string | null;
    createdMs?: number;
  },
) {
  const at = secondsAt(row.createdMs ?? BASE_MS);
  db.$client
    .query(
      `INSERT INTO wedding_upgrade_purchases
         (id, wedding_id, entitlement, from_tier, status, checkout_session_id, created_by_osn_profile_id, created_at, updated_at)
       VALUES (?, 'wed_test', ?, ?, ?, ?, 'usr_owner', ?, ?)`,
    )
    .run(
      row.id,
      row.product,
      row.fromTier === undefined ? "ivory" : row.fromTier,
      row.status ?? "pending",
      row.sessionId ?? null,
      at,
      at,
    );
}

/** Rows as the database actually holds them, for assertions about state. */
const purchases = (db: Db) =>
  db.$client.query("SELECT * FROM wedding_upgrade_purchases ORDER BY created_at, id").all() as {
    id: string;
    status: string;
    checkout_session_id: string | null;
    entitlement: string;
    from_tier: string | null;
  }[];

const sales = (db: Db) =>
  db.$client.query("SELECT * FROM platform_sales").all() as {
    purchase_id: string;
    entitlement: string;
    amount_minor: number;
    currency: string;
  }[];

const tierRow = (db: Db, id = "wed_test") =>
  db.$client
    .query("SELECT tier, tier_source, tier_granted_by FROM weddings WHERE id = ?")
    .get(id) as { tier: string; tier_source: string | null; tier_granted_by: string | null };

interface StripeStub {
  client: StripeClient;
  /** Purchase ids a session was minted for, in order. */
  created: string[];
  /** The Price each minted session charged. */
  pricedAt: string[];
  /** The success URLs Stripe was actually handed. */
  successUrls: string[];
  /** Session ids this code asked Stripe to expire. */
  expired: string[];
  /** What the next probe answers. */
  probe: PlatformSessionState | "error";
  failCreate: boolean;
  failExpire: boolean;
  /** Runs while Stripe is "thinking", to drive a concurrent-write race. */
  onCreate?: () => void;
  /** Runs while Stripe expires a session, to drive a concurrent-write race. */
  onExpire?: () => void;
}

function stubStripe(): StripeStub {
  const stub: StripeStub = {
    created: [],
    pricedAt: [],
    successUrls: [],
    expired: [],
    probe: { status: "expired" },
    failCreate: false,
    failExpire: false,
    client: undefined as unknown as StripeClient,
  };
  let minted = 0;
  stub.client = {
    retrievePrice: () => Effect.succeed({ unitAmountMinor: 4900, currency: "AUD" }),
    createPlatformCheckoutSession(input: {
      clientReferenceId: string;
      successUrl: string;
      priceId: string;
    }) {
      if (stub.failCreate) return Effect.fail(new StripeError({ reason: "unreachable" }));
      stub.onCreate?.();
      minted += 1;
      stub.created.push(input.clientReferenceId);
      stub.pricedAt.push(input.priceId);
      stub.successUrls.push(input.successUrl);
      const id = `cs_${minted}`;
      return Effect.succeed({ id, url: `https://pay.test/${id}` });
    },
    retrievePlatformCheckoutSession() {
      return stub.probe === "error"
        ? Effect.fail(new StripeError({ reason: "unreachable" }))
        : Effect.succeed(stub.probe);
    },
    expirePlatformCheckoutSession(sessionId: string) {
      stub.onExpire?.();
      if (stub.failExpire) {
        return Effect.fail(new StripeError({ reason: "rejected", status: 400 }));
      }
      stub.expired.push(sessionId);
      return Effect.void;
    },
  } as unknown as StripeClient;
  return stub;
}

const PRICES = { gold: "price_g", crimson: "price_c", crimsonFromGold: "price_cg" };

function makeService(
  stripe: StripeClient,
  clock: { t: number },
  prices: Parameters<typeof createUpgradeCatalogue>[0]["prices"] = PRICES,
) {
  let n = 0;
  return createUpgradeService({
    stripe,
    catalogue: createUpgradeCatalogue({ stripe, prices }),
    now: () => clock.t,
    newId: (prefix) => `${prefix}_${++n}`,
  });
}

const START = {
  weddingId: "wed_test",
  tier: "gold" as const,
  actorProfileId: "usr_owner",
  successUrlFor: (id: string) => `https://host.test/?upgrade=${id}&w=wed_test&m=budget`,
  cancelUrl: "https://host.test/",
};
const CRIMSON = { ...START, tier: "crimson" as const };

describe("upgradeConflictReason", () => {
  /**
   * DRIVEN THROUGH THE REAL INDEX, not a hand-written string.
   *
   * SQLite names the COLUMNS a conflict was on and never the index that
   * enforced it, so a classifier matching on the index name reads correctly and
   * can never fire. A literal-string test passes either way — which is how that
   * mismatch survives review. This one asks the driver, with two DIFFERENT
   * products pending on one wedding, which the index refuses since it is on the
   * wedding alone.
   */
  it("classifies what the driver actually says on the one-pending index", () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_a", product: "gold" });
    let message = "";
    try {
      seedPurchase(db, { id: "upg_b", product: "crimson" });
    } catch (e) {
      message = String(e);
    }

    expect(message).toContain("UNIQUE constraint failed");
    expect(message).toContain("wedding_upgrade_purchases.wedding_id");
    // The assertion that would have caught the original bug.
    expect(message).not.toContain("one_pending");
    expect(upgradeConflictReason(message)).toBe("processing");
  });

  it("classifies a session-id conflict the driver reports", () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_a", product: "gold", status: "succeeded", sessionId: "cs_1" });
    let message = "";
    try {
      seedPurchase(db, { id: "upg_b", product: "crimson", status: "succeeded", sessionId: "cs_1" });
    } catch (e) {
      message = String(e);
    }
    expect(upgradeConflictReason(message)).toBe("session_taken");
  });

  it("returns null for anything that is not a unique violation", () => {
    // The whole point of the sniff: a disk error or a NOT NULL violation must
    // surface as a write error, never as a cheerful 409 telling the organiser
    // to wait for something that is not happening.
    expect(upgradeConflictReason("SQLITE_BUSY: database is locked")).toBeNull();
    expect(upgradeConflictReason("NOT NULL constraint failed: x.y")).toBeNull();
    expect(upgradeConflictReason("")).toBeNull();
  });

  it("returns null for a unique violation on some other table's columns", () => {
    expect(upgradeConflictReason("UNIQUE constraint failed: guests.email")).toBeNull();
    expect(upgradeConflictReason("UNIQUE constraint failed: wedding_hosts.wedding_id")).toBeNull();
  });
});

describe("tierForProduct", () => {
  it("maps each product, legacy keys included, to the tier it buys now", () => {
    expect(tierForProduct("gold")).toBe("gold");
    expect(tierForProduct("crimson")).toBe("crimson");
    expect(tierForProduct("registry")).toBe("gold");
    expect(tierForProduct("capacity_500")).toBe("gold");
    expect(tierForProduct("vendors")).toBe("crimson");
    expect(tierForProduct("capacity_1000")).toBe("crimson");
  });

  it("maps nothing else", () => {
    for (const product of ["ai", "premium_templates", "ivory", "", "constructor"]) {
      expect(tierForProduct(product)).toBeNull();
    }
  });
});

describe("startPurchase", () => {
  it("refuses a tier the wedding already holds, or one below it", async () => {
    for (const [held, buying] of [
      ["gold", START],
      ["crimson", START],
      ["crimson", CRIMSON],
    ] as const) {
      const db = createDb();
      seedWedding(db, "wed_test", held);
      const stripe = stubStripe();
      const svc = makeService(stripe.client, { t: BASE_MS });

      expect(await conflictOf(db, svc.startPurchase(buying))).toBe("already_held");
      expect(purchases(db)).toEqual([]);
      expect(stripe.created).toEqual([]);
    }
  });

  it("refuses a tier with no configured Price rather than selling it for nothing", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS }, {});

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(stripe.created).toEqual([]);
  });

  it("does not sell a Gold wedding Crimson when the upgrade-from-Gold Price is unset", async () => {
    const db = createDb();
    seedWedding(db, "wed_test", "gold");
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS }, { gold: "price_g", crimson: "price_c" });

    const exit = await runExit(db, svc.startPurchase(CRIMSON));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(stripe.created).toEqual([]);
    expect(purchases(db)).toEqual([]);
  });

  it("mints a session at the tier's own Price, and records the tier it started from", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    const res = await run(db, svc.startPurchase(START));
    expect(res.reused).toBe(false);
    expect(res.url).toBe("https://pay.test/cs_1");
    expect(stripe.pricedAt).toEqual(["price_g"]);
    expect(purchases(db)).toMatchObject([
      { status: "pending", checkout_session_id: "cs_1", entitlement: "gold", from_tier: "ivory" },
    ]);
  });

  it("charges a Gold wedding the upgrade-from-Gold Price for Crimson", async () => {
    const db = createDb();
    seedWedding(db, "wed_test", "gold");
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    await run(db, svc.startPurchase(CRIMSON));
    expect(stripe.pricedAt).toEqual(["price_cg"]);
    expect(purchases(db)).toMatchObject([{ entitlement: "crimson", from_tier: "gold" }]);
  });

  it("counts each start by tier and the tier it started from", async () => {
    const name = CIRE_METRICS.upgradeCheckoutStarted;
    const attrs = { tier: "crimson", from_tier: "gold", result: "ok" };
    const before = await counterValue(name, attrs);
    const db = createDb();
    seedWedding(db, "wed_test", "gold");
    await run(db, makeService(stubStripe().client, { t: BASE_MS }).startPurchase(CRIMSON));
    expect(await counterValue(name, attrs)).toBe(before + 1);
  });

  it("sends Stripe a success URL naming the real purchase, not a placeholder", async () => {
    // The purchase id does not exist until the row is minted, so the URL has to
    // be built from it. Getting this wrong is silent: Stripe accepts any URL,
    // the organiser pays, and only the page they land on is broken — it cannot
    // tell which purchase to poll, so nothing ever unlocks.
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    const res = await run(db, svc.startPurchase(START));
    expect(stripe.successUrls).toEqual([
      `https://host.test/?upgrade=${res.purchaseId}&w=wed_test&m=budget`,
    ]);
    expect(stripe.successUrls[0]).not.toContain("PURCHASE_ID");
  });

  it("hands back the SAME open session on a second press", async () => {
    // Two tabs, or an impatient organiser. Without this each press mints its
    // own payment page and both can be paid.
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    const first = await run(db, svc.startPurchase(START));
    stripe.probe = { status: "open", id: "cs_1", url: "https://pay.test/cs_1" };
    const second = await run(db, svc.startPurchase(START));

    expect(second.reused).toBe(true);
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(stripe.created).toEqual([first.purchaseId]);
    expect(stripe.expired).toEqual([]);
    expect(purchases(db)).toHaveLength(1);
  });

  /**
   * THE DOUBLE-CHARGE GUARD.
   *
   * The organiser paid, the webhook has not landed yet (seconds normally, days
   * if a 500 put Stripe into retry), they see nothing unlocked and press again.
   * A probe that collapsed `complete` into "no session" would close a row that
   * was PAID and sell a second time.
   */
  it("refuses to mint a second session while a paid one is unsettled", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    const first = await run(db, svc.startPurchase(START));
    stripe.probe = { status: "complete" };

    expect(await conflictOf(db, svc.startPurchase(START))).toBe("processing");
    expect(stripe.created).toEqual([first.purchaseId]);
    // And the paid row is untouched, so the webhook can still settle it.
    expect(purchases(db)).toMatchObject([{ status: "pending", checkout_session_id: "cs_1" }]);
  });

  it("waits rather than guessing when the probe itself fails", async () => {
    // A probe we could not run is not evidence the session is dead. Guessing
    // "expired" here is the same double charge by a different route.
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    await run(db, svc.startPurchase(START));
    stripe.probe = "error";

    expect(await conflictOf(db, svc.startPurchase(START))).toBe("processing");
    expect(stripe.created).toHaveLength(1);
  });

  it("replaces an expired session", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    await run(db, svc.startPurchase(START));
    stripe.probe = { status: "expired" };
    const second = await run(db, svc.startPurchase(START));

    expect(second.reused).toBe(false);
    expect(stripe.created).toHaveLength(2);
    expect(stripe.expired).toEqual([]);
    expect(purchases(db).map((r) => r.status)).toEqual(["expired", "pending"]);
  });

  /**
   * A row is session-less for one Stripe round trip. Closing another request's
   * in-flight row inside that window is a race: the first request then writes
   * its session id onto a closed row and hands out a payment page whose payment
   * settles into a dead purchase.
   */
  it("does not close another request's in-flight row inside the staleness window", async () => {
    const db = createDb();
    seedWedding(db);
    const clock = { t: BASE_MS };
    const stripe = stubStripe();
    const svc = makeService(stripe.client, clock);

    // A pending row with no session yet — exactly what an in-flight press is.
    seedPurchase(db, { id: "upg_inflight", product: "gold" });
    clock.t = BASE_MS + STALE_PENDING_MS - 1;

    expect(await conflictOf(db, svc.startPurchase(START))).toBe("processing");
    expect(stripe.created).toEqual([]);
    expect(purchases(db)).toMatchObject([{ id: "upg_inflight", status: "pending" }]);
  });

  it("closes a session-less row once it is genuinely stale", async () => {
    const db = createDb();
    seedWedding(db);
    const clock = { t: BASE_MS };
    const stripe = stubStripe();
    const svc = makeService(stripe.client, clock);

    seedPurchase(db, { id: "upg_dead", product: "gold" });
    clock.t = BASE_MS + STALE_PENDING_MS + 1;

    const res = await run(db, svc.startPurchase(START));
    expect(res.reused).toBe(false);
    expect(purchases(db).find((r) => r.id === "upg_dead")?.status).toBe("failed");
  });

  /**
   * The attach is conditional on the row still being `pending` with no
   * session, and its result is checked. If it matched nothing — because another
   * request closed or claimed the row while Stripe was thinking — handing out
   * the URL anyway takes a payment into a row that can never settle.
   *
   * Driven by closing the row mid-flight, which is what a concurrent press past
   * the staleness window actually does.
   */
  it("refuses to hand out a URL when the attach matched nothing", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    // Close the pending row at the moment Stripe is being asked, so the
    // conditional attach that follows finds nothing to update.
    stripe.onCreate = () => {
      db.$client.exec(
        "UPDATE wedding_upgrade_purchases SET status = 'failed' WHERE status = 'pending';",
      );
    };

    expect(await conflictOf(db, svc.startPurchase(START))).toBe("processing");
    // The session was minted, so Stripe has one — but no URL reached the caller.
    expect(stripe.created).toHaveLength(1);
    expect(purchases(db)[0]?.status).toBe("failed");
  });

  it("closes its own row when Stripe refuses, so the next press need not wait", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    stripe.failCreate = true;
    const svc = makeService(stripe.client, { t: BASE_MS });

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
    // Left pending, the wedding would be locked out for the whole window by a
    // failure that was never the organiser's doing.
    expect(purchases(db)).toMatchObject([{ status: "failed", checkout_session_id: null }]);
  });
});

/**
 * A wedding has one purchase in flight at a time, whatever it buys. A press for
 * a DIFFERENT product than the pending one must never be handed that one's
 * page — a Crimson click landing on a Gold checkout — and must never leave two
 * payable pages behind.
 */
describe("startPurchase across products", () => {
  function pendingGold(db: Db, session: string | null = "cs_gold", createdMs = BASE_MS) {
    seedPurchase(db, {
      id: "upg_gold",
      product: "gold",
      sessionId: session,
      createdMs,
    });
  }

  it("expires another product's open page at Stripe, closes its row, and opens its own", async () => {
    const db = createDb();
    seedWedding(db);
    pendingGold(db);
    const stripe = stubStripe();
    stripe.probe = { status: "open", id: "cs_gold", url: "https://pay.test/cs_gold" };
    const svc = makeService(stripe.client, { t: BASE_MS });

    const res = await run(db, svc.startPurchase(CRIMSON));
    expect(res.reused).toBe(false);
    expect(res.url).not.toBe("https://pay.test/cs_gold");
    expect(stripe.expired).toEqual(["cs_gold"]);
    expect(stripe.pricedAt).toEqual(["price_c"]);
    expect(
      purchases(db).map(({ id, status, entitlement }) => ({ id, status, entitlement })),
    ).toEqual([
      { id: "upg_1", status: "pending", entitlement: "crimson" },
      { id: "upg_gold", status: "expired", entitlement: "gold" },
    ]);
  });

  it("waits when Stripe will not expire the other page — it may have been paid", async () => {
    const db = createDb();
    seedWedding(db);
    pendingGold(db);
    const stripe = stubStripe();
    stripe.probe = { status: "open", id: "cs_gold", url: "https://pay.test/cs_gold" };
    stripe.failExpire = true;
    const svc = makeService(stripe.client, { t: BASE_MS });

    expect(await conflictOf(db, svc.startPurchase(CRIMSON))).toBe("processing");
    expect(stripe.created).toEqual([]);
    expect(purchases(db)).toMatchObject([{ id: "upg_gold", status: "pending" }]);
  });

  it("waits, and expires nothing, while the other product's paid session is unsettled", async () => {
    const db = createDb();
    seedWedding(db);
    pendingGold(db);
    const stripe = stubStripe();
    stripe.probe = { status: "complete" };
    const svc = makeService(stripe.client, { t: BASE_MS });

    expect(await conflictOf(db, svc.startPurchase(CRIMSON))).toBe("processing");
    expect(stripe.expired).toEqual([]);
    expect(stripe.created).toEqual([]);
  });

  it("waits when the probe of the other product's session fails", async () => {
    const db = createDb();
    seedWedding(db);
    pendingGold(db);
    const stripe = stubStripe();
    stripe.probe = "error";
    const svc = makeService(stripe.client, { t: BASE_MS });

    expect(await conflictOf(db, svc.startPurchase(CRIMSON))).toBe("processing");
    expect(stripe.expired).toEqual([]);
  });

  it("replaces the other product's expired session without asking Stripe to expire it", async () => {
    const db = createDb();
    seedWedding(db);
    pendingGold(db);
    const stripe = stubStripe();
    stripe.probe = { status: "expired" };
    const svc = makeService(stripe.client, { t: BASE_MS });

    await run(db, svc.startPurchase(CRIMSON));
    expect(stripe.expired).toEqual([]);
    expect(purchases(db).find((r) => r.id === "upg_gold")?.status).toBe("expired");
  });

  it("treats another product's session-less row by the same staleness window", async () => {
    const db = createDb();
    seedWedding(db);
    pendingGold(db, null);
    const clock = { t: BASE_MS + STALE_PENDING_MS - 1 };
    const stripe = stubStripe();
    const svc = makeService(stripe.client, clock);

    expect(await conflictOf(db, svc.startPurchase(CRIMSON))).toBe("processing");
    clock.t = BASE_MS + STALE_PENDING_MS + 1;
    await run(db, svc.startPurchase(CRIMSON));
    expect(purchases(db).find((r) => r.id === "upg_gold")?.status).toBe("failed");
  });

  it("expires a legacy per-module page rather than handing it out", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_vendors", product: "vendors", fromTier: null, sessionId: "cs_v" });
    const stripe = stubStripe();
    stripe.probe = { status: "open", id: "cs_v", url: "https://pay.test/cs_v" };
    const svc = makeService(stripe.client, { t: BASE_MS });

    const res = await run(db, svc.startPurchase(CRIMSON));
    expect(res.url).not.toBe("https://pay.test/cs_v");
    expect(stripe.expired).toEqual(["cs_v"]);
  });

  it("does not reuse a page for the same tier priced from a tier the wedding has since left", async () => {
    // Crimson started from Ivory at the full Price, then an operator moved the
    // wedding to Gold: that page now charges more than the wedding owes.
    const db = createDb();
    seedWedding(db, "wed_test", "gold");
    seedPurchase(db, {
      id: "upg_full",
      product: "crimson",
      fromTier: "ivory",
      sessionId: "cs_full",
    });
    const stripe = stubStripe();
    stripe.probe = { status: "open", id: "cs_full", url: "https://pay.test/cs_full" };
    const svc = makeService(stripe.client, { t: BASE_MS });

    const res = await run(db, svc.startPurchase(CRIMSON));
    expect(res.reused).toBe(false);
    expect(stripe.expired).toEqual(["cs_full"]);
    expect(stripe.pricedAt).toEqual(["price_cg"]);
  });

  it("answers processing, not a 500, when it loses the insert race to another press", async () => {
    // While this press is expiring the Gold page, a second press closes that
    // row and opens its own. The one-pending index refuses this press's insert,
    // and that must read as "wait", never as a write failure.
    const db = createDb();
    seedWedding(db);
    pendingGold(db);
    const stripe = stubStripe();
    stripe.probe = { status: "open", id: "cs_gold", url: "https://pay.test/cs_gold" };
    stripe.onExpire = () => {
      db.$client.exec(
        "UPDATE wedding_upgrade_purchases SET status = 'expired' WHERE id = 'upg_gold'",
      );
      seedPurchase(db, { id: "upg_rival", product: "crimson", sessionId: "cs_rival" });
    };
    const svc = makeService(stripe.client, { t: BASE_MS });

    expect(await conflictOf(db, svc.startPurchase(CRIMSON))).toBe("processing");
    expect(stripe.created).toEqual([]);
    expect(
      purchases(db)
        .filter((r) => r.status === "pending")
        .map((r) => r.id),
    ).toEqual(["upg_rival"]);
  });
});

describe("settlePurchase", () => {
  async function paidPurchase(
    db: Db,
    stripe: StripeStub,
    input: typeof START | typeof CRIMSON = START,
  ) {
    const svc = makeService(stripe.client, { t: BASE_MS });
    const started = await run(db, svc.startPurchase(input));
    return { svc, purchaseId: started.purchaseId };
  }

  const SETTLE = {
    checkoutSessionId: "cs_1",
    paid: true,
    paidAmountMinor: 4900,
    paidCurrency: "aud",
    paymentIntentId: "pi_1",
  };

  it("moves the wedding to the tier, records the sale and marks the row succeeded", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
    expect(tierRow(db)).toEqual({
      tier: "gold",
      tier_source: "purchase",
      // The purchase names the buyer; the grant names the purchase.
      tier_granted_by: `stripe:${purchaseId}`,
    });
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(sales(db)).toMatchObject([
      { purchase_id: purchaseId, entitlement: "gold", amount_minor: 4900, currency: "AUD" },
    ]);
  });

  it("is idempotent across Stripe's redeliveries", async () => {
    // At-least-once delivery makes a duplicate the ordinary case, not the edge.
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }));
    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");

    expect(sales(db)).toHaveLength(1);
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(tierRow(db).tier).toBe("gold");
  });

  /**
   * THE CRASH POINT. Grant-then-flip means a retry finishes the job;
   * flip-then-grant would leave a row reading `succeeded` with no tier and a
   * retry that matches nothing.
   */
  it("heals on redelivery when the flip never happened", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    // Simulate the grant having landed while the flip did not.
    db.$client.exec("UPDATE weddings SET tier = 'gold' WHERE id = 'wed_test'");
    expect(purchases(db)[0]?.status).toBe("pending");

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(sales(db)).toHaveLength(1);
  });

  /**
   * THE INVARIANT THE ORDERING EXISTS FOR, stated as the thing that must hold
   * rather than as the order itself.
   *
   * A delivery that dies after flipping the row but before granting would leave
   * a row reading `succeeded` with the wedding still on its old tier — a
   * customer who paid and is locked out. Nothing here may short-circuit on "the
   * row is already succeeded", because that is exactly the state such a crash
   * leaves behind. Settling again has to repair it.
   */
  it("repairs a missing tier even when the row already reads succeeded", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    db.$client.exec(
      `UPDATE wedding_upgrade_purchases SET status = 'succeeded' WHERE id = '${purchaseId}';`,
    );
    expect(tierRow(db).tier).toBe("ivory");

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
    expect(tierRow(db).tier).toBe("gold");
    expect(sales(db)).toHaveLength(1);
  });

  /**
   * A row is session-less between minting a session and storing its id, and the
   * session is payable throughout. Rejecting the settle as a mismatch would
   * lock out a customer who paid.
   */
  it("adopts a purchase whose session id was never stored", async () => {
    const db = createDb();
    seedWedding(db);
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    seedPurchase(db, { id: "upg_orphan", product: "crimson" });

    expect(await run(db, svc.settlePurchase({ purchaseId: "upg_orphan", ...SETTLE }))).toBe(
      "granted",
    );
    expect(tierRow(db).tier).toBe("crimson");
    expect(purchases(db)[0]?.checkout_session_id).toBe("cs_1");
  });

  /**
   * A session can be paid in the moment before it is expired — by this code
   * replacing it, or by migration 0071 expiring every legacy pending row. The
   * money is as real as any other, so the row flips and the tier is granted.
   */
  it("settles a paid session whose row was already expired", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_late", product: "gold", status: "expired", sessionId: "cs_1" });
    const svc = makeService(stubStripe().client, { t: BASE_MS });

    expect(await run(db, svc.settlePurchase({ purchaseId: "upg_late", ...SETTLE }))).toBe(
      "granted",
    );
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(tierRow(db).tier).toBe("gold");
    expect(sales(db)).toHaveLength(1);
  });

  it("never lowers a wedding already on a higher tier, but still records the sale", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());
    // An operator comped Crimson while the Gold checkout was open.
    db.$client.exec(
      "UPDATE weddings SET tier = 'crimson', tier_source = 'comp', tier_granted_by = 'script:ops' WHERE id = 'wed_test'",
    );

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
    expect(tierRow(db)).toEqual({
      tier: "crimson",
      tier_source: "comp",
      tier_granted_by: "script:ops",
    });
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(sales(db)).toHaveLength(1);
  });

  it("settles a legacy per-module purchase into the tier that replaced it", async () => {
    for (const [product, tier] of [
      ["vendors", "crimson"],
      ["capacity_1000", "crimson"],
      ["registry", "gold"],
      ["capacity_500", "gold"],
    ] as const) {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, { id: "upg_legacy", product, fromTier: null, sessionId: "cs_1" });
      const svc = makeService(stubStripe().client, { t: BASE_MS });

      expect(await run(db, svc.settlePurchase({ purchaseId: "upg_legacy", ...SETTLE }))).toBe(
        "granted",
      );
      expect(tierRow(db).tier, product).toBe(tier);
      expect(sales(db)).toMatchObject([{ entitlement: product }]);
    }
  });

  /**
   * A paid purchase whose product names no tier is money taken for nothing.
   * Answering it at all would end Stripe's retries — the only record that the
   * delivery needs a human — so it is a defect: a 500 at the webhook.
   */
  it("dies on a paid purchase that maps to no tier, and writes nothing", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_ai", product: "ai", fromTier: null, sessionId: "cs_1" });
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    const name = CIRE_METRICS.upgradePurchaseSettled;
    const before = await counterValue(name, { tier: "unmapped", outcome: "defect" });

    const exit = await runExit(db, svc.settlePurchase({ purchaseId: "upg_ai", ...SETTLE }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(tierRow(db).tier).toBe("ivory");
    expect(purchases(db)[0]?.status).toBe("pending");
    expect(sales(db)).toEqual([]);
    expect(await counterValue(name, { tier: "unmapped", outcome: "defect" })).toBe(before + 1);
  });

  it("refuses a session id that belongs to a different purchase", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    expect(
      await run(db, svc.settlePurchase({ purchaseId, ...SETTLE, checkoutSessionId: "cs_other" })),
    ).toBe("unknown");
    expect(tierRow(db).tier).toBe("ivory");
  });

  it("grants nothing for a purchase this deployment has never heard of", async () => {
    // The platform endpoint is shared with whatever else the Stripe account
    // does, so an unknown id is ordinary rather than an error.
    const db = createDb();
    seedWedding(db);
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    expect(await run(db, svc.settlePurchase({ purchaseId: "upg_nope", ...SETTLE }))).toBe(
      "unknown",
    );
    expect(sales(db)).toEqual([]);
  });

  it("grants nothing when the session completed without payment", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE, paid: false }))).toBe(
      "unpaid",
    );
    expect(tierRow(db).tier).toBe("ivory");
    expect(purchases(db)[0]?.status).toBe("pending");
    expect(sales(db)).toEqual([]);
  });

  it("counts each settle by the tier it bought", async () => {
    const name = CIRE_METRICS.upgradePurchaseSettled;
    const before = await counterValue(name, { tier: "crimson", outcome: "granted" });
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe(), CRIMSON);
    await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }));
    expect(await counterValue(name, { tier: "crimson", outcome: "granted" })).toBe(before + 1);
  });
});

describe("failPurchase", () => {
  it("closes a pending row and ignores anything else", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });
    const started = await run(db, svc.startPurchase(START));

    expect(
      await run(
        db,
        svc.failPurchase({
          purchaseId: started.purchaseId,
          checkoutSessionId: "cs_1",
          status: "expired",
        }),
      ),
    ).toBe("closed");
    expect(purchases(db)[0]?.status).toBe("expired");

    // A replayed `expired` after the fact must not move it again.
    expect(
      await run(
        db,
        svc.failPurchase({
          purchaseId: started.purchaseId,
          checkoutSessionId: "cs_1",
          status: "failed",
        }),
      ),
    ).toBe("ignored");
    expect(purchases(db)[0]?.status).toBe("expired");
  });

  it("cannot un-settle a purchase somebody actually paid for", async () => {
    // A replayed — or forged — `expired` arriving after the settle.
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });
    const started = await run(db, svc.startPurchase(START));
    await run(
      db,
      svc.settlePurchase({
        purchaseId: started.purchaseId,
        checkoutSessionId: "cs_1",
        paid: true,
        paidAmountMinor: 4900,
        paidCurrency: "aud",
        paymentIntentId: "pi_1",
      }),
    );

    expect(
      await run(
        db,
        svc.failPurchase({
          purchaseId: started.purchaseId,
          checkoutSessionId: "cs_1",
          status: "expired",
        }),
      ),
    ).toBe("ignored");
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(tierRow(db).tier).toBe("gold");
  });
});

describe("purchaseStatus", () => {
  it("is scoped to the wedding, so another wedding's id is simply not found", async () => {
    const db = createDb();
    seedWedding(db);
    seedWedding(db, "wed_other");
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    const started = await run(db, svc.startPurchase(START));

    expect(await run(db, svc.purchaseStatus("wed_test", started.purchaseId))).toEqual({
      status: "pending",
      tier: "gold",
    });
    expect(await run(db, svc.purchaseStatus("wed_other", started.purchaseId))).toBeNull();
  });

  it("names the tier a legacy purchase bought", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_v", product: "vendors", fromTier: null, status: "succeeded" });
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    expect(await run(db, svc.purchaseStatus("wed_test", "upg_v"))).toEqual({
      status: "succeeded",
      tier: "crimson",
    });
  });
});
