import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, unlockCodes, weddingHosts } from "@cire/db";
import { hashRecoveryCode } from "@shared/crypto/recovery";
import { createRateLimiter } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { createDb, DEV_OWNER_PROFILE_ID, seedDb } from "../../src/db/setup";
import type { StripeClient } from "../../src/services/stripe";
import { appRequest, jsonBody, setTier } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

/**
 * Every owner-only route, called by a wedding's SECOND owner.
 *
 * Owners are equals: an owner invited to the wedding holds everything its
 * creator does — claim codes, settings, the budget cap, billing, the payout
 * account, and who helps, the creator's own seat included. Each route is
 * asserted twice, so the pair proves the gate rather than the route: the second
 * owner gets through, and an editor on the same wedding is refused 403.
 */

const CREATOR = DEV_OWNER_PROFILE_ID;
const SECOND = "usr_second_owner";
const EDITOR = "usr_editor";
const UNLOCK_CODE = "3f9a-0c1e-b7d2-48aa";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** One double for both Stripe surfaces an owner reaches: the upgrade checkout
 *  and the registry's Connect onboarding. */
const stripe = {
  retrievePrice: () => Effect.succeed({ unitAmountMinor: 4900, currency: "AUD" }),
  createPlatformCheckoutSession: () =>
    Effect.succeed({ id: "cs_second", url: "https://pay.test/cs_second" }),
  retrievePlatformCheckoutSession: () => Effect.succeed({ status: "expired" as const }),
  createAccount: () =>
    Effect.succeed({
      id: "acct_second",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      defaultCurrency: null,
    }),
  createAccountLink: () =>
    Effect.succeed({ url: "https://connect.stripe.test/setup/x", expiresAt: 1_800_000_000 }),
  retrieveAccount: (id: string) =>
    Effect.succeed({
      id,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      defaultCurrency: null,
    }),
} as unknown as StripeClient;

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  for (const [osnProfileId, role] of [
    [SECOND, "owner"],
    [EDITOR, "editor"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id: `whost_${osnProfileId}`,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: CREATOR,
        role,
        createdAt: now,
      })
      .run();
  }
  // Gold reaches the budget and the registry; Crimson is still for sale.
  setTier(db, BOOTSTRAP_WEDDING_ID, "gold");
  // And a Crimson code would lift it.
  db.insert(unlockCodes)
    .values({
      id: "ulc_second",
      codeHash: hashRecoveryCode(UNLOCK_CODE),
      tier: "crimson",
      maxRedemptions: 1,
      createdBy: "script:ops",
      createdAt: now,
    })
    .run();
  const limiter = () => createRateLimiter({ maxRequests: 1000, windowMs: 60_000 });
  const app = createApp(db, {
    osnTestKey: auth.key,
    organiserOrigin: "https://host.test",
    stripe,
    upgradePrices: { crimsonFromGold: "price_cg" },
    upgradeLimiter: limiter(),
    unlockCodeLimiter: limiter(),
    resolveOsnProfileByHandle: async (handle) => ({
      ok: true,
      profileId: `usr_${handle}`,
      handle,
    }),
    registryStripeLimiter: limiter(),
    hostLimiter: limiter(),
    remintLimiter: limiter(),
    // The default export limiter is one module-level 10/min bucket per caller,
    // and this file calls every export as the same second owner.
    exportLimiter: limiter(),
  });
  const [family] = db.select({ id: families.id }).from(families).limit(1).all();
  return { app, db, familyId: family!.id };
}

type App = ReturnType<typeof buildApp>["app"];

async function call(
  app: App,
  method: string,
  rest: string,
  profileId: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await auth.sign(profileId)}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return appRequest(app, `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}${rest}`, init);
}

/** An owner-only route: how to call it, and what a passing call answers. */
type OwnerRoute = {
  name: string;
  method: string;
  path: (familyId: string) => string;
  body?: unknown;
  ok: number;
};

