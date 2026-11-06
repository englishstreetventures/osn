import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingUpgradePurchases } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { StripeError, type StripeClient } from "../../src/services/stripe";
import { jsonBody } from "../test-helpers";

/**
 * The endpoint that actually grants.
 *
 * What is load-bearing here:
 *   - it verifies against ITS OWN secret. The Connect endpoint's secret must
 *     not open this one — that is the whole reason there are two endpoints
 *     rather than one route with a second branch;
 *   - an event carrying `event.account` grants nothing, however well signed:
 *     a connected account naming itself must never move a wedding's tier;
 *   - Stripe redelivers, so a duplicate is the ordinary case;
 *   - it carries no Origin, so the CSRF guard must let it through — the
 *     failure that makes every other assertion here vacuous.
 */

const PLATFORM_SECRET = "whsec_platform";
const CONNECT_SECRET = "whsec_connect";
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Refunds the app asked Stripe for, and what the next one answers. */
interface RefundLog {
  calls: { paymentIntentId: string; idempotencyKey: string }[];
  refuse: string | null;
}

function stripeStub(refunds: RefundLog): StripeClient {
  return {
    retrievePrice: () => Effect.succeed({ unitAmountMinor: 4900, currency: "AUD" }),
    createPlatformCheckoutSession: () =>
      Effect.succeed({ id: "cs_1", url: "https://pay.test/cs_1" }),
    retrievePlatformCheckoutSession: () => Effect.succeed({ status: "expired" as const }),
    expirePlatformCheckoutSession: () => Effect.void,
    createPlatformRefund: (input: { paymentIntentId: string; idempotencyKey: string }) => {
      refunds.calls.push({
        paymentIntentId: input.paymentIntentId,
        idempotencyKey: input.idempotencyKey,
      });
      return refunds.refuse === null
        ? Effect.succeed({ id: `re_${refunds.calls.length}` })
        : Effect.fail(new StripeError({ reason: "rejected", status: 400, code: refunds.refuse }));
    },
  } as unknown as StripeClient;
}

