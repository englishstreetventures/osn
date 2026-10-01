import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingHosts } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { StripeError, type StripeClient } from "../../src/services/stripe";
import type { Tier } from "../../src/services/tiers";
import { appRequest, jsonBody, setTier } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

/**
 * Buying a plan tier.
 *
 * What is load-bearing here:
 *   - the session route is OWNER-only. It names a card, so an editor must not
 *     reach it — the same line the Connect route draws;
 *   - a value this surface does not sell is a 404, never a checkout;
 *   - the catalogue offers only tiers above the wedding's own, priced for the
 *     move from where it is;
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

const AMOUNTS: Record<string, number> = { price_g: 4900, price_c: 9900, price_cg: 5000 };

function stripeStub(opts: { failCreate?: boolean } = {}) {
  const created: { purchaseId: string; priceId: string; successUrl: string; cancelUrl: string }[] =
    [];
  let minted = 0;
  const client = {
    retrievePrice: (priceId: string) =>
      Effect.succeed({ unitAmountMinor: AMOUNTS[priceId] ?? 0, currency: "AUD" }),
    createPlatformCheckoutSession(input: {
      clientReferenceId: string;
      priceId: string;
      successUrl: string;
      cancelUrl: string;
    }) {
      if (opts.failCreate) return Effect.fail(new StripeError({ reason: "unreachable" }));
      minted += 1;
      created.push({
        purchaseId: input.clientReferenceId,
        priceId: input.priceId,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      return Effect.succeed({ id: `cs_${minted}`, url: `https://pay.test/cs_${minted}` });
    },
    retrievePlatformCheckoutSession: () => Effect.succeed({ status: "expired" as const }),
    expirePlatformCheckoutSession: () => Effect.void,
  } as unknown as StripeClient;
  return { client, created };
}

const PRICES = { gold: "price_g", crimson: "price_c", crimsonFromGold: "price_cg" };

function buildApp({
  stripe,
  prices = PRICES,
  tier = "ivory",
}: {
  stripe?: StripeClient | null;
  prices?: Record<string, string>;
  tier?: Tier;
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
  setTier(db, BOOTSTRAP_WEDDING_ID, tier);
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
  body: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, `${base}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("who may start a purchase", () => {
  it("lets the owner", async () => {
    const { app } = buildApp();
    const res = await startSession(app, OWNER, { tier: "gold" });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toMatchObject({ url: "https://pay.test/cs_1", reused: false });
  });

  it("refuses an editor: naming a card is not ordinary help", async () => {
    const { app } = buildApp();
    expect((await startSession(app, EDITOR, { tier: "gold" })).status).toBe(403);
  });

  it("refuses a stranger and an unauthenticated caller", async () => {
    const { app } = buildApp();
    expect((await startSession(app, STRANGER, { tier: "gold" })).status).toBe(403);
    expect((await startSession(app, undefined, { tier: "gold" })).status).toBe(401);
  });

  it("lets an editor READ the catalogue", async () => {
    // Seeing what a tier costs is not buying it.
    const { app } = buildApp();
    const res = await get(app, `${base}/catalogue`, EDITOR);
    expect(res.status).toBe(200);
  });
});

describe("what may be bought", () => {
  it("404s anything that is not a paid tier", async () => {
    // The free tier, and the legacy per-module keys, are not for sale. From
    // here that is indistinguishable from a value that does not exist.
    const { app } = buildApp();
    for (const tier of ["ivory", "vendors", "registry", "capacity_500", "platinum"]) {
      const res = await startSession(app, OWNER, { tier });
      expect(res.status, tier).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "not_purchasable" });
    }
  });

  it("404s the legacy request shape, which names an entitlement and no tier", async () => {
    const { app } = buildApp();
    expect((await startSession(app, OWNER, { entitlement: "vendors" })).status).toBe(404);
  });

  it("404s a tier with no configured Price rather than selling it for nothing", async () => {
    const { app } = buildApp({ prices: { gold: "price_g" } });
    const res = await startSession(app, OWNER, { tier: "crimson" });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "not_purchasable" });
  });

  it("404s Crimson for a Gold wedding when the upgrade-from-Gold Price is unset", async () => {
    const { app } = buildApp({ tier: "gold", prices: { gold: "price_g", crimson: "price_c" } });
    expect((await startSession(app, OWNER, { tier: "crimson" })).status).toBe(404);
  });

  it("404s a non-string tier rather than trusting the body", async () => {
    const { app } = buildApp();
    expect((await startSession(app, OWNER, { tier: { toString: "gold" } })).status).toBe(404);
    expect((await startSession(app, OWNER, { tier: null })).status).toBe(404);
  });

  /**
   * The body is checked whole, at the boundary, before anything reaches the
   * service: a `module` that is not a short string is refused there, not
   * quietly replaced, so a field added later gets the same treatment.
   */
  it("404s a body whose module is not a short string, and opens no checkout", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    for (const module of [42, ["budget"], { name: "budget" }, "m".repeat(33)]) {
      const res = await startSession(app, OWNER, { tier: "gold", module });
      expect(res.status, JSON.stringify(module)).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "not_purchasable" });
    }
    expect(stripe.created).toEqual([]);
  });

  it("404s a body that is not JSON", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${base}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign(OWNER)}`,
      },
      body: "{tier: gold",
    });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "not_purchasable" });
  });

  it("409s a tier the wedding already holds, or one below it", async () => {
    for (const [held, buying] of [
      ["gold", "gold"],
      ["crimson", "gold"],
      ["crimson", "crimson"],
    ] as const) {
      const { app } = buildApp({ tier: held });
      const res = await startSession(app, OWNER, { tier: buying });
      expect(res.status, `${held} buying ${buying}`).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "already_held" });
    }
  });

  it("charges a Gold wedding the upgrade-from-Gold Price for Crimson", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ tier: "gold", stripe: stripe.client });
    expect((await startSession(app, OWNER, { tier: "crimson" })).status).toBe(200);
    expect(stripe.created.map((c) => c.priceId)).toEqual(["price_cg"]);
  });
});

describe("where Stripe sends the organiser back", () => {
  it("names the module they asked to return to, and the purchase to poll", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    const res = await startSession(app, OWNER, { tier: "gold", module: "budget" });
    const { purchaseId } = (await jsonBody(res)) as { purchaseId: string };
    const [session] = stripe.created;
    const success = new URL(session!.successUrl);
    expect(success.origin).toBe("https://host.test");
    expect(Object.fromEntries(success.searchParams)).toEqual({
      w: BOOTSTRAP_WEDDING_ID,
      m: "budget",
      upgrade: purchaseId,
    });
    expect(Object.fromEntries(new URL(session!.cancelUrl).searchParams)).toEqual({
      w: BOOTSTRAP_WEDDING_ID,
      m: "budget",
    });
  });

  it("lands on Overview when no module, or one it does not know, is named", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    await startSession(app, OWNER, { tier: "gold" });
    await startSession(app, OWNER, { tier: "crimson", module: "https://evil.example/" });
    // The second press replaced the first's expired session.
    expect(stripe.created.map((c) => new URL(c.successUrl).searchParams.get("m"))).toEqual([
      "overview",
      "overview",
    ]);
  });
});

describe("the catalogue", () => {
  type Catalogue = {
    tier: string;
    upgrades: { tier: string; fromTier: string; amountMinor: number; currency: string }[];
  };

  it("offers an Ivory wedding both tiers, and names the tier it is on", async () => {
    const { app } = buildApp();
    const res = await get(app, `${base}/catalogue`, OWNER);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      tier: "ivory",
      upgrades: [
        {
          tier: "gold",
          fromTier: "ivory",
          title: "Gold",
          blurb: "Your budget, checklist and gift registry, for up to 500 guests.",
          amountMinor: 4900,
          currency: "AUD",
        },
        {
          tier: "crimson",
          fromTier: "ivory",
          title: "Crimson",
          blurb:
            "Everything in Gold, plus vendors and premium invite designs, for up to 1,000 guests.",
          amountMinor: 9900,
          currency: "AUD",
        },
      ],
    });
  });

  it("offers a Gold wedding only Crimson, priced as an upgrade from Gold", async () => {
    const { app } = buildApp({ tier: "gold" });
    const body = (await jsonBody(await get(app, `${base}/catalogue`, OWNER))) as Catalogue;
    expect(body.tier).toBe("gold");
    expect(body.upgrades).toMatchObject([{ tier: "crimson", fromTier: "gold", amountMinor: 5000 }]);
  });

  it("offers a Crimson wedding nothing", async () => {
    const { app } = buildApp({ tier: "crimson" });
    expect(await jsonBody(await get(app, `${base}/catalogue`, OWNER))).toEqual({
      tier: "crimson",
      upgrades: [],
    });
  });

  it("omits a tier with no configured Price", async () => {
    const { app } = buildApp({ prices: { gold: "price_g" } });
    const body = (await jsonBody(await get(app, `${base}/catalogue`, OWNER))) as Catalogue;
    expect(body.upgrades.map((u) => u.tier)).toEqual(["gold"]);
  });
});

describe("polling a purchase", () => {
  it("reports its status and tier to a member", async () => {
    const { app } = buildApp();
    const started = (await jsonBody(await startSession(app, OWNER, { tier: "gold" }))) as {
      purchaseId: string;
    };
    const res = await get(app, `${base}/purchases/${started.purchaseId}`, EDITOR);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ purchase: { status: "pending", tier: "gold" } });
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
    expect((await startSession(app, OWNER, { tier: "gold" })).status).toBe(404);
  });
});

describe("when Stripe refuses", () => {
  it("502s rather than reporting a broken account", async () => {
    // Not this API's fault and not the organiser's, so the portal can offer
    // the button again.
    const { app } = buildApp({ stripe: stripeStub({ failCreate: true }).client });
    const res = await startSession(app, OWNER, { tier: "gold" });
    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toEqual({ error: "payment_provider_unavailable" });
  });
});
