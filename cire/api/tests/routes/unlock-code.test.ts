import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  unlockCodes,
  weddingHosts,
  weddings,
  weddingUpgradePurchases,
} from "@cire/db";
import { hashRecoveryCode } from "@shared/crypto/recovery";
import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import type { PaidTier, Tier } from "../../src/services/tiers";
import { appRequest, jsonBody, setTier } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

/**
 * Redeeming an unlock code.
 *
 * What is load-bearing here:
 *   - only an owner may redeem: a code changes what the wedding is on, like
 *     buying a tier does;
 *   - every code that cannot be used gets the same status and the same body,
 *     so a caller guessing codes learns nothing about which exist;
 *   - a wedding already on the code's tier or above is told so, and the code
 *     is not spent;
 *   - attempts are limited per organiser.
 */

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const STRANGER = "usr_stranger";
const CODE = "3f9a-0c1e-b7d2-48aa";
const WID = BOOTSTRAP_WEDDING_ID;
const PATH = `/api/organiser/weddings/${WID}/unlock-code`;

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp({
  tier = "ivory",
  limiter = createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
}: { tier?: Tier; limiter?: RateLimiterBackend } = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddingHosts)
    .values({
      id: "whost_editor",
      weddingId: WID,
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: new Date(),
    })
    .run();
  setTier(db, WID, tier);
  // A fresh limiter per app: the module-level default is shared process-wide.
  const app = createApp(db, { osnTestKey: auth.key, unlockCodeLimiter: limiter });
  return { app, db };
}
type Built = ReturnType<typeof buildApp>;

function mint(
  db: Built["db"],
  opts: { code?: string; tier?: PaidTier; max?: number; used?: number; expiresAt?: Date } = {},
) {
  db.insert(unlockCodes)
    .values({
      id: `ulc_${opts.code ?? CODE}`,
      codeHash: hashRecoveryCode(opts.code ?? CODE),
      tier: opts.tier ?? "gold",
      maxRedemptions: opts.max ?? 1,
      redeemedCount: opts.used ?? 0,
      expiresAt: opts.expiresAt ?? null,
      createdBy: "script:ops",
      createdAt: new Date(),
    })
    .run();
}

