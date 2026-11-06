import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  registrySettings,
  registryStripeOAuthStates,
  weddingHosts,
  weddings,
} from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { registryService } from "../../src/services/registry";
import { StripeError, type StripeAccount, type StripeClient } from "../../src/services/stripe";
import { OAuthReplyError, type StripeConnectOAuth } from "../../src/services/stripe-connect-oauth";
import type { Tier } from "../../src/services/tiers";
import { appRequest, jsonBody, setTier } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding, ownerSeat } from "../test-helpers/wedding";

/**
 * Connecting a Stripe account the couple already have, through Stripe Connect
 * OAuth. Each case below is one way the connect must refuse, from the failure
 * list written before the code (NEW-FEAT.md):
 *
 *   - a `state` is good once, for the owner who started it, for the wedding it
 *     names, inside its time — and a bad one never reaches Stripe, where a
 *     code exchanged twice revokes the connection;
 *   - the callback answers a redirect to the portal, built from configuration
 *     and cire's own row, never from the query;
 *   - an account already on another wedding joins only where the reuse rules
 *     let it (the planner case is englishstreetventures/osn#2018's);
 *   - only `stripe_user_id` is kept, and an account cire connected and cannot
 *     use is handed back — unless another wedding uses it.
 */

const OWNER = "usr_dev_bootstrap_owner";
const SECOND = "usr_second_owner";
const EDITOR = "usr_editor";
const STRANGER = "usr_stranger";
const ORGANISER = "https://host.test";
const CALLBACK = "/api/organiser/stripe/oauth/callback";
const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry/stripe`;

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

const STANDARD: StripeAccount = {
  id: "acct_standard",
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  defaultCurrency: "AUD",
  type: "standard",
};

/** An OAuth client that records what it was asked. */
function oauthStub(
  overrides: {
    accountId?: string;
    exchange?: () => Effect.Effect<{ accountId: string }, StripeError | OAuthReplyError>;
    /** Runs while the exchange is in flight: another request's write. */
    duringExchange?: () => void;
    failDeauthorize?: boolean;
    /** Runs while Stripe is revoking: another request's write. */
    duringDeauthorize?: () => void;
  } = {},
) {
  const exchanged: string[] = [];
  const deauthorized: string[] = [];
  const client: StripeConnectOAuth = {
    clientId: "ca_test",
    redirectUri: `https://api.test${CALLBACK}`,
    authorizeUrl(state) {
      const url = new URL("https://connect.stripe.com/oauth/authorize");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", "ca_test");
      url.searchParams.set("scope", "read_write");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", `https://api.test${CALLBACK}`);
      return url.toString();
    },
    exchangeCode(code) {
      exchanged.push(code);
      overrides.duringExchange?.();
      return overrides.exchange
        ? overrides.exchange()
        : Effect.succeed({ accountId: overrides.accountId ?? STANDARD.id });
    },
    deauthorize(accountId) {
      deauthorized.push(accountId);
      overrides.duringDeauthorize?.();
      return overrides.failDeauthorize
        ? Effect.fail(new StripeError({ reason: "unreachable" }))
        : Effect.void;
    },
  };
  return { client, exchanged, deauthorized };
}

/** The API client: only `retrieveAccount` is part of the connect. */
function stripeStub(account: StripeAccount | null = STANDARD) {
  const calls: string[] = [];
  const refuse = () => Effect.fail(new StripeError({ reason: "not used here" }));
  const client: StripeClient = {
    createAccount: refuse,
    createAccountLink(input) {
      calls.push(`createAccountLink:${input.accountId}`);
      return Effect.succeed({ url: "https://connect.stripe.test/setup/x", expiresAt: 1 });
    },
    retrieveAccount(accountId) {
      calls.push(`retrieveAccount:${accountId}`);
      return account
        ? Effect.succeed({ ...account, id: accountId })
        : Effect.fail(new StripeError({ reason: "unreachable" }));
    },
    createCheckoutSession: () => Effect.die(new Error("not part of the connect")),
    retrieveCheckoutSession: () => Effect.die(new Error("not part of the connect")),
    createPlatformCheckoutSession: refuse,
    retrievePlatformCheckoutSession: refuse,
    expirePlatformCheckoutSession: refuse,
    createPlatformRefund: refuse,
    findPlatformRefund: refuse,
    retrievePrice: refuse,
  };
  return { client, calls };
}

