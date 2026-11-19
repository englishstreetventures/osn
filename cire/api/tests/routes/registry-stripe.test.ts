import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  registryRetiredAccounts,
  registrySettings,
  weddingHosts,
  weddings,
} from "@cire/db";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import type { AppOptions } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { registryService } from "../../src/services/registry";
import {
  createStripeClient,
  StripeError,
  type StripeAccount,
  type StripeClient,
} from "../../src/services/stripe";
import type { Tier } from "../../src/services/tiers";
import { appRequest, beforeStatement, jsonBody, recordStatements, setTier } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
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
    createPlatformRefund: () => Effect.fail(new StripeError({ reason: "not used here" })),
    findPlatformRefund: () => Effect.fail(new StripeError({ reason: "not used here" })),
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
  options = {},
}: {
  tier?: Tier;
  stripe?: StripeClient | null;
  limiter?: ReturnType<typeof createRateLimiter>;
  /** The Connect webhook's signing secret: with it, the site takes money gifts. */
  stripeWebhookSecret?: string | null;
  /** Anything else the app takes, such as the owner-notice transport. */
  options?: Partial<AppOptions>;
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
    ...options,
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

describe("an account the couple connected through Stripe meanwhile", () => {
  it("gets no onboarding link when it won the race", async () => {
    const built: { db?: ReturnType<typeof buildApp>["db"] } = {};
    const stub = stripeStub({
      duringCreate: () => {
        const now = new Date();
        built.db
          ?.insert(registrySettings)
          .values({
            weddingId: BOOTSTRAP_WEDDING_ID,
            stripeAccountId: "acct_their_own",
            stripeConnectedByOsnProfileId: OWNER,
            stripeAccountType: "standard",
            createdAt: now,
            updatedAt: now,
          })
          .run();
      },
    });
    const app = buildApp({ stripe: stub.client });
    built.db = app.db;
    const res = await req(app.app, `${base}/session`, OWNER);
    expect(res.status).toBe(409);
    expect(((await jsonBody(res)) as { error: string }).error).toBe("stripe_standard_account");
    expect(stub.calls.filter((c) => c.startsWith("createAccountLink"))).toEqual([]);
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

  it.each([
    ["is removed as an owner", "demoted"],
    ["has the wedding deleted", "deleted"],
    ["has the wedding purged", "purged"],
  ] as const)(
    "records nothing for an owner who %s while Stripe makes the account",
    async (_label, change) => {
      // The gate read the seat before the Stripe round trip; the write reads
      // it again, so the account is not stored under someone who may no
      // longer act for the wedding, and no link into it is handed out.
      const box: { db?: Built["db"] } = {};
      const stripe = stripeStub({
        account: { ...ACCOUNT, id: "acct_unstored" },
        duringCreate: () => {
          if (change === "demoted") {
            box
              .db!.update(weddingHosts)
              .set({ role: "editor" })
              .where(eq(weddingHosts.osnProfileId, OWNER))
              .run();
          } else if (change === "purged") {
            box.db!.delete(weddings).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID)).run();
          } else {
            box
              .db!.update(weddings)
              .set({ deletedAt: new Date() })
              .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
              .run();
          }
        },
      });
      const built = buildApp({ stripe: stripe.client });
      box.db = built.db;

      let res: Response | undefined;
      const logs = await captureLogs(async () => {
        res = await req(built.app, `${base}/session`, OWNER);
      });

      expect(res?.status).toBe(403);
      expect(await jsonBody(res!)).toEqual({ error: "forbidden" });
      expect(row(built.db)).toBeUndefined();
      expect(stripe.calls).toEqual([`createAccount:${BOOTSTRAP_WEDDING_ID}:AU`]);
      // The account exists at Stripe with nothing storing it: its id is the
      // one record for the manual fix.
      expect(logs).toContain("stripe account created but not stored");
      expect(logs).toContain("acct_unstored");
    },
  );

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
      payoutHolderAbsent: false,
    });
    expect(stripe.calls).toEqual(["retrieveAccount:acct_first"]);
  });

  it("tells every owner, on the refresh, when the account's holder is not an owner", async () => {
    const live = {
      id: "acct_first",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      defaultCurrency: "AUD",
    };
    // Held by the editor, and held by nobody on record: both absent.
    for (const connector of [EDITOR, null]) {
      const { app, db } = buildApp({ stripe: stripeStub({ account: live }).client });
      connectedBy(db, connector);
      const answer = (await jsonBody(await req(app, `${base}/refresh`, SECOND))) as {
        payoutHolderAbsent: unknown;
      };
      expect(answer.payoutHolderAbsent).toBe(true);
    }
    // And when the write kept a later state, the answer read again says the same.
    const kept = buildApp({ stripe: stripeStub({ account: live }).client });
    connectedBy(kept.db, EDITOR);
    kept.db
      .update(registrySettings)
      .set({ stripeAccountUpdatedAt: new Date(Date.now() + 3_600_000) })
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();
    const reread = (await jsonBody(await req(kept.app, `${base}/refresh`, OWNER))) as {
      payoutHolderAbsent: unknown;
    };
    expect(reread.payoutHolderAbsent).toBe(true);
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

  it("stores what Stripe said about the new account, its currency included", async () => {
    const stripe = stripeStub({
      account: { ...ACCOUNT, chargesEnabled: true, payoutsEnabled: true, defaultCurrency: "AUD" },
    });
    const { app, db } = buildApp({ stripe: stripe.client });

    expect((await req(app, `${base}/session`, OWNER)).status).toBe(200);

    const row = db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();
    expect(row?.stripeChargesEnabled).toBe(true);
    expect(row?.stripePayoutsEnabled).toBe(true);
    expect(row?.stripeDefaultCurrency).toBe("AUD");
    expect(row?.stripeAccountUpdatedAt).not.toBeNull();
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

/**
 * Stripe replays the first answer to an idempotency key for at least 24 hours.
 * The create key carries how many times the wedding's account has been
 * cleared, so a Connect press after a clear never gets the cleared account
 * back, and the attach stores nothing when a clear happened while its own
 * request was at Stripe.
 */
describe("an account cleared before or during a connect", () => {
  type Built = ReturnType<typeof buildApp>;

  const row = (db: Built["db"]) =>
    db
      .select()
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .get();

  /**
   * The real client over a Stripe that replays the first answer to a key, as
   * Stripe does, and mints a new account for a key it has not seen.
   */
  function replayingStripe() {
    const createKeys: string[] = [];
    const byKey = new Map<string, string>();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/v1/accounts") && init?.method === "POST") {
        const key = new Headers(init.headers).get("idempotency-key") ?? "";
        createKeys.push(key);
        if (!byKey.has(key)) byKey.set(key, `acct_made_${byKey.size + 1}`);
        return json({
          id: byKey.get(key),
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
        });
      }
      if (url.endsWith("/v1/account_links") && init?.method === "POST") {
        return json({ url: "https://connect.stripe.test/setup/x", expires_at: 1_800_000_000 });
      }
      throw new Error(`not part of this test: ${init?.method} ${url}`);
    }) as unknown as typeof fetch;
    const client = createStripeClient({
      secretKey: "sk_test",
      apiBase: "https://stripe.test",
      fetchImpl,
    });
    return { client, createKeys };
  }

  it("asks Stripe for a new account after Stripe took the last one away", async () => {
    const stripe = replayingStripe();
    const { app, db } = buildApp({ stripe: stripe.client });

    expect((await req(app, `${base}/session`, OWNER)).status).toBe(200);
    expect(row(db)?.stripeAccountId).toBe("acct_made_1");
    await Effect.runPromise(
      registryService
        .detachStripeAccount({ accountId: "acct_made_1" })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect((await req(app, `${base}/session`, OWNER)).status).toBe(200);

    expect(stripe.createKeys).toEqual([
      `cire-account-${BOOTSTRAP_WEDDING_ID}-0`,
      `cire-account-${BOOTSTRAP_WEDDING_ID}-1`,
    ]);
    expect(row(db)?.stripeAccountId).toBe("acct_made_2");
  });

  it("stores nothing when another owner's account was connected and cleared while Stripe made this one", async () => {
    // This owner read generation 0. Meanwhile another owner connected
    // acct_cleared under the same key and it was cleared; Stripe replays it
    // to this request. Storing it would make this owner the holder of an
    // account carrying someone else's identity and bank.
    const box: { db?: ReturnType<typeof buildApp>["db"] } = {};
    const stripe = stripeStub({
      account: { ...ACCOUNT, id: "acct_cleared" },
      duringCreate: () => {
        const now = new Date();
        box
          .db!.insert(registrySettings)
          .values({
            weddingId: BOOTSTRAP_WEDDING_ID,
            stripeAccountId: "acct_cleared",
            stripeConnectedByOsnProfileId: SECOND,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        box
          .db!.update(registrySettings)
          .set({ stripeAccountId: null, stripeConnectedByOsnProfileId: null })
          .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
          .run();
      },
    });
    const built = buildApp({ stripe: stripe.client });
    box.db = built.db;

    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await req(built.app, `${base}/session`, OWNER);
    });

    expect(res?.status).toBe(409);
    expect(await jsonBody(res!)).toEqual({ error: "stripe_account_changed" });
    expect(row(built.db)?.stripeAccountId).toBeNull();
    expect(row(built.db)?.stripeConnectedByOsnProfileId).toBeNull();
    expect(stripe.calls).toEqual([`createAccount:${BOOTSTRAP_WEDDING_ID}:AU`]);
    // The account exists at Stripe with nothing storing it: its id is the
    // one record for the manual fix.
    expect(logs).toContain("stripe account created but not stored");
    expect(logs).toContain("acct_cleared");
    expect(logs).toContain("stripe onboarding refused");
    expect(logs).toContain("account_changed");
  });

  it("tells an owner removed meanwhile nothing about the account changing", async () => {
    // Both happened while Stripe made the account: this owner was demoted,
    // and another owner's account was connected and cleared. The refusal is
    // the one the gate would now give, with nothing about the wedding's account.
    const box: { db?: ReturnType<typeof buildApp>["db"] } = {};
    const stripe = stripeStub({
      account: { ...ACCOUNT, id: "acct_cleared" },
      duringCreate: () => {
        const db = box.db!;
        const now = new Date();
        db.update(weddingHosts)
          .set({ role: "editor" })
          .where(eq(weddingHosts.osnProfileId, OWNER))
          .run();
        db.insert(registrySettings)
          .values({
            weddingId: BOOTSTRAP_WEDDING_ID,
            stripeAccountId: "acct_cleared",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.update(registrySettings)
          .set({ stripeAccountId: null })
          .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
          .run();
      },
    });
    const built = buildApp({ stripe: stripe.client });
    box.db = built.db;

    const res = await req(built.app, `${base}/session`, OWNER);

    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
    expect(row(built.db)?.stripeAccountId).toBeNull();
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
      payoutHolderAbsent: false,
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
      payoutHolderAbsent: false,
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
        payoutHolderAbsent: false,
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
    const failing = buildApp({ stripe: stripeStub({ failRetrieve: true }).client });
    // Give the app an account to refresh.
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

/**
 * Giving a wedding the account its owner already connected on another wedding.
 *
 * The account carries the identity and bank of whoever ran its onboarding, so
 * the route takes no account id at all: the caller names a wedding, and the
 * account comes off that wedding's row, only when cire's own record says the
 * caller connected it there and still owns that wedding. Every other source is
 * the same 404, so the route says nothing about weddings the caller cannot see.
 * And the account goes only where every owner already sits beside it: whoever
 * could remove the connector here could already do it on the source wedding.
 */
describe("using an account connected on another wedding", () => {
  type Built = ReturnType<typeof buildApp>;
  const SOURCE = "wed_source";
  const SHARED = "acct_shared";
  /** When Stripe last described the shared account, as the source row holds it. */
  const STAMP = new Date(1_700_000_000_000);

  /** Another wedding whose account `connector` connected; both owners seated. */
  function sourceWedding(
    db: Built["db"],
    over: {
      id?: string;
      displayName?: string;
      owners?: readonly string[];
      connector?: string | null;
      accountId?: string | null;
      currency?: string | null;
      chargesEnabled?: boolean;
      deletedAt?: Date | null;
    } = {},
  ) {
    const id = over.id ?? SOURCE;
    const now = new Date();
    insertWedding(db, {
      id,
      slug: id.replace(/_/g, "-"),
      displayName: over.displayName ?? "Ceremony",
      tier: "gold",
      deletedAt: over.deletedAt ?? null,
      owners: over.owners ?? [OWNER, SECOND],
    });
    db.insert(registrySettings)
      .values({
        weddingId: id,
        stripeAccountId: over.accountId === undefined ? SHARED : over.accountId,
        stripeConnectedByOsnProfileId: over.connector === undefined ? OWNER : over.connector,
        stripeChargesEnabled: over.chargesEnabled ?? true,
        stripePayoutsEnabled: over.chargesEnabled ?? true,
        stripeDefaultCurrency: over.currency === undefined ? "AUD" : over.currency,
        stripeAccountUpdatedAt: STAMP,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const settingsOf = (db: Built["db"], weddingId: string) =>
    db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).get();
  const target = (db: Built["db"]) => settingsOf(db, BOOTSTRAP_WEDDING_ID);

  async function reuse(
    app: App,
    body: unknown,
    profileId: string | null = OWNER,
    path = `${base}/reuse`,
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
    return appRequest(app, path, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function accounts(app: App, profileId: string | null = OWNER): Promise<Response> {
    const headers: Record<string, string> = {};
    if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
    return appRequest(app, `${base}/accounts`, { method: "GET", headers });
  }

  /** The bootstrap wedding holding an account already, connected by `connector`. */
  function targetConnected(db: Built["db"], connector: string, accountId = "acct_first") {
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        stripeAccountId: accountId,
        stripeConnectedByOsnProfileId: connector,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  describe("what it attaches", () => {
    it("gives the wedding the account the caller connected on another, asking Stripe nothing", async () => {
      const stripe = stripeStub();
      const { app, db } = buildApp({ stripe: stripe.client });
      sourceWedding(db);
      const before = settingsOf(db, SOURCE);

      const res = await reuse(app, { fromWeddingId: SOURCE });

      expect(res.status).toBe(200);
      const body = (await jsonBody(res)) as { settings: Record<string, unknown> };
      expect(body.settings.stripeConnected).toBe(true);
      expect(body.settings.stripeChargesEnabled).toBe(true);
      expect(body.settings.stripeConnectedByOsnProfileId).toBe(OWNER);
      // What guests are offered is judged here as everywhere: this site takes
      // no money gift (no webhook secret), so that is the reason.
      expect(body.settings.moneyGiftsBlockedBy).toBe("payments_unavailable");
      expect(JSON.stringify(body)).not.toContain(SHARED);

      const row = target(db);
      expect(row?.stripeAccountId).toBe(SHARED);
      expect(row?.stripeConnectedByOsnProfileId).toBe(OWNER);
      expect(row?.stripeChargesEnabled).toBe(true);
      expect(row?.stripePayoutsEnabled).toBe(true);
      expect(row?.stripeDefaultCurrency).toBe("AUD");
      // The same observation of the account as the source holds, so a later
      // `account.updated` is judged alike on both rows.
      expect(row?.stripeAccountUpdatedAt?.getTime()).toBe(STAMP.getTime());
      // Connecting is not consent to show guests a contribute button.
      expect(row?.cashGiftsEnabled).toBe(false);
      expect(row?.published).toBe(false);
      expect(settingsOf(db, SOURCE)).toEqual(before);
      expect(stripe.calls).toEqual([]);
    });

    it("keeps what the wedding's row already holds when it fills in the account", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);
      const now = new Date();
      const revoked = new Date(1_650_000_000_000);
      db.insert(registrySettings)
        .values({
          weddingId: BOOTSTRAP_WEDDING_ID,
          published: true,
          headline: "Our list",
          message: "No boxed gifts, please",
          cashGiftsEnabled: true,
          shippingAddress: "1 Harbour St",
          stripeDeauthorizedAccountId: "acct_revoked",
          stripeDeauthorizedAt: revoked,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      expect((await reuse(app, { fromWeddingId: SOURCE })).status).toBe(200);

      const row = target(db);
      expect(row?.stripeAccountId).toBe(SHARED);
      expect(row?.stripeConnectedByOsnProfileId).toBe(OWNER);
      expect(row?.published).toBe(true);
      expect(row?.headline).toBe("Our list");
      expect(row?.message).toBe("No boxed gifts, please");
      expect(row?.cashGiftsEnabled).toBe(true);
      expect(row?.shippingAddress).toBe("1 Harbour St");
      // The record of where earlier gifts settled is kept.
      expect(row?.stripeDeauthorizedAccountId).toBe("acct_revoked");
      expect(row?.stripeDeauthorizedAt?.getTime()).toBe(revoked.getTime());
    });

    it("takes the account from the wedding named, never from an account id in the body", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);

      const res = await reuse(app, { fromWeddingId: SOURCE, accountId: "acct_someone_else" });

      expect(res.status).toBe(200);
      expect(target(db)?.stripeAccountId).toBe(SHARED);
    });

    it("accepts an account whose payout currency Stripe has not said yet", async () => {
      const { app, db } = buildApp();
      sourceWedding(db, { currency: null, chargesEnabled: false });

      const res = await reuse(app, { fromWeddingId: SOURCE });

      expect(res.status).toBe(200);
      expect(target(db)?.stripeAccountId).toBe(SHARED);
      expect(target(db)?.stripeDefaultCurrency).toBeNull();
    });

    it("hands the caller the account's onboarding links here, and no other owner", async () => {
      const stripe = stripeStub();
      const { app, db } = buildApp({ stripe: stripe.client });
      sourceWedding(db);
      expect((await reuse(app, { fromWeddingId: SOURCE })).status).toBe(200);

      const other = await req(app, `${base}/session`, SECOND);
      expect(other.status).toBe(403);
      expect(await jsonBody(other)).toEqual({ error: "stripe_connector_only" });

      expect((await req(app, `${base}/session`, OWNER)).status).toBe(200);
      expect(stripe.calls).toEqual([`createAccountLink:${SHARED}`]);
    });

    it("logs the reuse by wedding, never by person or account", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);
      const logs = await captureLogs(async () => {
        await reuse(app, { fromWeddingId: SOURCE });
      });
      expect(logs).toContain("stripe account reused");
      expect(logs).toContain(BOOTSTRAP_WEDDING_ID);
      expect(logs).not.toContain(OWNER);
      expect(logs).not.toContain(SHARED);
    });
  });

  describe("every source the caller may not use is the same 404", () => {
    const NOT_FOUND = { error: "stripe_account_not_found" };

    async function refusedFrom(
      setUp: (db: Built["db"]) => void | Promise<void>,
      fromWeddingId = SOURCE,
    ) {
      const stripe = stripeStub();
      const { app, db } = buildApp({ stripe: stripe.client });
      await setUp(db);
      const before = settingsOf(db, fromWeddingId);
      const res = await reuse(app, { fromWeddingId });
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual(NOT_FOUND);
      // Nothing written, nothing asked of Stripe, the source untouched.
      expect(target(db)).toBeUndefined();
      expect(settingsOf(db, fromWeddingId)).toEqual(before);
      expect(stripe.calls).toEqual([]);
    }

    it("refuses an account another owner connected", async () => {
      await refusedFrom((db) => sourceWedding(db, { connector: SECOND }));
    });

    it("refuses an account nobody is on record as connecting", async () => {
      await refusedFrom((db) => sourceWedding(db, { connector: null }));
    });

    it("refuses a wedding the caller holds no seat on", async () => {
      await refusedFrom((db) =>
        sourceWedding(db, { owners: [STRANGER, SECOND], connector: STRANGER }),
      );
    });

    it("refuses a wedding the caller connected but was removed from", async () => {
      await refusedFrom((db) => sourceWedding(db, { owners: [SECOND] }));
    });

    it("refuses a wedding where the caller connected the account but is now an editor", async () => {
      await refusedFrom((db) => {
        sourceWedding(db, { owners: [SECOND] });
        db.insert(weddingHosts)
          .values({
            id: "whost_demoted",
            weddingId: SOURCE,
            osnProfileId: OWNER,
            addedByOsnProfileId: SECOND,
            role: "editor",
            createdAt: new Date(),
          })
          .run();
      });
    });

    it("refuses a deleted wedding", async () => {
      await refusedFrom((db) => sourceWedding(db, { deletedAt: new Date() }));
    });

    it("refuses an account Stripe has revoked", async () => {
      await refusedFrom(async (db) => {
        sourceWedding(db);
        await Effect.runPromise(
          registryService
            .detachStripeAccount({ accountId: SHARED })
            .pipe(Effect.provideService(DbService, db)),
        );
      });
    });

    it("refuses a wedding with no account, and one that does not exist", async () => {
      await refusedFrom((db) => sourceWedding(db, { accountId: null, connector: null }));
      await refusedFrom(() => undefined, "wed_nowhere");
    });

    it("logs a refusal by wedding and reason, never by person or account", async () => {
      const { app, db } = buildApp();
      sourceWedding(db, { connector: SECOND });
      const logs = await captureLogs(async () => {
        await reuse(app, { fromWeddingId: SOURCE });
      });
      expect(logs).toContain("stripe account reuse refused");
      expect(logs).toContain(BOOTSTRAP_WEDDING_ID);
      expect(logs).toContain("not_found");
      expect(logs).not.toContain(OWNER);
      expect(logs).not.toContain(SECOND);
      expect(logs).not.toContain(SHARED);
    });
  });

  describe("what it refuses to change", () => {
    it("refuses a wedding that already has an account, and keeps it", async () => {
      const stripe = stripeStub();
      const { app, db } = buildApp({ stripe: stripe.client });
      sourceWedding(db);
      targetConnected(db, SECOND);

      const res = await reuse(app, { fromWeddingId: SOURCE });

      expect(res.status).toBe(409);
      const body = (await jsonBody(res)) as {
        error: string;
        settings: Record<string, unknown>;
      };
      expect(body.error).toBe("stripe_already_connected");
      // The row as it stands, so a stale page can show it.
      expect(body.settings.stripeConnected).toBe(true);
      expect(body.settings.stripeConnectedByOsnProfileId).toBe(SECOND);
      expect(target(db)?.stripeAccountId).toBe("acct_first");
      expect(target(db)?.stripeConnectedByOsnProfileId).toBe(SECOND);
      expect(stripe.calls).toEqual([]);
      const logs = await captureLogs(async () => {
        await reuse(app, { fromWeddingId: SOURCE });
      });
      expect(logs).toContain("already_connected");
    });

    it("answers a wedding named as its own source as already connected", async () => {
      const { app, db } = buildApp();
      targetConnected(db, OWNER);
      const res = await reuse(app, { fromWeddingId: BOOTSTRAP_WEDDING_ID });
      expect(res.status).toBe(409);
      expect(((await jsonBody(res)) as { error: string }).error).toBe("stripe_already_connected");
      expect(target(db)?.stripeAccountId).toBe("acct_first");
    });

    it.each([
      // The wedding's second owner is not an owner of the source: once the
      // account were here, they could remove its connector and keep it.
      [
        "sit beside an owner who is not on its own wedding",
        { owners: [OWNER] },
        "stripe_owners_differ",
        "owners_differ",
      ],
      [
        "pay out in another currency",
        { currency: "USD" },
        "currency_mismatch",
        "currency_mismatch",
      ],
    ] as const)(
      "refuses an account that would %s, with the settings as they stand",
      async (_label, source, error, reason) => {
        const { app, db } = buildApp();
        sourceWedding(db, source);

        let res: Response | undefined;
        const logs = await captureLogs(async () => {
          res = await reuse(app, { fromWeddingId: SOURCE });
        });

        expect(res?.status).toBe(409);
        const body = (await jsonBody(res!)) as {
          error: string;
          settings?: Record<string, unknown>;
        };
        expect(body.error).toBe(error);
        // The page that asked is out of date, so it is handed the row as it is.
        expect(body.settings?.weddingId).toBe(BOOTSTRAP_WEDDING_ID);
        expect(body.settings?.stripeConnected).toBe(false);
        expect(target(db)).toBeUndefined();
        expect(logs).toContain("stripe account reuse refused");
        expect(logs).toContain(reason);
      },
    );

    it("refuses a body that names no wedding", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);
      for (const body of [
        { accountId: SHARED },
        {},
        { fromWeddingId: "" },
        { fromWeddingId: "w".repeat(65) },
        { fromWeddingId: 7 },
        "not json",
      ]) {
        const res = await reuse(app, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
      }
      // Sixty-four characters is a wedding id the route will look for.
      const longest = await reuse(app, { fromWeddingId: "w".repeat(64) });
      expect(longest.status).toBe(404);
      expect(target(db)).toBeUndefined();
    });

    it("refuses a target the caller stopped owning, or that went away, after the gate", async () => {
      // The route's gate read the seat in its own query; the write checks it
      // again, so a demotion or a delete in between attaches nothing.
      for (const change of ["demoted", "deleted"] as const) {
        const { db } = buildApp();
        sourceWedding(db);
        if (change === "demoted") {
          db.update(weddingHosts)
            .set({ role: "editor" })
            .where(eq(weddingHosts.osnProfileId, OWNER))
            .run();
          // The source seat must stay an owner's for this to test the target.
          db.update(weddingHosts)
            .set({ role: "owner" })
            .where(eq(weddingHosts.weddingId, SOURCE))
            .run();
        } else {
          db.update(weddings)
            .set({ deletedAt: new Date() })
            .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
            .run();
        }
        const outcome = await Effect.runPromise(
          registryService
            .adoptStripeAccount(BOOTSTRAP_WEDDING_ID, SOURCE, OWNER, { takesPayments: false })
            .pipe(
              Effect.map(() => "attached"),
              Effect.catchTag("StripeAccountNotFound", () => Effect.succeed("not_found")),
              Effect.provideService(DbService, db),
            ),
        );
        expect(outcome, change).toBe("not_found");
        expect(target(db), change).toBeUndefined();
      }
    });

    it("tells a caller who lost this wedding nothing about it, whatever else fails", async () => {
      // Two rules fail at once: the caller was demoted here after the gate,
      // and the target already has an account (or the source's owners
      // differ). Either 409 would hand them this wedding's settings.
      for (const second of ["already_connected", "owners_differ"] as const) {
        const { db } = buildApp();
        sourceWedding(db, second === "owners_differ" ? { owners: [OWNER] } : {});
        if (second === "already_connected") targetConnected(db, SECOND);
        db.update(weddingHosts)
          .set({ role: "editor" })
          .where(
            and(
              eq(weddingHosts.weddingId, BOOTSTRAP_WEDDING_ID),
              eq(weddingHosts.osnProfileId, OWNER),
            ),
          )
          .run();
        const outcome = await Effect.runPromise(
          registryService
            .adoptStripeAccount(BOOTSTRAP_WEDDING_ID, SOURCE, OWNER, { takesPayments: false })
            .pipe(
              Effect.map(() => "attached"),
              Effect.catchTags({
                StripeAccountNotFound: () => Effect.succeed("not_found"),
                StripeAlreadyConnected: () => Effect.succeed("already_connected"),
                StripeOwnersDiffer: () => Effect.succeed("owners_differ"),
              }),
              Effect.provideService(DbService, db),
            ),
        );
        expect(outcome, second).toBe("not_found");
      }
    });

    it("judges what guests are offered against the wedding's own currency", async () => {
      // A New Zealand wedding taking an account that settles in NZD, on a site
      // that takes money gifts: the answer says only that money is off.
      const { app, db } = buildApp({ stripeWebhookSecret: "whsec_test" });
      db.update(weddings)
        .set({ currency: "NZD" })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
        .run();
      sourceWedding(db, { currency: "NZD" });

      const res = await reuse(app, { fromWeddingId: SOURCE });

      expect(res.status).toBe(200);
      const body = (await jsonBody(res)) as { settings: Record<string, unknown> };
      expect(body.settings.moneyGiftsBlockedBy).toBe("cash_gifts_off");
    });

    it("answers 500, and logs the wedding, when the database fails", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);
      db.$client.run("DROP TABLE registry_settings");
      let reused: Response | undefined;
      let listed: Response | undefined;
      const logs = await captureLogs(async () => {
        reused = await reuse(app, { fromWeddingId: SOURCE });
        listed = await accounts(app);
      });
      for (const res of [reused, listed]) {
        expect(res?.status).toBe(500);
        expect(await jsonBody(res!)).toEqual({ error: "Internal error" });
      }
      expect(logs).toContain("registry stripe handler defect");
      expect(logs).toContain(BOOTSTRAP_WEDDING_ID);
    });

    it("keeps a reused account in step with its source when a create loses the race", async () => {
      // The second owner pressed Connect; while their create was at Stripe,
      // the first owner gave the wedding the shared account. The create's
      // attach keeps it — and keeps the source's view of it, so an
      // `account.updated` Stripe sent in between still reaches both rows.
      const box: { db?: Built["db"] } = {};
      // The row as the reuse leaves it: the source's account, connector and
      // view of the account. (The stub's hook runs synchronously.)
      const reused = () => {
        const now = new Date();
        box
          .db!.insert(registrySettings)
          .values({
            weddingId: BOOTSTRAP_WEDDING_ID,
            stripeAccountId: SHARED,
            stripeConnectedByOsnProfileId: OWNER,
            stripeChargesEnabled: true,
            stripePayoutsEnabled: true,
            stripeDefaultCurrency: "AUD",
            stripeAccountUpdatedAt: STAMP,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      };
      const stripe = stripeStub({ duringCreate: reused });
      const built = buildApp({ stripe: stripe.client });
      box.db = built.db;
      sourceWedding(built.db);

      expect((await req(built.app, `${base}/session`, SECOND)).status).toBe(403);
      expect(target(built.db)?.stripeAccountId).toBe(SHARED);
      expect(target(built.db)?.stripeConnectedByOsnProfileId).toBe(OWNER);
      expect(target(built.db)?.stripeAccountUpdatedAt?.getTime()).toBe(STAMP.getTime());

      const matched = await Effect.runPromise(
        registryService
          .applyStripeAccountState({
            id: SHARED,
            chargesEnabled: false,
            payoutsEnabled: false,
            observedAt: STAMP.getTime() / 1000 + 60,
          })
          .pipe(Effect.provideService(DbService, built.db)),
      );
      expect(matched).toBe(true);
      expect(target(built.db)?.stripeChargesEnabled).toBe(false);
      expect(settingsOf(built.db, SOURCE)?.stripeChargesEnabled).toBe(false);
    });
  });

  describe("who may", () => {
    it("refuses an editor, a stranger and anyone with no token, on both routes", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);
      expect((await reuse(app, { fromWeddingId: SOURCE }, EDITOR)).status).toBe(403);
      expect((await reuse(app, { fromWeddingId: SOURCE }, STRANGER)).status).toBe(403);
      expect((await reuse(app, { fromWeddingId: SOURCE }, null)).status).toBe(401);
      expect((await accounts(app, EDITOR)).status).toBe(403);
      expect((await accounts(app, STRANGER)).status).toBe(403);
      expect((await accounts(app, null)).status).toBe(401);
      expect(target(db)).toBeUndefined();
    });

    it("refuses a viewer and a co-host on the old host role, on both routes", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);
      const now = new Date();
      db.insert(weddingHosts)
        .values([
          {
            id: "whost_viewer",
            weddingId: BOOTSTRAP_WEDDING_ID,
            osnProfileId: "usr_viewer",
            addedByOsnProfileId: OWNER,
            role: "viewer",
            createdAt: now,
          },
          {
            id: "whost_legacy_host",
            weddingId: BOOTSTRAP_WEDDING_ID,
            osnProfileId: "usr_legacy_host",
            addedByOsnProfileId: OWNER,
            role: "host",
            createdAt: now,
          },
        ])
        .run();
      for (const who of ["usr_viewer", "usr_legacy_host"]) {
        expect((await reuse(app, { fromWeddingId: SOURCE }, who)).status, who).toBe(403);
        expect((await accounts(app, who)).status, who).toBe(403);
      }
      expect(target(db)).toBeUndefined();
    });

    it("asks for a live credential, by bearer token or session cookie", async () => {
      const { app, db } = buildApp();
      sourceWedding(db);
      const token = await seedOrganiserSession(db, OWNER);
      const call = (path: "accounts" | "reuse", headers: Record<string, string>) =>
        appRequest(
          app,
          `${base}/${path}`,
          path === "accounts"
            ? { method: "GET", headers }
            : {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ fromWeddingId: SOURCE }),
              },
        );
      for (const path of ["accounts", "reuse"] as const) {
        expect((await call(path, { Authorization: "Bearer not-a-jwt" })).status, path).toBe(401);
        expect(
          (await call(path, { cookie: "cire_org_session=not-a-live-session-token" })).status,
          path,
        ).toBe(401);
      }
      expect(target(db)).toBeUndefined();
      expect((await call("accounts", { cookie: `cire_org_session=${token}` })).status).toBe(200);
      expect((await call("reuse", { cookie: `cire_org_session=${token}` })).status).toBe(200);
      expect(target(db)?.stripeAccountId).toBe(SHARED);
    });

    it("refuses a wedding below Gold with 402", async () => {
      const { app, db } = buildApp({ tier: "ivory" });
      sourceWedding(db);
      expect((await reuse(app, { fromWeddingId: SOURCE })).status).toBe(402);
      expect((await accounts(app)).status).toBe(402);
    });

    it("does not exist when Stripe is not configured", async () => {
      const { app, db } = buildApp({ stripe: null });
      sourceWedding(db);
      expect((await reuse(app, { fromWeddingId: SOURCE })).status).toBe(404);
      expect((await accounts(app)).status).toBe(404);
    });
  });

  describe("the accounts an owner is offered", () => {
    type Listed = {
      fromWeddingId: string;
      weddingNames: string[];
      chargesEnabled: boolean;
      currencyKnown: boolean;
      blockedBy: string | null;
    };

    it("lists each account the caller connected on a wedding they own, once, and nothing else", async () => {
      const { app, db } = buildApp();
      // One account on two weddings: offered once, under both names.
      sourceWedding(db, { id: "wed_ceremony", displayName: "Ceremony" });
      sourceWedding(db, { id: "wed_beach", displayName: "Beach" });
      // Ready to use, but this wedding's second owner is not an owner there.
      sourceWedding(db, {
        id: "wed_solo",
        displayName: "Solo",
        owners: [OWNER],
        accountId: "acct_solo",
      });
      // Pays out in another currency.
      sourceWedding(db, {
        id: "wed_abroad",
        displayName: "Abroad",
        accountId: "acct_usd",
        currency: "USD",
      });
      // Not yet onboarded: no currency yet.
      sourceWedding(db, {
        id: "wed_new",
        displayName: "New",
        accountId: "acct_new_one",
        currency: null,
        chargesEnabled: false,
      });
      // Never offered: another owner's, nobody's, a wedding the caller left,
      // and a deleted one.
      sourceWedding(db, { id: "wed_partner", connector: SECOND, accountId: "acct_partner" });
      sourceWedding(db, { id: "wed_nobody", connector: null, accountId: "acct_nobody" });
      sourceWedding(db, { id: "wed_left", owners: [SECOND], accountId: "acct_left" });
      sourceWedding(db, { id: "wed_gone", deletedAt: new Date(), accountId: "acct_gone" });

      const res = await accounts(app);

      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as { accounts: Listed[] };
      expect(body.accounts).toEqual([
        {
          fromWeddingId: "wed_abroad",
          weddingNames: ["Abroad"],
          chargesEnabled: true,
          currencyKnown: true,
          blockedBy: "currency_mismatch",
        },
        {
          fromWeddingId: "wed_beach",
          weddingNames: ["Beach", "Ceremony"],
          chargesEnabled: true,
          currencyKnown: true,
          blockedBy: null,
        },
        {
          fromWeddingId: "wed_new",
          weddingNames: ["New"],
          chargesEnabled: false,
          currencyKnown: false,
          blockedBy: null,
        },
        {
          fromWeddingId: "wed_solo",
          weddingNames: ["Solo"],
          chargesEnabled: true,
          currencyKnown: true,
          blockedBy: "stripe_owners_differ",
        },
      ]);
      // No account id and no currency reach the browser.
      expect(raw).not.toContain("acct_");
      expect(raw).not.toContain("AUD");
      expect(raw).not.toContain("USD");
    });

    it("names a wedding the account can be taken from, when the first by name cannot", async () => {
      const { app, db } = buildApp();
      // One account on two weddings: "Aardvark" (where this wedding's second
      // owner is not an owner) sorts first, "Zebra" (where they are) last.
      sourceWedding(db, { id: "wed_aardvark", displayName: "Aardvark", owners: [OWNER] });
      sourceWedding(db, { id: "wed_zebra", displayName: "Zebra" });

      const body = (await jsonBody(await accounts(app))) as { accounts: Listed[] };

      expect(body.accounts).toEqual([
        {
          fromWeddingId: "wed_zebra",
          weddingNames: ["Aardvark", "Zebra"],
          chargesEnabled: true,
          currencyKnown: true,
          blockedBy: null,
        },
      ]);
    });

    it("reads at most fifty weddings", async () => {
      const { app, db } = buildApp();
      for (let i = 0; i < 51; i++) {
        const n = String(i).padStart(2, "0");
        sourceWedding(db, {
          id: `wed_many_${n}`,
          displayName: `Many ${n}`,
          accountId: `acct_many_${n}`,
        });
      }
      const body = (await jsonBody(await accounts(app))) as { accounts: Listed[] };
      expect(body.accounts).toHaveLength(50);
      expect(body.accounts.at(-1)?.fromWeddingId).toBe("wed_many_49");
    });

    it("leaves out the wedding it is asked for", async () => {
      const { app, db } = buildApp();
      targetConnected(db, OWNER, SHARED);
      const res = await accounts(app);
      expect(await jsonBody(res)).toEqual({ accounts: [] });
    });

    it("asks Stripe nothing", async () => {
      const stripe = stripeStub();
      const { app, db } = buildApp({ stripe: stripe.client });
      sourceWedding(db);
      expect((await accounts(app)).status).toBe(200);
      expect(stripe.calls).toEqual([]);
    });
  });
});

/**
 * Retiring the wedding's account: the wedding stops naming it, and nothing at
 * Stripe changes. The holder hands money gifts to another owner or
 * disconnects; another owner replaces it, whether or not its holder still
 * holds an owner seat. A retire is a state change on the money path, so every
 * rule sits in the write, and the record of the account is written in the same
 * batch as the clear.
 */
describe("retiring the wedding's account", () => {
  type Built = ReturnType<typeof buildApp>;
  const retirePath = `${base}/retire`;
  const CONNECTED_AT = new Date("2026-10-01T00:00:00.000Z");

  async function retire(app: App, profileId: string | undefined, body: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
    return appRequest(app, retirePath, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  /** The bootstrap wedding's account, held by `holder` (null: nobody recorded). */
  function holding(
    db: Built["db"],
    holder: string | null,
    { weddingId = BOOTSTRAP_WEDDING_ID, accountId = "acct_old" } = {},
  ) {
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId,
        cashGiftsEnabled: true,
        stripeAccountId: accountId,
        stripeConnectedByOsnProfileId: holder,
        stripeAccountType: "standard",
        stripeConnectedAt: CONNECTED_AT,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        stripeDefaultCurrency: "AUD",
        stripeAccountUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const row = (db: Built["db"], weddingId = BOOTSTRAP_WEDDING_ID) =>
    db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).get();

  const retired = (db: Built["db"]) =>
    db.select().from(registryRetiredAccounts).orderBy(registryRetiredAccounts.retiredAt).all();

  const outcomeCount = (outcome: string) =>
    counterValue(CIRE_METRICS.registryStripeRetire, { outcome });

  describe("what a retire writes", () => {
    for (const [label, caller, holder, handTo, reason, by, handed] of [
      [
        "the holder hands money gifts to another owner",
        OWNER,
        OWNER,
        SECOND,
        "handed_over",
        "holder",
        "yes",
      ],
      ["the holder disconnects", OWNER, OWNER, null, "disconnected", "holder", "no"],
      [
        "another owner replaces a seated holder's account",
        SECOND,
        OWNER,
        null,
        "replaced",
        "other_owner",
        "no",
      ],
      [
        "an owner replaces an account whose holder sits below owner",
        OWNER,
        EDITOR,
        null,
        "holder_absent",
        "absent_holder",
        "no",
      ],
      [
        "an owner replaces an account nobody is recorded as holding",
        OWNER,
        null,
        null,
        "holder_absent",
        "absent_holder",
        "no",
      ],
    ] as const) {
      it(`records ${reason} when ${label}, and clears the row`, async () => {
        const { app, db } = buildApp({ stripeWebhookSecret: "whsec_test_connect" });
        holding(db, holder);
        const before = await outcomeCount(reason);

        let res: Response | undefined;
        const logs = await captureLogs(async () => {
          res = await retire(app, caller, { handTo });
        });

        expect(res?.status).toBe(200);
        const body = (await jsonBody(res!)) as { settings: Record<string, unknown> };
        expect(body.settings).toMatchObject({
          stripeConnected: false,
          stripeConnectedByOsnProfileId: null,
          stripeAccountType: null,
          stripeChargesEnabled: false,
          payoutHolderAbsent: false,
          // The switch is the couple's intent, and a retire leaves it.
          cashGiftsEnabled: true,
          moneyGiftsBlockedBy: "stripe_not_ready",
        });

        const after = row(db);
        expect(after).toMatchObject({
          stripeAccountId: null,
          stripeConnectedByOsnProfileId: null,
          stripeAccountType: null,
          stripeConnectedAt: null,
          stripeChargesEnabled: false,
          stripePayoutsEnabled: false,
          stripeDefaultCurrency: null,
          stripeAccountUpdatedAt: null,
          cashGiftsEnabled: true,
          // A retire is not a deauthorization, and records none.
          stripeDeauthorizedAt: null,
          stripeDeauthorizedAccountId: null,
        });
        expect(after?.stripeAccountGeneration).toBe(1);

        const records = retired(db);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          weddingId: BOOTSTRAP_WEDDING_ID,
          stripeAccountId: "acct_old",
          stripeAccountType: "standard",
          stripeConnectedAt: CONNECTED_AT,
          reason,
          releasedAt: null,
          lastHandBackAt: null,
        });
        expect(records[0]?.id).toMatch(/^rra_/);

        expect(logs).toContain("stripe account retired");
        expect(logs).toContain(`by: ${by}`);
        expect(logs).toContain(`handed: ${handed}`);
        // No profile id and no account id: the record row holds the account.
        for (const secret of ["acct_old", OWNER, SECOND, EDITOR]) {
          expect(logs).not.toContain(secret);
        }
        expect(await outcomeCount(reason)).toBe(before + 1);
      });
    }

    it("retires on a wedding below Gold: it calls Stripe for nothing", async () => {
      const stripe = stripeStub();
      const { app, db } = buildApp({ tier: "ivory", stripe: stripe.client });
      holding(db, OWNER);
      expect((await retire(app, OWNER, { handTo: null })).status).toBe(200);
      expect(row(db)?.stripeAccountId).toBeNull();
      expect(stripe.calls).toEqual([]);
    });

    it("exists on a deployment with no Stripe key", async () => {
      const { app, db } = buildApp({ stripe: null });
      holding(db, OWNER);
      expect((await retire(app, OWNER, { handTo: null })).status).toBe(200);
      expect(retired(db)).toHaveLength(1);
    });

    it("leaves another wedding that names the same account as it was", async () => {
      const { app, db } = buildApp();
      insertWedding(db, {
        id: "wed_other",
        slug: "other-wedding",
        displayName: "Other",
        owners: [OWNER],
      });
      holding(db, OWNER, { weddingId: "wed_other", accountId: "acct_shared" });
      holding(db, OWNER, { accountId: "acct_shared" });

      expect((await retire(app, OWNER, { handTo: null })).status).toBe(200);

      expect(row(db, "wed_other")?.stripeAccountId).toBe("acct_shared");
      expect(row(db, "wed_other")?.stripeConnectedByOsnProfileId).toBe(OWNER);
      // And what Stripe says about the account still reaches it.
      const later = Math.floor(Date.now() / 1000) + 60;
      const matched = await Effect.runPromise(
        registryService
          .applyStripeAccountState({
            id: "acct_shared",
            chargesEnabled: false,
            payoutsEnabled: true,
            observedAt: later,
          })
          .pipe(Effect.provideService(DbService, db)),
      );
      expect(matched).toBe(true);
      expect(row(db, "wed_other")?.stripeChargesEnabled).toBe(false);
      expect(row(db)?.stripeChargesEnabled).toBe(false);
      expect(row(db)?.stripeAccountId).toBeNull();
    });

    it("asks Stripe for a new account on the next Connect, not the retired one", async () => {
      const fetchKeys: string[] = [];
      const byKey = new Map<string, string>();
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        if (url.endsWith("/v1/accounts") && init?.method === "POST") {
          const key = new Headers(init.headers).get("idempotency-key") ?? "";
          fetchKeys.push(key);
          if (!byKey.has(key)) byKey.set(key, `acct_made_${byKey.size + 1}`);
          return json({
            id: byKey.get(key),
            charges_enabled: false,
            payouts_enabled: false,
            details_submitted: false,
          });
        }
        if (url.endsWith("/v1/account_links") && init?.method === "POST") {
          return json({ url: "https://connect.stripe.test/setup/x", expires_at: 1_800_000_000 });
        }
        throw new Error(`not part of this test: ${init?.method} ${url}`);
      }) as unknown as typeof fetch;
      const client = createStripeClient({
        secretKey: "sk_test",
        apiBase: "https://stripe.test",
        fetchImpl,
      });
      const { app, db } = buildApp({ stripe: client });

      expect((await req(app, `${base}/session`, OWNER)).status).toBe(200);
      expect(row(db)?.stripeAccountId).toBe("acct_made_1");
      expect((await retire(app, OWNER, { handTo: SECOND })).status).toBe(200);
      expect((await req(app, `${base}/session`, SECOND)).status).toBe(200);

      expect(fetchKeys).toEqual([
        `cire-account-${BOOTSTRAP_WEDDING_ID}-0`,
        `cire-account-${BOOTSTRAP_WEDDING_ID}-1`,
      ]);
      expect(row(db)?.stripeAccountId).toBe("acct_made_2");
      expect(row(db)?.stripeConnectedByOsnProfileId).toBe(SECOND);
    });
  });

  describe("who may", () => {
    it("refuses an editor, a stranger and anyone with no token", async () => {
      const { app, db } = buildApp();
      holding(db, OWNER);
      const editor = await retire(app, EDITOR, { handTo: null });
      expect(editor.status).toBe(403);
      expect(await jsonBody(editor)).toEqual({ error: "forbidden" });
      expect((await retire(app, STRANGER, { handTo: null })).status).toBe(403);
      expect((await retire(app, undefined, { handTo: null })).status).toBe(401);
      expect(row(db)?.stripeAccountId).toBe("acct_old");
      expect(retired(db)).toEqual([]);
    });

    it("lets only the holder name an owner to hand money gifts to", async () => {
      const { app, db } = buildApp();
      holding(db, OWNER);
      const before = await outcomeCount("handover_not_owner");
      let res: Response | undefined;
      const logs = await captureLogs(async () => {
        res = await retire(app, SECOND, { handTo: OWNER });
      });
      expect(res?.status).toBe(409);
      expect(await jsonBody(res!)).toEqual({ error: "handover_not_owner" });
      expect(row(db)?.stripeAccountId).toBe("acct_old");
      expect(retired(db)).toEqual([]);
      expect(logs).toContain("stripe account retire refused");
      expect(logs).toContain("handover_not_owner");
      for (const secret of ["acct_old", OWNER, SECOND]) expect(logs).not.toContain(secret);
      expect(await outcomeCount("handover_not_owner")).toBe(before + 1);
    });

    for (const [label, handTo] of [
      ["an editor", EDITOR],
      ["a profile with no seat", "usr_nobody"],
      ["the holder themself", OWNER],
    ] as const) {
      it(`refuses a hand-over to ${label}`, async () => {
        const { app, db } = buildApp();
        holding(db, OWNER);
        const res = await retire(app, OWNER, { handTo });
        expect(res.status).toBe(409);
        expect(await jsonBody(res)).toEqual({ error: "handover_not_owner" });
        expect(row(db)?.stripeAccountId).toBe("acct_old");
        expect(row(db)?.stripeAccountGeneration).toBe(0);
        expect(retired(db)).toEqual([]);
      });
    }

    it("spends the per-organiser budget, after the owner gate", async () => {
      const { app, db } = buildApp({
        limiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
      });
      holding(db, OWNER);
      expect((await retire(app, STRANGER, { handTo: null })).status).toBe(403);
      expect((await retire(app, OWNER, { handTo: null })).status).toBe(200);
      expect((await retire(app, OWNER, { handTo: null })).status).toBe(429);
    });

    it("refuses a body that does not say whom money gifts go to", async () => {
      const { app, db } = buildApp();
      holding(db, OWNER);
      const bodies = [{}, { handTo: 7 }, { handTo: "" }, { handTo: "x".repeat(65) }, "{"];
      const before = await outcomeCount("invalid");
      for (const body of bodies) {
        const res = await retire(app, OWNER, body);
        expect(res.status).toBe(400);
        expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
      }
      expect(await outcomeCount("invalid")).toBe(before + bodies.length);
      expect(row(db)?.stripeAccountId).toBe("acct_old");
      expect(retired(db)).toEqual([]);
    });
  });

  describe("an account that changed under the request", () => {
    it("answers stripe_account_changed, with the settings, for a wedding with no account", async () => {
      const { app, db } = buildApp();
      const res = await retire(app, OWNER, { handTo: null });
      expect(res.status).toBe(409);
      const body = (await jsonBody(res)) as {
        error: string;
        settings: { stripeConnected: boolean };
      };
      expect(body.error).toBe("stripe_account_changed");
      expect(body.settings.stripeConnected).toBe(false);
      expect(retired(db)).toEqual([]);
      expect(await outcomeCount("account_changed")).toBeGreaterThan(0);
    });

    it("says the account changed before it judges whom the holder named", async () => {
      // A page holding an account another owner has since retired, naming an
      // editor: the page is out of date, and that is what it is told, with
      // the settings to catch up from.
      const { app, db } = buildApp();
      holding(db, OWNER);
      db.update(registrySettings)
        .set({ stripeAccountId: null, stripeConnectedByOsnProfileId: null })
        .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
        .run();
      const before = await outcomeCount("account_changed");
      const res = await retire(app, OWNER, { handTo: EDITOR });
      expect(res.status).toBe(409);
      const body = (await jsonBody(res)) as { error: string; settings?: unknown };
      expect(body.error).toBe("stripe_account_changed");
      expect(body.settings).toBeDefined();
      expect(await outcomeCount("account_changed")).toBe(before + 1);
    });

    it("refuses an owner removed after the gate with 403, writing nothing", async () => {
      const { app, db } = buildApp();
      holding(db, OWNER);
      beforeStatement(db, /^insert into "registry_retired_accounts"/, () => {
        db.update(weddingHosts)
          .set({ role: "editor" })
          .where(eq(weddingHosts.osnProfileId, SECOND))
          .run();
      });
      const before = await outcomeCount("forbidden");
      let res: Response | undefined;
      const logs = await captureLogs(async () => {
        res = await retire(app, SECOND, { handTo: null });
      });
      expect(res?.status).toBe(403);
      expect(await jsonBody(res!)).toEqual({ error: "forbidden" });
      expect(row(db)?.stripeAccountId).toBe("acct_old");
      expect(retired(db)).toEqual([]);
      expect(logs).toContain("stripe account retire refused");
      expect(logs).toContain("refusal: forbidden");
      expect(await outcomeCount("forbidden")).toBe(before + 1);
    });

    it("answers 500, logging the wedding alone, when the database fails", async () => {
      const { app, db } = buildApp();
      holding(db, OWNER);
      db.$client.exec("DROP TABLE registry_retired_accounts");
      let res: Response | undefined;
      const logs = await captureLogs(async () => {
        res = await retire(app, OWNER, { handTo: null });
      });
      expect(res?.status).toBe(500);
      expect(await jsonBody(res!)).toEqual({ error: "Internal error" });
      expect(logs).toContain("registry stripe handler defect");
      expect(row(db)?.stripeAccountId).toBe("acct_old");
    });

    it("retires nothing when another account was connected after the route read the row", async () => {
      const { app, db } = buildApp();
      holding(db, OWNER);
      // Between the read and the batch: the account is cleared and another
      // connected, as two owners replacing at once, or a deauthorization and
      // a reconnect, would leave it.
      beforeStatement(db, /^insert into "registry_retired_accounts"/, () => {
        db.update(registrySettings)
          .set({ stripeAccountId: null })
          .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
          .run();
        db.update(registrySettings)
          .set({ stripeAccountId: "acct_newer", stripeConnectedByOsnProfileId: SECOND })
          .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
          .run();
      });
      const res = await retire(app, OWNER, { handTo: null });
      expect(res.status).toBe(409);
      const body = (await jsonBody(res)) as {
        error: string;
        settings: { stripeConnected: boolean; stripeConnectedByOsnProfileId: string | null };
      };
      expect(body.error).toBe("stripe_account_changed");
      expect(body.settings.stripeConnectedByOsnProfileId).toBe(SECOND);
      expect(row(db)?.stripeAccountId).toBe("acct_newer");
      expect(retired(db)).toEqual([]);
    });

    it("records the standing the write saw, not the one the route read", async () => {
      // The holder's record is cleared between the read and the batch, as an
      // account erasure clears it: the retire is of an absent holder's account.
      const mail = makeLogEmailLive();
      const { app, db } = buildApp({
        options: {
          organiserEmailLookup: async (ids) => ({
            answered: true,
            emails: new Map(ids.map((id) => [id, `${id}@example.test`] as const)),
          }),
          emailLayer: mail.layer,
        },
      });
      holding(db, OWNER);
      beforeStatement(db, /^insert into "registry_retired_accounts"/, () => {
        db.update(registrySettings)
          .set({ stripeConnectedByOsnProfileId: null })
          .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
          .run();
      });
      let res: Response | undefined;
      const logs = await captureLogs(async () => {
        res = await retire(app, SECOND, { handTo: null });
      });
      expect(res?.status).toBe(200);
      expect(retired(db)[0]?.reason).toBe("holder_absent");
      expect(logs).toContain("by: absent_holder");
      // Every owner reads the absent-holder words; no one is told it was theirs.
      const sent = mail.recorded();
      expect(sent.length).toBeGreaterThan(0);
      expect(
        sent.every((m) => m.text.includes("None of the wedding's owners had connected it")),
      ).toBe(true);
      expect(sent.some((m) => m.text.includes("the Stripe account you connected"))).toBe(false);
      expect(
        sent.some((m) => m.text.includes("Gifts already given stay in your Stripe account")),
      ).toBe(false);
    });
  });

  describe("telling the owners", () => {
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    function noticeApp() {
      const mail = makeLogEmailLive();
      const built = buildApp({
        options: {
          organiserEmailLookup: async (ids) => ({
            answered: true,
            emails: new Map(ids.map((id) => [id, `${id}@example.test`] as const)),
          }),
          emailLayer: mail.layer,
        },
      });
      // The second owner was seated long enough ago to be mailed.
      built.db
        .update(weddingHosts)
        .set({ createdAt: longAgo })
        .where(eq(weddingHosts.osnProfileId, SECOND))
        .run();
      return { ...built, mail };
    }

    it("mails every owner once after a retire, and no one else", async () => {
      const { app, db, mail } = noticeApp();
      holding(db, OWNER);
      expect((await retire(app, OWNER, { handTo: SECOND })).status).toBe(200);
      const sent = mail.recorded();
      expect(sent.every((m) => m.template === "registry-payout-retired")).toBe(true);
      expect(sent.map((m) => m.to).toSorted()).toEqual(
        [`${OWNER}@example.test`, `${SECOND}@example.test`].toSorted(),
      );
      // The owner money gifts were handed to is spoken to.
      const named = sent.find((m) => m.to === `${SECOND}@example.test`);
      expect(named?.text).toContain("and asked you to connect the next one.");
    });

    it("tells the seated holder whose account another owner replaced that it was theirs", async () => {
      const { app, db, mail } = noticeApp();
      holding(db, SECOND);
      expect((await retire(app, OWNER, { handTo: null })).status).toBe(200);
      const holder = mail.recorded().find((m) => m.to === `${SECOND}@example.test`);
      expect(holder?.text).toContain("disconnected the Stripe account you connected");
      expect(holder?.text).toContain("Gifts already given stay in your Stripe account");
    });

    it("mails no one when the retire is refused", async () => {
      const { app, db, mail } = noticeApp();
      holding(db, OWNER);
      expect((await retire(app, OWNER, { handTo: EDITOR })).status).toBe(409);
      expect((await retire(app, EDITOR, { handTo: null })).status).toBe(403);
      expect(mail.recorded()).toEqual([]);
    });
  });
});