function buildApp({ platformSecret = PLATFORM_SECRET as string | null } = {}) {
  const refunds: RefundLog = { calls: [], refuse: null };
  const db = createDb(":memory:");
  seedDb(db);
  const app = createApp(db, {
    // A configured allowlist, so the origin guard is ACTIVE. Without this the
    // guard is skipped entirely and the exemption these deliveries rely on is
    // never exercised.
    webOrigin: "http://localhost:4321",
    allowedOrigins: ["http://localhost:4321"],
    organiserOrigin: "https://host.test",
    stripe: stripeStub(refunds),
    stripePlatformWebhookSecret: platformSecret,
    stripeWebhookSecret: CONNECT_SECRET,
    upgradePrices: { crimson: "price_c" },
    upgradeLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, db, refunds };
}
type App = ReturnType<typeof buildApp>["app"];

/**
 * A pending purchase, as `startPurchase` would have left one. A tier purchase
 * records the Price it opened at; a legacy per-module product predates that.
 */
function seedPurchase(
  db: ReturnType<typeof createDb>,
  product: (typeof weddingUpgradePurchases.$inferInsert)["entitlement"] = "crimson",
  id = "upg_1",
) {
  const now = new Date();
  const tierProduct = product === "gold" || product === "crimson";
  db.insert(weddingUpgradePurchases)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      entitlement: product,
      fromTier: "ivory",
      status: "pending",
      checkoutSessionId: "cs_1",
      priceId: tierProduct ? "price_c" : null,
      priceAmountMinor: tierProduct ? 4900 : null,
      priceCurrency: tierProduct ? "AUD" : null,
      createdByOsnProfileId: "usr_dev_bootstrap_owner",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/** No `Origin` header, the way Stripe actually sends it. */
async function deliver(
  app: App,
  body: Record<string, unknown>,
  { secret = PLATFORM_SECRET, path = "/api/stripe/platform-webhook" } = {},
): Promise<Response> {
  const text = JSON.stringify(body);
  const at = nowSeconds();
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${at},v1=${await hmacHex(secret, `${at}.${text}`)}`,
      },
      body: text,
    }),
  );
}

const completed = (extra: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  created: nowSeconds(),
  data: {
    object: {
      id: "cs_1",
      client_reference_id: "upg_1",
      payment_status: "paid",
      amount_total: 4900,
      currency: "aud",
      payment_intent: "pi_1",
    },
  },
  ...extra,
});

const tierOf = (db: ReturnType<typeof createDb>) =>
  db.$client
    .query("SELECT tier, tier_source, tier_granted_by FROM weddings WHERE id = ?")
    .get(BOOTSTRAP_WEDDING_ID);
const IVORY = { tier: "ivory", tier_source: null, tier_granted_by: null };

describe("granting from a verified delivery", () => {
  it("moves the wedding to the tier bought and records the sale", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, completed());
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "granted" });
    expect(tierOf(db)).toEqual({
      tier: "crimson",
      tier_source: "purchase",
      tier_granted_by: "stripe:upg_1",
    });
    expect(db.$client.query("SELECT COUNT(*) AS n FROM platform_sales").get()).toEqual({ n: 1 });
  });

  it("settles a legacy per-module purchase into the tier that replaced it", async () => {
    const { app, db } = buildApp();
    seedPurchase(db, "registry");

    const res = await deliver(app, completed());
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "granted" });
    expect(tierOf(db)).toMatchObject({ tier: "gold" });
  });

  /**
   * Money taken for a product that names no tier is given back, rather than
   * answered 500 until Stripe stops asking.
   */
  it("refunds a payment whose purchase names no tier", async () => {
    const { app, db, refunds } = buildApp();
    seedPurchase(db, "ai");

    const res = await deliver(app, completed());
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "auto_refunded" });
    expect(refunds.calls).toEqual([
      { paymentIntentId: "pi_1", idempotencyKey: "cire-upgrade-refund-upg_1" },
    ]);
    expect(tierOf(db)).toEqual(IVORY);
    expect(db.$client.query("SELECT COUNT(*) AS n FROM platform_sales").get()).toEqual({ n: 0 });
  });

  /**
   * Checkout can charge something other than the Price — tax, a discount, a
   * converted currency. The session is the purchase's own, so the payment
   * bought the purchase's tier.
   */
  it("grants a payment of another amount than the Price, from the purchase's own session", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);
    const event = completed();
    Object.assign(event.data.object as Record<string, unknown>, {
      amount_total: 5390,
      currency: "usd",
    });

    const res = await deliver(app, event);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "granted" });
    expect(tierOf(db)).toMatchObject({ tier: "crimson", tier_granted_by: "stripe:upg_1" });
    expect(db.$client.query("SELECT amount_minor, currency FROM platform_sales").get()).toEqual({
      amount_minor: 5390,
      currency: "USD",
    });
  });

  it("is idempotent across redeliveries", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);

    await deliver(app, completed());
    const second = await deliver(app, completed());
    expect(await jsonBody(second)).toEqual({ received: true, outcome: "replayed" });
    expect(db.$client.query("SELECT COUNT(*) AS n FROM platform_sales").get()).toEqual({ n: 1 });
  });

  it("closes a pending purchase when the session expires", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, {
      ...completed(),
      type: "checkout.session.expired",
    });
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "closed" });
    expect(tierOf(db)).toEqual(IVORY);
    expect(
      db.$client.query("SELECT status FROM wedding_upgrade_purchases WHERE id = 'upg_1'").get(),
    ).toEqual({ status: "expired" });
  });
});

describe("what must never grant", () => {
  /**
   * THE REASON THERE ARE TWO ENDPOINTS. If one secret opened both, the split
   * would be decoration — and a branch on `event.account` alone is not a
   * security boundary, because the account field is inside the body.
   */
  it("refuses a delivery signed with the CONNECT endpoint's secret", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, completed(), { secret: CONNECT_SECRET });
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "invalid_signature", reason: "no-match" });
    expect(tierOf(db)).toEqual(IVORY);
  });

  it("grants nothing for an event carrying a connected account", async () => {
    // Belt and braces behind the separate secret: an account naming itself
    // must not be able to move a wedding's tier.
    const { app, db } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, completed({ account: "acct_someone" }));
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "not_platform" });
    expect(tierOf(db)).toEqual(IVORY);
  });

  it("grants nothing for a session that names no purchase of ours", async () => {
    // This endpoint belongs to the platform account, which does whatever else
    // it does. An unfamiliar session is ordinary, not an error.
    const { app, db, refunds } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, {
      id: "evt_x",
      type: "checkout.session.completed",
      created: nowSeconds(),
      data: { object: { id: "cs_other", payment_status: "paid" } },
    });
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "unknown" });
    expect(tierOf(db)).toEqual(IVORY);
    expect(refunds.calls).toEqual([]);
  });

  /**
   * The purchase id rides in `client_reference_id`, which any payment on this
   * Stripe account can carry — a Payment Link lets the payer set it. A paid
   * session that names a purchase of ours but is not the session the purchase
   * holds did not come from cire's checkout: nothing granted, nothing refunded.
   */
  it("grants and refunds nothing for a paid session naming our purchase that is not its own", async () => {
    const { app, db, refunds } = buildApp();
    seedPurchase(db);
    const event = completed();
    Object.assign(event.data.object as Record<string, unknown>, {
      id: "cs_payment_link",
      payment_intent: "pi_foreign",
    });

    const res = await deliver(app, event);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "unknown" });
    expect(tierOf(db)).toEqual(IVORY);
    expect(refunds.calls).toEqual([]);
    expect(db.$client.query("SELECT COUNT(*) AS n FROM platform_sales").get()).toEqual({ n: 0 });
  });

  it("answers 200 and grants nothing for a purchase an operator refunded", async () => {
    // A resend from the Stripe dashboard, or a retry after a 500, of a payment
    // that was later refunded and the wedding lowered.
    const { app, db } = buildApp();
    seedPurchase(db);
    await deliver(app, completed());
    db.$client.exec(
      "UPDATE wedding_upgrade_purchases SET status = 'refunded' WHERE id = 'upg_1';" +
        " UPDATE weddings SET tier = 'ivory', tier_source = 'comp', tier_granted_by = 'script:ops'" +
        ` WHERE id = '${BOOTSTRAP_WEDDING_ID}';`,
    );

    const res = await deliver(app, completed());
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "refunded" });
    expect(tierOf(db)).toEqual({
      tier: "ivory",
      tier_source: "comp",
      tier_granted_by: "script:ops",
    });
  });

  it("grants nothing on an unsigned delivery", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);
    const res = await app.fetch(
      new Request("http://localhost/api/stripe/platform-webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(completed()),
      }),
    );
    expect(res.status).toBe(400);
    expect(tierOf(db)).toEqual(IVORY);
  });

  it("refuses a body past the size bound", async () => {
    const { app } = buildApp();
    const fat = "x".repeat(70 * 1024);
    const res = await app.fetch(
      new Request("http://localhost/api/stripe/platform-webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
        body: JSON.stringify({ fat }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("mounting", () => {
  it("does not exist without a signing secret", async () => {
    // Nothing could be verified, and an endpoint that writes rows from
    // unverified bodies is an unauthenticated write API.
    const { app } = buildApp({ platformSecret: null });
    const res = await deliver(app, completed());
    expect(res.status).toBe(404);
  });

  it("does not exist on a secret of nothing but whitespace, which anyone could sign with", async () => {
    const blank = "   ";
    const { app, db } = buildApp({ platformSecret: blank });
    seedPurchase(db);
    const res = await deliver(app, completed(), { secret: blank });
    expect(res.status).toBe(404);
    expect(tierOf(db)).toEqual(IVORY);
  });

  it("leaves the Connect endpoint alone", async () => {
    // A platform-shaped session arriving at the Connect endpoint still falls
    // through as unknown — that route's behaviour is unchanged.
    const { app, db } = buildApp();
    seedPurchase(db);
    const res = await deliver(app, completed(), {
      secret: CONNECT_SECRET,
      path: "/api/stripe/webhook",
    });
    expect(res.status).toBe(200);
    expect(tierOf(db)).toEqual(IVORY);
  });
});

describe("a payment for a wedding deleted while its checkout was open", () => {
  const deleteWedding = (db: ReturnType<typeof createDb>) =>
    db.$client
      .query("UPDATE weddings SET deleted_at = unixepoch() WHERE id = ?")
      .run(BOOTSTRAP_WEDDING_ID);
  const purchaseRow = (db: ReturnType<typeof createDb>) =>
    db.$client
      .query("SELECT status, refund_id FROM wedding_upgrade_purchases WHERE id = 'upg_1'")
      .get();

  it("is refunded through Stripe, and grants and records no sale", async () => {
    const { app, db, refunds } = buildApp();
    seedPurchase(db);
    deleteWedding(db);

    const res = await deliver(app, completed());

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "auto_refunded" });
    expect(refunds.calls).toEqual([
      { paymentIntentId: "pi_1", idempotencyKey: "cire-upgrade-refund-upg_1" },
    ]);
    expect(purchaseRow(db)).toEqual({ status: "auto_refunded", refund_id: "re_1" });
    expect(tierOf(db)).toEqual(IVORY);
    expect(db.$client.query("SELECT COUNT(*) AS n FROM platform_sales").get()).toEqual({ n: 0 });
  });

  /**
   * A refund Stripe refuses is acknowledged: the purchase reads `refunding`,
   * so nothing can grant it, and the daily reconciliation asks Stripe again.
   * A 500 would only replay Stripe's saved refusal and count against the
   * endpoint until Stripe disabled it.
   */
  it("acknowledges a refund Stripe refuses, keeping the purchase refunding for the next attempt", async () => {
    const { app, db, refunds } = buildApp();
    seedPurchase(db);
    deleteWedding(db);
    refunds.refuse = "balance_insufficient";

    const res = await deliver(app, completed());
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "refund_failed" });
    expect(purchaseRow(db)).toEqual({ status: "refunding", refund_id: null });

    refunds.refuse = null;
    const again = await deliver(app, completed());
    expect(again.status).toBe(200);
    expect(await jsonBody(again)).toEqual({ received: true, outcome: "auto_refunded" });
    expect(purchaseRow(db)).toEqual({ status: "auto_refunded", refund_id: "re_2" });
    expect(tierOf(db)).toEqual(IVORY);
  });
});

describe("a refund the bank returned", () => {
  const refundFailed = (refundId: string, purchaseId = "upg_1") => ({
    id: "evt_rf",
    type: "refund.failed",
    created: nowSeconds(),
    data: {
      object: {
        id: refundId,
        object: "refund",
        status: "failed",
        payment_intent: "pi_1",
        metadata: { purchaseId },
      },
    },
  });

  it("marks our refund failed, and leaves a refund that is not ours alone", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);
    db.$client
      .query("UPDATE weddings SET deleted_at = unixepoch() WHERE id = ?")
      .run(BOOTSTRAP_WEDDING_ID);
    await deliver(app, completed());

    const other = await deliver(app, refundFailed("re_someone_else"));
    expect(await jsonBody(other)).toEqual({ received: true, outcome: "ignored" });

    const res = await deliver(app, refundFailed("re_1"));
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "recorded" });
    expect(
      db.$client.query("SELECT status FROM wedding_upgrade_purchases WHERE id = 'upg_1'").get(),
    ).toEqual({ status: "refund_failed" });
  });

  it("acknowledges a failed refund that names no purchase", async () => {
    const { app } = buildApp();
    const event = refundFailed("re_x");
    (event.data.object as Record<string, unknown>).metadata = {};
    const res = await deliver(app, event);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "unknown" });
  });
});
