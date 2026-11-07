import { describe, expect, it } from "bun:test";

import { weddingUpgradePurchases } from "@cire/db";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import { buildTierChange, tierChangeToSql } from "../../scripts/grant-tier";
import { DbService, driverErrorText } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import type { PlatformSessionState, StripeClient } from "../../src/services/stripe";
import { StripeError } from "../../src/services/stripe";
import type { Tier } from "../../src/services/tiers";
import { createUpgradeCatalogue } from "../../src/services/upgrade-catalogue";
import {
  createUpgradeService,
  NOTICE_TIMEOUT,
  productsAbove,
  type RefundNotice,
  RECONCILE_PER_RUN,
  REFUND_GIVE_UP_MS,
  STALE_PENDING_MS,
  tierForProduct,
  UpgradeConflict,
  upgradeConflictReason,
} from "../../src/services/upgrades";
import { beforeStatement, failLikeD1 } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
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
    `INSERT INTO weddings (id, slug, display_name, code_style, currency, tier, created_at, updated_at)
     VALUES ('${id}', '${id}-slug', 'Test', 'secure', 'AUD', '${tier}', ${t}, ${t});`,
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
    /** When the row last moved. Defaults to its creation. */
    updatedMs?: number;
    /** The Price the purchase opened at. Absent on a row written before
     *  purchases recorded one. */
    price?: { id: string; amountMinor: number; currency: string };
    paymentIntentId?: string | null;
    /** The Stripe refund cire recorded, for a row in a refund status. */
    refundId?: string | null;
    /** Defaults to `wed_test`. */
    weddingId?: string;
  },
) {
  const at = secondsAt(row.createdMs ?? BASE_MS);
  db.$client
    .query(
      `INSERT INTO wedding_upgrade_purchases
         (id, wedding_id, entitlement, from_tier, status, checkout_session_id,
          payment_intent_id, price_id, price_amount_minor, price_currency,
          created_by_osn_profile_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usr_owner', ?, ?)`,
    )
    .run(
      row.id,
      row.weddingId ?? "wed_test",
      row.product,
      row.fromTier === undefined ? "ivory" : row.fromTier,
      row.status ?? "pending",
      row.sessionId ?? null,
      row.paymentIntentId ?? null,
      row.price?.id ?? null,
      row.price?.amountMinor ?? null,
      row.price?.currency ?? null,
      at,
      row.updatedMs === undefined ? at : secondsAt(row.updatedMs),
    );
  // A row in a refund status has its record outside the cascade, written in
  // the same batch as the row's claim.
  const status = row.status ?? "pending";
  if (["refunding", "auto_refunded", "refund_failed", "refunded"].includes(status)) {
    seedRefund(db, { ...row, status });
  }
  if (row.refundId !== undefined) {
    db.$client
      .query("UPDATE wedding_upgrade_purchases SET refund_id = ? WHERE id = ?")
      .run(row.refundId, row.id);
  }
}

/** A refund record (`platform_refunds`), as the claim writes it. */
function seedRefund(
  db: Db,
  row: {
    id: string;
    product: string;
    status: string;
    paymentIntentId?: string | null;
    refundId?: string | null;
    createdMs?: number;
    updatedMs?: number;
  },
) {
  const at = secondsAt(row.createdMs ?? BASE_MS);
  db.$client
    .query(
      `INSERT INTO platform_refunds
         (id, purchase_id, entitlement, payment_intent_id, amount_minor, currency, reason,
          status, refund_id, owners_notified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 4900, 'AUD', 'wedding_not_live', ?, ?, NULL, ?, ?)`,
    )
    .run(
      `rfd_${row.id}`,
      row.id,
      row.product,
      row.paymentIntentId ?? null,
      row.status,
      row.refundId ?? null,
      at,
      row.updatedMs === undefined ? at : secondsAt(row.updatedMs),
    );
}

/** Refund records as the database holds them. */
const refundRecords = (db: Db) =>
  db.$client.query("SELECT * FROM platform_refunds ORDER BY created_at, id").all() as {
    purchase_id: string;
    status: string;
    refund_id: string | null;
    payment_intent_id: string | null;
    amount_minor: number | null;
    currency: string | null;
    reason: string;
    owners_notified_at: number | null;
  }[];

/** The Price every stubbed tier is read back at, as `startPurchase` records it. */
const GOLD_PRICE = { id: "price_g", amountMinor: 4900, currency: "AUD" };

/** Rows as the database actually holds them, for assertions about state. */
const purchases = (db: Db) =>
  db.$client.query("SELECT * FROM wedding_upgrade_purchases ORDER BY created_at, id").all() as {
    id: string;
    status: string;
    checkout_session_id: string | null;
    entitlement: string;
    from_tier: string | null;
    price_id: string | null;
    price_amount_minor: number | null;
    price_currency: string | null;
    amount_minor: number | null;
    currency: string | null;
    payment_intent_id: string | null;
    refund_id: string | null;
    updated_at: number;
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
  /** Session ids this code asked Stripe about. */
  probed: string[];
  /** Whether each of those asked for the payment and its charge too. */
  probedWithPayment: boolean[];
  /** What the next probe answers. */
  probe: PlatformSessionState | "error";
  failCreate: boolean;
  failExpire: boolean;
  /** Stripe refuses to read any Price. */
  failPrice: boolean;
  /** Runs while Stripe is "thinking", to drive a concurrent-write race. */
  onCreate?: () => void;
  /** Runs while Stripe expires a session, to drive a concurrent-write race. */
  onExpire?: () => void;
  /** Each refund this code asked Stripe for. */
  refunds: { paymentIntentId: string; idempotencyKey: string; purchaseId: unknown }[];
  /** What every refund answers: accepted, or a refusal with Stripe's code. */
  refund: "ok" | { status?: number; code?: string; reason?: string };
  /** Runs while Stripe takes a refund, to drive a concurrent-write race. */
  onRefund?: () => void;
  /** The refund Stripe holds for a PaymentIntent naming the purchase, if
   *  any; `"error"` when Stripe cannot be asked. */
  found: string | null;
  /** Each refund lookup this code made, as (PaymentIntent, purchase). */
  lookups: [string, string][];
}

