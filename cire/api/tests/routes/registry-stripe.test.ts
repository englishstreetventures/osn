import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, registrySettings, weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { registryService } from "../../src/services/registry";
import { StripeError, type StripeAccount, type StripeClient } from "../../src/services/stripe";
import type { Tier } from "../../src/services/tiers";
import { appRequest, jsonBody, recordStatements, setTier } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

/**
 * Connecting a couple's bank account.
 *
 * What is load-bearing here:
 *   - it is OWNER-only. Adding a gift is ordinary help; naming the account the
 *     money lands in is not, and an editor must not be able to;
 *   - once an account is connected, only the owner who connected it may open
 *     its onboarding links: the account carries their identity and their bank.
 *     Every other owner may still read its status;
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
/** The wedding's other owner, seated in every app this file builds. */
const SECOND = "usr_second_owner";

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
    /** Runs while `createAccount` is in flight: another request's write. */
    duringCreate?: () => void;
  } = {},
) {
  const calls: string[] = [];
  const links: { accountId: string; returnUrl: string; refreshUrl: string }[] = [];
  const client: StripeClient = {
    createAccount(input) {
      calls.push(`createAccount:${input.weddingId}:${input.country}`);
      overrides.duringCreate?.();
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
    expirePlatformCheckoutSession: () => Effect.fail(new StripeError({ reason: "not used here" })),
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
  tier = "gold",
  stripe,
  limiter,
  stripeWebhookSecret = null,
}: {
  tier?: Tier;
  stripe?: StripeClient | null;
  limiter?: ReturnType<typeof createRateLimiter>;
  /** The Connect webhook's signing secret: with it, the site takes money gifts. */
  stripeWebhookSecret?: string | null;
} = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values([
      {
        id: "whost_editor",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: EDITOR,
        addedByOsnProfileId: OWNER,
        role: "editor",
        createdAt: now,
      },
      {
        id: "whost_second",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: SECOND,
        addedByOsnProfileId: OWNER,
        role: "owner",
        createdAt: now,
      },
    ])
    .run();
  setTier(db, BOOTSTRAP_WEDDING_ID, tier);
  const app = createApp(db, {
    osnTestKey: auth.key,
    organiserOrigin: "https://host.test",
    stripe: stripe === undefined ? stripeStub().client : stripe,
    // A FRESH limiter per app: the module-level default is shared process-wide,
    // so without this the eleventh call in this file would 429 whichever test
    // happened to run last.
    registryStripeLimiter: limiter ?? createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    stripeWebhookSecret,
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

  // The refresh answers the account's capabilities and why guests cannot give,
  // so its own gate is pinned for each way in, not only through `/session`.
  it("asks for a live credential on the refresh, by bearer token or session cookie", async () => {
    const { app, db } = buildApp();
    const token = await seedOrganiserSession(db, OWNER);
    const refresh = (headers: Record<string, string>) =>
      appRequest(app, `${base}/refresh`, { method: "POST", headers });

    expect((await refresh({})).status).toBe(401);
    expect((await refresh({ Authorization: "Bearer not-a-jwt" })).status).toBe(401);
    expect((await refresh({ cookie: "cire_org_session=not-a-live-session-token" })).status).toBe(
      401,
    );
    expect((await refresh({ cookie: `cire_org_session=${token}` })).status).toBe(200);
  });

  it("refuses a wedding below Gold with 402", async () => {
    const { app } = buildApp({ tier: "ivory" });
    const res = await req(app, `${base}/session`, OWNER);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual({ error: "payment_required", tier: "gold" });
  });

  it("does not exist at all when Stripe is not configured", async () => {
    // A deployment with no Stripe account has no payment surface, rather than
    // one that 500s — the portal probes and hides the panel.
    const { app } = buildApp({ stripe: null });
    expect((await req(app, `${base}/session`, OWNER)).status).toBe(404);
    expect((await req(app, `${base}/refresh`, OWNER)).status).toBe(404);
  });
});

describe("only the owner who connected the account may open its links", () => {
  type Built = ReturnType<typeof buildApp>;

  /** The bootstrap wedding's settings row, as stored. */
  const row = (db: Built["db"]) =>
    db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();

  /** A row holding an account, connected by `connector` (null: nobody recorded). */
  function connectedBy(db: Built["db"], connector: string | null, accountId = "acct_first") {
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        stripeAccountId: accountId,
        stripeConnectedByOsnProfileId: connector,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        stripeDefaultCurrency: "AUD",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("refuses another owner 403, asking Stripe nothing and changing nothing", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });
    connectedBy(db, OWNER);

    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await req(app, `${base}/session`, SECOND);
    });

    expect(res?.status).toBe(403);
    expect(await jsonBody(res!)).toEqual({ error: "stripe_connector_only" });
    // No link minted, no account created: the account is in someone else's name.
    expect(stripe.calls).toEqual([]);
    expect(row(db)?.stripeAccountId).toBe("acct_first");
    expect(row(db)?.stripeConnectedByOsnProfileId).toBe(OWNER);
    // The refusal is logged by wedding and reason, never by person.
    expect(logs).toContain("stripe onboarding refused");
    expect(logs).toContain(BOOTSTRAP_WEDDING_ID);
    expect(logs).toContain("not_connector");
    expect(logs).not.toContain(SECOND);
    expect(logs).not.toContain(OWNER);
  });

  it("refuses every owner an account nobody is recorded as connecting", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });
    connectedBy(db, null);

    for (const owner of [OWNER, SECOND]) {
      const res = await req(app, `${base}/session`, owner);
      expect(res.status, owner).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "stripe_connector_only" });
    }
    expect(stripe.calls).toEqual([]);
    expect(row(db)?.stripeConnectedByOsnProfileId).toBeNull();
  });

  it("records whoever connects first, and keeps handing them links", async () => {
    for (const connector of [OWNER, SECOND]) {
      const stripe = stripeStub();
      const { app, db } = buildApp({ stripe: stripe.client });

      for (let trip = 0; trip < 3; trip++) {
        const res = await req(app, `${base}/session`, connector);
        expect(res.status, `${connector} trip ${trip}`).toBe(200);
        const body = (await jsonBody(res)) as { url: string };
        expect(body.url).toBe("https://connect.stripe.test/setup/x");
      }

      expect(row(db)?.stripeConnectedByOsnProfileId).toBe(connector);
      expect(stripe.calls).toEqual([
        `createAccount:${BOOTSTRAP_WEDDING_ID}:AU`,
        "createAccountLink:acct_new",
        "createAccountLink:acct_new",
        "createAccountLink:acct_new",
      ]);
    }
  });

  it("refuses an owner whose connect lost to another owner's, with no link", async () => {
    // The second owner read a row with no account; while their create was in
    // flight the first owner's request attached the same account (Stripe's
    // idempotency key is per wedding). The attach keeps the first owner's.
    const box: { db?: Built["db"] } = {};
    const stripe = stripeStub({ duringCreate: () => connectedBy(box.db!, OWNER, "acct_new") });
    const built = buildApp({ stripe: stripe.client });
    box.db = built.db;

    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await req(built.app, `${base}/session`, SECOND);
    });

    expect(res?.status).toBe(403);
    expect(await jsonBody(res!)).toEqual({ error: "stripe_connector_only" });
    expect(stripe.calls.filter((c) => c.startsWith("createAccountLink:"))).toEqual([]);
    expect(row(built.db)?.stripeAccountId).toBe("acct_new");
    expect(row(built.db)?.stripeConnectedByOsnProfileId).toBe(OWNER);
    // Stripe answered with the account that is stored: nothing is orphaned,
    // so nothing sends an operator to look for one.
    expect(logs).not.toContain("stripe account created but not stored");
    expect(logs).toContain("connected_meanwhile");
  });

  it("logs the account a losing connect minted, so it is not lost without a trace", async () => {
    // Past Stripe's idempotency window the losing create mints a second
    // account. Nothing stores it, so the log line is the only record of it.
    const box: { db?: Built["db"] } = {};
    const stripe = stripeStub({
      account: { ...ACCOUNT, id: "acct_orphan" },
      duringCreate: () => connectedBy(box.db!, OWNER, "acct_first"),
    });
    const built = buildApp({ stripe: stripe.client });
    box.db = built.db;

    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await req(built.app, `${base}/session`, SECOND);
    });

    expect(res?.status).toBe(403);
    expect(row(built.db)?.stripeAccountId).toBe("acct_first");
    expect(logs).toContain("stripe account created but not stored");
    expect(logs).toContain("acct_orphan");
  });

  it("forgets who connected an account when Stripe takes it away", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });
    connectedBy(db, OWNER);

    await Effect.runPromise(
      registryService
        .detachStripeAccount({ accountId: "acct_first" })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(row(db)?.stripeAccountId).toBeNull();
    expect(row(db)?.stripeConnectedByOsnProfileId).toBeNull();

    // So the next account is whoever connects it.
    expect((await req(app, `${base}/session`, SECOND)).status).toBe(200);
    expect(row(db)?.stripeConnectedByOsnProfileId).toBe(SECOND);
  });

  it("still lets another owner read the account's status", async () => {
    const stripe = stripeStub({
      account: {
        id: "acct_first",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        defaultCurrency: "AUD",
      },
    });
    const { app, db } = buildApp({ stripe: stripe.client });
    connectedBy(db, OWNER);

    const res = await req(app, `${base}/refresh`, SECOND);

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      moneyGiftsBlockedBy: "payments_unavailable",
    });
    expect(stripe.calls).toEqual(["retrieveAccount:acct_first"]);
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
      moneyGiftsBlockedBy: "payments_unavailable",
    });
    expect(stripe.calls).toEqual([]);

    // On a site that takes money, the reason is the missing account.
    const paying = buildApp({ stripe: stripe.client, stripeWebhookSecret: "whsec_test_connect" });
    const answer = (await jsonBody(await req(paying.app, `${base}/refresh`, OWNER))) as {
      moneyGiftsBlockedBy: unknown;
    };
    expect(answer.moneyGiftsBlockedBy).toBe("stripe_not_ready");
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
      // No webhook secret on this app, so the site takes no money gift.
      moneyGiftsBlockedBy: "payments_unavailable",
    });
    const row = await db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeChargesEnabled).toBe(true);
    expect(row?.stripePayoutsEnabled).toBe(true);
  });

  // The portal shows this answer as what guests are offered, so it is the row as
  // the guest gate will read it after the write — never the live read alone.
  describe("why guests cannot give money", () => {
    const live = (defaultCurrency: string | null): StripeAccount => ({
      id: "acct_new",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      defaultCurrency,
    });

    /**
     * A paying site whose couple connected an account and turned money gifts
     * on, with the row still saying onboarding is unfinished — so an answer
     * taken from the row before the refresh says `stripe_not_ready`.
     */
    async function connectedWithMoneyOn(account: StripeAccount) {
      const built = buildApp({
        stripe: stripeStub({ account }).client,
        stripeWebhookSecret: "whsec_test_connect",
      });
      await req(built.app, `${base}/session`, OWNER);
      built.db
        .update(registrySettings)
        .set({ cashGiftsEnabled: true, stripeChargesEnabled: false, stripeDefaultCurrency: null })
        .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
        .run();
      return built;
    }

    it("answers null once the live read settles in the wedding's currency", async () => {
      const { app } = await connectedWithMoneyOn(live("AUD"));
      const body = (await jsonBody(await req(app, `${base}/refresh`, OWNER))) as {
        moneyGiftsBlockedBy: unknown;
      };
      expect(body.moneyGiftsBlockedBy).toBeNull();
    });

    it("answers from the row its write returned, with no read after the write", async () => {
      const { app, db } = await connectedWithMoneyOn(live("AUD"));
      const statements = recordStatements(db);
      const body = (await jsonBody(await req(app, `${base}/refresh`, OWNER))) as {
        moneyGiftsBlockedBy: unknown;
      };
      expect(body.moneyGiftsBlockedBy).toBeNull();
      const settingsStatements = statements
        .map((st) => st.sql)
        .filter((sql) => sql.includes('"registry_settings"'));
      // One read to find the account, one write that answers the row.
      expect(settingsStatements).toHaveLength(2);
      expect(settingsStatements[1]).toMatch(/^update "registry_settings"/);
    });

    it("answers currency_mismatch when the live read settles in another currency", async () => {
      const { app } = await connectedWithMoneyOn(live("USD"));
      const body = (await jsonBody(await req(app, `${base}/refresh`, OWNER))) as {
        moneyGiftsBlockedBy: unknown;
      };
      expect(body.moneyGiftsBlockedBy).toBe("currency_mismatch");
    });

    it("answers the stored row when it holds a later state than the live read", async () => {
      // Stripe said "cannot charge" at a time later than this read: the write
      // keeps it, so the guest gate reads "cannot charge", and so must the answer.
      // Stored payouts differ from stored charges and from the live read, so
      // only an answer taken from the stored payouts column matches.
      const { app, db } = await connectedWithMoneyOn({ ...live("AUD"), payoutsEnabled: false });
      db.update(registrySettings)
        .set({
          stripeChargesEnabled: false,
          stripePayoutsEnabled: true,
          stripeAccountUpdatedAt: new Date(Date.now() + 3_600_000),
        })
        .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
        .run();
      expect(await jsonBody(await req(app, `${base}/refresh`, OWNER))).toEqual({
        connected: true,
        chargesEnabled: false,
        payoutsEnabled: true,
        moneyGiftsBlockedBy: "stripe_not_ready",
      });
    });

    it("judges the live read against this wedding's own currency", async () => {
      const { app, db } = await connectedWithMoneyOn(live("NZD"));
      db.update(weddings)
        .set({ currency: "NZD" })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
        .run();
      const body = (await jsonBody(await req(app, `${base}/refresh`, OWNER))) as {
        moneyGiftsBlockedBy: unknown;
      };
      expect(body.moneyGiftsBlockedBy).toBeNull();
    });

    it("answers from this wedding's row when another wedding names the same account", async () => {
      const { app, db } = buildApp({
        stripe: stripeStub({ account: live("AUD") }).client,
        stripeWebhookSecret: "whsec_test_connect",
      });
      // Written before this wedding's row, so the write returns it first.
      const now = new Date();
      insertWedding(db, { id: "wed_other", slug: "other-wedding", displayName: "Other" });
      db.insert(registrySettings)
        .values({
          weddingId: "wed_other",
          stripeAccountId: "acct_new",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await req(app, `${base}/session`, OWNER);
      db.update(registrySettings)
        .set({ cashGiftsEnabled: true })
        .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
        .run();
      const body = (await jsonBody(await req(app, `${base}/refresh`, OWNER))) as {
        moneyGiftsBlockedBy: unknown;
      };
      // The other wedding has money gifts off; this one has them on.
      expect(body.moneyGiftsBlockedBy).toBeNull();
    });
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
    const body = (await jsonBody(res)) as {
      error: string;
      settings: { cashGiftsEnabled: boolean; stripeChargesEnabled: boolean };
    };
    expect(body.error).toBe("stripe_not_ready");
    // With the row as it stands, so the portal shows it without asking again.
    expect(body.settings.cashGiftsEnabled).toBe(false);
    expect(body.settings.stripeChargesEnabled).toBe(false);
  });
});
