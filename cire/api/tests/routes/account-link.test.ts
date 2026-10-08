import { describe, it, expect, beforeAll } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guestAccountLinks, guests } from "@cire/db";
import { createStaticFlags } from "@shared/feature-flags";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { hostCodeService } from "../../src/services/host-code";
import { organiserSessionService } from "../../src/services/organiser-session";
import type { OsnAccountResolver } from "../../src/services/osn-bridge";
import { jsonBody } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { seedPlusOne } from "../test-helpers/plus-one";

// Seeded families (see @cire/db/seed — cire/db/seed/data/guests.ts):
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
function buildApp(resolver: OsnAccountResolver | "disabled" = okResolver, linkingEnabled = true) {
  const db = createDb(":memory:");
  seedDb(db);
  const app = createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    accountLinkLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    osnTestKey: auth.key,
    resolveOsnAccountId: resolver === "disabled" ? undefined : resolver,
    // The account-linking feature flag gates the whole surface. Enable it for
    // the functional tests; the flag-off contract is exercised separately.
    flags: createStaticFlags({ "cire.account-linking": linkingEnabled }),
  });
  return { db, app };
}

function guestIdByName(db: TestDb, firstName: string): string {
  const row = db
    .select({ id: guests.id, firstName: guests.firstName })
    .from(guests)
    .all()
    .find((g) => g.firstName === firstName);
  if (!row) throw new Error(`no seeded guest named ${firstName}`);
  return row.id;
}

// `cf-connecting-ip` simulates the CF edge for the fail-closed limiter (C4) —
// every account-link route is rate-limited, so requests need a resolvable IP.
// `Origin` satisfies the CSRF origin guard (C5) on the state-changing methods.
const TEST_CF_IP = "203.0.113.7";
const TEST_ORIGIN = "http://localhost:4321";

async function claimCookie(app: ReturnType<typeof createApp>, publicId: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": TEST_CF_IP,
        Origin: TEST_ORIGIN,
      },
      body: JSON.stringify({ publicId }),
    }),
  );
  expect(res.status).toBe(200);
  const token = parseSessionToken(res.headers.get("Set-Cookie"));
  expect(token).not.toBeNull();
  return `cire_session=${token}`;
}

/** "Who are you?": choose the household member this session says it is. */
function chooseMember(
  app: ReturnType<typeof createApp>,
  cookie: string | undefined,
  guestId: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": TEST_CF_IP,
    Origin: TEST_ORIGIN,
  };
  if (cookie) headers["Cookie"] = cookie;
  return Promise.resolve(
    app.fetch(
      new Request("http://localhost/api/claim/member", {
        method: "POST",
        headers,
        body: JSON.stringify({ guestId }),
      }),
    ),
  );
}

/**
 * Link the session's member. With `guestId`, that member is chosen first, the
 * way the guest site does it; a refused choice is returned as it stands.
 */
async function postLink(
  app: ReturnType<typeof createApp>,
  opts: { cookie?: string; bearer?: string; guestId?: string },
): Promise<Response> {
  if (opts.guestId !== undefined) {
    const chosen = await chooseMember(app, opts.cookie, opts.guestId);
    if (chosen.status !== 200) return chosen;
  }
  const headers: Record<string, string> = {
    "cf-connecting-ip": TEST_CF_IP,
    Origin: TEST_ORIGIN,
  };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  return app.fetch(new Request("http://localhost/api/account/link", { method: "POST", headers }));
}

/**
 * After a successful link the server rotates the guest session and returns
 * a fresh `Set-Cookie`. Subsequent requests in the same household must use the
 * rotated cookie — the old one is revoked. Returns the new cookie if the
 * response rotated, else the prior cookie unchanged.
 */
function rotatedCookie(res: Response, prior: string): string {
  const token = parseSessionToken(res.headers.get("Set-Cookie"));
  return token ? `cire_session=${token}` : prior;
}