function stubStripe(): StripeStub {
  const stub: StripeStub = {
    created: [],
    pricedAt: [],
    successUrls: [],
    expired: [],
    probed: [],
    probedWithPayment: [],
    probe: { status: "expired" },
    failCreate: false,
    failExpire: false,
    failPrice: false,
    refunds: [],
    refund: "ok",
    found: null,
    lookups: [],
    client: undefined as unknown as StripeClient,
  };
  let minted = 0;
  stub.client = {
    retrievePrice: () =>
      stub.failPrice
        ? Effect.fail(new StripeError({ reason: "unreachable" }))
        : Effect.succeed({ unitAmountMinor: 4900, currency: "AUD" }),
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
    retrievePlatformCheckoutSession(sessionId: string, options?: { withPayment?: boolean }) {
      stub.probed.push(sessionId);
      stub.probedWithPayment.push(options?.withPayment === true);
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
    createPlatformRefund(input: {
      paymentIntentId: string;
      idempotencyKey: string;
      metadata: { purchaseId?: unknown };
    }) {
      stub.onRefund?.();
      stub.refunds.push({
        paymentIntentId: input.paymentIntentId,
        idempotencyKey: input.idempotencyKey,
        purchaseId: input.metadata.purchaseId,
      });
      const answer = stub.refund;
      return answer === "ok"
        ? Effect.succeed({ id: `re_${stub.refunds.length}` })
        : Effect.fail(
            new StripeError({
              reason: answer.reason ?? "rejected",
              status: answer.status,
              code: answer.code,
            }),
          );
    },
    findPlatformRefund: (paymentIntentId: string, purchaseId: string) => {
      stub.lookups.push([paymentIntentId, purchaseId]);
      return stub.found === "error"
        ? Effect.fail(new StripeError({ reason: "unreachable" }))
        : Effect.succeed(stub.found === null ? null : { id: stub.found });
    },
  } as unknown as StripeClient;
  return stub;
}

const PRICES = { gold: "price_g", crimson: "price_c", crimsonFromGold: "price_cg" };

/** Every owner notice of a refund the service asked for, in order. */
let notices: RefundNotice[] = [];

function makeService(
  stripe: StripeClient,
  clock: { t: number },
  prices: Parameters<typeof createUpgradeCatalogue>[0]["prices"] = PRICES,
) {
  let n = 0;
  notices = [];
  return createUpgradeService({
    stripe,
    catalogue: createUpgradeCatalogue({ stripe, prices }),
    now: () => clock.t,
    newId: (prefix) => `${prefix}_${++n}`,
    notifyRefund: (notice) =>
      Effect.sync(() => {
        notices.push(notice);
        return true;
      }),
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

  it("classifies the one-pending conflict as D1 reports it, statement and all", () => {
    // On D1 the text read through `driverErrorText` opens with drizzle's
    // `Failed query: <statement>`, and the INSERT names `checkout_session_id`
    // whatever the conflict was on.
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_a", product: "gold" });
    failLikeD1(db);
    let text = "";
    try {
      const now = new Date();
      db.insert(weddingUpgradePurchases)
        .values({
          id: "upg_b",
          weddingId: "wed_test",
          entitlement: "crimson",
          createdByOsnProfileId: "usr_owner",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (e) {
      text = driverErrorText(e);
    }

    expect(text).toContain('"checkout_session_id"');
    expect(text).toContain("UNIQUE constraint failed: wedding_upgrade_purchases.wedding_id");
    expect(upgradeConflictReason(text)).toBe("processing");
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

describe("productsAbove", () => {
  it("names every product that grants a tier ranked above the one given", () => {
    expect(productsAbove("ivory").toSorted()).toEqual(
      ["capacity_1000", "capacity_500", "crimson", "gold", "registry", "vendors"].toSorted(),
    );
    expect(productsAbove("gold").toSorted()).toEqual(
      ["capacity_1000", "crimson", "vendors"].toSorted(),
    );
    expect(productsAbove("crimson")).toEqual([]);
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

  it("records the Price it opened at, and what that Price charges", async () => {
    const db = createDb();
    seedWedding(db);
    const svc = makeService(stubStripe().client, { t: BASE_MS });

    await run(db, svc.startPurchase(START));
    expect(purchases(db)).toMatchObject([
      { price_id: "price_g", price_amount_minor: 4900, price_currency: "AUD" },
    ]);
  });

  it("opens nothing when Stripe will not read the Price", async () => {
    // Without the Price's amount there is nothing to check the payment
    // against, so no row and no payment page.
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    stripe.failPrice = true;
    const svc = makeService(stripe.client, { t: BASE_MS });

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(error._tag === "Some" && error.value._tag).toBe("UpgradeProviderError");
    }
    expect(purchases(db)).toEqual([]);
    expect(stripe.created).toEqual([]);
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
    const name = CIRE_METRICS.upgradeCheckoutStarted;
    const attrs = { tier: "crimson", from_tier: "ivory", result: "processing" };
    const before = await counterValue(name, attrs);

    expect(await conflictOf(db, svc.startPurchase(CRIMSON))).toBe("processing");
    expect(stripe.created).toEqual([]);
    expect(
      purchases(db)
        .filter((r) => r.status === "pending")
        .map((r) => r.id),
    ).toEqual(["upg_rival"]);
    // Counted like every other press told to wait.
    expect(await counterValue(name, attrs)).toBe(before + 1);
  });

  it("answers a write error, not processing, when the insert fails for any other reason", async () => {
    // Failed as D1 fails it, with a reason that is no unique conflict: the
    // organiser must not be told to wait, and the press is no contention.
    // The database's text here stands in for one that quotes a bound value.
    const db = createDb();
    seedWedding(db);
    failLikeD1(db);
    db.$client.exec(
      "CREATE TRIGGER upg_fail BEFORE INSERT ON wedding_upgrade_purchases BEGIN SELECT RAISE(ABORT, 'value Annabelle not supported'); END",
    );
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });
    const name = CIRE_METRICS.upgradeCheckoutStarted;
    const attrs = { tier: "crimson", from_tier: "ivory", result: "processing" };
    const before = await counterValue(name, attrs);

    const error = await run(db, svc.startPurchase(CRIMSON).pipe(Effect.flip));

    expect(error).toMatchObject({ _tag: "UpgradeWriteError", op: "insert-purchase" });
    // The logged reason names the statement and never the database's text.
    const { reason } = error as { reason: string };
    expect(reason).toContain('Failed query: insert into "wedding_upgrade_purchases"');
    expect(reason).not.toContain("Annabelle");
    expect(stripe.created).toEqual([]);
    expect(await counterValue(name, attrs)).toBe(before);
  });
});

/**
 * The tier migration marked every pending per-module purchase `expired` in the
 * database, but a database write cannot close a Stripe session: each stays
 * payable until Stripe expires it, a day after it opened. Until then the first
 * tier checkout on that wedding must close it at Stripe before opening its own,
 * exactly as it would a pending row's page — or the organiser could pay both.
 */
describe("startPurchase and a legacy page the migration closed only in the database", () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = BASE_MS + HOUR;

  function legacyPage(
    db: Db,
    opts: { id?: string; product?: string; sessionId?: string | null; createdMs?: number } = {},
  ) {
    seedPurchase(db, {
      id: opts.id ?? "upg_vendors",
      product: opts.product ?? "vendors",
      fromTier: null,
      status: "expired",
      sessionId: opts.sessionId === undefined ? "cs_v" : opts.sessionId,
      createdMs: opts.createdMs ?? BASE_MS,
    });
  }

  it("expires it at Stripe before opening a tier's page", async () => {
    const db = createDb();
    seedWedding(db);
    legacyPage(db);
    const stripe = stubStripe();
    stripe.probe = { status: "open", id: "cs_v", url: "https://pay.test/cs_v" };
    const svc = makeService(stripe.client, { t: NOW });

    const res = await run(db, svc.startPurchase(CRIMSON));
    expect(res.url).not.toBe("https://pay.test/cs_v");
    expect(stripe.expired).toEqual(["cs_v"]);
    expect(stripe.created).toHaveLength(1);
    expect(purchases(db).find((r) => r.id === "upg_vendors")?.status).toBe("expired");
  });

  it("closes every such page on the wedding", async () => {
    const db = createDb();
    seedWedding(db);
    legacyPage(db, { id: "upg_vendors", product: "vendors", sessionId: "cs_v" });
    legacyPage(db, { id: "upg_registry", product: "registry", sessionId: "cs_r" });
    const stripe = stubStripe();
    stripe.probe = { status: "open", id: "cs_x", url: "https://pay.test/cs_x" };
    const svc = makeService(stripe.client, { t: NOW });

    await run(db, svc.startPurchase(START));
    expect(stripe.expired.toSorted()).toEqual(["cs_r", "cs_v"]);
  });

  it("waits, and opens nothing, while that page is paid and not yet settled", async () => {
    const db = createDb();
    seedWedding(db);
    legacyPage(db);
    const stripe = stubStripe();
    stripe.probe = { status: "complete" };
    const svc = makeService(stripe.client, { t: NOW });

    expect(await conflictOf(db, svc.startPurchase(CRIMSON))).toBe("processing");
    expect(stripe.created).toEqual([]);
    expect(purchases(db).map((r) => r.id)).toEqual(["upg_vendors"]);
  });

  it("waits when Stripe will not expire it, or cannot be asked", async () => {
    for (const failure of ["expire", "probe"] as const) {
      const db = createDb();
      seedWedding(db);
      legacyPage(db);
      const stripe = stubStripe();
      stripe.probe =
        failure === "probe"
          ? "error"
          : { status: "open", id: "cs_v", url: "https://pay.test/cs_v" };
      stripe.failExpire = failure === "expire";
      const svc = makeService(stripe.client, { t: NOW });

      expect(await conflictOf(db, svc.startPurchase(CRIMSON)), failure).toBe("processing");
      expect(stripe.created, failure).toEqual([]);
    }
  });

  it("asks Stripe nothing about a page older than a session can live", async () => {
    const db = createDb();
    seedWedding(db);
    legacyPage(db, { createdMs: NOW - 24 * HOUR - 1000 });
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: NOW });

    await run(db, svc.startPurchase(CRIMSON));
    expect(stripe.probed).toEqual([]);
    expect(stripe.created).toHaveLength(1);
  });

  it("asks Stripe nothing about an expired tier purchase, or a legacy row with no session", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_gold_old",
      product: "gold",
      status: "expired",
      sessionId: "cs_g",
      createdMs: BASE_MS,
    });
    legacyPage(db, { id: "upg_sessionless", sessionId: null });
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: NOW });

    await run(db, svc.startPurchase(CRIMSON));
    expect(stripe.probed).toEqual([]);
    expect(stripe.created).toHaveLength(1);
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
    const stripe = stubStripe();
    const { svc, purchaseId } = await paidPurchase(db, stripe);

    await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }));
    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");

    expect(sales(db)).toHaveLength(1);
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(tierRow(db).tier).toBe("gold");
    expect(stripe.refunds).toEqual([]);
  });

  /**
   * THE CRASH POINT. A row still open while the wedding already holds the tier
   * this purchase granted (`tier_granted_by` names it) is a grant whose flip
   * never landed: the retry finishes the job rather than reading the tier as
   * held from elsewhere and refunding a customer who got what they paid for.
   */
  it("heals on redelivery when the flip never happened", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const { svc, purchaseId } = await paidPurchase(db, stripe);

    // Simulate the grant having landed while the flip did not.
    db.$client.exec(
      `UPDATE weddings SET tier = 'gold', tier_source = 'purchase', tier_granted_by = 'stripe:${purchaseId}' WHERE id = 'wed_test'`,
    );
    expect(purchases(db)[0]?.status).toBe("pending");

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(sales(db)).toHaveLength(1);
    expect(stripe.refunds).toEqual([]);
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
   * A session can be paid in the moment before it is expired — by this code
   * replacing it, or by migration 0073 expiring every legacy pending row. The
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

  /**
   * An earlier release marked a payment of another amount `mismatch` and
   * granted nothing. Nothing writes the status now, and a resend of its own
   * session's payment — from the Stripe dashboard — grants what was bought.
   */
  it("grants a legacy mismatch row when its own session's payment arrives again", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_mis",
      product: "gold",
      status: "mismatch",
      sessionId: "cs_1",
      price: GOLD_PRICE,
    });
    const svc = makeService(stubStripe().client, { t: BASE_MS });

    expect(
      await run(db, svc.settlePurchase({ purchaseId: "upg_mis", ...SETTLE, paidAmountMinor: 100 })),
    ).toBe("granted");
    expect(tierRow(db).tier).toBe("gold");
    expect(purchases(db)[0]).toMatchObject({ status: "succeeded", amount_minor: 100 });
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

  it("still settles a row that recorded no Price by the session it already holds", async () => {
    // Rows written before purchases recorded a Price are bound to their own
    // session, which only Stripe could have minted for this purchase.
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_old", product: "gold", status: "expired", sessionId: "cs_1" });
    const svc = makeService(stubStripe().client, { t: BASE_MS });

    // A delivery that names no currency still grants, and the sale's NOT NULL
    // currency reads empty rather than failing the batch.
    expect(
      await run(
        db,
        svc.settlePurchase({
          purchaseId: "upg_old",
          ...SETTLE,
          paidAmountMinor: 1234,
          paidCurrency: null,
        }),
      ),
    ).toBe("granted");
    expect(tierRow(db).tier).toBe("gold");
    expect(sales(db)).toMatchObject([{ amount_minor: 1234, currency: "" }]);
    expect(purchases(db)[0]).toMatchObject({ currency: null });
  });

  it("grants nothing when the session completed without payment", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const { svc, purchaseId } = await paidPurchase(db, stripe);

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE, paid: false }))).toBe(
      "unpaid",
    );
    expect(tierRow(db).tier).toBe("ivory");
    expect(purchases(db)[0]?.status).toBe("pending");
    expect(sales(db)).toEqual([]);
    // No money moved, so there is nothing to give back.
    expect(stripe.refunds).toEqual([]);
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

  /**
   * The owner's rule: a payment that went through upgrades the wedding. What a
   * paid session of ours bought is the purchase row's tier, whatever the
   * amount Checkout charged and whatever happened to the wedding's tier while
   * the page was open.
   */
  describe("a paid checkout of ours always grants", () => {
    it("grants whatever amount and currency Checkout charged, and records what arrived", async () => {
      // Tax, a discount or a converted currency on the Stripe page. The
      // session is this row's own, so it sold this row's Price.
      const db = createDb();
      seedWedding(db);
      const { svc, purchaseId } = await paidPurchase(db, stubStripe());

      expect(
        await run(
          db,
          svc.settlePurchase({ purchaseId, ...SETTLE, paidAmountMinor: 5390, paidCurrency: "usd" }),
        ),
      ).toBe("granted");
      expect(tierRow(db).tier).toBe("gold");
      expect(purchases(db)[0]).toMatchObject({
        status: "succeeded",
        amount_minor: 5390,
        currency: "USD",
        payment_intent_id: "pi_1",
      });
      expect(sales(db)).toMatchObject([{ amount_minor: 5390, currency: "USD" }]);
    });

    it("grants a purchase priced from Gold while the wedding still holds Gold, and repairs it on a replay", async () => {
      const db = createDb();
      seedWedding(db, "wed_test", "gold");
      const { svc, purchaseId } = await paidPurchase(db, stubStripe(), CRIMSON);
      expect(purchases(db)[0]?.from_tier).toBe("gold");

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
      expect(tierRow(db).tier).toBe("crimson");
      // The grant lost, the row already reading succeeded: the replay heals it.
      db.$client.exec("UPDATE weddings SET tier = 'gold' WHERE id = 'wed_test'");
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      expect(tierRow(db).tier).toBe("crimson");
      expect(sales(db)).toHaveLength(1);
    });

    it("never raises a from-Gold purchase on a replay once the wedding is below Gold", async () => {
      // Lowered by hand with the purchase left `succeeded`: a redelivery must
      // not sell the whole tier at the difference's price either.
      const db = createDb();
      seedWedding(db, "wed_test", "gold");
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe, CRIMSON);
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
      db.$client.exec("UPDATE weddings SET tier = 'ivory' WHERE id = 'wed_test'");

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      expect(tierRow(db).tier).toBe("ivory");
      expect(stripe.refunds).toEqual([]);
      expect(sales(db)).toHaveLength(1);
    });

    it("grants a purchase priced from Ivory when the wedding has since reached a lower paid tier", async () => {
      const db = createDb();
      seedWedding(db);
      const { svc, purchaseId } = await paidPurchase(db, stubStripe(), CRIMSON);
      db.$client.exec("UPDATE weddings SET tier = 'gold' WHERE id = 'wed_test'");

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
      expect(tierRow(db).tier).toBe("crimson");
    });
  });

  /**
   * A payment that did not come from this platform's own checkout grants
   * nothing and is not refunded: it is not ours to keep or to give back. The
   * purchase id arrives in `client_reference_id`, which any payment on this
   * Stripe account can carry, so "ours" is the session this row holds — the
   * one id only cire's own create call could have written there.
   */
  describe("a payment that is not ours", () => {
    it("grants and refunds nothing for a purchase this deployment has never heard of", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const svc = makeService(stripe.client, { t: BASE_MS });
      expect(await run(db, svc.settlePurchase({ purchaseId: "upg_nope", ...SETTLE }))).toBe(
        "unknown",
      );
      expect(sales(db)).toEqual([]);
      expect(stripe.refunds).toEqual([]);
    });

    it("grants and refunds nothing for a session the purchase does not hold", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);

      const logs = await captureLogs(async () => {
        expect(
          await run(
            db,
            svc.settlePurchase({ purchaseId, ...SETTLE, checkoutSessionId: "cs_other" }),
          ),
        ).toBe("unknown");
      });
      expect(logs).toContain("upgrade settle for a session the purchase does not hold");
      expect(tierRow(db).tier).toBe("ivory");
      expect(purchases(db)[0]).toMatchObject({ status: "pending", checkout_session_id: "cs_1" });
      expect(stripe.refunds).toEqual([]);
    });

    /**
     * A row is session-less only until its own session id is stored, and the
     * payment page is handed out only after that. So a paid session naming a
     * session-less row is never the row's own: it is adopted by nothing,
     * whatever it charged and whatever the row's status.
     */
    it("grants and refunds nothing for a session naming a row that holds none", async () => {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, { id: "upg_live", product: "gold", price: GOLD_PRICE });
      seedPurchase(db, {
        id: "upg_gone",
        product: "crimson",
        status: "failed",
        price: GOLD_PRICE,
        createdMs: BASE_MS + 1000,
      });
      const stripe = stubStripe();
      const svc = makeService(stripe.client, { t: BASE_MS });

      for (const purchaseId of ["upg_live", "upg_gone"]) {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE })), purchaseId).toBe(
          "unknown",
        );
      }
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(purchases(db).map((r) => [r.status, r.checkout_session_id])).toEqual([
        ["pending", null],
        ["failed", null],
      ]);
      expect(stripe.refunds).toEqual([]);
    });

    /**
     * A refund is an operator lowering the wedding with `grant-tier.ts --lower`,
     * which also marks the purchase `refunded`. Stripe redelivers a completed
     * session after a 500 and an operator can resend one from the dashboard, so
     * the refund must hold against the same payment arriving again — and cire
     * must not refund it a second time.
     */
    it("grants and refunds nothing for a purchase an operator refunded, however often it is redelivered", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");

      db.$client.exec(tierChangeToSql(buildTierChange("wed_test", "ivory", "ops", true)));
      expect(purchases(db)[0]?.status).toBe("refunded");

      const name = CIRE_METRICS.upgradePurchaseSettled;
      const before = await counterValue(name, { tier: "gold", outcome: "refunded" });
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("refunded");
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("refunded");
      expect(tierRow(db)).toEqual({
        tier: "ivory",
        tier_source: "comp",
        tier_granted_by: "script:ops",
      });
      expect(purchases(db)[0]?.status).toBe("refunded");
      expect(sales(db)).toHaveLength(1);
      expect(stripe.refunds).toEqual([]);
      expect(await counterValue(name, { tier: "gold", outcome: "refunded" })).toBe(before + 2);
    });
  });

  /**
   * When a paid checkout of ours cannot upgrade the wedding, cire gives the
   * money back through Stripe and records it, rather than keeping a payment
   * that bought nothing.
   */
  describe("a payment it cannot grant is refunded", () => {
    const KEY = (purchaseId: string) => `cire-upgrade-refund-${purchaseId}`;

    it("refunds a payment for a wedding deleted while its checkout was open", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      const name = CIRE_METRICS.upgradePurchaseSettled;
      const before = await counterValue(name, { tier: "gold", outcome: "auto_refunded" });

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      });

      expect(stripe.refunds).toEqual([
        { paymentIntentId: "pi_1", idempotencyKey: KEY(purchaseId), purchaseId },
      ]);
      expect(purchases(db)[0]).toMatchObject({
        status: "auto_refunded",
        refund_id: "re_1",
        payment_intent_id: "pi_1",
        amount_minor: 4900,
        currency: "AUD",
      });
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(logs).toContain("upgrade settle refunding a payment it cannot grant");
      expect(logs).toContain("wedding_not_live");
      expect(await counterValue(name, { tier: "gold", outcome: "auto_refunded" })).toBe(before + 1);
      // The refund's record, outside the cascade, written with the claim and
      // moved with the acceptance; and one notice to the owners.
      expect(refundRecords(db)).toMatchObject([
        {
          purchase_id: purchaseId,
          status: "auto_refunded",
          refund_id: "re_1",
          payment_intent_id: "pi_1",
          amount_minor: 4900,
          currency: "AUD",
          reason: "wedding_not_live",
        },
      ]);
      expect(refundRecords(db)[0]?.owners_notified_at).not.toBeNull();
      expect(notices).toEqual([
        { weddingId: "wed_test", tier: "gold", amountMinor: 4900, currency: "AUD" },
      ]);
    });

    it("refunds a payment whose product names no tier, rather than answering 500 forever", async () => {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, { id: "upg_ai", product: "ai", fromTier: null, sessionId: "cs_1" });
      const stripe = stubStripe();
      const svc = makeService(stripe.client, { t: BASE_MS });

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId: "upg_ai", ...SETTLE }))).toBe(
          "auto_refunded",
        );
      });
      expect(logs).toContain("no_tier");
      expect(stripe.refunds).toHaveLength(1);
      expect(purchases(db)[0]?.status).toBe("auto_refunded");
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(refundRecords(db)).toMatchObject([{ reason: "no_tier", status: "auto_refunded" }]);
      expect(notices).toMatchObject([{ tier: null }]);
    });

    /**
     * The from-Gold Crimson Price is the difference between the tiers. Paid
     * after an operator lowered the wedding below Gold, granting Crimson would
     * sell the whole tier at the difference's price, so the payment is
     * refunded instead.
     */
    it("refunds a purchase priced from Gold paid after the wedding was lowered below Gold", async () => {
      const db = createDb();
      seedWedding(db, "wed_test", "gold");
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe, CRIMSON);
      db.$client.exec(tierChangeToSql(buildTierChange("wed_test", "ivory", "ops", true)));

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      });
      expect(logs).toContain("not_from_tier");
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(stripe.refunds).toHaveLength(1);
      expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_1" });
    });

    it("refunds a purchase priced from Gold when the lowering lands between its read and its grant", async () => {
      const db = createDb();
      seedWedding(db, "wed_test", "gold");
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe, CRIMSON);
      beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
        db.$client.exec("UPDATE weddings SET tier = 'ivory' WHERE id = 'wed_test'");
      });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(stripe.refunds).toHaveLength(1);
    });

    it("refunds a payment for a tier the wedding reached some other way while the page was open", async () => {
      // An operator comped Crimson, or an unlock code raised the wedding, while
      // the Gold checkout was still payable: the payment bought nothing.
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec(
        "UPDATE weddings SET tier = 'crimson', tier_source = 'comp', tier_granted_by = 'script:ops' WHERE id = 'wed_test'",
      );

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      });
      expect(logs).toContain("already_held");
      expect(tierRow(db)).toEqual({
        tier: "crimson",
        tier_source: "comp",
        tier_granted_by: "script:ops",
      });
      expect(purchases(db)[0]?.status).toBe("auto_refunded");
      expect(stripe.refunds).toHaveLength(1);
      expect(sales(db)).toEqual([]);
    });

    /**
     * Stripe saves a refused request under its idempotency key for a day and
     * answers every repeat with the same refusal. The row stays `refunding`,
     * and every attempt is logged and counted; the daily reconciliation, not a
     * failing webhook, owns the next attempt. Once Stripe takes the refund, it
     * lands.
     */
    it("keeps a refused refund pending, logs and counts each refusal, and lands it on a later attempt", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.refund = { status: 400, code: "balance_insufficient" };
      const name = CIRE_METRICS.upgradePurchaseSettled;
      const before = await counterValue(name, { tier: "gold", outcome: "refund_failed" });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const logs = await captureLogs(async () => {
          expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe(
            "refund_failed",
          );
        });
        expect(logs).toContain("upgrade refund failed");
        expect(logs).toContain("balance_insufficient");
        expect(purchases(db)[0]).toMatchObject({ status: "refunding", refund_id: null });
      }
      expect(await counterValue(name, { tier: "gold", outcome: "refund_failed" })).toBe(before + 2);

      stripe.refund = "ok";
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_3" });
      // One key for the purchase, every attempt.
      expect(new Set(stripe.refunds.map((r) => r.idempotencyKey))).toEqual(
        new Set([KEY(purchaseId)]),
      );
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
    });

    it("records a payment someone already refunded by hand as refunded, and stops asking", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.refund = { status: 400, code: "charge_already_refunded" };

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("refunded");
      expect(purchases(db)[0]).toMatchObject({ status: "refunded", refund_id: null });
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("refunded");
      expect(stripe.refunds).toHaveLength(1);
    });

    /**
     * A refund that ran at Stripe while this side timed out, retried after its
     * key has gone: Stripe refuses it as already refunded. It is still cire's
     * own refund, and recorded so — a later `refund.failed` must find it.
     */
    it("records cire's own earlier refund, found at Stripe, rather than a person's", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.refund = { status: 400, code: "charge_already_refunded" };
      stripe.found = "re_earlier";

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_earlier" });
      expect(stripe.lookups).toEqual([["pi_1", purchaseId]]);
      // cire's own refund, so the owners hear of it.
      expect(notices).toHaveLength(1);
      expect(refundRecords(db)[0]?.owners_notified_at).not.toBeNull();
    });

    it("tells nobody when another delivery records the earlier refund it found first", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.refund = { status: 400, code: "charge_already_refunded" };
      stripe.found = "re_earlier";
      beforeStatement(db, /^update "platform_refunds" set "status" = \?/, () => {
        db.$client.exec(
          `UPDATE wedding_upgrade_purchases SET status = 'auto_refunded', refund_id = 're_earlier' WHERE id = '${purchaseId}'; UPDATE platform_refunds SET status = 'auto_refunded', refund_id = 're_earlier' WHERE purchase_id = '${purchaseId}'`,
        );
      });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      expect(refundRecords(db)).toMatchObject([
        { status: "auto_refunded", refund_id: "re_earlier" },
      ]);
      // The delivery that recorded it told the owners; this one tells nobody.
      expect(notices).toEqual([]);
    });

    it("answers a refund another delivery is making as in progress, not a refund failure", async () => {
      // Stripe refuses a second request under a key one is still running.
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.refund = { status: 409, code: "idempotency_key_in_use" };
      const name = CIRE_METRICS.upgradePurchaseSettled;
      const before = await counterValue(name, { tier: "gold", outcome: "refund_failed" });

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("refunding");
      });
      expect(logs).toContain("upgrade refund in progress elsewhere");
      expect(logs).not.toContain("upgrade refund failed");
      expect(await counterValue(name, { tier: "gold", outcome: "refund_failed" })).toBe(before);
      expect(purchases(db)[0]?.status).toBe("refunding");
    });

    /**
     * Only Stripe's "a request under this key is still running" is waiting on
     * another delivery. Any other conflict, and an idempotency refusal that is
     * not a conflict, is a refusal like the rest: logged and counted.
     */
    it("counts any other conflict, and an idempotency refusal, as a refused refund", async () => {
      for (const refusal of [
        { status: 409, code: "lock_timeout" },
        { status: 400, code: "idempotency_error" },
      ]) {
        const db = createDb();
        seedWedding(db);
        const stripe = stubStripe();
        const { svc, purchaseId } = await paidPurchase(db, stripe);
        db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
        stripe.refund = refusal;

        const logs = await captureLogs(async () => {
          expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE })), refusal.code).toBe(
            "refund_failed",
          );
        });
        expect(logs, refusal.code).toContain("upgrade refund failed");
        expect(purchases(db)[0]?.status, refusal.code).toBe("refunding");
      }
    });

    it("keeps a refund pending when Stripe cannot say whose refund the charge already has", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.refund = { status: 400, code: "charge_already_refunded" };
      stripe.found = "error";

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("refunding");
      });
      expect(logs).toContain("upgrade refund failed");
      // Not handed to a person: the next attempt can still find out.
      expect(purchases(db)[0]).toMatchObject({ status: "refunding", refund_id: null });
    });

    /**
     * Two refusals no retry can change: there is no payment to refund, or the
     * charge is disputed, so Stripe's dispute decides the money. Each ends at
     * `refund_failed` at once, logged, for a person — rather than holding the
     * wedding's data back from the purge while a retry fails every day.
     */
    it("hands a refund no retry can make to a person at once", async () => {
      for (const [label, patch] of [
        ["no payment intent", { paymentIntentId: null }],
        ["disputed", {}],
      ] as const) {
        const db = createDb();
        seedWedding(db);
        const stripe = stubStripe();
        if (label === "disputed") stripe.refund = { status: 400, code: "charge_disputed" };
        const { svc, purchaseId } = await paidPurchase(db, stripe);
        db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");

        const logs = await captureLogs(async () => {
          expect(
            await run(db, svc.settlePurchase({ purchaseId, ...SETTLE, ...patch })),
            label,
          ).toBe("refund_failed");
        });
        expect(logs, label).toContain("upgrade refund failed");
        expect(purchases(db)[0], label).toMatchObject({ status: "refund_failed", refund_id: null });
        expect(stripe.refunds, label).toHaveLength(label === "disputed" ? 1 : 0);
      }
    });

    it("refunds once, and grants nothing, however often the payment is redelivered", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      // Restored afterwards: the decision stands.
      db.$client.exec("UPDATE weddings SET deleted_at = NULL WHERE id = 'wed_test'");
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");

      expect(stripe.refunds).toHaveLength(1);
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_1" });
    });

    /**
     * The owners hear of a refund once, after Stripe accepts it: not before,
     * not again on a webhook replay or the reconciliation's retry, not for a
     * refund a person made, and never for a payment that is not cire's.
     */
    it("tells the owners once per refund, after Stripe accepts it", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.refund = { status: 400, code: "balance_insufficient" };

      await captureLogs(() => run(db, svc.settlePurchase({ purchaseId, ...SETTLE })));
      expect(notices).toEqual([]);

      stripe.refund = "ok";
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      expect(notices).toHaveLength(1);
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      await run(db, svc.reconcile());
      expect(notices).toHaveLength(1);
    });

    it("tells nobody of a refund a person made, or of a payment that is not cire's", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      // Deleted first, so a broken session check would refund, and mail.
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      expect(
        await run(db, svc.settlePurchase({ purchaseId, ...SETTLE, checkoutSessionId: "cs_x" })),
      ).toBe("unknown");
      expect(stripe.refunds).toEqual([]);
      expect(notices).toEqual([]);
      stripe.refund = { status: 400, code: "charge_already_refunded" };
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("refunded");
      expect(notices).toEqual([]);
      expect(refundRecords(db)).toMatchObject([{ status: "refunded", owners_notified_at: null }]);
    });

    /**
     * Once cire has decided to refund, a later delivery must not grant — the
     * wedding was restored, say, between the refused refund and its retry.
     * Granting then would keep the tier and return the money.
     */
    it("finishes a refund it decided on, and never grants it, once the wedding is live again", async () => {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, {
        id: "upg_r",
        product: "gold",
        status: "refunding",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
        price: GOLD_PRICE,
      });
      const stripe = stubStripe();
      const svc = makeService(stripe.client, { t: BASE_MS });

      expect(await run(db, svc.settlePurchase({ purchaseId: "upg_r", ...SETTLE }))).toBe(
        "auto_refunded",
      );
      expect(stripe.refunds).toEqual([
        { paymentIntentId: "pi_1", idempotencyKey: KEY("upg_r"), purchaseId: "upg_r" },
      ]);
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
    });

    /**
     * The other direction: a purchase that was granted stays granted. A replay
     * after the wedding was deleted, or reached a higher tier, is a replay —
     * the money bought the tier when it arrived.
     */
    it("never refunds a purchase it granted, whatever has happened to the wedding since", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");

      db.$client.exec(
        "UPDATE weddings SET tier = 'crimson', tier_granted_by = 'script:ops' WHERE id = 'wed_test'",
      );
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");

      expect(stripe.refunds).toEqual([]);
      expect(purchases(db)[0]?.status).toBe("succeeded");
      expect(sales(db)).toHaveLength(1);
    });

    /**
     * Two refunds of one purchase both reach Stripe — a resend racing a
     * retry — and the other records first. This one records nothing and
     * counts nothing a second time.
     */
    it("counts one refund once when another delivery records it first", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      stripe.onRefund = () => {
        db.$client.exec(
          `UPDATE wedding_upgrade_purchases SET status = 'auto_refunded', refund_id = 're_other' WHERE id = '${purchaseId}'; UPDATE platform_refunds SET status = 'auto_refunded', refund_id = 're_other' WHERE purchase_id = '${purchaseId}'`,
        );
      };
      const name = CIRE_METRICS.upgradePurchaseSettled;
      const before = await counterValue(name, { tier: "gold", outcome: "auto_refunded" });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_other" });
      expect(await counterValue(name, { tier: "gold", outcome: "auto_refunded" })).toBe(before);
      // The delivery that recorded it told the owners; this one tells nobody.
      expect(notices).toEqual([]);
    });

    /**
     * A delivery can name no PaymentIntent — a resend of an older event — for
     * a row that already recorded one. The refund uses the row's, and the
     * claim never erases it.
     */
    it("refunds the PaymentIntent the row holds when a delivery names none", async () => {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, {
        id: "upg_p",
        product: "gold",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
        price: GOLD_PRICE,
      });
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      const stripe = stubStripe();
      const svc = makeService(stripe.client, { t: BASE_MS });

      expect(
        await run(
          db,
          svc.settlePurchase({ purchaseId: "upg_p", ...SETTLE, paymentIntentId: null }),
        ),
      ).toBe("auto_refunded");
      expect(stripe.refunds.map((r) => r.paymentIntentId)).toEqual(["pi_1"]);
      expect(purchases(db)[0]).toMatchObject({
        status: "auto_refunded",
        payment_intent_id: "pi_1",
      });
    });

    /**
     * The purge takes the purchase row between the read and the batch. The
     * payment then reads as nobody's: nothing granted, recorded or refunded.
     */
    it("grants, records and refunds nothing when the purchase row goes between its read and its batch", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
        db.$client.exec(`DELETE FROM wedding_upgrade_purchases WHERE id = '${purchaseId}'`);
      });

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("unknown");
      });
      expect(logs).toContain("upgrade settle lost its purchase");
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(stripe.refunds).toEqual([]);
    });

    /**
     * A restore landing between the read that decided to refund and the claim
     * leaves the row open: the claim holds the read's decision, as the grant's
     * flip does, and a fresh read grants the payment.
     */
    it("leaves the row refunding when the record names another refund", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      // The record alone moves, by hand, to another refund: Stripe's answer
      // for this one must not carry the row past it.
      beforeStatement(db, /^update "platform_refunds" set "status" = \?/, () => {
        db.$client.exec(
          `UPDATE platform_refunds SET status = 'auto_refunded', refund_id = 're_other' WHERE purchase_id = '${purchaseId}'`,
        );
      });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      expect(purchases(db)[0]).toMatchObject({ status: "refunding", refund_id: null });
      expect(notices).toEqual([]);
    });

    it("grants, not refunds, when the wedding is restored between its read and its refund claim", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
        db.$client.exec("UPDATE weddings SET deleted_at = NULL WHERE id = 'wed_test'");
      });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
      expect(tierRow(db).tier).toBe("gold");
      expect(stripe.refunds).toEqual([]);
      // The claim matched nothing, so it wrote no refund record either, and the
      // daily run has nothing to refund.
      expect(refundRecords(db)).toEqual([]);
      await run(db, svc.reconcile());
      expect(stripe.refunds).toEqual([]);
    });

    it("counts a person's refund once when another delivery records it first", async () => {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, {
        id: "upg_r",
        product: "gold",
        status: "refunding",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
      });
      const stripe = stubStripe();
      stripe.refund = { status: 400, code: "charge_already_refunded" };
      const svc = makeService(stripe.client, { t: BASE_MS });
      beforeStatement(db, /^update "platform_refunds" set "status" = \?/, () => {
        db.$client.exec(
          "UPDATE wedding_upgrade_purchases SET status = 'refunded' WHERE id = 'upg_r'; UPDATE platform_refunds SET status = 'refunded' WHERE purchase_id = 'upg_r'",
        );
      });
      const name = CIRE_METRICS.upgradePurchaseSettled;
      const before = await counterValue(name, { tier: "gold", outcome: "refunded" });

      expect(await run(db, svc.settlePurchase({ purchaseId: "upg_r", ...SETTLE }))).toBe(
        "replayed",
      );
      expect(await counterValue(name, { tier: "gold", outcome: "refunded" })).toBe(before);
    });

    it("hands a disputed refund to a person only if it is still pending", async () => {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, {
        id: "upg_r",
        product: "gold",
        status: "refunding",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
      });
      const stripe = stubStripe();
      stripe.refund = { status: 400, code: "charge_disputed" };
      const svc = makeService(stripe.client, { t: BASE_MS });
      beforeStatement(db, /^update "platform_refunds" set "status" = \?/, () => {
        db.$client.exec(
          "UPDATE wedding_upgrade_purchases SET status = 'auto_refunded', refund_id = 're_other' WHERE id = 'upg_r'; UPDATE platform_refunds SET status = 'auto_refunded', refund_id = 're_other' WHERE purchase_id = 'upg_r'",
        );
      });

      const logs = await captureLogs(() =>
        run(db, svc.settlePurchase({ purchaseId: "upg_r", ...SETTLE })),
      );
      expect(logs).toContain('"handedToAPerson":false');
      expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_other" });
    });

    it("refunds a payment for a wedding whose tier no build knows", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET tier = 'platinum' WHERE id = 'wed_test'");

      const logs = await captureLogs(async () => {
        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      });
      expect(logs).toContain("unknown_tier");
      expect(sales(db)).toEqual([]);
    });

    it("lets the database refuse a status cire does not write", () => {
      const db = createDb();
      seedWedding(db);
      expect(() =>
        seedPurchase(db, { id: "upg_x", product: "gold", status: "refund-failed" }),
      ).toThrow("upgrade purchase status is not one cire writes");
      seedPurchase(db, { id: "upg_y", product: "gold", status: "refund_failed" });
      expect(() =>
        db.$client.exec("UPDATE wedding_upgrade_purchases SET status = 'done' WHERE id = 'upg_y'"),
      ).toThrow("upgrade purchase status is not one cire writes");
    });

    /**
     * Two claims of one payment: the other's row move and record land first.
     * This claim's record insert does nothing on the conflict, its batch
     * still commits, and one refund is made under one record.
     */
    it("keeps the one record when another delivery's claim lands first", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
        db.$client.exec(
          `UPDATE wedding_upgrade_purchases SET status = 'refunding', payment_intent_id = 'pi_1' WHERE id = '${purchaseId}'`,
        );
        seedRefund(db, {
          id: purchaseId,
          product: "gold",
          status: "refunding",
          paymentIntentId: "pi_1",
        });
      });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      expect(refundRecords(db)).toHaveLength(1);
      expect(stripe.refunds).toHaveLength(1);
    });

    /**
     * A notice that cannot be sent never undoes the refund: the money went
     * back, the record says so, and the failure is a warning.
     */
    it("records the refund even when the owners cannot be told", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const svc = createUpgradeService({
        stripe: stripe.client,
        catalogue: createUpgradeCatalogue({ stripe: stripe.client, prices: PRICES }),
        now: () => BASE_MS,
        notifyRefund: () => Effect.die(new Error("mail down")),
      });
      const started = await run(db, svc.startPurchase(START));
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");

      const logs = await captureLogs(async () => {
        expect(
          await run(db, svc.settlePurchase({ purchaseId: started.purchaseId, ...SETTLE })),
        ).toBe("auto_refunded");
      });
      expect(logs).toContain("upgrade refund notice failed");
      expect(refundRecords(db)).toMatchObject([{ status: "auto_refunded" }]);
    });

    /**
     * Two deliveries of one payment read the row before either writes, and
     * reach opposite answers: the wedding was restored between them. Whichever
     * write lands first decides, and the other follows it rather than doing
     * its own: never a grant and a refund of the same payment.
     */
    it("follows a refund decided between its read and its grant", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
        db.$client.exec(
          `UPDATE wedding_upgrade_purchases SET status = 'refunding', payment_intent_id = 'pi_1' WHERE id = '${purchaseId}'`,
        );
        seedRefund(db, {
          id: purchaseId,
          product: "gold",
          status: "refunding",
          paymentIntentId: "pi_1",
        });
      });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("auto_refunded");
      expect(tierRow(db).tier).toBe("ivory");
      expect(sales(db)).toEqual([]);
      expect(stripe.refunds).toHaveLength(1);
    });

    /**
     * The other race: a comp, or a delete, lands between the read that decided
     * to grant and the batch that grants. The flip itself carries the decision,
     * so it matches nothing, and a fresh read sends the payment to a refund.
     */
    it("refunds, not grants, when the wedding is deleted or comped between its read and its grant", async () => {
      for (const change of [
        "UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'",
        "UPDATE weddings SET tier = 'crimson', tier_granted_by = 'script:ops' WHERE id = 'wed_test'",
      ]) {
        const db = createDb();
        seedWedding(db);
        const stripe = stubStripe();
        const { svc, purchaseId } = await paidPurchase(db, stripe);
        beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
          db.$client.exec(change);
        });

        expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE })), change).toBe(
          "auto_refunded",
        );
        expect(sales(db), change).toEqual([]);
        expect(stripe.refunds, change).toHaveLength(1);
        expect(purchases(db)[0]?.status, change).toBe("auto_refunded");
      }
    });

    it("follows a grant landed between its read and its refund claim", async () => {
      const db = createDb();
      seedWedding(db);
      const stripe = stubStripe();
      const { svc, purchaseId } = await paidPurchase(db, stripe);
      db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
      beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
        db.$client.exec(
          `UPDATE wedding_upgrade_purchases SET status = 'succeeded' WHERE id = '${purchaseId}'`,
        );
      });

      expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
      expect(stripe.refunds).toEqual([]);
      expect(purchases(db)[0]?.status).toBe("succeeded");
      // No record either: the daily run reads refunds from the record alone,
      // so one beside a granted row would refund a payment that bought the tier.
      expect(refundRecords(db)).toEqual([]);
      await run(db, svc.reconcile());
      expect(stripe.refunds).toEqual([]);
    });
  });
});

