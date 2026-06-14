import { describe, it, expect, beforeAll } from "bun:test";

import { guestAccountLinks, guests } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { parseSessionToken } from "../lib/cookie";
import type { OsnAccountResolver } from "../services/osn-bridge";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Seeded families (see data/guests.json):
//   TESTONE-IVY-AA11 Testfamily → Ada
//   TESTTWO-OAK-BB22 Sampleton  → Bo, Cleo, Dot
const TESTFAMILY = "TESTONE-IVY-AA11";
const SAMPLETON = "TESTTWO-OAK-BB22";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** Default stub: resolves any profile to a fixed account id. */
const okResolver: OsnAccountResolver = async () => ({ ok: true, accountId: "acc_default" });

// "disabled" maps to no resolver at all (deployment without an ARC key). A
// sentinel rather than `undefined` so passing it can't collide with the default.
function buildApp(resolver: OsnAccountResolver | "disabled" = okResolver) {
  const db = createDb(":memory:");
  seedDb(db);
  const app = createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    accountLinkLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    osnTestKey: auth.key,
    resolveOsnAccountId: resolver === "disabled" ? undefined : resolver,
  });
  return { db, app };
}

function guestIdByName(db: Db, firstName: string): string {
  const row = db
    .select({ id: guests.id, firstName: guests.firstName })
    .from(guests)
    .all()
    .find((g) => g.firstName === firstName);
  if (!row) throw new Error(`no seeded guest named ${firstName}`);
  return row.id;
}

async function claimCookie(app: ReturnType<typeof createApp>, publicId: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId }),
    }),
  );
  expect(res.status).toBe(200);
  const token = parseSessionToken(res.headers.get("Set-Cookie"));
  expect(token).not.toBeNull();
  return `cire_session=${token}`;
}

function postLink(
  app: ReturnType<typeof createApp>,
  opts: { cookie?: string; bearer?: string; guestId?: string },
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  return app.fetch(
    new Request("http://localhost/api/account/link", {
      method: "POST",
      headers,
      body: JSON.stringify({ guestId: opts.guestId }),
    }),
  );
}

