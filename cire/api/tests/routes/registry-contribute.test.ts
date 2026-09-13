import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryContributions,
  registrySettings,
  weddingEntitlements,
  weddings,
} from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import {
  StripeError,
  type CreateCheckoutSessionInput,
  type StripeClient,
} from "../../src/services/stripe";
import { appRequest, jsonBody, TEST_ORIGIN } from "../test-helpers";

/**
 * A guest giving money.
 *
 * What is load-bearing here:
 *   - the guest is turned away BEFORE their card is — no session is created for
 *     a wedding that is not taking money, a household of another wedding, or a
 *     visitor with no claim at all;
 *   - the charge is DIRECT: it names the couple's connected account, so the
 *     money is theirs from the moment it is taken;
 *   - the row is written FIRST and the session attached after (osn-tracker
 *     #528), so a payment page never exists at Stripe that we have no record
 *     of; the row stays `pending` until the webhook says the money moved;
 *   - the amount is bounded, so a fat-fingered zero is a validation error
 *     rather than a card charge.
 */

const SLUG = "cire-wedding";
const FAMILY = "TESTONE-IVY-AA11";
const ACCOUNT = "acct_couple";
/** A household of the OTHER wedding — the cross-tenant cookie. */
const FOREIGN_FAMILY = "OTHERWD-ELM-EE55";

function stripeStub(
  options: {
    fail?: boolean;
    reusable?: boolean;
    /**
     * Runs while the route is still inside `createCheckoutSession` — the only
     * vantage point from which "the row exists BEFORE Stripe is asked" can be
     * observed rather than inferred from the end state.
     */
    onCreate?: () => void;
  } = {},
) {
  const sessions: CreateCheckoutSessionInput[] = [];
  /** Session ids the route asked Stripe to read back on the reuse path. */
  const retrieved: string[] = [];
  let minted = 0;
  const client: StripeClient = {
    createAccount: () => Effect.fail(new StripeError({ reason: "not used here" })),
    createAccountLink: () => Effect.fail(new StripeError({ reason: "not used here" })),
    retrieveAccount: () => Effect.fail(new StripeError({ reason: "not used here" })),
    createCheckoutSession(input) {
      sessions.push(input);
      options.onCreate?.();
      if (options.fail) return Effect.fail(new StripeError({ reason: "unreachable" }));
      // Ids count up, so a test can tell a second session from a reused first.
      minted += 1;
      const id = `cs_${minted}`;
      return Effect.succeed({ id, url: `https://checkout.stripe.test/pay/${id}` });
    },
    retrieveCheckoutSession(input) {
      retrieved.push(input.sessionId);
      // `reusable: false` is Stripe answering "that page is spent" — expired or
      // already paid — which the route must treat as no page at all.
      return Effect.succeed(
        options.reusable === false
          ? null
          : { id: input.sessionId, url: `https://checkout.stripe.test/pay/${input.sessionId}` },
      );
    },
  };
  return { client, sessions, retrieved };
}