async function redeem(
  app: Built["app"],
  profileId: string | undefined,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, PATH, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const tierOf = (db: Built["db"]) =>
  db.select({ tier: weddings.tier }).from(weddings).where(eq(weddings.id, WID)).get()?.tier;

describe("POST …/unlock-code", () => {
  it("raises the owner's wedding to the code's tier", async () => {
    const { app, db } = buildApp();
    mint(db);
    const res = await redeem(app, OWNER, { unlockCode: CODE.toUpperCase() });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ tier: "gold" });
    expect(tierOf(db)).toBe("gold");
  });

  it("refuses an editor, a stranger and an unauthenticated caller, and spends nothing", async () => {
    const { app, db } = buildApp();
    mint(db);
    expect((await redeem(app, EDITOR, { unlockCode: CODE })).status).toBe(403);
    expect((await redeem(app, STRANGER, { unlockCode: CODE })).status).toBe(403);
    expect((await redeem(app, undefined, { unlockCode: CODE })).status).toBe(401);
    expect(tierOf(db)).toBe("ivory");
    expect(db.select().from(unlockCodes).get()?.redeemedCount).toBe(0);
  });

  it("answers an unknown, an expired and a used-up code identically", async () => {
    const answers: string[] = [];
    for (const setup of [
      () => ({}),
      (db: Built["db"]) => mint(db, { expiresAt: new Date(Date.now() - 1000) }),
      (db: Built["db"]) => mint(db, { max: 1, used: 1 }),
    ]) {
      const { app, db } = buildApp();
      setup(db);
      const res = await redeem(app, OWNER, { unlockCode: CODE });
      answers.push(`${res.status} ${res.headers.get("content-type")} ${await res.text()}`);
      expect(tierOf(db)).toBe("ivory");
    }
    expect(answers[0]).toBe(`404 application/json;charset=utf-8 {"error":"unlock_code_invalid"}`);
    expect(new Set(answers).size).toBe(1);
  });

  it("tells a wedding already on the tier, naming its own tier, and keeps the code", async () => {
    const { app, db } = buildApp({ tier: "crimson" });
    mint(db, { tier: "gold" });
    const res = await redeem(app, OWNER, { unlockCode: CODE });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "tier_already_held", tier: "crimson" });
    expect(db.select().from(unlockCodes).get()?.redeemedCount).toBe(0);
  });

  it("holds a live code back while an upgrade checkout can still be paid", async () => {
    const { app, db } = buildApp();
    mint(db);
    const now = new Date();
    db.insert(weddingUpgradePurchases)
      .values({
        id: "upg_open",
        weddingId: WID,
        entitlement: "gold",
        fromTier: "ivory",
        status: "pending",
        checkoutSessionId: "cs_open",
        createdByOsnProfileId: OWNER,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const res = await redeem(app, OWNER, { unlockCode: CODE });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "purchase_in_flight" });
    expect(tierOf(db)).toBe("ivory");
  });

  it.each([
    ["no JSON", "not json"],
    ["no code", {}],
    ["an empty code", { unlockCode: "" }],
    ["a code that is not text", { unlockCode: 1234 }],
    ["a code too long to be one", { unlockCode: "a".repeat(65) }],
  ])("400s a body with %s", async (_label, body) => {
    const { app } = buildApp();
    const res = await redeem(app, OWNER, body);
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
  });

  it("takes a code at the 64-character bound to the service, not the 400", async () => {
    const { app } = buildApp();
    const res = await redeem(app, OWNER, { unlockCode: "a".repeat(64) });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "unlock_code_invalid" });
  });

  it("limits attempts per organiser", async () => {
    const { app } = buildApp({ limiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }) });
    expect((await redeem(app, OWNER, { unlockCode: "0000-0000-0000-0001" })).status).toBe(404);
    expect((await redeem(app, OWNER, { unlockCode: "0000-0000-0000-0002" })).status).toBe(404);
    const third = await redeem(app, OWNER, { unlockCode: CODE });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("refuses a stranger at the gate, before the limiter counts them", async () => {
    const { app } = buildApp({ limiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }) });
    // Were the limiter mounted first, the third would be a 429.
    expect((await redeem(app, STRANGER, { unlockCode: CODE })).status).toBe(403);
    expect((await redeem(app, STRANGER, { unlockCode: CODE })).status).toBe(403);
    expect((await redeem(app, STRANGER, { unlockCode: CODE })).status).toBe(403);
  });

  it("answers a failed write with 500 and spends nothing it can see", async () => {
    const { app, db } = buildApp();
    mint(db);
    db.$client.exec(
      "CREATE TRIGGER fail_tier_update BEFORE UPDATE OF tier ON weddings BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    const res = await redeem(app, OWNER, { unlockCode: CODE });
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "internal" });
    expect(tierOf(db)).toBe("ivory");
  });
});

describe("POST …/unlock-code with the portal's session cookie", () => {
  /** A request carrying the organiser session cookie, as the portal sends it. */
  function withCookie(app: Built["app"], token: string, origin?: string): Promise<Response> {
    const headers: Record<string, string> = {
      cookie: `cire_org_session=${token}`,
      "Content-Type": "application/json",
    };
    if (origin) headers.Origin = origin;
    return appRequest(app, PATH, {
      method: "POST",
      headers,
      body: JSON.stringify({ unlockCode: CODE }),
    });
  }

  const spent = (db: Built["db"]) => db.select().from(unlockCodes).get()?.redeemedCount;

  it("lets the owner in with a live session", async () => {
    const { app, db } = buildApp();
    mint(db);
    const res = await withCookie(app, await seedOrganiserSession(db, OWNER));
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ tier: "gold" });
    expect(tierOf(db)).toBe("gold");
  });

  it("refuses a cookie naming no live session, and a malformed bearer, spending nothing", async () => {
    const { app, db } = buildApp();
    mint(db);
    expect((await withCookie(app, "not-a-live-session-token")).status).toBe(401);
    const bearer = await appRequest(app, PATH, {
      method: "POST",
      headers: { Authorization: "Bearer not.a.jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ unlockCode: CODE }),
    });
    expect(bearer.status).toBe(401);
    expect(tierOf(db)).toBe("ivory");
    expect(spent(db)).toBe(0);
  });

  it("refuses a cross-origin request carrying a live session cookie", async () => {
    const { app, db } = buildApp();
    mint(db);
    const res = await withCookie(app, await seedOrganiserSession(db, OWNER), "http://evil.example");
    expect(res.status).toBe(403);
    expect(tierOf(db)).toBe("ivory");
    expect(spent(db)).toBe(0);
  });
});
