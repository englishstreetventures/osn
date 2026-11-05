import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryClaims,
  registryContributions,
  registryItems,
  registrySettings,
} from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { hostCodeService } from "../../src/services/host-code";
import type {
  PublicRegistryDto,
  RegistryItemDto,
  RegistrySnapshot,
} from "../../src/services/registry";
import { StripeError, type StripeClient } from "../../src/services/stripe";
import { appRequest, jsonBody, recordStatements, setTier, TEST_ORIGIN } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { makeOsnTestAuth, type OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

/**
 * Group gifts: one item several households give money towards.
 *
 * A group gift is a cash fund with `allow_partial` set, so it rides the money
 * path a fund does and is never reserved. The target is SOFT (owner,
 * 2026-11-04): nothing caps it, and money that passes it is the couple's. Each
 * test below is one way that can go wrong:
 *
 *   - concurrent checkouts past the target, both kept;
 *   - a gift after the target, which the guest is never told about;
 *   - refunds and disputes taking money out of what the couple see raised;
 *   - the host preview household, which never gives or reserves;
 *   - a guest reading any figure — target, total, count — or any donor;
 *   - the couple's own checks on what a group gift may carry.
 */

const SLUG = "cire-wedding";
const OWNER = "usr_dev_bootstrap_owner";
const ACCOUNT = "acct_couple";
const SECRET = "whsec_test_connect";
const HOUSEHOLDS = ["TESTONE-IVY-AA11", "TESTTWO-OAK-BB22", "TESTTRE-DEW-CC33", "TESTFOR-JOY-DD44"];
const organiserBase = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry`;
const guestBase = `/api/invite/${SLUG}/registry`;

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function stripeStub() {
  const sessions: string[] = [];
  let minted = 0;
  const unused = () => Effect.fail(new StripeError({ reason: "not used here" }));
  const client: StripeClient = {
    createAccount: unused,
    createAccountLink: unused,
    retrieveAccount: unused,
    createPlatformCheckoutSession: unused,
    retrievePlatformCheckoutSession: unused,
    expirePlatformCheckoutSession: unused,
    retrievePrice: unused,
    createCheckoutSession() {
      minted += 1;
      const id = `cs_${minted}`;
      sessions.push(id);
      return Effect.succeed({ id, url: `https://checkout.stripe.test/pay/${id}` });
    },
    retrieveCheckoutSession(input) {
      return Effect.succeed({
        id: input.sessionId,
        url: `https://checkout.stripe.test/pay/${input.sessionId}`,
      });
    },
  };
  return { client, sessions };
}

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  insertWedding(db, {
    id: "wed_other",
    slug: "other-wedding",
    displayName: "Other",
    createdAt: now,
    updatedAt: now,
    owners: ["usr_bob"],
  });
  db.insert(families)
    .values({
      id: "fam_other",
      weddingId: "wed_other",
      publicId: "OTHERWD-ELM-EE55",
      familyName: "Elmwood",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  setTier(db, BOOTSTRAP_WEDDING_ID, "gold");
  db.insert(registrySettings)
    .values({
      weddingId: BOOTSTRAP_WEDDING_ID,
      published: true,
      cashGiftsEnabled: true,
      stripeAccountId: ACCOUNT,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDefaultCurrency: "AUD",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const stripe = stripeStub();
  const app = createApp(db, {
    osnTestKey: auth.key,
    webOrigin: "https://invite.test",
    allowedOrigins: [TEST_ORIGIN, "https://invite.test"],
    stripe: stripe.client,
    stripeWebhookSecret: SECRET,
    claimLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    registryContributeLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, db, stripe };
}
type App = ReturnType<typeof buildApp>["app"];
type Db = ReturnType<typeof buildApp>["db"];

async function organiser(app: App, method: string, path: string, body?: unknown) {
  return appRequest(app, `${organiserBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await auth.sign(OWNER)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function addGroupGift(app: App, title: string, targetMinor: number) {
  const res = await organiser(app, "POST", "/items", {
    kind: "cash_fund",
    allowPartial: true,
    title,
    targetMinor,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { item: RegistryItemDto }).item;
}

async function snapshot(app: App): Promise<RegistrySnapshot> {
  const res = await organiser(app, "GET", "");
  expect(res.status).toBe(200);
  return (await res.json()) as RegistrySnapshot;
}

async function raisedOf(app: App, itemId: string) {
  return (await snapshot(app)).items.find((i) => i.id === itemId)?.raised;
}

async function guestCookie(app: App, publicId: string): Promise<string> {
  const res = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicId }),
  });
  expect(res.status).toBe(200);
  const token = /cire_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  expect(token).toBeTruthy();
  return `cire_session=${token}`;
}

function contribute(app: App, cookie: string, body: unknown) {
  return appRequest(app, `${guestBase}/contribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function guestRead(app: App, cookie: string, path = "") {
  return appRequest(app, `${guestBase}${path}`, { headers: { Cookie: cookie } });
}

async function hmacHex(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One signed Stripe delivery on the couple's connected account. */
async function deliver(app: App, type: string, object: Record<string, unknown>) {
  const at = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: `evt_${type}_${String(object.id)}`,
    type,
    created: at,
    account: ACCOUNT,
    data: { object },
  });
  const res = await appRequest(app, "/api/stripe/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${at},v1=${await hmacHex(`${at}.${payload}`)}`,
    },
    body: payload,
  });
  expect(res.status).toBe(200);
  return jsonBody(res);
}

function rowOfSession(db: Db, sessionId: string) {
  const row = db
    .select()
    .from(registryContributions)
    .where(eq(registryContributions.stripeCheckoutSessionId, sessionId))
    .get();
  expect(row).toBeDefined();
  return row!;
}

/** Stripe says the money for this session moved. */
async function settle(app: App, db: Db, sessionId: string) {
  const row = rowOfSession(db, sessionId);
  expect(
    await deliver(app, "checkout.session.completed", {
      id: sessionId,
      client_reference_id: row.id,
      payment_intent: `pi_${sessionId}`,
      payment_status: "paid",
      metadata: { contributionId: row.id },
    }),
  ).toEqual({ received: true, outcome: "settled" });
}

/** A guest's gift towards an item, as far as a payment page; its session id. */
async function startGift(app: App, publicId: string, itemId: string, amountMinor: number) {
  const res = await contribute(app, await guestCookie(app, publicId), { amountMinor, itemId });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  return url.slice(url.lastIndexOf("/") + 1);
}

async function giveAndSettle(
  app: App,
  db: Db,
  publicId: string,
  itemId: string,
  amountMinor: number,
) {
  const sessionId = await startGift(app, publicId, itemId, amountMinor);
  await settle(app, db, sessionId);
  return sessionId;
}

/** A gift row written straight to the table, for what no route writes. */
function insertGift(
  db: Db,
  over: Partial<typeof registryContributions.$inferInsert> & { id: string; itemId: string },
) {
  const familyId = db
    .select({ id: families.id })
    .from(families)
    .where(eq(families.publicId, HOUSEHOLDS[0]!))
    .get()!.id;
  const now = new Date();
  db.insert(registryContributions)
    .values({
      weddingId: BOOTSTRAP_WEDDING_ID,
      familyId,
      status: "succeeded",
      amountMinor: 1_000,
      currency: "AUD",
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
}

describe("the target is soft", () => {
  it("keeps two checkouts started at once that together pass the target", async () => {
    const { app, db, stripe } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 10_000);
    const [a, b] = await Promise.all([
      guestCookie(app, HOUSEHOLDS[0]!),
      guestCookie(app, HOUSEHOLDS[1]!),
    ]);

    // Nothing reserves part of the target, so neither checkout waits on or
    // refuses the other.
    const [first, second] = await Promise.all([
      contribute(app, a, { amountMinor: 8_000, itemId: gift.id }),
      contribute(app, b, { amountMinor: 7_000, itemId: gift.id }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(stripe.sessions).toHaveLength(2);
    const pending = db
      .select()
      .from(registryContributions)
      .where(eq(registryContributions.itemId, gift.id))
      .all();
    expect(pending.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(pending.map((r) => r.itemTitle)).toEqual(["Espresso machine", "Espresso machine"]);

    for (const sessionId of stripe.sessions) await settle(app, db, sessionId);

    expect(await raisedOf(app, gift.id)).toEqual({
      raisedMinor: 15_000,
      giftCount: 2,
      otherCurrencyCount: 0,
    });
  });

  it("takes a gift after the target is reached, and never tells a guest it was", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 5_000);
    const reader = await guestCookie(app, HOUSEHOLDS[3]!);
    const before = await (await guestRead(app, reader)).text();

    await giveAndSettle(app, db, HOUSEHOLDS[0]!, gift.id, 6_000);
    const reached = await (await guestRead(app, reader)).text();
    const late = await startGift(app, HOUSEHOLDS[1]!, gift.id, 2_000);
    await settle(app, db, late);
    const after = await (await guestRead(app, reader)).text();

    // The guest list is the same bytes at nothing raised, at the target and
    // past it: any difference would tell a guest how much has come in.
    expect(reached).toBe(before);
    expect(after).toBe(before);
    expect(await raisedOf(app, gift.id)).toEqual({
      raisedMinor: 8_000,
      giftCount: 2,
      otherCurrencyCount: 0,
    });
  });
});

describe("what counts as raised", () => {
  it("leaves out a refunded gift and a disputed one, and takes a won dispute back", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 20_000);
    const refunded = await giveAndSettle(app, db, HOUSEHOLDS[0]!, gift.id, 10_000);
    const disputed = await giveAndSettle(app, db, HOUSEHOLDS[1]!, gift.id, 6_000);
    // Never paid, and paid for nothing: neither is money.
    await startGift(app, HOUSEHOLDS[2]!, gift.id, 4_000);
    const expired = await startGift(app, HOUSEHOLDS[3]!, gift.id, 3_000);
    await deliver(app, "checkout.session.expired", {
      id: expired,
      client_reference_id: rowOfSession(db, expired).id,
      metadata: { contributionId: rowOfSession(db, expired).id },
    });
    expect(await raisedOf(app, gift.id)).toEqual({
      raisedMinor: 16_000,
      giftCount: 2,
      otherCurrencyCount: 0,
    });

    await deliver(app, "charge.refunded", {
      id: "ch_refund",
      payment_intent: `pi_${refunded}`,
      refunded: true,
      amount: 10_000,
      amount_refunded: 10_000,
    });
    expect(await raisedOf(app, gift.id)).toEqual({
      raisedMinor: 6_000,
      giftCount: 1,
      otherCurrencyCount: 0,
    });

    const dispute = { id: "dp_1", charge: "ch_dispute", payment_intent: `pi_${disputed}` };
    await deliver(app, "charge.dispute.created", { ...dispute, status: "needs_response" });
    expect(await raisedOf(app, gift.id)).toEqual({
      raisedMinor: 0,
      giftCount: 0,
      otherCurrencyCount: 0,
    });
    await deliver(app, "charge.dispute.closed", { ...dispute, status: "won" });
    expect(await raisedOf(app, gift.id)).toEqual({
      raisedMinor: 6_000,
      giftCount: 1,
      otherCurrencyCount: 0,
    });
  });

  it("counts a partly refunded gift at the amount given, as the gift log and the total do", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 20_000);
    const session = await giveAndSettle(app, db, HOUSEHOLDS[0]!, gift.id, 10_000);

    await deliver(app, "charge.refunded", {
      id: "ch_partial",
      payment_intent: `pi_${session}`,
      refunded: false,
      amount: 10_000,
      amount_refunded: 2_500,
    });

    const snap = await snapshot(app);
    expect(snap.items.find((i) => i.id === gift.id)?.raised?.raisedMinor).toBe(10_000);
    expect(snap.contributionsPrimaryMinor).toBe(10_000);
  });

  it("counts only this wedding's gifts, and the wedding's currency by the total's own key", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 20_000);
    insertGift(db, { id: "rct_aud", itemId: gift.id, amountMinor: 2_000 });
    // Charged in USD with an AUD figure on the row: the wedding total counts
    // it by the AUD pair, and so does the group gift.
    insertGift(db, {
      id: "rct_converted",
      itemId: gift.id,
      amountMinor: 1_000,
      currency: "usd",
      primaryAmountMinor: 1_500,
      primaryCurrency: "AUD",
    });
    // Given before the couple changed currency: counted, never added.
    insertGift(db, { id: "rct_usd", itemId: gift.id, amountMinor: 9_000, currency: "USD" });
    // A row of another wedding naming this item is not this item's money.
    insertGift(db, {
      id: "rct_foreign",
      itemId: gift.id,
      weddingId: "wed_other",
      familyId: "fam_other",
      amountMinor: 50_000,
    });

    const snap = await snapshot(app);
    expect(snap.items.find((i) => i.id === gift.id)?.raised).toEqual({
      raisedMinor: 3_500,
      giftCount: 2,
      otherCurrencyCount: 1,
    });
    // The same rows make the wedding's own total.
    expect(snap.contributionsPrimaryMinor).toBe(3_500);
    expect(snap.contributionsOtherCurrencyCount).toBe(1);
  });

  it("answers an edit with what the gift has raised, in the edit's one statement", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 20_000);
    insertGift(db, { id: "rct_1", itemId: gift.id, amountMinor: 4_000 });
    const statements = recordStatements(db);

    const res = await organiser(app, "PATCH", `/items/${gift.id}`, { title: "Espresso grinder" });

    expect(res.status).toBe(200);
    const { item } = (await res.json()) as { item: RegistryItemDto };
    expect(item.title).toBe("Espresso grinder");
    expect(item.raised).toEqual({ raisedMinor: 4_000, giftCount: 1, otherCurrencyCount: 0 });
    expect(
      statements.filter((s) => /registry_items|registry_contributions/.test(s.sql)),
    ).toHaveLength(1);
  });

  it("sends no raised figure on a gift to reserve or a plain fund", async () => {
    const { app } = buildApp();
    const product = await organiser(app, "POST", "/items", { title: "Copper pan" });
    const fund = await organiser(app, "POST", "/items", { kind: "cash_fund", title: "Honeymoon" });
    const snap = await snapshot(app);
    for (const res of [product, fund]) {
      const { item } = (await res.json()) as { item: RegistryItemDto };
      expect(item.raised).toBeNull();
      expect(snap.items.find((i) => i.id === item.id)?.raised).toBeNull();
    }
  });
});