describe("POST /api/account/link", () => {
  it("links an invitee given a guest session + OSN token (201)", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const guestId = guestIdByName(db, "Bo");

    const res = await postLink(app, { cookie, bearer, guestId });
    expect(res.status).toBe(201);
    expect(await jsonBody(res)).toEqual({ linked: true, guestId });

    const rows = db.select().from(guestAccountLinks).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.osnAccountId).toBe("acc_default");
    expect(rows[0]!.osnProfileId).toBe("usr_alice");
    expect(rows[0]!.guestId).toBe(guestId);
  });

  // A successful link rotates the guest session — fresh Set-Cookie, old
  // token revoked (session-fixation defence).
  it("rotates the guest session cookie on a successful link", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const oldToken = cookie.replace("cire_session=", "");
    const bearer = await auth.sign("usr_alice");
    const guestId = guestIdByName(db, "Bo");

    const res = await postLink(app, { cookie, bearer, guestId });
    expect(res.status).toBe(201);

    // A fresh cookie is set, and it carries a DIFFERENT token to the old one.
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    const newToken = parseSessionToken(setCookie);
    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(oldToken);

    // The old token is revoked: a request bearing it is now 401 on a guest
    // route (the session restore).
    const restore = (householdCookie: string) =>
      app.fetch(
        new Request("http://localhost/api/claim/session?slug=cire-wedding", {
          headers: { Cookie: householdCookie, "cf-connecting-ip": TEST_CF_IP },
        }),
      );
    expect((await restore(cookie)).status).toBe(401);

    // The rotated cookie still works, and still names the member.
    const restored = await restore(`cire_session=${newToken}`);
    expect(restored.status).toBe(200);
    expect(((await jsonBody(restored)) as { member: unknown }).member).toEqual({ guestId });
  });

  // The OSN check accepts the organiser session cookie first and falls back to
  // a bearer token; anything else is the plugin's own 401, not the handler's.
  describe("OSN credentials", () => {
    const linkWith = async (osn: (db: TestDb) => Promise<{ cookie?: string; bearer?: string }>) => {
      const { db, app } = buildApp();
      const guestCookie = await claimCookie(app, SAMPLETON);
      const { cookie, bearer } = await osn(db);
      const res = await postLink(app, {
        cookie: cookie ? `${guestCookie}; ${cookie}` : guestCookie,
        bearer,
        guestId: guestIdByName(db, "Bo"),
      });
      return { db, res };
    };

    it("links on a live organiser session cookie alone", async () => {
      const { db, res } = await linkWith(async (db) => ({
        cookie: `cire_org_session=${await seedOrganiserSession(db, "usr_alice")}`,
      }));
      expect(res.status).toBe(201);
      expect(db.select().from(guestAccountLinks).all()[0]?.osnProfileId).toBe("usr_alice");
    });

    it("falls through a dead organiser cookie to a valid bearer token", async () => {
      const { db, res } = await linkWith(async () => ({
        cookie: "cire_org_session=not-a-live-session-token",
        bearer: await auth.sign("usr_alice"),
      }));
      expect(res.status).toBe(201);
      expect(db.select().from(guestAccountLinks).all()[0]?.osnProfileId).toBe("usr_alice");
    });

    it("refuses a dead organiser cookie, an expired token and a foreign audience", async () => {
      for (const osn of [
        async () => ({ cookie: "cire_org_session=not-a-live-session-token" }),
        async () => ({ bearer: await auth.sign("usr_alice", { expiresIn: "-120s" }) }),
        async () => ({ bearer: await auth.sign("usr_alice", { audience: "some-other-aud" }) }),
      ]) {
        const { db, res } = await linkWith(osn);
        expect(res.status).toBe(401);
        // The plugin's body, so it was the OSN check that refused.
        expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
        expect(db.select().from(guestAccountLinks).all()).toEqual([]);
      }
    });
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

  it("returns 403 for a plus-one's seat, which no account may take", async () => {
    const { db, app } = buildApp();
    const samId = seedPlusOne(db, guestIdByName(db, "Bo"), { firstName: "Sam" });
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { cookie, bearer, guestId: samId });
    // Refused at the choice: a plus-one can never be the session's member.
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "plus_one_seat" });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);
  });

  it("returns 409 member_required when the session has chosen no member", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { cookie, bearer });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "member_required" });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);
  });

  it("links the session's member and ignores any guestId in the body", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const bo = guestIdByName(db, "Bo");
    expect((await chooseMember(app, cookie, bo)).status).toBe(200);
    const res = await app.fetch(
      new Request("http://localhost/api/account/link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Authorization: `Bearer ${await auth.sign("usr_alice")}`,
          "cf-connecting-ip": TEST_CF_IP,
          Origin: TEST_ORIGIN,
        },
        body: JSON.stringify({ guestId: guestIdByName(db, "Cleo") }),
      }),
    );
    expect(res.status).toBe(201);
    expect(
      db
        .select()
        .from(guestAccountLinks)
        .all()
        .map((r) => r.guestId),
    ).toEqual([bo]);
  });

  it("links a one-member household's only member with no choice made", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, TESTFAMILY);
    const res = await postLink(app, { cookie, bearer: await auth.sign("usr_alice") });
    expect(res.status).toBe(201);
    expect(await jsonBody(res)).toEqual({ linked: true, guestId: guestIdByName(db, "Ada") });
  });

  it("returns 409 when the same invitee is linked twice", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const guestId = guestIdByName(db, "Bo");
    const first = await postLink(app, { cookie, bearer, guestId });
    expect(first.status).toBe(201);
    // The link rotated the session — reuse the fresh cookie for the retry.
    const res = await postLink(app, { cookie: rotatedCookie(first, cookie), bearer, guestId });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "already_linked" });
  });

  // The "same account, different seat" conflict must be
  // INDISTINGUISHABLE from the "same invitee linked twice" conflict above —
  // identical status AND body — so the caller can't probe sibling-seat
  // membership of their own household (a membership oracle).
  it("returns the SAME opaque 409 when one OSN account claims two seats in a family", async () => {
    const { db, app } = buildApp(); // okResolver → same account for any profile
    const cookie = await claimCookie(app, SAMPLETON);
    const bo = guestIdByName(db, "Bo");
    const cleo = guestIdByName(db, "Cleo");
    const first = await postLink(app, { cookie, bearer: await auth.sign("usr_a"), guestId: bo });
    expect(first.status).toBe(201);
    // Reuse the rotated cookie for the second link in the same household.
    const res = await postLink(app, {
      cookie: rotatedCookie(first, cookie),
      bearer: await auth.sign("usr_b"),
      guestId: cleo,
    });
    expect(res.status).toBe(409);
    // Same opaque body as the guest-already-linked 409 — no `account_already_in_family`.
    expect(await jsonBody(res)).toEqual({ error: "already_linked" });
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
    const { app } = buildApp("disabled");
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    const res = await postLink(app, { cookie, bearer });
    expect(res.status).toBe(503);
  });
});

