import { describe, it, expect } from "bun:test";

import { Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { entitlementService } from "../../src/services/entitlements";
import type { PlatformSessionState, StripeClient } from "../../src/services/stripe";
import { StripeError } from "../../src/services/stripe";
import { createUpgradeCatalogue } from "../../src/services/upgrade-catalogue";
import {
  createUpgradeService,
  STALE_PENDING_MS,
  upgradeConflictReason,
} from "../../src/services/upgrades";

/**
 * Two failures are being defended against, and both are invisible to a
 * happy-path test: charging twice for one entitlement, and taking money while
 * granting nothing. Nearly every case below is one crash point or one race.
 */

type Db = ReturnType<typeof createDb>;

const run = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)) as Effect.Effect<A, E, never>);

const runExit = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(
    eff.pipe(Effect.provideService(DbService, db)) as Effect.Effect<A, E, never>,
  );

/**
 * Timestamp columns are drizzle `mode: "timestamp"`, which is epoch SECONDS —
 * while the injected clock, like `Date.now()`, is milliseconds. Every raw SQL
 * insert below goes through this so the two cannot be mixed up silently; the
 * staleness window is measured in the difference, so a 1000x error there reads
 * as "not stale" forever.
 */
const BASE_MS = 1_700_000_000_000;
const secondsAt = (ms: number) => Math.floor(ms / 1000);

function seedWedding(db: Db, id = "wed_test") {
  const t = Date.now();
  db.$client.exec(
    `INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, code_style, currency, created_at, updated_at)
     VALUES ('${id}', '${id}-slug', 'Test', 'usr_owner', 'secure', 'AUD', ${t}, ${t});`,
  );
  return id;
}

/** Rows as the database actually holds them, for assertions about state. */
const purchases = (db: Db) =>
  db.$client.query("SELECT * FROM wedding_upgrade_purchases ORDER BY created_at").all() as {
    id: string;
    status: string;
    checkout_session_id: string | null;
    entitlement: string;
  }[];

const sales = (db: Db) =>
  db.$client.query("SELECT * FROM platform_sales").all() as {
    purchase_id: string;
    amount_minor: number;
    currency: string;
  }[];

interface StripeStub {
  client: StripeClient;
  created: string[];
  /** The success URLs Stripe was actually handed. */
  successUrls: string[];
  /** What the next probe answers. */
  probe: PlatformSessionState | "error";
  failCreate: boolean;
  /** Runs while Stripe is "thinking", to drive a concurrent-write race. */
  onCreate?: () => void;
}

function stubStripe(): StripeStub {
  const stub: StripeStub = {
    created: [],
    successUrls: [],
    probe: { status: "expired" },
    failCreate: false,
    client: undefined as unknown as StripeClient,
  };
  let minted = 0;
  stub.client = {
    retrievePrice: () => Effect.succeed({ unitAmountMinor: 4900, currency: "AUD" }),
    createPlatformCheckoutSession(input: { clientReferenceId: string; successUrl: string }) {
      if (stub.failCreate) return Effect.fail(new StripeError({ reason: "unreachable" }));
      stub.onCreate?.();
      minted += 1;
      stub.created.push(input.clientReferenceId);
      stub.successUrls.push(input.successUrl);
      const id = `cs_${minted}`;
      return Effect.succeed({ id, url: `https://pay.test/${id}` });
    },
    retrievePlatformCheckoutSession() {
      return stub.probe === "error"
        ? Effect.fail(new StripeError({ reason: "unreachable" }))
        : Effect.succeed(stub.probe);
    },
  } as unknown as StripeClient;
  return stub;
}

function makeService(stripe: StripeClient, clock: { t: number }) {
  let n = 0;
  return createUpgradeService({
    stripe,
    catalogue: createUpgradeCatalogue({ stripe, prices: { vendors: "price_v" } }),
    now: () => clock.t,
    newId: (prefix) => `${prefix}_${++n}`,
  });
}

const START = {
  weddingId: "wed_test",
  entitlement: "vendors" as const,
  actorProfileId: "usr_owner",
  successUrlFor: (id: string) => `https://host.test/?upgrade=${id}&w=wed_test&m=vendors`,
  cancelUrl: "https://host.test/",
};