function buildApp(
  options: {
    oauth?: StripeConnectOAuth | null;
    stripe?: StripeClient;
    tier?: Tier;
    callbackLimiter?: ReturnType<typeof createRateLimiter>;
  } = {},
) {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddingHosts)
    .values([
      { ...ownerSeat(BOOTSTRAP_WEDDING_ID, SECOND), addedByOsnProfileId: OWNER },
      {
        id: "whost_editor",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: EDITOR,
        addedByOsnProfileId: OWNER,
        role: "editor",
        createdAt: new Date(),
      },
    ])
    .run();
  setTier(db, BOOTSTRAP_WEDDING_ID, options.tier ?? "gold");
  const oauth = options.oauth === undefined ? oauthStub().client : options.oauth;
  const app = createApp(db, {
    osnTestKey: auth.key,
    organiserOrigin: `${ORGANISER}/`,
    stripe: options.stripe ?? stripeStub().client,
    stripeConnectOAuth: oauth,
    registryStripeLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    stripeOAuthCallbackLimiter:
      options.callbackLimiter ?? createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, db };
}
type App = ReturnType<typeof buildApp>["app"];

async function post(app: App, path: string, profileId?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "POST", headers });
}

/** Start a connect as `profileId` and return the state it minted. */
async function start(app: App, profileId = OWNER): Promise<string> {
  const res = await post(app, `${base}/oauth`, profileId);
  expect(res.status).toBe(200);
  const { url } = (await jsonBody(res)) as { url: string };
  return new URL(url).searchParams.get("state") ?? "";
}

interface Landing {
  status: number;
  location: URL;
  outcome: string | null;
  cacheControl: string | null;
}

/** The callback as Stripe's redirect reaches it, signed in as `profileId`. */
async function callback(
  app: App,
  params: Record<string, string>,
  who: { profileId?: string; cookie?: string } = { profileId: OWNER },
): Promise<Landing> {
  const query = new URLSearchParams(params);
  const headers: Record<string, string> = {};
  if (who.profileId) headers.Authorization = `Bearer ${await auth.sign(who.profileId)}`;
  if (who.cookie) headers.cookie = who.cookie;
  // A top-level navigation: a GET with no Origin header.
  const res = await appRequest(app, `${CALLBACK}?${query.toString()}`, {
    method: "GET",
    headers: { ...headers, origin: "" },
  });
  const location = new URL(res.headers.get("location") ?? "about:blank");
  return {
    status: res.status,
    location,
    outcome: location.searchParams.get("stripe_connect"),
    cacheControl: res.headers.get("cache-control"),
  };
}

const settingsRow = (db: TestDb, weddingId = BOOTSTRAP_WEDDING_ID) =>
  db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).get();

const stateRows = (db: TestDb) => db.select().from(registryStripeOAuthStates).all();

/** A settings row with no account, as a wedding that opened its registry has. */
function openedRegistry(db: TestDb, weddingId = BOOTSTRAP_WEDDING_ID) {
  const now = new Date();
  db.insert(registrySettings).values({ weddingId, createdAt: now, updatedAt: now }).run();
}