function buildApp({
  cashGiftsEnabled = true,
  chargesEnabled = true,
  accountId = ACCOUNT as string | null,
  published = true,
  stripe,
}: {
  cashGiftsEnabled?: boolean;
  chargesEnabled?: boolean;
  accountId?: string | null;
  published?: boolean;
  stripe?: StripeClient | null;
} = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  // A second wedding with its own household, so "a cookie for one wedding buys
  // nothing on another" has a real target rather than a fabricated id.
  db.insert(weddings)
    .values({
      id: "wed_other",
      slug: "other-wedding",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(families)
    .values({
      id: "fam_other",
      weddingId: "wed_other",
      publicId: FOREIGN_FAMILY,
      familyName: "Elmwood",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  // The registry module is entitlement-gated; without this every route here
  // answers the same 404 an unpublished list does.
  db.insert(weddingEntitlements)
    .values({
      weddingId: BOOTSTRAP_WEDDING_ID,
      entitlement: "registry",
      source: "comp",
      grantedAt: now,
      grantedBy: "usr_dev_bootstrap_owner",
      providerRef: null,
    })
    .onConflictDoNothing()
    .run();
  db.insert(registrySettings)
    .values({
      weddingId: BOOTSTRAP_WEDDING_ID,
      published,
      cashGiftsEnabled,
      stripeAccountId: accountId,
      stripeChargesEnabled: chargesEnabled,
      stripePayoutsEnabled: chargesEnabled,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const app = createApp(db, {
    // The guest site's public origin — what the success/cancel URLs are built
    // from. `allowedOrigins` still has to admit the origin the test harness
    // sends, or the CSRF guard 403s every POST before the route runs.
    webOrigin: "https://invite.test",
    allowedOrigins: [TEST_ORIGIN, "https://invite.test"],
    stripe: stripe === undefined ? stripeStub().client : stripe,
    // Fresh limiters: the module-level defaults are process-wide.
    claimLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    registryContributeLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, db };
}
type App = ReturnType<typeof buildApp>["app"];

/** Claim a code and keep the `cire_session` cookie it mints. */
async function guestCookie(app: App, publicId = FAMILY): Promise<string> {
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

function contribute(app: App, cookie: string | null, body: unknown, slug = SLUG) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return appRequest(app, `/api/invite/${slug}/registry/contribute`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("who may give", () => {
  it("hands a claimed guest a hosted checkout URL", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);

    const res = await contribute(app, cookie, { amountMinor: 5000 });

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ url: "https://checkout.stripe.test/pay/cs_1" });
  });

  it("refuses a visitor with no claim", async () => {
    const { app } = buildApp();
    expect((await contribute(app, null, { amountMinor: 5000 })).status).toBe(401);
  });

  it("refuses a household of another wedding, as the same 404 everything else gives", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    const foreign = await guestCookie(app, FOREIGN_FAMILY);
    const res = await contribute(app, foreign, { amountMinor: 5000 });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
    // Turned away before their card was — the cross-tenant case is the one
    // this claim matters most for.
    expect(stripe.sessions).toHaveLength(0);
  });

  it("does not exist at all when Stripe is not configured", async () => {
    const { app } = buildApp({ stripe: null });
    const cookie = await guestCookie(app);
    // A guest must never be offered a button that cannot lead anywhere.
    expect((await contribute(app, cookie, { amountMinor: 5000 })).status).toBe(404);
  });
});

describe("the couple must be taking money", () => {
  const cases: Array<[string, Parameters<typeof buildApp>[0]]> = [
    ["they never turned cash gifts on", { cashGiftsEnabled: false }],
    ["Stripe cannot take a charge today", { chargesEnabled: false }],
    ["there is no connected account", { accountId: null }],
  ];

  for (const [label, options] of cases) {
    it(`refuses with a code the page can act on when ${label}`, async () => {
      const stripe = stripeStub();
      const { app } = buildApp({ ...options, stripe: stripe.client });
      const cookie = await guestCookie(app);

      const res = await contribute(app, cookie, { amountMinor: 5000 });

      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "cash_gifts_unavailable" });
      // Turned away before their card was.
      expect(stripe.sessions).toHaveLength(0);
    });
  }

  it("refuses an unpublished registry as a 404, like every other guest route", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ published: false, stripe: stripe.client });
    const cookie = await guestCookie(app);
    const res = await contribute(app, cookie, { amountMinor: 5000 });
    expect(res.status).toBe(404);
    expect(stripe.sessions).toHaveLength(0);
  });
});