describe("the host preview household", () => {
  it("never gives towards a group gift, nor reserves it", async () => {
    const { app, db, stripe } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 10_000);
    const { publicId } = await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID, SLUG)
        .pipe(Effect.provideService(DbService, db)),
    );
    const preview = await guestCookie(app, publicId);

    const given = await contribute(app, preview, { amountMinor: 5_000, itemId: gift.id });
    const claimed = await appRequest(app, `${guestBase}/items/${gift.id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: preview },
      body: JSON.stringify({ quantity: 1 }),
    });

    expect(given.status).toBe(403);
    expect(await jsonBody(given)).toEqual({ error: "preview_read_only" });
    expect(claimed.status).toBe(403);
    expect(await jsonBody(claimed)).toEqual({ error: "preview_read_only" });
    expect(db.select().from(registryContributions).all()).toEqual([]);
    expect(db.select().from(registryClaims).all()).toEqual([]);
    expect(stripe.sessions).toHaveLength(0);
  });
});

describe("what a guest sees of a group gift", () => {
  it("its name, picture and words and that it is a group gift — no figure, no donor", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 123_456);
    const session = await startGift(app, HOUSEHOLDS[0]!, gift.id, 98_765);
    await settle(app, db, session);
    db.update(registryContributions)
      .set({ displayName: "Auntie Ros", message: "For the mornings" })
      .run();
    const reader = await guestCookie(app, HOUSEHOLDS[1]!);

    const raw = await (await guestRead(app, reader)).text();
    const body = JSON.parse(raw) as PublicRegistryDto;

    // Given to, never reserved: not on the shelves.
    expect(body.items.some((i) => i.id === gift.id)).toBe(false);
    const entry = body.funds.find((f) => f.id === gift.id);
    // Exhaustive key set: a target, total or count added later fails here.
    expect(Object.keys(entry ?? {}).toSorted()).toEqual(
      ["description", "groupGift", "id", "imageCrop", "imageName", "sortOrder", "title"].toSorted(),
    );
    expect(entry?.groupGift).toBe(true);
    expect(entry?.title).toBe("Espresso machine");
    for (const secret of ["123456", "98765", "Auntie Ros", "For the mornings", "Testfamily"]) {
      expect(raw).not.toContain(secret);
    }
    // The giver's own household read says nothing about money either.
    const mine = await (
      await guestRead(app, await guestCookie(app, HOUSEHOLDS[0]!), "/mine")
    ).text();
    expect(JSON.parse(mine)).toEqual({ claims: [] });
  });

  it("cannot be reserved: no claim on it, whatever a guest sends", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 10_000);
    const cookie = await guestCookie(app, HOUSEHOLDS[0]!);

    for (const status of ["reserved", "purchased"]) {
      const res = await appRequest(app, `${guestBase}/items/${gift.id}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ quantity: 1, status }),
      });
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "registry_item_not_found" });
    }
    expect(db.select().from(registryClaims).all()).toEqual([]);
  });

  it("is not offered, and takes nothing, while the couple are not taking money", async () => {
    const { app, db, stripe } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 10_000);
    db.update(registrySettings).set({ cashGiftsEnabled: false }).run();
    const cookie = await guestCookie(app, HOUSEHOLDS[0]!);

    const list = (await (await guestRead(app, cookie)).json()) as PublicRegistryDto;
    const given = await contribute(app, cookie, { amountMinor: 5_000, itemId: gift.id });

    expect(list.funds).toEqual([]);
    expect(list.items.some((i) => i.id === gift.id)).toBe(false);
    expect(given.status).toBe(409);
    expect(await jsonBody(given)).toEqual({ error: "cash_gifts_unavailable" });
    expect(stripe.sessions).toHaveLength(0);
  });
});

