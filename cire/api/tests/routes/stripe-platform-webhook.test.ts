import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingUpgradePurchases } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import type { StripeClient } from "../../src/services/stripe";
import { jsonBody } from "../test-helpers";

/**
 * The endpoint that actually grants.
 *
 * What is load-bearing here:
 *   - it verifies against ITS OWN secret. The Connect endpoint's secret must
 *     not open this one — that is the whole reason there are two endpoints
 *     rather than one route with a second branch;
 *   - an event carrying `event.account` grants nothing, however well signed:
 *     a connected account naming itself must never move a platform entitlement;
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

function stripeStub(): StripeClient {
  return {
    retrievePrice: () => Effect.succeed({ unitAmountMinor: 4900, currency: "AUD" }),
    createPlatformCheckoutSession: () =>
      Effect.succeed({ id: "cs_1", url: "https://pay.test/cs_1" }),
    retrievePlatformCheckoutSession: () => Effect.succeed({ status: "expired" as const }),
  } as unknown as StripeClient;
}

function buildApp({ platformSecret = PLATFORM_SECRET as string | null } = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const app = createApp(db, {
    // A configured allowlist, so the origin guard is ACTIVE. Without this the
    // guard is skipped entirely and the exemption these deliveries rely on is
    // never exercised.
    webOrigin: "http://localhost:4321",
    allowedOrigins: ["http://localhost:4321"],
    organiserOrigin: "https://host.test",
    stripe: stripeStub(),
    stripePlatformWebhookSecret: platformSecret,
    stripeWebhookSecret: CONNECT_SECRET,
    upgradePrices: { vendors: "price_v" },
    upgradeLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, db };
}
type App = ReturnType<typeof buildApp>["app"];

/** A pending purchase, as `startPurchase` would have left one. */
function seedPurchase(db: ReturnType<typeof createDb>, id = "upg_1") {
  const now = new Date();
  db.insert(weddingUpgradePurchases)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      entitlement: "vendors",
      status: "pending",
      checkoutSessionId: "cs_1",
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

const entitlements = (db: ReturnType<typeof createDb>) =>
  db.$client.query("SELECT entitlement, source, granted_by FROM wedding_entitlements").all();

describe("granting from a verified delivery", () => {
  it("grants the entitlement and records the sale", async () => {
    const { app, db } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, completed());
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "granted" });
    expect(entitlements(db)).toEqual([
      { entitlement: "vendors", source: "purchase", granted_by: "usr_dev_bootstrap_owner" },
    ]);
    expect(db.$client.query("SELECT COUNT(*) AS n FROM platform_sales").get()).toEqual({ n: 1 });
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
    expect(entitlements(db)).toEqual([]);
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
    expect(entitlements(db)).toEqual([]);
  });

  it("grants nothing for an event carrying a connected account", async () => {
    // Belt and braces behind the separate secret: an account naming itself
    // must not be able to move a platform entitlement.
    const { app, db } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, completed({ account: "acct_someone" }));
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "not_platform" });
    expect(entitlements(db)).toEqual([]);
  });

  it("grants nothing for a session that names no purchase of ours", async () => {
    // This endpoint belongs to the platform account, which does whatever else
    // it does. An unfamiliar session is ordinary, not an error.
    const { app, db } = buildApp();
    seedPurchase(db);

    const res = await deliver(app, {
      id: "evt_x",
      type: "checkout.session.completed",
      created: nowSeconds(),
      data: { object: { id: "cs_other", payment_status: "paid" } },
    });
    expect(await jsonBody(res)).toEqual({ received: true, outcome: "unknown" });
    expect(entitlements(db)).toEqual([]);
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
    expect(entitlements(db)).toEqual([]);
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
    expect(entitlements(db)).toEqual([]);
  });
});
