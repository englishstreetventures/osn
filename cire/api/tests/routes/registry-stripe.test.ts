import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  registrySettings,
  weddingEntitlements,
  weddingHosts,
} from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { StripeError, type StripeAccount, type StripeClient } from "../../src/services/stripe";
import { appRequest, jsonBody } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

/**
 * Connecting a couple's bank account.
 *
 * What is load-bearing here:
 *   - it is OWNER-only. Adding a gift is ordinary help; naming the account the
 *     money lands in is not, and an editor must not be able to;
 *   - it never mints a second connected account for a wedding that has one —
 *     the failure that needs a human at Stripe to unpick;
 *   - it never turns cash gifts ON. Connecting an account and offering guests a
 *     contribute button are two decisions, and the second is the couple's;
 *   - Stripe being unreachable is a 502, not a 500 and not a broken account;
 *   - with no Stripe configured the routes do not exist at all.
 */

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

const ACCOUNT: StripeAccount = {
  id: "acct_new",
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  defaultCurrency: null,
};

/** A Stripe that records what it was asked, and can be told to refuse. */
function stripeStub(
  overrides: {
    account?: StripeAccount;
    failCreate?: boolean;
    failLink?: boolean;
    failRetrieve?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const links: { accountId: string; returnUrl: string; refreshUrl: string }[] = [];
  const client: StripeClient = {
    createAccount(input) {
      calls.push(`createAccount:${input.weddingId}:${input.country}`);
      return overrides.failCreate
        ? Effect.fail(new StripeError({ reason: "rejected", status: 400, code: "country_invalid" }))
        : Effect.succeed(overrides.account ?? ACCOUNT);
    },
    createAccountLink(input) {
      calls.push(`createAccountLink:${input.accountId}`);
      links.push(input);
      return overrides.failLink
        ? Effect.fail(new StripeError({ reason: "unreachable" }))
        : Effect.succeed({ url: "https://connect.stripe.test/setup/x", expiresAt: 1_800_000_000 });
    },
    // Upgrade purchases do not touch these route groups; a double that
    // silently succeeded here would let a test pass against a call it never
    // meant to make.
    createPlatformCheckoutSession: () => Effect.fail(new StripeError({ reason: "not used here" })),
    retrievePlatformCheckoutSession: () =>
      Effect.fail(new StripeError({ reason: "not used here" })),
    retrievePrice: () => Effect.fail(new StripeError({ reason: "not used here" })),
    retrieveAccount(accountId) {
      calls.push(`retrieveAccount:${accountId}`);
      return overrides.failRetrieve
        ? Effect.fail(new StripeError({ reason: "unreachable" }))
        : Effect.succeed({ ...(overrides.account ?? ACCOUNT), id: accountId });
    },
    // These two belong to the guest contribute path, which this route file
    // never reaches. Present because `StripeClient` is one interface, and
    // failing loudly is better than a silent stub that could be mistaken for
    // a tested path.
    createCheckoutSession() {
      calls.push("createCheckoutSession");
      return Effect.die(new Error("createCheckoutSession is not part of the onboarding routes"));
    },
    retrieveCheckoutSession() {
      calls.push("retrieveCheckoutSession");
      return Effect.die(new Error("retrieveCheckoutSession is not part of the onboarding routes"));
    },
  };
  return { client, calls, links };
}

function buildApp({
  grantRegistry = true,
  stripe,
  limiter,
}: {
  grantRegistry?: boolean;
  stripe?: StripeClient | null;
  limiter?: ReturnType<typeof createRateLimiter>;
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
  if (grantRegistry) {
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "registry",
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
    // A FRESH limiter per app: the module-level default is shared process-wide,
    // so without this the eleventh call in this file would 429 whichever test
    // happened to run last.
    registryStripeLimiter: limiter ?? createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, db };
}
type App = ReturnType<typeof buildApp>["app"];

async function req(app: App, path: string, profileId?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "POST", headers });
}

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry/stripe`;

describe("who may connect an account", () => {
  it("lets the owner start onboarding", async () => {
    const { app } = buildApp();
    const res = await req(app, `${base}/session`, OWNER);
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as { url: string; status: { connected: boolean } };
    expect(body.url).toBe("https://connect.stripe.test/setup/x");
    expect(body.status.connected).toBe(true);
  });

  it("refuses an editor — a co-host may add gifts, not name the bank account", async () => {
    const { app } = buildApp();
    expect((await req(app, `${base}/session`, EDITOR)).status).toBe(403);
    expect((await req(app, `${base}/refresh`, EDITOR)).status).toBe(403);
  });

  it("refuses a stranger, and anyone with no token", async () => {
    const { app } = buildApp();
    expect((await req(app, `${base}/session`, STRANGER)).status).toBe(403);
    expect((await req(app, `${base}/session`)).status).toBe(401);
  });

  it("refuses a wedding without the registry entitlement", async () => {
    const { app } = buildApp({ grantRegistry: false });
    expect((await req(app, `${base}/session`, OWNER)).status).toBe(402);
  });

  it("does not exist at all when Stripe is not configured", async () => {
    // A deployment with no Stripe account has no payment surface, rather than
    // one that 500s — the portal probes and hides the panel.
    const { app } = buildApp({ stripe: null });
    expect((await req(app, `${base}/session`, OWNER)).status).toBe(404);
    expect((await req(app, `${base}/refresh`, OWNER)).status).toBe(404);
  });
});

describe("create-or-resume", () => {
  it("returns the couple to the settings tab, where the button they pressed is", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    await req(app, `${base}/session`, OWNER);
    // Both URLs: `refresh_url` is where Stripe sends them when the link has
    // expired, and it must land on the button that mints a fresh one.
    expect(stripe.links[0]?.returnUrl).toBe(
      `https://host.test/#/w/${BOOTSTRAP_WEDDING_ID}/registry/settings`,
    );
    expect(stripe.links[0]?.refreshUrl).toBe(stripe.links[0]?.returnUrl);
  });

  it("creates one account, stores it, and returns the couple to their own registry", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });

    await req(app, `${base}/session`, OWNER);

    expect(stripe.calls).toEqual([
      `createAccount:${BOOTSTRAP_WEDDING_ID}:AU`,
      "createAccountLink:acct_new",
    ]);
    const row = await db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeAccountId).toBe("acct_new");
    // Connecting an account is not consent to show guests a contribute button.
    expect(row?.cashGiftsEnabled).toBe(false);
    expect(row?.published).toBe(false);
  });

  it("reuses the account on every return trip — onboarding is a form people abandon", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });

    await req(app, `${base}/session`, OWNER);
    await req(app, `${base}/session`, OWNER);
    await req(app, `${base}/session`, OWNER);

    // One account, three links. A second account would silently repoint every
    // future gift at a different bank account.
    expect(stripe.calls.filter((c) => c.startsWith("createAccount:"))).toHaveLength(1);
    expect(stripe.calls.filter((c) => c.startsWith("createAccountLink:"))).toHaveLength(3);
    const row = await db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeAccountId).toBe("acct_new");
  });

  it("keeps the couple's own settings when it fills in the account", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        published: true,
        headline: "Our list",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await req(app, `${base}/session`, OWNER);

    const row = await db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeAccountId).toBe("acct_new");
    expect(row?.published).toBe(true);
    expect(row?.headline).toBe("Our list");
  });
});