describe("the couple's record of it", () => {
  it("keeps each gift and the gift's name after the group gift is deleted", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 10_000);
    await giveAndSettle(app, db, HOUSEHOLDS[0]!, gift.id, 4_000);

    expect((await organiser(app, "DELETE", `/items/${gift.id}`)).status).toBe(200);

    const [row] = db.select().from(registryContributions).all();
    expect(row?.itemId).toBeNull();
    expect(row?.itemTitle).toBe("Espresso machine");
    expect(row?.status).toBe("succeeded");
    const log = (await snapshot(app)).gifts;
    expect(log.map((g) => [g.kind, g.itemTitle, g.amountMinor])).toEqual([
      ["contribution", "Espresso machine", 4_000],
    ]);
  });
});

describe("what a group gift may carry", () => {
  it("is a cash fund with a target, counted as a group gift", async () => {
    const { app, db } = buildApp();
    const groupGiftWrites = () =>
      counterValue(CIRE_METRICS.registryItemWrite, { action: "create", kind: "group_gift" });
    const before = await groupGiftWrites();

    const gift = await addGroupGift(app, "Espresso machine", 10_000);

    expect(gift.kind).toBe("cash_fund");
    expect(gift.allowPartial).toBe(true);
    expect(gift.targetMinor).toBe(10_000);
    expect(gift.raised).toEqual({ raisedMinor: 0, giftCount: 0, otherCurrencyCount: 0 });
    const row = db.select().from(registryItems).where(eq(registryItems.id, gift.id)).get();
    expect([row?.kind, row?.allowPartial, row?.targetMinor]).toEqual(["cash_fund", true, 10_000]);
    expect(await groupGiftWrites()).toBe(before + 1);
  });

  it("refuses a group gift that is a gift to reserve, has no target, or has a gift's fields", async () => {
    const { app, db } = buildApp();
    const bodies = [
      { allowPartial: true, title: "Espresso machine", targetMinor: 10_000 },
      { kind: "product", allowPartial: true, title: "Espresso machine" },
      { kind: "cash_fund", allowPartial: true, title: "Espresso machine" },
      { kind: "cash_fund", allowPartial: true, title: "Espresso machine", targetMinor: null },
      {
        kind: "cash_fund",
        allowPartial: true,
        title: "Espresso machine",
        targetMinor: 10_000,
        priceMinor: 10_000,
      },
    ];
    for (const body of bodies) {
      const res = await organiser(app, "POST", "/items", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "invalid_item_fields" });
    }
    expect(db.select().from(registryItems).all()).toEqual([]);
  });

  it("keeps its target and stays a group gift whatever an edit sends", async () => {
    const { app, db } = buildApp();
    const gift = await addGroupGift(app, "Espresso machine", 10_000);

    const cleared = await organiser(app, "PATCH", `/items/${gift.id}`, { targetMinor: null });
    const priced = await organiser(app, "PATCH", `/items/${gift.id}`, { priceMinor: 5_000 });
    const flipped = await organiser(app, "PATCH", `/items/${gift.id}`, {
      allowPartial: false,
      title: "Espresso grinder",
    });

    expect(cleared.status).toBe(400);
    expect(await jsonBody(cleared)).toEqual({ error: "invalid_item_fields" });
    expect(priced.status).toBe(400);
    expect(flipped.status).toBe(200);
    const row = db.select().from(registryItems).where(eq(registryItems.id, gift.id)).get();
    expect([row?.title, row?.allowPartial, row?.targetMinor, row?.priceMinor]).toEqual([
      "Espresso grinder",
      true,
      10_000,
      null,
    ]);
  });

  it("still lets a plain fund drop its goal, and answers a missing item 404", async () => {
    const { app } = buildApp();
    const fund = await organiser(app, "POST", "/items", {
      kind: "cash_fund",
      title: "Honeymoon",
      targetMinor: 10_000,
    });
    const { item } = (await fund.json()) as { item: RegistryItemDto };

    const cleared = await organiser(app, "PATCH", `/items/${item.id}`, { targetMinor: null });
    const missing = await organiser(app, "PATCH", "/items/reg_nothing", { targetMinor: null });

    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { item: RegistryItemDto }).item.targetMinor).toBeNull();
    expect(missing.status).toBe(404);
  });
});