describe("POST /api/account/link", () => {
  it("links an invitee given a guest session + OSN token (201)", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const guestId = guestIdByName(db, "Bo");

    const res = await postLink(app, { cookie, bearer, guestId });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ linked: true, guestId });

    const rows = db.select().from(guestAccountLinks).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.osnAccountId).toBe("acc_default");
    expect(rows[0]!.osnProfileId).toBe("usr_alice");
    expect(rows[0]!.guestId).toBe(guestId);
  });

  it("returns 401 without an OSN token (guest cookie alone is not enough)", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const res = await postLink(app, { cookie, guestId: guestIdByName(db, "Bo") });
    expect(res.status).toBe(401);
  });

  it("returns 401 without a guest session cookie", async () => {
    const { db, app } = buildApp();
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { bearer, guestId: guestIdByName(db, "Bo") });
    expect(res.status).toBe(401);
  });

  it("returns 403 when the guest belongs to another family", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, TESTFAMILY); // authenticated as Testfamily
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { cookie, bearer, guestId: guestIdByName(db, "Bo") }); // Bo ∈ Sampleton
    expect(res.status).toBe(403);
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);
  });

  it("returns 400 for a missing guestId", async () => {
    const { app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { cookie, bearer });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the same invitee is linked twice", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const guestId = guestIdByName(db, "Bo");
    expect((await postLink(app, { cookie, bearer, guestId })).status).toBe(201);
    const res = await postLink(app, { cookie, bearer, guestId });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_linked" });
  });

  it("returns 409 when one OSN account claims two seats in a family", async () => {
    const { db, app } = buildApp(); // okResolver → same account for any profile
    const cookie = await claimCookie(app, SAMPLETON);
    const bo = guestIdByName(db, "Bo");
    const cleo = guestIdByName(db, "Cleo");
    expect(
      (await postLink(app, { cookie, bearer: await auth.sign("usr_a"), guestId: bo })).status,
    ).toBe(201);
    const res = await postLink(app, { cookie, bearer: await auth.sign("usr_b"), guestId: cleo });
    expect(res.status).toBe(409);
  });

  it("returns 404 when OSN reports the profile does not exist", async () => {
    const { db, app } = buildApp(async () => ({ ok: false, reason: "profile_not_found" }));
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_ghost");
    const res = await postLink(app, { cookie, bearer, guestId: guestIdByName(db, "Bo") });
    expect(res.status).toBe(404);
  });

  it("returns 502 when the OSN account lookup throws (osn unavailable)", async () => {
    const { db, app } = buildApp(async () => {
      throw new Error("ECONNREFUSED");
    });
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { cookie, bearer, guestId: guestIdByName(db, "Bo") });
    expect(res.status).toBe(502);
  });

  it("returns 503 when account linking is not configured", async () => {
    const { db, app } = buildApp("disabled");
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { cookie, bearer, guestId: guestIdByName(db, "Bo") });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/account/link", () => {
  it("lists linked invitees for the household (no account id leaked)", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const guestId = guestIdByName(db, "Bo");
    await postLink(app, { cookie, bearer: await auth.sign("usr_alice"), guestId });

    const res = await app.fetch(
      new Request("http://localhost/api/account/link", { headers: { Cookie: cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: Array<{ guestId: string; linkedAt: number }> };
    expect(body.links).toHaveLength(1);
    expect(body.links[0]!.guestId).toBe(guestId);
    expect(typeof body.links[0]!.linkedAt).toBe("number");
    // account id is S2S-only and must never appear in a client response.
    expect(JSON.stringify(body)).not.toContain("acc_default");
  });

  it("returns 401 without a guest session", async () => {
    const { app } = buildApp();
    const res = await app.fetch(new Request("http://localhost/api/account/link"));
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/account/link/:guestId", () => {
  it("removes a link and is idempotent", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const guestId = guestIdByName(db, "Bo");
    await postLink(app, { cookie, bearer: await auth.sign("usr_alice"), guestId });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(1);

    const del = () =>
      app.fetch(
        new Request(`http://localhost/api/account/link/${guestId}`, {
          method: "DELETE",
          headers: { Cookie: cookie },
        }),
      );

    const res1 = await del();
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ linked: false, guestId });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);

    // Second delete still succeeds (idempotent).
    expect((await del()).status).toBe(200);
  });

  it("only unlinks within the caller's household", async () => {
    const { db, app } = buildApp();
    // Link Bo (Sampleton) as one household.
    const sampletonCookie = await claimCookie(app, SAMPLETON);
    const bo = guestIdByName(db, "Bo");
    await postLink(app, {
      cookie: sampletonCookie,
      bearer: await auth.sign("usr_alice"),
      guestId: bo,
    });

    // A different household (Testfamily) tries to delete Bo's link.
    const testfamilyCookie = await claimCookie(app, TESTFAMILY);
    const res = await app.fetch(
      new Request(`http://localhost/api/account/link/${bo}`, {
        method: "DELETE",
        headers: { Cookie: testfamilyCookie },
      }),
    );
    expect(res.status).toBe(200); // idempotent no-op, not an error
    // Bo's link survives — the foreign household's scoped delete matched nothing.
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(1);
  });

  it("returns 401 without a guest session", async () => {
    const { db, app } = buildApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/account/link/${guestIdByName(db, "Bo")}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("account-link rate limiting (S-L1)", () => {
  it("returns 429 once the per-IP budget is exhausted", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    // Tiny budget shared across the account-link surface.
    const app = createApp(db, {
      claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
      accountLinkLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
      osnTestKey: auth.key,
      resolveOsnAccountId: okResolver,
    });
    const cookie = await claimCookie(app, SAMPLETON);
    const get = () =>
      app.fetch(new Request("http://localhost/api/account/link", { headers: { Cookie: cookie } }));

    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});