describe("refundFailed", () => {
  /**
   * Stripe accepted the refund and the bank then returned it — a closed card,
   * say. The money is back in cire's balance and a person has to return it
   * another way, so the row says so and the failure is logged and counted.
   */
  it("marks our refund failed when the bank returns it, and ignores a refund that is not ours", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "auto_refunded",
      sessionId: "cs_1",
      refundId: "re_1",
    });
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    const name = CIRE_METRICS.upgradePurchaseSettled;
    const before = await counterValue(name, { tier: "gold", outcome: "refund_failed" });

    // Our purchase, a refund it does not hold: still ours to return, so said.
    const other = await captureLogs(async () => {
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_r", refundId: "re_other" }))).toBe(
        "ignored",
      );
    });
    expect(other).toContain("upgrade refund failed at the bank");
    expect(await run(db, svc.refundFailed({ purchaseId: "upg_nope", refundId: "re_1" }))).toBe(
      "ignored",
    );
    expect(purchases(db)[0]?.status).toBe("auto_refunded");

    const logs = await captureLogs(async () => {
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_r", refundId: "re_1" }))).toBe(
        "recorded",
      );
    });
    expect(logs).toContain("upgrade refund failed at the bank");
    expect(purchases(db)[0]).toMatchObject({ status: "refund_failed", refund_id: "re_1" });
    expect(await counterValue(name, { tier: "gold", outcome: "refund_failed" })).toBe(before + 1);

    // A redelivery records nothing again, and raises no second alarm.
    const unmapped = await counterValue(name, { tier: "unmapped", outcome: "refund_failed" });
    const again = await captureLogs(async () => {
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_r", refundId: "re_1" }))).toBe(
        "ignored",
      );
    });
    expect(again).not.toContain("upgrade refund failed at the bank");
    expect(await counterValue(name, { tier: "unmapped", outcome: "refund_failed" })).toBe(unmapped);
  });

  /**
   * Stripe accepted cire's refund while cire's call timed out, so the row is
   * still `refunding` with no refund id, and the bank then returns it. The
   * failure lands on the row, and the refund's late success, replayed under
   * the same key, never overwrites it.
   */
  it("records a bank's failure of a refund cire has not recorded yet, and keeps it", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS + 24 * 60 * 60 * 1000 });

    await captureLogs(async () => {
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_r", refundId: "re_9" }))).toBe(
        "recorded",
      );
    });
    expect(purchases(db)[0]).toMatchObject({ status: "refund_failed", refund_id: "re_9" });

    await captureLogs(() => run(db, svc.reconcile()));
    expect(purchases(db)[0]).toMatchObject({ status: "refund_failed", refund_id: "re_9" });
  });

  /**
   * A refund handed to a person with no refund id, then a bank failure of a
   * refund cire never recorded: still money owed, so still an alarm.
   */
  it("raises the alarm for a bank's failure of a refund it never recorded", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_h", product: "gold", status: "refund_failed", sessionId: "cs_1" });
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    const name = CIRE_METRICS.upgradePurchaseSettled;
    const before = await counterValue(name, { tier: "unmapped", outcome: "refund_failed" });

    const logs = await captureLogs(async () => {
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_h", refundId: "re_9" }))).toBe(
        "ignored",
      );
    });
    expect(logs).toContain("upgrade refund failed at the bank");
    expect(await counterValue(name, { tier: "unmapped", outcome: "refund_failed" })).toBe(
      before + 1,
    );
  });

  /**
   * The purchase row moves only into the state its record holds. A record a
   * person marked `refunded`, or one that names another refund, leaves the
   * row where it was, however well the row's own columns match.
   */
  it("leaves the purchase row alone when the record says otherwise", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_p",
      product: "gold",
      status: "auto_refunded",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
      refundId: "re_1",
    });
    seedPurchase(db, {
      id: "upg_q",
      product: "gold",
      status: "refunding",
      sessionId: "cs_2",
      paymentIntentId: "pi_2",
    });
    db.$client.exec(
      "UPDATE platform_refunds SET status = 'refunded' WHERE purchase_id = 'upg_p';" +
        " UPDATE platform_refunds SET status = 'refund_failed', refund_id = 're_other' WHERE purchase_id = 'upg_q';",
    );
    const svc = makeService(stubStripe().client, { t: BASE_MS });

    await captureLogs(async () => {
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_p", refundId: "re_1" }))).toBe(
        "ignored",
      );
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_q", refundId: "re_1" }))).toBe(
        "ignored",
      );
    });
    expect(purchases(db)).toMatchObject([
      { id: "upg_p", status: "auto_refunded", refund_id: "re_1" },
      { id: "upg_q", status: "refunding", refund_id: null },
    ]);
  });

  /**
   * A refund cire made can fail at the bank days later, after the purge has
   * taken the deleted wedding's purchase row with it. The money is still owed,
   * so a failed refund naming one of our purchases that moves no row is an
   * error a person sees, never a silent acknowledgement.
   */
  it("logs and counts a failed refund of ours that matches no purchase it still holds", async () => {
    const db = createDb();
    seedWedding(db);
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    const name = CIRE_METRICS.upgradePurchaseSettled;
    const before = await counterValue(name, { tier: "unmapped", outcome: "refund_failed" });

    const logs = await captureLogs(async () => {
      expect(await run(db, svc.refundFailed({ purchaseId: "upg_purged", refundId: "re_9" }))).toBe(
        "ignored",
      );
    });
    expect(logs).toContain("upgrade refund failed at the bank");
    expect(logs).toContain("re_9");
    expect(await counterValue(name, { tier: "unmapped", outcome: "refund_failed" })).toBe(
      before + 1,
    );
  });
});