describe("when Stripe will not play", () => {
  it("answers 502 when the account cannot be created", async () => {
    const { app } = buildApp({ stripe: stripeStub({ failCreate: true }).client });
    const res = await req(app, `${base}/session`, OWNER);
    // Not a 500: nothing here is broken, and the portal can offer the button
    // again rather than reporting a broken account.
    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toEqual({ error: "stripe_unavailable" });
  });

  it("answers 502 when the hosted link cannot be minted, and stores the account anyway", async () => {
    const stripe = stripeStub({ failLink: true });
    const { app, db } = buildApp({ stripe: stripe.client });

    expect((await req(app, `${base}/session`, OWNER)).status).toBe(502);

    // The account exists at Stripe by then, so it must exist here too — losing
    // it would mint a second one on the couple's next attempt.
    const row = await db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeAccountId).toBe("acct_new");
  });
});

describe("refreshing what Stripe says", () => {
  it("reports not connected, and asks Stripe nothing, before there is an account", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });

    const res = await req(app, `${base}/refresh`, OWNER);

    expect(await jsonBody(res)).toEqual({
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    expect(stripe.calls).toEqual([]);
  });

  it("caches what a live read says, so the portal does not wait on the webhook", async () => {
    const stripe = stripeStub({
      account: {
        id: "acct_new",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        defaultCurrency: "AUD",
      },
    });
    const { app, db } = buildApp({ stripe: stripe.client });
    await req(app, `${base}/session`, OWNER);

    const res = await req(app, `${base}/refresh`, OWNER);

    expect(await jsonBody(res)).toEqual({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    const row = await db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeChargesEnabled).toBe(true);
    expect(row?.stripePayoutsEnabled).toBe(true);
  });

  it("answers 502 when Stripe cannot be reached", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    await req(app, `${base}/session`, OWNER);

    const failing = buildApp({ stripe: stripeStub({ failRetrieve: true }).client });
    // Give the second app an account to refresh.
    await req(failing.app, `${base}/session`, OWNER);
    const res = await req(failing.app, `${base}/refresh`, OWNER);
    expect(res.status).toBe(502);
  });
});

describe("the outbound-call budget", () => {
  it("throttles onboarding, because every press spends a Stripe call", async () => {
    // Owner-auth caps the blast radius to one wedding; it does not cap the
    // RATE, and the quota being spent is the platform's.
    const { app } = buildApp({ limiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }) });
    expect((await req(app, `${base}/session`, OWNER)).status).toBe(200);
    expect((await req(app, `${base}/session`, OWNER)).status).toBe(429);
  });

  it("throttles after the gates, so a stranger cannot spend the couple's budget", async () => {
    const { app } = buildApp({ limiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }) });
    expect((await req(app, `${base}/session`, STRANGER)).status).toBe(403);
    // The owner's first call still lands: the stranger never reached the limiter.
    expect((await req(app, `${base}/session`, OWNER)).status).toBe(200);
  });
});

describe("cash gifts stay the couple's decision", () => {
  it("still refuses to enable them while Stripe cannot take a charge", async () => {
    const { app } = buildApp();
    await req(app, `${base}/session`, OWNER);

    const res = await appRequest(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry/settings`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await auth.sign(OWNER)}`,
        },
        body: JSON.stringify({ cashGiftsEnabled: true }),
      },
    );

    // Connected, but not yet able to charge: offering guests a contribute
    // button now is a refund and a support case.
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "stripe_not_ready" });
  });
});
