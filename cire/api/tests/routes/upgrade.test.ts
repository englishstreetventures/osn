import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingEntitlements, weddingHosts } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { StripeError, type StripeClient } from "../../src/services/stripe";
import { appRequest, jsonBody } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

/**
 * Buying a locked module.
 *
 * What is load-bearing here:
 *   - the session route is OWNER-only. It names a card, so an editor must not
 *     reach it — the same line the Connect route draws;
 *   - a key this surface does not sell is a 404, never a checkout;
 *   - with no Stripe configured the routes do not exist at all, so a keyless
 *     deployment has no purchase surface rather than a broken one;
 *   - nothing here grants anything. A 200 means a payment page exists.
 */

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function stripeStub(opts: { failCreate?: boolean } = {}) {
  const created: string[] = [];
  let minted = 0;
  const client = {
    retrievePrice: () => Effect.succeed({ unitAmountMinor: 4900, currency: "AUD" }),
    createPlatformCheckoutSession(input: { clientReferenceId: string }) {
      if (opts.failCreate) return Effect.fail(new StripeError({ reason: "unreachable" }));
      minted += 1;
      created.push(input.clientReferenceId);
      return Effect.succeed({ id: `cs_${minted}`, url: `https://pay.test/cs_${minted}` });
    },
    retrievePlatformCheckoutSession: () => Effect.succeed({ status: "expired" as const }),
  } as unknown as StripeClient;
  return { client, created };
}

function buildApp({
  stripe,
  prices = { vendors: "price_v", registry: "price_r" },
  grantVendors = false,
}: {
  stripe?: StripeClient | null;
  prices?: Record<string, string>;
  grantVendors?: boolean;
} = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_editor",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: now,
    })
    .run();
  if (grantVendors) {
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
        providerRef: null,
      })
      .onConflictDoNothing()
      .run();
  }
  const app = createApp(db, {
    osnTestKey: auth.key,
    organiserOrigin: "https://host.test",
    stripe: stripe === undefined ? stripeStub().client : stripe,
    upgradePrices: prices,
    // A fresh limiter per app: the module-level default is shared
    // process-wide, so the eleventh call in this file would otherwise 429
    // whichever test ran last.
    upgradeLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, db };
}
type App = ReturnType<typeof buildApp>["app"];

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/upgrade`;

async function get(app: App, path: string, profileId?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "GET", headers });
}

async function startSession(
  app: App,
  profileId: string | undefined,
  entitlement: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, `${base}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ entitlement }),
  });
}

describe("who may start a purchase", () => {
  it("lets the owner", async () => {
    const { app } = buildApp();
    const res = await startSession(app, OWNER, "vendors");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toMatchObject({ url: "https://pay.test/cs_1", reused: false });
  });

  it("refuses an editor: naming a card is not ordinary help", async () => {
    const { app } = buildApp();
    expect((await startSession(app, EDITOR, "vendors")).status).toBe(403);
  });

  it("refuses a stranger and an unauthenticated caller", async () => {
    const { app } = buildApp();
    expect((await startSession(app, STRANGER, "vendors")).status).toBe(403);
    expect((await startSession(app, undefined, "vendors")).status).toBe(401);
  });

  it("lets an editor READ the catalogue", async () => {
    // Seeing what a module costs is not buying it.
    const { app } = buildApp();
    const res = await get(app, `${base}/catalogue`, EDITOR);
    expect(res.status).toBe(200);
  });
});

describe("what may be bought", () => {
  it("404s a key this surface does not sell", async () => {
    // `capacity_500` is a real entitlement, deliberately not self-serve. From
    // here that is indistinguishable from one that does not exist.
    const { app } = buildApp();
    const res = await startSession(app, OWNER, "capacity_500");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "not_purchasable" });
  });

  it("404s a key with no configured Price rather than selling it for nothing", async () => {
    const { app } = buildApp({ prices: { vendors: "price_v" } });
    const res = await startSession(app, OWNER, "registry");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "not_purchasable" });
  });

  it("404s a non-string entitlement rather than trusting the body", async () => {
    const { app } = buildApp();
    expect((await startSession(app, OWNER, { toString: "vendors" })).status).toBe(404);
    expect((await startSession(app, OWNER, null)).status).toBe(404);
  });

  it("409s a key the wedding already holds", async () => {
    const { app } = buildApp({ grantVendors: true });
    const res = await startSession(app, OWNER, "vendors");
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "already_held" });
  });
});

describe("the catalogue", () => {
  it("prices what is for sale and says what the wedding already has", async () => {
    const { app } = buildApp({ grantVendors: true });
    const res = await get(app, `${base}/catalogue`, OWNER);
    const body = (await jsonBody(res)) as { upgrades: { entitlement: string; held: boolean }[] };
    expect(body.upgrades).toMatchObject([
      { entitlement: "vendors", amountMinor: 4900, currency: "AUD", held: true },
      { entitlement: "registry", amountMinor: 4900, currency: "AUD", held: false },
    ]);
  });

  it("omits a key with no configured Price", async () => {
    const { app } = buildApp({ prices: { vendors: "price_v" } });
    const res = await get(app, `${base}/catalogue`, OWNER);
    const body = (await jsonBody(res)) as { upgrades: { entitlement: string }[] };
    expect(body.upgrades.map((u) => u.entitlement)).toEqual(["vendors"]);
  });
});

describe("polling a purchase", () => {
  it("reports its status to a member", async () => {
    const { app } = buildApp();
    const started = (await jsonBody(await startSession(app, OWNER, "vendors"))) as {
      purchaseId: string;
    };
    const res = await get(app, `${base}/purchases/${started.purchaseId}`, EDITOR);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      purchase: { status: "pending", entitlement: "vendors" },
    });
  });

  it("404s a purchase id that is not this wedding's", async () => {
    const { app } = buildApp();
    expect((await get(app, `${base}/purchases/upg_nope`, OWNER)).status).toBe(404);
  });
});

describe("when Stripe is not configured", () => {
  /**
   * The key-optional half, and the reason it is a route-level test rather than
   * a service one: a deployment with no Stripe key must have NO purchase
   * surface at all. A 500 here would mean the surface exists and is broken,
   * which is what an unmounted route exists to avoid.
   */
  it("has no upgrade routes at all", async () => {
    const { app } = buildApp({ stripe: null });
    expect((await get(app, `${base}/catalogue`, OWNER)).status).toBe(404);
    expect((await startSession(app, OWNER, "vendors")).status).toBe(404);
  });
});

describe("when Stripe refuses", () => {
  it("502s rather than reporting a broken account", async () => {
    // Not this API's fault and not the organiser's, so the portal can offer
    // the button again.
    const { app } = buildApp({ stripe: stripeStub({ failCreate: true }).client });
    const res = await startSession(app, OWNER, "vendors");
    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toEqual({ error: "payment_provider_unavailable" });
  });
});