describe("reconcile", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const paidSession = (paymentIntentId = "pi_1"): PlatformSessionState => ({
    status: "complete",
    payment: { paid: true, amountMinor: 4900, currency: "aud", paymentIntentId, refunded: false },
  });

  /**
   * The webhook is the fast path, never the only one. A paid session whose
   * delivery never landed — the endpoint was down past Stripe's retries, or
   * storage failed every time — still upgrades the wedding once the daily run
   * asks Stripe what happened.
   */
  it("grants a paid session whose webhook never landed", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    const stripe = stubStripe();
    stripe.probe = paidSession();
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 1000 });

    expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 0 });
    expect(stripe.probed).toEqual(["cs_1"]);
    // The charge comes with it, for the refunded-by-a-person check.
    expect(stripe.probedWithPayment).toEqual([true]);
    expect(tierRow(db)).toMatchObject({ tier: "gold", tier_granted_by: "stripe:upg_s" });
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(sales(db)).toHaveLength(1);
  });

  it("refunds a paid session whose webhook never landed, when it cannot grant", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_test'");
    const stripe = stubStripe();
    stripe.probe = paidSession();
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 1000 });

    expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 0 });
    expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_1" });
    expect(stripe.refunds).toEqual([
      { paymentIntentId: "pi_1", idempotencyKey: "cire-upgrade-refund-upg_s", purchaseId: "upg_s" },
    ]);
  });

  it("closes a pending row whose session expired unpaid", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    const stripe = stubStripe();
    stripe.probe = { status: "expired", stripeStatus: "expired" };
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 1000 });

    expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 0 });
    expect(purchases(db)[0]?.status).toBe("expired");
    expect(tierRow(db).tier).toBe("ivory");
    expect(stripe.refunds).toEqual([]);
  });

  /**
   * The probe also answers `expired` for a session it cannot read plainly —
   * open with no URL, or a status this code does not know. Closing on that
   * would end, for good, the one row the sweep exists to finish.
   */
  it("closes nothing on a session Stripe did not itself call expired, and moves it to the back", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    const stripe = stubStripe();
    stripe.probe = { status: "expired", stripeStatus: "something_new" };
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 5000 });

    expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 1 });
    expect(purchases(db)[0]).toMatchObject({
      status: "pending",
      updated_at: secondsAt(BASE_MS + DAY + 5000),
    });
  });

  it("moves a session that completed unpaid to the back rather than stalling on it", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    const stripe = stubStripe();
    stripe.probe = {
      status: "complete",
      payment: {
        paid: false,
        amountMinor: null,
        currency: null,
        paymentIntentId: null,
        refunded: false,
      },
    };
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 5000 });

    expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 1 });
    expect(purchases(db)[0]).toMatchObject({
      status: "pending",
      updated_at: secondsAt(BASE_MS + DAY + 5000),
    });
    expect(tierRow(db).tier).toBe("ivory");
  });

  /**
   * A person refunded the payment in the dashboard while its webhook kept
   * failing — the customer asked where their upgrade was. The sweep records
   * the refund; it never grants a tier for money already given back.
   */
  it("records a payment a person already refunded, and grants nothing", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    const stripe = stubStripe();
    stripe.probe = {
      status: "complete",
      payment: {
        paid: true,
        amountMinor: 4900,
        currency: "aud",
        paymentIntentId: "pi_1",
        refunded: true,
      },
    };
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 1000 });

    expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 0 });
    expect(purchases(db)[0]).toMatchObject({ status: "refunded", payment_intent_id: "pi_1" });
    expect(tierRow(db).tier).toBe("ivory");
    expect(sales(db)).toEqual([]);
    expect(stripe.refunds).toEqual([]);
  });

  /**
   * A refund Stripe keeps refusing is handed to a person: past
   * `REFUND_GIVE_UP_MS` the sweep stops asking, marks it `refund_failed` and
   * says so, and says so again each day until a person resolves it.
   */
  it("gives a refund up to a person once it has failed for too long", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    stripe.refund = { status: 400, code: "balance_insufficient" };
    const svc = makeService(stripe.client, { t: BASE_MS + REFUND_GIVE_UP_MS + 1000 });

    const logs = await captureLogs(async () => {
      expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 0 });
    });
    expect(logs).toContain("upgrade refund given up");
    expect(logs).toContain("upgrade refunds waiting for a person");
    expect(purchases(db)[0]).toMatchObject({ status: "refund_failed", refund_id: null });

    // The next run reads nothing, and says again that a person is needed.
    const again = await captureLogs(async () => {
      expect(await run(db, svc.reconcile())).toEqual({ read: 0, failed: 0 });
    });
    expect(again).toContain("upgrade refunds waiting for a person");
  });

  /**
   * A refund that may exist at Stripe — another delivery's request still
   * running, or a call whose answer never arrived — is never given up on:
   * handing it to a person would have them return money Stripe already did.
   */
  it("never gives up a refund that may exist at Stripe", async () => {
    for (const refusal of [
      { status: 409, code: "idempotency_key_in_use" },
      { reason: "unreachable" },
      { reason: "timeout" },
    ]) {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, {
        id: "upg_r",
        product: "gold",
        status: "refunding",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
      });
      const stripe = stubStripe();
      stripe.refund = refusal;
      const svc = makeService(stripe.client, { t: BASE_MS + REFUND_GIVE_UP_MS + 1000 });

      await captureLogs(() => run(db, svc.reconcile()));
      expect(purchases(db)[0]?.status, JSON.stringify(refusal)).toBe("refunding");
    }
  });

  it("records a refund Stripe accepted after it was handed to a person", async () => {
    // The give-up lands while this call's refund is on its way back.
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    // The give-up moves the record and the row together, as the daily run does,
    // so only the record's `refund_failed` arm can take the acceptance.
    stripe.onRefund = () => {
      db.$client.exec(
        "UPDATE wedding_upgrade_purchases SET status = 'refund_failed' WHERE id = 'upg_r';" +
          " UPDATE platform_refunds SET status = 'refund_failed' WHERE purchase_id = 'upg_r';",
      );
    };
    const svc = makeService(stripe.client, { t: BASE_MS });

    expect(
      await run(
        db,
        svc.settlePurchase({
          purchaseId: "upg_r",
          checkoutSessionId: "cs_1",
          paid: true,
          paidAmountMinor: 4900,
          paidCurrency: "aud",
          paymentIntentId: "pi_1",
        }),
      ),
    ).toBe("auto_refunded");
    expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_1" });
    expect(refundRecords(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_1" });
    expect(notices).toHaveLength(1);
  });

  /**
   * The give-up's write is guarded on the row still being `refunding`. A
   * refund recorded by another delivery just before it stays recorded.
   */
  it("hands nothing to a person that another delivery refunded just before", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    stripe.refund = { status: 400, code: "balance_insufficient" };
    const svc = makeService(stripe.client, { t: BASE_MS + REFUND_GIVE_UP_MS + 1000 });
    beforeStatement(db, /^update "platform_refunds" set "status" = \?/, () => {
      db.$client.exec(
        "UPDATE wedding_upgrade_purchases SET status = 'auto_refunded', refund_id = 're_other' WHERE id = 'upg_r'; UPDATE platform_refunds SET status = 'auto_refunded', refund_id = 're_other' WHERE purchase_id = 'upg_r'",
      );
    });

    const logs = await captureLogs(() => run(db, svc.reconcile()));
    expect(logs).not.toContain("upgrade refund given up");
    expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_other" });
  });

  /**
   * The sweep's write of a person's refund is guarded on the row still being
   * `pending`: a grant landing just before it is never turned into a refund.
   */
  it("never marks refunded a purchase granted just before its write", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    const stripe = stubStripe();
    stripe.probe = {
      status: "complete",
      payment: {
        paid: true,
        amountMinor: 4900,
        currency: "aud",
        paymentIntentId: "pi_1",
        refunded: true,
      },
    };
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 1000 });
    beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
      db.$client.exec(
        "UPDATE wedding_upgrade_purchases SET status = 'succeeded' WHERE id = 'upg_s'",
      );
    });

    await run(db, svc.reconcile());
    expect(purchases(db)[0]?.status).toBe("succeeded");
  });

  it("retries a refund Stripe refused, and lands it", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS + DAY });

    expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 0 });
    // A refunding row is not asked about at Stripe first: the refund is the step.
    expect(stripe.probed).toEqual([]);
    expect(purchases(db)[0]).toMatchObject({ status: "auto_refunded", refund_id: "re_1" });
    // The daily run's refund is told to the owners, as the webhook's is.
    expect(notices).toHaveLength(1);
  });

  it("asks nothing about a checkout still inside its session's lifetime, or a row that is done", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_open", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    seedPurchase(db, {
      id: "upg_done",
      product: "gold",
      status: "succeeded",
      sessionId: "cs_2",
      createdMs: BASE_MS - 2 * DAY,
    });
    seedPurchase(db, {
      id: "upg_bare",
      product: "gold",
      status: "failed",
      createdMs: BASE_MS - 2 * DAY,
    });
    const stripe = stubStripe();
    stripe.probe = paidSession();
    const svc = makeService(stripe.client, { t: BASE_MS + DAY - 1000 });

    expect(await run(db, svc.reconcile())).toEqual({ read: 0, failed: 0 });
    expect(stripe.probed).toEqual([]);
    expect(purchases(db).find((r) => r.id === "upg_open")?.status).toBe("pending");
  });

  /**
   * A row whose step keeps failing must not hold the run's few places for
   * good: it is moved to the back, so the next run starts with another, and a
   * run reads no more than its cap.
   */
  it("reads at most its cap a run, and moves a row that failed to the back", async () => {
    const db = createDb();
    seedWedding(db);
    for (let i = 0; i < RECONCILE_PER_RUN + 1; i += 1) {
      seedPurchase(db, {
        id: `upg_${i}`,
        product: "gold",
        status: "refunding",
        sessionId: `cs_${i}`,
        paymentIntentId: `pi_${i}`,
        createdMs: BASE_MS + i * 1000,
      });
    }
    const stripe = stubStripe();
    stripe.refund = { status: 400, code: "balance_insufficient" };
    const clock = { t: BASE_MS + DAY };
    const svc = makeService(stripe.client, clock);

    const logs = await captureLogs(async () => {
      expect(await run(db, svc.reconcile())).toEqual({
        read: RECONCILE_PER_RUN,
        failed: RECONCILE_PER_RUN,
      });
    });
    expect(logs).toContain("balance_insufficient");
    expect(stripe.refunds.map((r) => r.purchaseId)).toEqual(
      Array.from({ length: RECONCILE_PER_RUN }, (_, i) => `upg_${i}`),
    );

    // The next run starts with the row the first left unread.
    stripe.refunds.length = 0;
    clock.t += DAY;
    await captureLogs(() => run(db, svc.reconcile()));
    expect(stripe.refunds[0]?.purchaseId).toBe(`upg_${RECONCILE_PER_RUN}`);
  });

  it("counts a refund another delivery is still making as not done", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    stripe.refund = { status: 409, code: "idempotency_key_in_use" };
    const svc = makeService(stripe.client, { t: BASE_MS + DAY });

    await captureLogs(async () => {
      expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 1 });
    });
    expect(purchases(db)[0]?.status).toBe("refunding");
  });

  /**
   * A row whose step dies — a storage failure — must not end the run: the
   * refund behind it is still asked for.
   */
  it("goes on to the next row when one row's step dies", async () => {
    const db = createDb();
    seedWedding(db);
    for (const [i, id] of ["upg_a", "upg_b"].entries()) {
      seedPurchase(db, {
        id,
        product: "gold",
        status: "refunding",
        sessionId: `cs_${i}`,
        paymentIntentId: `pi_${i}`,
        createdMs: BASE_MS + i * 1000,
      });
    }
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS + DAY });
    beforeStatement(db, /^update "wedding_upgrade_purchases" set "status" = \?/, () => {
      throw new Error("D1_ERROR: storage unavailable");
    });

    const logs = await captureLogs(async () => {
      expect(await run(db, svc.reconcile())).toEqual({ read: 2, failed: 1 });
    });
    expect(logs).toContain("upgrade reconcile step failed");
    expect(purchases(db).map((r) => [r.id, r.status])).toEqual([
      ["upg_a", "refunding"],
      ["upg_b", "auto_refunded"],
    ]);
  });

  it("reads a pending row from the moment its session's day is over, and asks again until the give-up day", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_2",
      paymentIntentId: "pi_2",
    });
    const stripe = stubStripe();
    stripe.probe = { status: "expired", stripeStatus: "expired" };
    stripe.refund = { status: 400, code: "balance_insufficient" };

    // Exactly one day: the pending row is read. Exactly the give-up age is
    // still inside the window for the refunding one only when it is younger.
    const atDay = makeService(stripe.client, { t: BASE_MS + DAY });
    await captureLogs(() => run(db, atDay.reconcile()));
    expect(stripe.probed).toEqual(["cs_1"]);
    expect(purchases(db).find((r) => r.id === "upg_r")?.status).toBe("refunding");

    const atGiveUp = makeService(stripe.client, { t: BASE_MS + REFUND_GIVE_UP_MS });
    const logs = await captureLogs(() => run(db, atGiveUp.reconcile()));
    expect(logs).toContain("upgrade refund given up");
    expect(purchases(db).find((r) => r.id === "upg_r")?.status).toBe("refund_failed");
  });

  /**
   * Refunds and stale checkouts share one queue, least recently moved first,
   * so one run reads no more than its cap whatever is queued.
   */
  it("works one queue, oldest first, across refunds and stale checkouts, never past its cap", async () => {
    const db = createDb();
    seedWedding(db);
    for (let i = 0; i < RECONCILE_PER_RUN - 1; i += 1) {
      seedPurchase(db, {
        id: `upg_r${i}`,
        product: "gold",
        status: "refunding",
        sessionId: `cs_r${i}`,
        paymentIntentId: `pi_r${i}`,
      });
    }
    seedWedding(db, "wed_b");
    seedWedding(db, "wed_c");
    for (const [i, weddingId] of (["wed_b", "wed_c"] as const).entries()) {
      seedPurchase(db, {
        id: `upg_s${i}`,
        weddingId,
        product: "gold",
        sessionId: `cs_s${i}`,
        price: GOLD_PRICE,
        createdMs: BASE_MS + i * 1000,
      });
    }
    const stripe = stubStripe();
    stripe.refund = { status: 400, code: "balance_insufficient" };
    stripe.probe = { status: "open", id: "cs", url: "https://pay.test/cs" };
    const clock = { t: BASE_MS + DAY + 5000 };
    const svc = makeService(stripe.client, clock);

    await captureLogs(() => run(db, svc.reconcile()));
    expect(stripe.refunds).toHaveLength(RECONCILE_PER_RUN - 1);
    expect(stripe.probed).toEqual(["cs_s0"]);

    // The next run starts with the checkout the first left unread.
    clock.t += DAY;
    stripe.refund = "ok";
    await run(db, svc.reconcile());
    expect(stripe.probed).toEqual(["cs_s0", "cs_s1"]);
  });

  /**
   * Refunds Stripe keeps refusing must not hold every place: a paid checkout
   * whose webhook never landed still gets its turn the next day.
   */
  it("still reaches a paid stale checkout while refunds keep failing", async () => {
    const db = createDb();
    seedWedding(db);
    for (const i of [0, 1]) {
      seedPurchase(db, {
        id: `upg_r${i}`,
        product: "gold",
        status: "refunding",
        sessionId: `cs_r${i}`,
        paymentIntentId: `pi_r${i}`,
        createdMs: BASE_MS - 1000 + i,
      });
    }
    seedWedding(db, "wed_b");
    seedPurchase(db, {
      id: "upg_s",
      weddingId: "wed_b",
      product: "gold",
      sessionId: "cs_s",
      price: GOLD_PRICE,
    });
    const stripe = stubStripe();
    stripe.refund = { status: 400, code: "balance_insufficient" };
    stripe.probe = {
      status: "complete",
      payment: {
        paid: true,
        amountMinor: 4900,
        currency: "aud",
        paymentIntentId: "pi_s",
        refunded: false,
      },
    };
    const clock = { t: BASE_MS + DAY + 5000 };
    const svc = makeService(stripe.client, clock);

    await captureLogs(() => run(db, svc.reconcile()));
    expect(stripe.probed).toEqual([]);
    clock.t += DAY;
    await captureLogs(() => run(db, svc.reconcile()));
    expect(stripe.probed).toEqual(["cs_s"]);
    expect(purchases(db).find((r) => r.id === "upg_s")?.status).toBe("succeeded");
  });

  /**
   * The email transport sets no timeout, so a send that never answers is cut
   * off at {@link NOTICE_TIMEOUT}: the daily run, or the webhook's
   * `waitUntil`, finishes with the refund recorded and the owners not marked
   * as told.
   */
  it("gives up on a notice that never answers, keeping the refund", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    const svc = createUpgradeService({
      stripe: stripe.client,
      catalogue: createUpgradeCatalogue({ stripe: stripe.client, prices: PRICES }),
      now: () => BASE_MS + DAY,
      notifyRefund: () => Effect.never,
    });
    const settled = await run(
      db,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(svc.reconcile());
        // Real time, so the run reaches the hung notice before the clock moves.
        yield* TestClock.withLive(Effect.sleep("20 millis"));
        yield* TestClock.adjust(NOTICE_TIMEOUT);
        return yield* TestClock.withLive(Fiber.join(fiber).pipe(Effect.timeoutOption("1 second")));
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(Option.isSome(settled)).toBe(true);
    const record = refundRecords(db)[0];
    expect(record?.status).toBe("auto_refunded");
    expect(record?.owners_notified_at).toBeNull();
  });

  /**
   * `owners_notified_at` says the owners were mailed, so it is written only
   * once a notice went out: a notice that sent nothing leaves it empty.
   */
  it("records the owners as told only when the notice went out", async () => {
    for (const sent of [true, false]) {
      const db = createDb();
      seedWedding(db);
      seedPurchase(db, {
        id: "upg_r",
        product: "gold",
        status: "refunding",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
      });
      const stripe = stubStripe();
      const svc = createUpgradeService({
        stripe: stripe.client,
        catalogue: createUpgradeCatalogue({ stripe: stripe.client, prices: PRICES }),
        now: () => BASE_MS + DAY,
        notifyRefund: () => Effect.succeed(sent),
      });
      await run(db, svc.reconcile());
      const record = refundRecords(db)[0];
      expect(record?.status, String(sent)).toBe("auto_refunded");
      expect(record?.owners_notified_at === null, String(sent)).toBe(!sent);
    }
  });

  /**
   * An operator marked the record refunded by hand but not the purchase row,
   * and a late acceptance then arrives: the row follows the record, so it is
   * not moved into a state the record does not hold.
   */
  it("moves a purchase row only into the state its record holds", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, {
      id: "upg_r",
      product: "gold",
      status: "refunding",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const stripe = stubStripe();
    // While Stripe takes the refund, a person marks the record refunded and
    // the row handed over, by hand and out of step.
    stripe.onRefund = () => {
      db.$client.exec(
        "UPDATE platform_refunds SET status = 'refunded' WHERE purchase_id = 'upg_r';" +
          " UPDATE wedding_upgrade_purchases SET status = 'refund_failed' WHERE id = 'upg_r';",
      );
    };
    const svc = makeService(stripe.client, { t: BASE_MS + DAY });

    await run(db, svc.reconcile());
    expect(purchases(db)[0]).toMatchObject({ status: "refund_failed", refund_id: null });
    expect(refundRecords(db)[0]?.status).toBe("refunded");
    expect(notices).toEqual([]);
  });

  it("leaves a row whose session it could not ask about, and moves it to the back", async () => {
    const db = createDb();
    seedWedding(db);
    seedPurchase(db, { id: "upg_s", product: "gold", sessionId: "cs_1", price: GOLD_PRICE });
    const stripe = stubStripe();
    stripe.probe = "error";
    const svc = makeService(stripe.client, { t: BASE_MS + DAY + 5000 });

    const logs = await captureLogs(async () => {
      expect(await run(db, svc.reconcile())).toEqual({ read: 1, failed: 1 });
    });
    expect(logs).toContain("upgrade session probe failed");
    expect(purchases(db)[0]).toMatchObject({
      status: "pending",
      updated_at: secondsAt(BASE_MS + DAY + 5000),
    });
  });
});

describe("failPurchase", () => {
  it("closes a pending row and ignores anything else", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });
    const started = await run(db, svc.startPurchase(START));

    const name = CIRE_METRICS.upgradePurchaseSettled;
    const before = await counterValue(name, { tier: "gold", outcome: "expired" });
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
    expect(await counterValue(name, { tier: "gold", outcome: "expired" })).toBe(before + 1);

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