describe("upgradeConflictReason", () => {
  /**
   * DRIVEN THROUGH THE REAL INDEX, not a hand-written string.
   *
   * SQLite names the COLUMNS a conflict was on and never the index that
   * enforced it, so a classifier matching on the index name reads correctly and
   * can never fire. A literal-string test passes either way — which is how that
   * mismatch survives review. This one asks the driver.
   */
  it("classifies what the driver actually says on the one-pending index", () => {
    const db = createDb();
    seedWedding(db);
    const insert = (id: string) =>
      db.$client.exec(
        `INSERT INTO wedding_upgrade_purchases
           (id, wedding_id, entitlement, status, created_by_osn_profile_id, created_at, updated_at)
         VALUES ('${id}', 'wed_test', 'vendors', 'pending', 'usr_owner', 1, 1);`,
      );
    insert("upg_a");
    let message = "";
    try {
      insert("upg_b");
    } catch (e) {
      message = String(e);
    }

    expect(message).toContain("UNIQUE constraint failed");
    // The assertion that would have caught the original bug.
    expect(message).not.toContain("one_pending");
    expect(upgradeConflictReason(message)).toBe("processing");
  });

  it("classifies a session-id conflict the driver reports", () => {
    const db = createDb();
    seedWedding(db);
    db.$client.exec(
      `INSERT INTO wedding_upgrade_purchases
         (id, wedding_id, entitlement, status, checkout_session_id, created_by_osn_profile_id, created_at, updated_at)
       VALUES ('upg_a', 'wed_test', 'vendors', 'succeeded', 'cs_1', 'usr_owner', 1, 1);`,
    );
    let message = "";
    try {
      db.$client.exec(
        `INSERT INTO wedding_upgrade_purchases
           (id, wedding_id, entitlement, status, checkout_session_id, created_by_osn_profile_id, created_at, updated_at)
         VALUES ('upg_b', 'wed_test', 'registry', 'succeeded', 'cs_1', 'usr_owner', 1, 1);`,
      );
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
  });
});

describe("startPurchase", () => {
  it("refuses a key the wedding already holds", async () => {
    const db = createDb();
    seedWedding(db);
    await run(
      db,
      entitlementService.grant("wed_test", "vendors", { source: "comp", grantedBy: "op" }),
    );
    const svc = makeService(stubStripe().client, { t: BASE_MS });

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(purchases(db)).toEqual([]);
  });

  it("refuses a key with no configured Price rather than selling it for nothing", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = createUpgradeService({
      stripe: stripe.client,
      catalogue: createUpgradeCatalogue({ stripe: stripe.client, prices: {} }),
    });

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(stripe.created).toEqual([]);
  });

  it("mints a session and stores its id", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    const res = await run(db, svc.startPurchase(START));
    expect(res.reused).toBe(false);
    expect(res.url).toBe("https://pay.test/cs_1");
    expect(purchases(db)).toMatchObject([{ status: "pending", checkout_session_id: "cs_1" }]);
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
      `https://host.test/?upgrade=${res.purchaseId}&w=wed_test&m=vendors`,
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
    expect(purchases(db)).toHaveLength(1);
  });

  /**
   * THE DOUBLE-CHARGE GUARD.
   *
   * The organiser paid, the webhook has not landed yet (seconds normally, days
   * if a 500 put Stripe into retry), they see nothing unlocked and press again.
   * A probe that collapsed `complete` into "no session" would close a row that
   * was PAID and sell the same entitlement a second time.
   */
  it("refuses to mint a second session while a paid one is unsettled", async () => {
    const db = createDb();
    seedWedding(db);
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });

    const first = await run(db, svc.startPurchase(START));
    stripe.probe = { status: "complete" };

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
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

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
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
    const rows = purchases(db);
    expect(rows.map((r) => r.status)).toEqual(["expired", "pending"]);
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
    db.$client.exec(
      `INSERT INTO wedding_upgrade_purchases
         (id, wedding_id, entitlement, status, created_by_osn_profile_id, created_at, updated_at)
       VALUES ('upg_inflight', 'wed_test', 'vendors', 'pending', 'usr_owner', ${secondsAt(BASE_MS)}, ${secondsAt(BASE_MS)});`,
    );
    clock.t = BASE_MS + STALE_PENDING_MS - 1;

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(stripe.created).toEqual([]);
    expect(purchases(db)).toMatchObject([{ id: "upg_inflight", status: "pending" }]);
  });

  it("closes a session-less row once it is genuinely stale", async () => {
    const db = createDb();
    seedWedding(db);
    const clock = { t: BASE_MS };
    const stripe = stubStripe();
    const svc = makeService(stripe.client, clock);

    db.$client.exec(
      `INSERT INTO wedding_upgrade_purchases
         (id, wedding_id, entitlement, status, created_by_osn_profile_id, created_at, updated_at)
       VALUES ('upg_dead', 'wed_test', 'vendors', 'pending', 'usr_owner', ${secondsAt(BASE_MS)}, ${secondsAt(BASE_MS)});`,
    );
    clock.t = BASE_MS + STALE_PENDING_MS + 1;

    const res = await run(db, svc.startPurchase(START));
    expect(res.reused).toBe(false);
    const rows = purchases(db);
    expect(rows.find((r) => r.id === "upg_dead")?.status).toBe("failed");
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

    const exit = await runExit(db, svc.startPurchase(START));
    expect(Exit.isFailure(exit)).toBe(true);
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

describe("settlePurchase", () => {
  async function paidPurchase(db: Db, stripe: StripeStub) {
    const svc = makeService(stripe.client, { t: BASE_MS });
    const started = await run(db, svc.startPurchase(START));
    return { svc, purchaseId: started.purchaseId };
  }

  const SETTLE = {
    checkoutSessionId: "cs_1",
    paid: true,
    paidAmountMinor: 4900,
    paidCurrency: "aud",
    paymentIntentId: "pi_1",
  };

  it("grants the entitlement, records the sale and marks the row succeeded", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("granted");
    expect(await run(db, entitlementService.has("wed_test", "vendors"))).toBe(true);
    expect(purchases(db)[0]?.status).toBe("succeeded");
    expect(sales(db)).toMatchObject([
      { purchase_id: purchaseId, amount_minor: 4900, currency: "AUD" },
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
  });

  /**
   * THE CRASH POINT. The settle is four round trips with no transaction, so the
   * question is what a delivery that dies partway leaves behind. Grant-then-flip
   * means a retry finishes the job; flip-then-grant would leave a row reading
   * `succeeded` with no entitlement and a retry that matches nothing.
   */
  it("heals on redelivery when the flip never happened", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    // Simulate the grant + sale having landed while the flip did not.
    await run(
      db,
      entitlementService.grant("wed_test", "vendors", {
        source: "purchase",
        grantedBy: "usr_owner",
        providerRef: "cs_1",
      }),
    );
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
   * a row reading `succeeded` with no entitlement — a customer who paid and is
   * locked out. Nothing here may short-circuit on "the row is already
   * succeeded", because that is exactly the state such a crash leaves behind.
   * Settling again has to repair it.
   *
   * This is what makes grant-before-flip safe to rely on, and it is the test
   * that fails if someone later adds an early return on a replayed delivery.
   */
  it("repairs a missing entitlement even when the row already reads succeeded", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    db.$client.exec(
      `UPDATE wedding_upgrade_purchases SET status = 'succeeded' WHERE id = '${purchaseId}';`,
    );
    expect(await run(db, entitlementService.has("wed_test", "vendors"))).toBe(false);

    expect(await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }))).toBe("replayed");
    expect(await run(db, entitlementService.has("wed_test", "vendors"))).toBe(true);
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
    const stripe = stubStripe();
    const svc = makeService(stripe.client, { t: BASE_MS });
    db.$client.exec(
      `INSERT INTO wedding_upgrade_purchases
         (id, wedding_id, entitlement, status, created_by_osn_profile_id, created_at, updated_at)
       VALUES ('upg_orphan', 'wed_test', 'vendors', 'pending', 'usr_owner', ${secondsAt(BASE_MS)}, ${secondsAt(BASE_MS)});`,
    );

    expect(await run(db, svc.settlePurchase({ purchaseId: "upg_orphan", ...SETTLE }))).toBe(
      "granted",
    );
    expect(await run(db, entitlementService.has("wed_test", "vendors"))).toBe(true);
    expect(purchases(db)[0]?.checkout_session_id).toBe("cs_1");
  });

  it("refuses a session id that belongs to a different purchase", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());

    expect(
      await run(db, svc.settlePurchase({ purchaseId, ...SETTLE, checkoutSessionId: "cs_other" })),
    ).toBe("unknown");
    expect(await run(db, entitlementService.has("wed_test", "vendors"))).toBe(false);
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
    expect(await run(db, entitlementService.has("wed_test", "vendors"))).toBe(false);
    expect(purchases(db)[0]?.status).toBe("pending");
    expect(sales(db)).toEqual([]);
  });

  it("records the entitlement's grant against the buyer, not a machine", async () => {
    const db = createDb();
    seedWedding(db);
    const { svc, purchaseId } = await paidPurchase(db, stubStripe());
    await run(db, svc.settlePurchase({ purchaseId, ...SETTLE }));

    const row = db.$client
      .query("SELECT granted_by, source, provider_ref FROM wedding_entitlements")
      .get() as { granted_by: string; source: string; provider_ref: string };
    expect(row).toEqual({ granted_by: "usr_owner", source: "purchase", provider_ref: "cs_1" });
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
    expect(await run(db, entitlementService.has("wed_test", "vendors"))).toBe(true);
  });
});

describe("purchaseStatus", () => {
  it("is scoped to the wedding, so another wedding's id is simply not found", async () => {
    const db = createDb();
    seedWedding(db);
    seedWedding(db, "wed_other");
    const svc = makeService(stubStripe().client, { t: BASE_MS });
    const started = await run(db, svc.startPurchase(START));

    expect(await run(db, svc.purchaseStatus("wed_test", started.purchaseId))).toMatchObject({
      status: "pending",
      entitlement: "vendors",
    });
    expect(await run(db, svc.purchaseStatus("wed_other", started.purchaseId))).toBeNull();
  });
});