/** A second wedding naming `accountId`, connected by `connector`, owned by `owners`. */
function otherWeddingWith(db: TestDb, accountId: string, connector: string, owners: string[]) {
  const now = new Date();
  insertWedding(db, { id: "wed_other", slug: "other-wedding", displayName: "Other", owners });
  db.insert(registrySettings)
    .values({
      weddingId: "wed_other",
      stripeAccountId: accountId,
      stripeConnectedByOsnProfileId: connector,
      stripeAccountType: "standard",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDefaultCurrency: "AUD",
      stripeAccountUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("starting a connect", () => {
  it("sends the owner to Stripe's authorize page with a state bound to them (17)", async () => {
    const { app, db } = buildApp();
    const res = await post(app, `${base}/oauth`, OWNER);
    expect(res.status).toBe(200);
    const url = new URL(((await jsonBody(res)) as { url: string }).url);
    expect(url.origin).toBe("https://connect.stripe.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("ca_test");
    expect(url.searchParams.get("scope")).toBe("read_write");
    expect(url.searchParams.get("redirect_uri")).toBe(`https://api.test${CALLBACK}`);
    const state = url.searchParams.get("state") ?? "";
    expect(state).toMatch(new RegExp(`^${BOOTSTRAP_WEDDING_ID}\\.[A-Za-z0-9_-]{43}$`));
    const [row] = stateRows(db);
    // Only the hash is kept.
    expect(row?.osnProfileId).toBe(OWNER);
    expect(row?.stateHash).not.toContain(state.split(".")[1] ?? "x");
    expect(row?.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replaces the owner's earlier state when they start again (17)", async () => {
    const { app, db } = buildApp();
    const first = await start(app);
    const second = await start(app);
    expect(second).not.toBe(first);
    expect(stateRows(db)).toHaveLength(1);
    expect((await callback(app, { state: first, code: "ac_1" })).outcome).toBe("expired");
  });

  it("refuses an editor and a stranger (6)", async () => {
    const { app, db } = buildApp();
    expect((await post(app, `${base}/oauth`, EDITOR)).status).toBe(403);
    expect((await post(app, `${base}/oauth`, STRANGER)).status).toBe(403);
    expect(stateRows(db)).toHaveLength(0);
  });

  it("refuses a wedding that already has an account, with the settings (7)", async () => {
    const { app, db } = buildApp();
    otherWeddingWith(db, "acct_x", OWNER, [OWNER]);
    db.update(registrySettings)
      .set({ weddingId: BOOTSTRAP_WEDDING_ID })
      .where(eq(registrySettings.weddingId, "wed_other"))
      .run();
    const res = await post(app, `${base}/oauth`, OWNER);
    expect(res.status).toBe(409);
    const body = (await jsonBody(res)) as { error: string; settings: { stripeConnected: boolean } };
    expect(body.error).toBe("stripe_already_connected");
    expect(body.settings.stripeConnected).toBe(true);
    expect(stateRows(db)).toHaveLength(0);
  });

  it("does not exist when OAuth is not configured (15)", async () => {
    const { app } = buildApp({ oauth: null });
    expect((await post(app, `${base}/oauth`, OWNER)).status).toBe(404);
    const landing = await appRequest(app, `${CALLBACK}?state=x&code=y`, { method: "GET" });
    expect(landing.status).toBe(404);
  });

  it("deletes states past their time whenever anyone starts", async () => {
    const { app, db } = buildApp();
    const past = new Date(Date.now() - 60_000);
    db.insert(registryStripeOAuthStates)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: SECOND,
        stateHash: "0".repeat(64),
        expiresAt: past,
        createdAt: past,
      })
      .run();
    await start(app, OWNER);
    expect(stateRows(db).map((r) => r.osnProfileId)).toEqual([OWNER]);
  });
});

describe("the callback refuses every state but the one it issued", () => {
  it("connects with the state it issued, once (2)", async () => {
    const oauth = oauthStub();
    const stripe = stripeStub();
    const { app, db } = buildApp({ oauth: oauth.client, stripe: stripe.client });
    const state = await start(app);
    const landing = await callback(app, { state, code: "ac_good", scope: "read_write" });
    expect(landing.status).toBe(302);
    expect(landing.outcome).toBe("connected");
    expect(landing.location.origin).toBe(ORGANISER);
    expect(landing.location.hash).toBe(`#/w/${BOOTSTRAP_WEDDING_ID}/registry/settings`);
    expect(landing.cacheControl).toBe("no-store");
    const row = settingsRow(db);
    expect(row?.stripeAccountId).toBe(STANDARD.id);
    expect(row?.stripeAccountType).toBe("standard");
    expect(row?.stripeConnectedByOsnProfileId).toBe(OWNER);
    expect(row?.stripeChargesEnabled).toBe(true);
    expect(row?.stripeDefaultCurrency).toBe("AUD");
    expect(stateRows(db)).toHaveLength(0);

    const replay = await callback(app, { state, code: "ac_good" });
    expect(replay.outcome).toBe("expired");
    expect(oauth.exchanged).toEqual(["ac_good"]);
  });

  it("refuses a forged state and keeps the real one (1)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    const forged = `${BOOTSTRAP_WEDDING_ID}.${"A".repeat(43)}`;
    expect((await callback(app, { state: forged, code: "ac_x" })).outcome).toBe("expired");
    expect(oauth.exchanged).toEqual([]);
    expect(stateRows(db)).toHaveLength(1);
    expect((await callback(app, { state, code: "ac_y" })).outcome).toBe("connected");
  });

  it("refuses a state past its time, and uses it up (3)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    db.update(registryStripeOAuthStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("expired");
    expect(oauth.exchanged).toEqual([]);
    expect(stateRows(db)).toHaveLength(0);
  });

  it("refuses one wedding's state under another wedding's name (4)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    insertWedding(db, { id: "wed_b", slug: "wedding-b", displayName: "B", owners: [OWNER] });
    const state = await start(app);
    const token = state.split(".")[1] ?? "";
    expect((await callback(app, { state: `wed_b.${token}`, code: "ac_x" })).outcome).toBe(
      "expired",
    );
    expect(oauth.exchanged).toEqual([]);
  });

  it("refuses another owner's state, and leaves it for them (5)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app, OWNER);
    expect((await callback(app, { state, code: "ac_x" }, { profileId: SECOND })).outcome).toBe(
      "expired",
    );
    expect(oauth.exchanged).toEqual([]);
    expect(stateRows(db)).toHaveLength(1);
  });

  it("sends a signed-out browser to sign in and keeps the state (6)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" }, {})).outcome).toBe("signed_out");
    expect(stateRows(db)).toHaveLength(1);
  });

  it("takes the organiser session cookie, as Stripe's redirect carries it", async () => {
    const { app, db } = buildApp();
    const state = await start(app);
    const token = await seedOrganiserSession(db, OWNER);
    const landing = await callback(
      app,
      { state, code: "ac_x" },
      { cookie: `cire_org_session=${token}` },
    );
    expect(landing.outcome).toBe("connected");
  });

  it("answers a denial with the state used up and nothing exchanged", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    const landing = await callback(app, {
      state,
      error: "access_denied",
      error_description: "The user denied your request <script>",
    });
    expect(landing.outcome).toBe("denied");
    expect(oauth.exchanged).toEqual([]);
    expect(stateRows(db)).toHaveLength(0);
  });

  it("never puts query input in the redirect (19)", async () => {
    const { app } = buildApp();
    const state = await start(app);
    const crafted = await callback(app, {
      state: `evil.example.${"A".repeat(43)}`,
      code: "ac_x",
      error_description: "https://evil.example/",
    });
    expect(crafted.location.origin).toBe(ORGANISER);
    expect(crafted.location.toString()).not.toContain("evil");
    const denied = await callback(app, { state, error: "access_denied", error_description: "x" });
    expect(denied.location.toString()).not.toContain("error_description");
    expect(denied.location.toString()).not.toContain("access_denied");
  });
});