describe("what reaches Stripe, and what does not", () => {
  it("is a direct charge on the couple's account, in the wedding's currency", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);

    await contribute(app, cookie, {
      amountMinor: 12_500,
      message: "For the honeymoon",
      displayName: "The Ashworths",
    });

    const session = stripe.sessions[0];
    expect(session?.accountId).toBe(ACCOUNT);
    expect(session?.amountMinor).toBe(12_500);
    expect(session?.currency).toBe("AUD");
    // Generic on purpose: it is what the guest sees on their statement, and a
    // gift's line item is not the place to publish what a couple asked for.
    expect(session?.productName).toBe("Wedding gift");
    expect(session?.successUrl).toBe("https://invite.test/cire-wedding/registry?gift=thanks");
    expect(session?.cancelUrl).toBe("https://invite.test/cire-wedding/registry?gift=cancelled");
  });

  /**
   * The guest's note and the name they chose stay in D1 under a basis we
   * have declared; Stripe is told an opaque id and the money, which is all it
   * needs to take a payment. It also means nothing a connected account can type
   * into its own session's metadata can settle a gift here.
   */
  it("sends Stripe one opaque id and nothing about the guest", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);

    await contribute(app, cookie, {
      amountMinor: 12_500,
      message: "For the honeymoon",
      displayName: "The Ashworths",
    });

    const metadata = stripe.sessions[0]?.metadata ?? {};
    expect(Object.keys(metadata)).toEqual(["contributionId"]);
    expect(String(metadata.contributionId)).toMatch(/^rct_/);
    // The same id also goes in `client_reference_id`, which the connected
    // account cannot rewrite the way it can rewrite its own metadata — so the
    // webhook reads that first and metadata only as the fallback.
    expect(stripe.sessions[0]?.clientReferenceId).toBe(String(metadata.contributionId));
    const serialised = JSON.stringify(stripe.sessions[0]);
    expect(serialised).not.toContain("For the honeymoon");
    expect(serialised).not.toContain("The Ashworths");
    expect(serialised).not.toContain(BOOTSTRAP_WEDDING_ID);
  });

  it("writes the gift as pending BEFORE Stripe is asked for a page", async () => {
    // A payment with no record is the one outcome there is no way back from,
    // so the row has to be on disk while Stripe is still being asked — not
    // once it has answered.
    let duringCreate: Array<{ id: string; status: string; sessionId: string | null }> = [];
    const stripe = stripeStub({
      onCreate: () => {
        duringCreate = db
          .select({
            id: registryContributions.id,
            status: registryContributions.status,
            sessionId: registryContributions.stripeCheckoutSessionId,
          })
          .from(registryContributions)
          .all();
      },
    });
    const built = buildApp({ stripe: stripe.client });
    const { app } = built;
    const db = built.db;
    const cookie = await guestCookie(app);

    await contribute(app, cookie, { amountMinor: 5000, message: "x", displayName: "Y" });

    // Mid-flight: the gift exists, and has no session because there is not one
    // yet — that NULL is the whole point of migration 0060.
    expect(duringCreate).toHaveLength(1);
    expect(duringCreate[0]?.status).toBe("pending");
    expect(duringCreate[0]?.sessionId).toBeNull();
    expect(duringCreate[0]?.id).toMatch(/^rct_/);

    const rows = await db.select().from(registryContributions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(duringCreate[0]?.id);
    expect(rows[0]?.status).toBe("pending");
    // …and afterwards the session Stripe handed back is attached to it.
    expect(rows[0]?.stripeCheckoutSessionId).toBe("cs_1");
    expect(rows[0]?.id).toBe(String(stripe.sessions[0]?.metadata.contributionId));
    // Nothing is called a gift until Stripe says the money moved.
    expect(rows[0]?.stripePaymentIntentId).toBeNull();
  });

  it("drops an item id that is not this wedding's rather than refusing the gift", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);

    await contribute(app, cookie, { amountMinor: 5000, itemId: "reg_other_pan" });

    const rows = await db.select().from(registryContributions).all();
    expect(rows[0]?.itemId).toBeNull();
    expect(rows[0]?.amountMinor).toBe(5000);
  });

  /**
   * The key carries the note itself, not a digest of it. A key that folded the
   * note down to its LENGTH would have both failure modes an idempotency key
   * exists to avoid: two different gifts of the same amount collide, so the
   * second silently never charges; and a retry with different words hits
   * Stripe's `idempotency_error` permanently, because the key never changes.
   *
   * `reusable: false` here is doing a job: it takes the reuse read out of the
   * way — every press is spent on arrival — so what reaches Stripe is the key
   * alone, which is the belt this test is about.
   */
  it("collapses a double-tap and separates everything else", async () => {
    const stripe = stripeStub({ reusable: false });
    const { app } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);

    await contribute(app, cookie, { amountMinor: 5000, message: "aaa" });
    await contribute(app, cookie, { amountMinor: 5000, message: "aaa" });
    await contribute(app, cookie, { amountMinor: 5000, message: "bbb" });
    await contribute(app, cookie, { amountMinor: 9000, message: "aaa" });

    const keys = stripe.sessions.map((s) => s.idempotencyKey);
    // The same gift pressed twice is one attempt…
    expect(keys[0]).toBe(keys[1]);
    // …a different note of the SAME LENGTH is a different attempt, not a 400…
    expect(keys[2]).not.toBe(keys[0]);
    // …and so is a different amount.
    expect(keys[3]).not.toBe(keys[0]);
    for (const key of keys) expect(key).toMatch(/^cire-gift-[0-9a-f]{32}$/);
  });

  it("answers 502 when Stripe will not play, and closes the attempt it opened", async () => {
    const { app, db } = buildApp({ stripe: stripeStub({ fail: true }).client });
    const cookie = await guestCookie(app);
    const res = await contribute(app, cookie, { amountMinor: 5000 });
    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toEqual({ error: "stripe_unavailable" });
    // The row was written before Stripe was asked, so it exists — but it is
    // marked `failed`, not left pending: there is no payment page it could
    // ever belong to, and a `pending` row is a gift an organiser is waiting on.
    const rows = await db.select().from(registryContributions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.stripeCheckoutSessionId).toBeNull();
  });

  /**
   * The reuse read collapses the second press of the same button onto the page
   * the first one got, so two presses leave one gift and one session rather
   * than two of each.
   */
  it("gives a double-tap one payment page and one gift", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);

    const first = await contribute(app, cookie, { amountMinor: 5000, message: "aaa" });
    const second = await contribute(app, cookie, { amountMinor: 5000, message: "aaa" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    // The second press never asked Stripe for a page — it read back the first.
    expect(stripe.sessions).toHaveLength(1);
    expect(stripe.retrieved).toEqual(["cs_1"]);

    const rows = await db.select().from(registryContributions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stripeCheckoutSessionId).toBe("cs_1");
  });

  /**
   * A row with a NULL session is an attempt the Worker never
   * finished — it was evicted between writing the gift and hearing back from
   * Stripe. There is no page to send anyone back to, so the reuse read must
   * skip it and mint a fresh one, rather than handing the guest a `null` URL.
   */
  it("never reuses an attempt that never got a payment page", async () => {
    const stripe = stripeStub();
    const { app, db } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);
    const familyId = db
      .select({ id: families.id })
      .from(families)
      .where(eq(families.publicId, FAMILY))
      .get()?.id;
    expect(familyId).toBeTruthy();
    const now = new Date();
    db.insert(registryContributions)
      .values({
        id: "rct_orphan",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: null,
        familyId: familyId as string,
        status: "pending",
        amountMinor: 5000,
        currency: "AUD",
        stripeCheckoutSessionId: null,
        message: null,
        displayName: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await contribute(app, cookie, { amountMinor: 5000 });

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ url: "https://checkout.stripe.test/pay/cs_1" });
    // Stripe was asked for a new page, and never asked to read the orphan back.
    expect(stripe.sessions).toHaveLength(1);
    expect(stripe.retrieved).toEqual([]);
    // The orphan is left exactly as it was; the new gift is its own row.
    const rows = await db.select().from(registryContributions).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "rct_orphan")?.stripeCheckoutSessionId).toBeNull();
  });
});

describe("the amount", () => {
  it("refuses one below the floor, above the ceiling, or not a whole number", async () => {
    const stripe = stripeStub();
    const { app } = buildApp({ stripe: stripe.client });
    const cookie = await guestCookie(app);

    for (const amountMinor of [0, 499, 1_000_001, 12.5, -5000]) {
      const res = await contribute(app, cookie, { amountMinor });
      expect(res.status).toBe(400);
    }
    // A fat-fingered zero is a validation error, never a card charge.
    expect(stripe.sessions).toHaveLength(0);
  });

  it("refuses a body with no amount at all", async () => {
    const { app } = buildApp();
    const cookie = await guestCookie(app);
    expect((await contribute(app, cookie, {})).status).toBe(400);
    expect((await contribute(app, cookie, null)).status).toBe(400);
  });
});