describe("POST /api/account/link — host preview", () => {
  it("never links the organiser's preview seat", async () => {
    // A host code opens the organiser's preview as a synthetic household with
    // one seat. That seat is not a guest, so it can never be linked, even by a
    // request crafted around the hidden box.
    const { db, app } = buildApp();
    const { publicId } = await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID, "cire-wedding")
        .pipe(Effect.provideService(DbService, db)),
    );
    const cookie = await claimCookie(app, publicId);
    const [hostSeat] = db
      .select({ id: guests.id })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(eq(families.publicId, publicId))
      .all();

    const res = await postLink(app, {
      cookie,
      bearer: await auth.sign("usr_owner"),
      guestId: hostSeat!.id,
    });
    expect(res.status).toBe(403);
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);
  });
});

describe("DELETE /api/account/link/:guestId", () => {
  /** A live `cire_org_session` for `profileId`, as the OIDC callback mints it. */
  async function orgCookie(db: TestDb, profileId: string): Promise<string> {
    const { token } = await Effect.runPromise(
      organiserSessionService
        .create({
          osnProfileId: profileId,
          osnSub: `sub_${profileId}`,
          email: null,
          handle: null,
          displayName: null,
          avatarUrl: null,
        })
        .pipe(Effect.provideService(DbService, db)),
    );
    return `cire_org_session=${token}`;
  }

  const del = (app: ReturnType<typeof createApp>, cookie: string, guestId: string) =>
    app.fetch(
      new Request(`http://localhost/api/account/link/${guestId}`, {
        method: "DELETE",
        headers: { Cookie: cookie, "cf-connecting-ip": TEST_CF_IP, Origin: TEST_ORIGIN },
      }),
    );

  it("lets the linked account release its own seat, idempotently", async () => {
    const { db, app } = buildApp();
    const cookie = await claimCookie(app, SAMPLETON);
    const guestId = guestIdByName(db, "Bo");
    const linked = await postLink(app, { cookie, bearer: await auth.sign("usr_alice"), guestId });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(1);
    // The link rotated the session — delete with the fresh cookie, signed in
    // as the linked account.
    const both = `${rotatedCookie(linked, cookie)}; ${await orgCookie(db, "usr_alice")}`;

    const res1 = await del(app, both, guestId);
    expect(res1.status).toBe(200);
    expect(await jsonBody(res1)).toEqual({ linked: false, guestId });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);
    expect((await del(app, both, guestId)).status).toBe(200);
  });

  it("refuses another account, or no sign-in, on the member's own seat", async () => {
    const { db, app } = buildApp(async (profileId) => ({
      ok: true,
      accountId: `acc_${profileId}`,
    }));
    const cookie = await claimCookie(app, SAMPLETON);
    const bo = guestIdByName(db, "Bo");
    const linked = await postLink(app, {
      cookie,
      bearer: await auth.sign("usr_alice"),
      guestId: bo,
    });
    const session = rotatedCookie(linked, cookie);

    const signedOut = await del(app, session, bo);
    expect(signedOut.status).toBe(403);
    const eve = await del(app, `${session}; ${await orgCookie(db, "usr_eve")}`, bo);
    expect(eve.status).toBe(403);
    expect(await jsonBody(eve)).toEqual({ error: "not_linked_account" });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(1);
  });

  it("refuses a seat that is not the session's member, in or out of the household", async () => {
    const { db, app } = buildApp();
    const sampletonCookie = await claimCookie(app, SAMPLETON);
    const bo = guestIdByName(db, "Bo");
    await postLink(app, {
      cookie: sampletonCookie,
      bearer: await auth.sign("usr_alice"),
      guestId: bo,
    });
    const org = await orgCookie(db, "usr_alice");

    // A different household (Testfamily, member Ada) tries to delete Bo's link.
    const testfamilyCookie = await claimCookie(app, TESTFAMILY);
    const res = await del(app, `${testfamilyCookie}; ${org}`, bo);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "not_your_seat" });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(1);
  });

  it("returns 401 without a guest session", async () => {
    const { db, app } = buildApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/account/link/${guestIdByName(db, "Bo")}`, {
        method: "DELETE",
        headers: { "cf-connecting-ip": TEST_CF_IP, Origin: TEST_ORIGIN },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("account-linking feature flag (cire.account-linking OFF)", () => {
  it("POST returns 503 (defense in depth — a crafted request can't link)", async () => {
    const { db, app } = buildApp(okResolver, false);
    const cookie = await claimCookie(app, SAMPLETON);
    const bearer = await auth.sign("usr_alice");
    // With the flag off there is no member step either.
    expect((await chooseMember(app, cookie, guestIdByName(db, "Bo"))).status).toBe(404);
    const res = await postLink(app, { cookie, bearer });
    expect(res.status).toBe(503);
    // Nothing was written.
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);
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
      flags: createStaticFlags({ "cire.account-linking": true }),
    });
    const cookie = await claimCookie(app, SAMPLETON);
    // Unlink is idempotent, so the same request can spend the budget.
    const unlink = () =>
      app.fetch(
        new Request(`http://localhost/api/account/link/${guestIdByName(db, "Bo")}`, {
          method: "DELETE",
          headers: { Cookie: cookie, "cf-connecting-ip": TEST_CF_IP, Origin: TEST_ORIGIN },
        }),
      );

    expect((await unlink()).status).not.toBe(429);
    expect((await unlink()).status).not.toBe(429);
    const limited = await unlink();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});