describe("the callback refuses what the wedding cannot take", () => {
  it("refuses a caller who stopped owning the wedding, before the exchange (13)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app, SECOND);
    db.update(weddingHosts)
      .set({ role: "editor" })
      .where(eq(weddingHosts.osnProfileId, SECOND))
      .run();
    expect((await callback(app, { state, code: "ac_x" }, { profileId: SECOND })).outcome).toBe(
      "forbidden",
    );
    expect(oauth.exchanged).toEqual([]);
  });

  it("refuses a wedding deleted after the start, using the state up (26)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    db.update(weddings)
      .set({ deletedAt: new Date() })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("forbidden");
    expect(oauth.exchanged).toEqual([]);
    expect(stateRows(db)).toHaveLength(0);
  });

  it("refuses a wedding that gained an account meanwhile, without the exchange (7)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        stripeAccountId: "acct_meanwhile",
        stripeConnectedByOsnProfileId: SECOND,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("already_connected");
    expect(oauth.exchanged).toEqual([]);
  });

  it("names a refused code as rejected and never logs Stripe's words (8)", async () => {
    const oauth = oauthStub({
      exchange: () =>
        Effect.fail(new StripeError({ reason: "rejected", status: 400, code: "invalid_grant" })),
    });
    const { app } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    let landing: Landing | undefined;
    const text = await captureLogs(async () => {
      landing = await callback(app, { state, code: "ac_secret_code" });
    });
    expect(landing?.outcome).toBe("rejected");
    expect(text).toContain("invalid_grant");
    expect(text).not.toContain("ac_secret_code");
  });

  it("names cire's own faults unavailable: a bad key, a rate limit, no network (8)", async () => {
    for (const error of [
      new StripeError({ reason: "rejected", status: 401, code: "invalid_request_error" }),
      new StripeError({ reason: "rejected", status: 429 }),
      new StripeError({ reason: "unreachable" }),
    ]) {
      const { app } = buildApp({ oauth: oauthStub({ exchange: () => Effect.fail(error) }).client });
      const state = await start(app);
      expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("unavailable");
    }
  });

  it("stores nothing from a reply with no account or the wrong scope, and hands it back (9)", async () => {
    const oauth = oauthStub({
      exchange: () => Effect.fail(new OAuthReplyError({ connectedAccountId: "acct_wrong_scope" })),
    });
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("unavailable");
    expect(settingsRow(db)?.stripeAccountId ?? null).toBeNull();
    expect(oauth.deauthorized).toEqual(["acct_wrong_scope"]);
  });

  it("hands back an account it cannot read, or one that is not Standard (10)", async () => {
    for (const account of [null, { ...STANDARD, type: "express" }]) {
      const oauth = oauthStub();
      const { app, db } = buildApp({ oauth: oauth.client, stripe: stripeStub(account).client });
      const state = await start(app);
      expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("unavailable");
      expect(settingsRow(db)?.stripeAccountId ?? null).toBeNull();
      expect(oauth.deauthorized).toEqual([STANDARD.id]);
    }
  });

  it("refuses an account that pays out in another currency, and hands it back (11)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({
      oauth: oauth.client,
      stripe: stripeStub({ ...STANDARD, defaultCurrency: "USD" }).client,
    });
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("currency_mismatch");
    expect(settingsRow(db)?.stripeAccountId ?? null).toBeNull();
    expect(oauth.deauthorized).toEqual([STANDARD.id]);
  });

  it("refuses an account another couple's wedding uses, and leaves it there (12)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    // A planner's account: on a wedding whose owners are not this wedding's.
    otherWeddingWith(db, STANDARD.id, OWNER, [OWNER, "usr_other_couple"]);
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("owners_differ");
    expect(settingsRow(db)?.stripeAccountId ?? null).toBeNull();
    expect(settingsRow(db, "wed_other")?.stripeAccountId).toBe(STANDARD.id);
    expect(oauth.deauthorized).toEqual([]);
  });

  it("lets the same couple bring an account from their other wedding (12)", async () => {
    const { app, db } = buildApp();
    otherWeddingWith(db, STANDARD.id, OWNER, [OWNER, SECOND]);
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("connected");
    expect(settingsRow(db)?.stripeAccountId).toBe(STANDARD.id);
    expect(settingsRow(db)?.stripeConnectedByOsnProfileId).toBe(OWNER);
  });

  it("refuses an account on the couple's other wedding that another owner connected (12)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    otherWeddingWith(db, STANDARD.id, SECOND, [OWNER, SECOND]);
    const state = await start(app, OWNER);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("owners_differ");
    expect(oauth.deauthorized).toEqual([]);
  });

  it("answers a lost race as already connected, handing back only an unused account (13)", async () => {
    // Filled once the app is built; the exchange runs after that.
    const held: { db?: TestDb } = {};
    const oauth = oauthStub({
      duringExchange: () => {
        const now = new Date();
        held.db
          ?.insert(registrySettings)
          .values({
            weddingId: BOOTSTRAP_WEDDING_ID,
            stripeAccountId: "acct_won",
            stripeConnectedByOsnProfileId: SECOND,
            stripeAccountType: "express",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: registrySettings.weddingId,
            set: {
              stripeAccountId: "acct_won",
              stripeConnectedByOsnProfileId: SECOND,
              stripeAccountType: "express",
            },
          })
          .run();
      },
    });
    const built = buildApp({ oauth: oauth.client });
    held.db = built.db;
    const { db } = built;
    openedRegistry(db);
    const state = await start(built.app);
    expect((await callback(built.app, { state, code: "ac_x" })).outcome).toBe("already_connected");
    expect(settingsRow(db)?.stripeAccountId).toBe("acct_won");
    // The account another owner attached first keeps its own type.
    expect(settingsRow(db)?.stripeAccountType).toBe("express");
    expect(oauth.deauthorized).toEqual([STANDARD.id]);
  });

  it("logs the id of an account it could not hand back", async () => {
    const oauth = oauthStub({ failDeauthorize: true });
    const { app } = buildApp({
      oauth: oauth.client,
      stripe: stripeStub({ ...STANDARD, defaultCurrency: "USD" }).client,
    });
    const state = await start(app);
    const text = await captureLogs(() => callback(app, { state, code: "ac_x" }));
    expect(text).toContain("stripe account connected but not stored");
    expect(text).toContain(STANDARD.id);
  });

  it("redirects a rate-limited callback, never answering JSON (27)", async () => {
    const { app } = buildApp({
      callbackLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    await callback(app, { state: "x", code: "y" });
    const limited = await callback(app, { state: "x", code: "y" });
    expect(limited.status).toBe(302);
    expect(limited.outcome).toBe("unavailable");
    expect(limited.cacheControl).toBe("no-store");
  });

  it("redirects a defect, never answering JSON (27)", async () => {
    const oauth = oauthStub({ exchange: () => Effect.die(new Error("boom")) });
    const { app } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    const landing = await callback(app, { state, code: "ac_x" });
    expect(landing.status).toBe(302);
    expect(landing.outcome).toBe("unavailable");
  });
});