const OWNER_ROUTES: readonly OwnerRoute[] = [
  {
    name: "regenerate a household's code",
    method: "POST",
    path: (f) => `/families/${f}/regenerate-code`,
    ok: 200,
  },
  {
    name: "deactivate a household",
    method: "POST",
    path: (f) => `/families/${f}/deactivate`,
    ok: 200,
  },
  {
    name: "reactivate a household",
    method: "POST",
    path: (f) => `/families/${f}/reactivate`,
    ok: 200,
  },
  {
    name: "re-mint every code",
    method: "POST",
    path: () => "/remint",
    body: { codeStyle: "simple" },
    ok: 200,
  },
  {
    name: "set the budget cap",
    method: "PUT",
    path: () => "/budget/total",
    body: { budgetTotalMinor: 5_000_000 },
    ok: 200,
  },
  {
    name: "rename the wedding (an owner-only setting)",
    method: "PUT",
    path: () => "/settings",
    body: { displayName: "Renamed by the second owner" },
    ok: 200,
  },
  {
    name: "start an upgrade checkout",
    method: "POST",
    path: () => "/upgrade/session",
    body: { tier: "crimson" },
    ok: 200,
  },
  {
    name: "redeem an unlock code",
    method: "POST",
    path: () => "/unlock-code",
    body: { unlockCode: UNLOCK_CODE },
    ok: 200,
  },
  {
    name: "start the registry's payout onboarding",
    method: "POST",
    path: () => "/registry/stripe/session",
    ok: 200,
  },
  {
    name: "add someone to the wedding",
    method: "POST",
    path: () => "/hosts",
    body: { handle: "newcomer" },
    ok: 201,
  },
  {
    name: "change a co-host's role",
    method: "PUT",
    path: () => `/hosts/${EDITOR}/role`,
    body: { role: "viewer" },
    ok: 200,
  },
  { name: "remove a co-host", method: "DELETE", path: () => `/hosts/${EDITOR}`, ok: 200 },
  ...(
    [
      "/rsvps.csv",
      "/guests.csv",
      "/events.csv",
      "/gifts.csv",
      "/budget.csv",
      "/tasks.csv",
      "/module-rows",
      "/export/events.csv",
      "/export/guests.csv",
    ] as const
  ).map((path) => ({
    name: `${path.endsWith(".csv") ? "download" : "read"} ${path.slice(1)}`,
    method: "GET",
    path: () => path,
    ok: 200,
  })),
];

describe("a wedding's second owner on every owner-only route", () => {
  for (const route of OWNER_ROUTES) {
    it(`may ${route.name}, which an editor may not`, async () => {
      const refused = buildApp();
      const asEditor = await call(
        refused.app,
        route.method,
        route.path(refused.familyId),
        EDITOR,
        route.body,
      );
      expect(asEditor.status).toBe(403);

      const allowed = buildApp();
      const asSecond = await call(
        allowed.app,
        route.method,
        route.path(allowed.familyId),
        SECOND,
        route.body,
      );
      expect(asSecond.status).toBe(route.ok);
    });
  }

  it("may remove the wedding's creator, who is then refused the owner routes", async () => {
    const { app, db, familyId } = buildApp();
    const res = await call(app, "DELETE", `/hosts/${CREATOR}`, SECOND);
    expect(res.status).toBe(200);
    const left = db
      .select()
      .from(weddingHosts)
      .where(
        and(
          eq(weddingHosts.weddingId, BOOTSTRAP_WEDDING_ID),
          eq(weddingHosts.osnProfileId, CREATOR),
        ),
      )
      .all();
    expect(left).toEqual([]);
    const after = await call(app, "POST", `/families/${familyId}/regenerate-code`, CREATOR);
    expect(after.status).toBe(403);
  });

  it("may demote the creator, who keeps what the new role carries and no more", async () => {
    const { app, familyId } = buildApp();
    const res = await call(app, "PUT", `/hosts/${CREATOR}/role`, SECOND, { role: "editor" });
    expect(res.status).toBe(200);
    expect((await call(app, "POST", `/families/${familyId}/regenerate-code`, CREATOR)).status).toBe(
      403,
    );
    expect((await call(app, "GET", "/guests", CREATOR)).status).toBe(200);
  });

  it("is refused removing the last owner left — themselves, once the creator has gone", async () => {
    const { app } = buildApp();
    expect((await call(app, "DELETE", `/hosts/${CREATOR}`, SECOND)).status).toBe(200);
    const res = await call(app, "DELETE", `/hosts/${SECOND}`, SECOND);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "last_owner" });
  });
});

describe("marking a household's code shared", () => {
  it("is an editor's as well as an owner's: it records a send and changes no code", async () => {
    for (const caller of [EDITOR, SECOND]) {
      const { app, familyId } = buildApp();
      const res = await call(app, "POST", `/families/${familyId}/mark-shared`, caller);
      expect(res.status, caller).toBe(200);
    }
  });

  it.each([
    ["viewer", "read_only_role"],
    ["helper", "forbidden"],
  ] as const)("is refused to a %s with 403 %s, recording nothing", async (role, error) => {
    const { app, db, familyId } = buildApp();
    const caller = `usr_${role}`;
    db.insert(weddingHosts)
      .values({
        id: `whost_${caller}`,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: caller,
        addedByOsnProfileId: CREATOR,
        role,
        createdAt: new Date(),
      })
      .run();
    db.update(families).set({ codeSharedAt: null }).where(eq(families.id, familyId)).run();

    const res = await call(app, "POST", `/families/${familyId}/mark-shared`, caller);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error });
    const [family] = db
      .select({ codeSharedAt: families.codeSharedAt })
      .from(families)
      .where(eq(families.id, familyId))
      .all();
    expect(family!.codeSharedAt).toBeNull();
  });
});