describe("what a Standard account changes", () => {
  it("stores the type on a wedding whose registry is already open (14)", async () => {
    const { app, db } = buildApp();
    openedRegistry(db);
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("connected");
    expect(settingsRow(db)?.stripeAccountType).toBe("standard");
  });

  it("refuses an onboarding link for it, even to its connector (16)", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    const state = await start(app);
    await callback(app, { state, code: "ac_x" });
    const res = await post(app, `${base}/session`, OWNER);
    expect(res.status).toBe(409);
    expect(((await jsonBody(res)) as { error: string }).error).toBe("stripe_standard_account");
    expect(stripe.calls.filter((c) => c.startsWith("createAccountLink"))).toEqual([]);
  });

  it("tells owners the type and nobody else (18)", async () => {
    const { app } = buildApp();
    const state = await start(app);
    await callback(app, { state, code: "ac_x" });
    const read = async (profileId: string) => {
      const res = await appRequest(
        app,
        `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry`,
        {
          headers: { Authorization: `Bearer ${await auth.sign(profileId)}` },
        },
      );
      return (await jsonBody(res)) as {
        connectsExistingStripe: boolean;
        settings: { stripeAccountType: string | null };
      };
    };
    expect((await read(SECOND)).settings.stripeAccountType).toBe("standard");
    expect((await read(EDITOR)).settings.stripeAccountType).toBeNull();
    expect((await read(OWNER)).connectsExistingStripe).toBe(true);
  });

  it("says the site connects no existing account without OAuth (15)", async () => {
    const { app } = buildApp({ oauth: null });
    const res = await appRequest(app, `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry`, {
      headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
    });
    expect(
      ((await jsonBody(res)) as { connectsExistingStripe: boolean }).connectsExistingStripe,
    ).toBe(false);
  });

  it("is copied by a reuse into an open registry, and cleared by a revocation (14)", async () => {
    const { app, db } = buildApp();
    const state = await start(app);
    await callback(app, { state, code: "ac_x" });
    insertWedding(db, {
      id: "wed_party",
      slug: "party",
      displayName: "Party",
      owners: [OWNER, SECOND],
    });
    setTier(db, "wed_party", "gold");
    openedRegistry(db, "wed_party");
    const reuse = await appRequest(app, `/api/organiser/weddings/wed_party/registry/stripe/reuse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await auth.sign(OWNER)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fromWeddingId: BOOTSTRAP_WEDDING_ID }),
    });
    expect(reuse.status).toBe(200);
    expect(settingsRow(db, "wed_party")?.stripeAccountType).toBe("standard");

    await Effect.runPromise(
      registryService
        .detachStripeAccount({ accountId: STANDARD.id })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(settingsRow(db)?.stripeAccountType ?? null).toBeNull();
    expect(settingsRow(db, "wed_party")?.stripeAccountType ?? null).toBeNull();
  });
});

describe("a revocation that predates a connection leaves it (25)", () => {
  const run = <A>(db: TestDb, effect: Effect.Effect<A, never, DbService>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));

  it("keeps a row attached after the event, and clears one known before it", async () => {
    const { app, db } = buildApp();
    const state = await start(app);
    await callback(app, { state, code: "ac_x" });
    const attachedAt = settingsRow(db)?.stripeAccountUpdatedAt?.getTime() ?? 0;
    const before = Math.floor(attachedAt / 1000) - 60;
    expect(
      await run(
        db,
        registryService.detachStripeAccount({ accountId: STANDARD.id, observedAt: before }),
      ),
    ).toBe(false);
    expect(settingsRow(db)?.stripeAccountId).toBe(STANDARD.id);
    const after = Math.floor(attachedAt / 1000) + 60;
    expect(
      await run(
        db,
        registryService.detachStripeAccount({ accountId: STANDARD.id, observedAt: after }),
      ),
    ).toBe(true);
    expect(settingsRow(db)?.stripeAccountId ?? null).toBeNull();
  });

  it("clears every row when the event carries no time", async () => {
    const { app, db } = buildApp();
    const state = await start(app);
    await callback(app, { state, code: "ac_x" });
    expect(await run(db, registryService.detachStripeAccount({ accountId: STANDARD.id }))).toBe(
      true,
    );
  });
});

describe("credentials, tier and input the connect refuses", () => {
  it("sends a dead session or a malformed token to sign in, keeping the state (T-E2)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    const wrong: Record<string, string>[] = [
      { cookie: "cire_org_session=not-a-live-session-token" },
      { authorization: "Bearer not-a-jwt" },
    ];
    for (const headers of wrong) {
      const res = await appRequest(
        app,
        `${CALLBACK}?${new URLSearchParams({ state, code: "ac_x" })}`,
        {
          method: "GET",
          headers: { ...headers, origin: "" },
        },
      );
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location") ?? "").searchParams.get("stripe_connect")).toBe(
        "signed_out",
      );
    }
    expect(oauth.exchanged).toEqual([]);
    expect(stateRows(db)).toHaveLength(1);
  });

  it("starts for a session cookie and refuses no credential (T-E2)", async () => {
    const { app, db } = buildApp();
    expect((await post(app, `${base}/oauth`)).status).toBe(401);
    expect(stateRows(db)).toHaveLength(0);
    const token = await seedOrganiserSession(db, OWNER);
    const res = await appRequest(app, `${base}/oauth`, {
      method: "POST",
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(stateRows(db)).toHaveLength(1);
  });

  it("refuses a wedding below Gold at the start, and one lowered before the return (T-E3)", async () => {
    const below = buildApp({ tier: "ivory" });
    expect((await post(below.app, `${base}/oauth`, OWNER)).status).toBe(402);
    expect(stateRows(below.db)).toHaveLength(0);

    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    const state = await start(app);
    setTier(db, BOOTSTRAP_WEDDING_ID, "ivory");
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("forbidden");
    expect(oauth.exchanged).toEqual([]);
  });

  it("answers a return with no code, or one no Stripe code is, as rejected (T-E5)", async () => {
    const returns: Record<string, string>[] = [{}, { code: "a".repeat(257) }];
    for (const params of returns) {
      const oauth = oauthStub();
      const { app, db } = buildApp({ oauth: oauth.client });
      const state = await start(app);
      expect((await callback(app, { state, ...params })).outcome).toBe("rejected");
      expect(oauth.exchanged).toEqual([]);
      expect(stateRows(db)).toHaveLength(0);
    }
  });

  it("redirects a request with no address it can key the limiter on (T-S3)", async () => {
    const { app } = buildApp();
    const res = await app.fetch(new Request(`http://localhost${CALLBACK}?state=x&code=y`));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("stripe_connect")).toBe(
      "unavailable",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("an account Stripe connected that cire then cannot store (T-E4)", () => {
  it("hands it back when the caller stops owning the wedding during the exchange", async () => {
    for (const change of ["demoted", "deleted"] as const) {
      const held: { db?: TestDb } = {};
      const oauth = oauthStub({
        duringExchange: () => {
          if (!held.db) return;
          if (change === "demoted") {
            held.db
              .update(weddingHosts)
              .set({ role: "editor" })
              .where(eq(weddingHosts.osnProfileId, SECOND))
              .run();
          } else {
            held.db
              .update(weddings)
              .set({ deletedAt: new Date() })
              .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
              .run();
          }
        },
      });
      const built = buildApp({ oauth: oauth.client });
      held.db = built.db;
      const state = await start(built.app, SECOND);
      const landing = await callback(built.app, { state, code: "ac_x" }, { profileId: SECOND });
      expect(landing.outcome).toBe("forbidden");
      expect(settingsRow(built.db)?.stripeAccountId ?? null).toBeNull();
      expect(oauth.deauthorized).toEqual([STANDARD.id]);
    }
  });

  it("hands it back after a defect once the exchange succeeded", async () => {
    const oauth = oauthStub();
    const stripe: StripeClient = {
      ...stripeStub().client,
      retrieveAccount: () => Effect.die(new Error("boom after the exchange")),
    };
    const { app, db } = buildApp({ oauth: oauth.client, stripe });
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe("unavailable");
    expect(settingsRow(db)?.stripeAccountId ?? null).toBeNull();
    expect(oauth.deauthorized).toEqual([STANDARD.id]);
  });
});

describe("what the state review found (G-)", () => {
  const run = <A>(db: TestDb, effect: Effect.Effect<A, never, DbService>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));

  it("clears a revoked account whose row a refresh stamped after the event (G-H1)", async () => {
    const { app, db } = buildApp();
    const state = await start(app);
    await callback(app, { state, code: "ac_x" });
    const connectedAt = Math.floor((settingsRow(db)?.stripeConnectedAt?.getTime() ?? 0) / 1000);
    // A refresh (or an `account.updated`) lands later than Stripe's revocation.
    db.update(registrySettings)
      .set({ stripeAccountUpdatedAt: new Date((connectedAt + 3600) * 1000) })
      .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();
    const cleared = await run(
      db,
      registryService.detachStripeAccount({ accountId: STANDARD.id, observedAt: connectedAt + 60 }),
    );
    expect(cleared).toBe(true);
    expect(settingsRow(db)?.stripeAccountId ?? null).toBeNull();
  });

  it("refuses an account once the wedding's currency changed during the exchange (G-M2)", async () => {
    const held: { db?: TestDb } = {};
    const oauth = oauthStub({
      duringExchange: () =>
        held.db
          ?.update(weddings)
          .set({ currency: "USD" })
          .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
          .run(),
    });
    const built = buildApp({ oauth: oauth.client });
    held.db = built.db;
    const state = await start(built.app);
    expect((await callback(built.app, { state, code: "ac_x" })).outcome).toBe("currency_mismatch");
    expect(settingsRow(built.db)?.stripeAccountId ?? null).toBeNull();
    expect(oauth.deauthorized).toEqual([STANDARD.id]);
  });

  it("clears a wedding that took the account while cire was handing it back (G-M1)", async () => {
    const held: { db?: TestDb } = {};
    const oauth = oauthStub({
      duringDeauthorize: () => {
        if (!held.db) return;
        const now = new Date();
        insertWedding(held.db, {
          id: "wed_tab2",
          slug: "tab-two",
          displayName: "Tab two",
          owners: [OWNER],
        });
        held.db
          .insert(registrySettings)
          .values({
            weddingId: "wed_tab2",
            stripeAccountId: STANDARD.id,
            stripeConnectedByOsnProfileId: OWNER,
            stripeAccountType: "standard",
            stripeConnectedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      },
    });
    const built = buildApp({
      oauth: oauth.client,
      stripe: stripeStub({ ...STANDARD, defaultCurrency: "USD" }).client,
    });
    held.db = built.db;
    const state = await start(built.app);
    const logs = await captureLogs(() => callback(built.app, { state, code: "ac_x" }));
    expect(oauth.deauthorized).toEqual([STANDARD.id]);
    expect(settingsRow(built.db, "wed_tab2")?.stripeAccountId ?? null).toBeNull();
    expect(logs).toContain("stripe account handed back while a wedding connected it");
  });

  it("names a deleted wedding that still holds the account, not other owners (G-L3)", async () => {
    const oauth = oauthStub();
    const { app, db } = buildApp({ oauth: oauth.client });
    otherWeddingWith(db, STANDARD.id, "usr_someone", ["usr_someone"]);
    db.update(weddings).set({ deletedAt: new Date() }).where(eq(weddings.id, "wed_other")).run();
    const state = await start(app);
    expect((await callback(app, { state, code: "ac_x" })).outcome).toBe(
      "account_on_deleted_wedding",
    );
    expect(oauth.deauthorized).toEqual([]);
  });
});
