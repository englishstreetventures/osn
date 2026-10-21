import { describe, it, expect, beforeAll, spyOn } from "bun:test";

import { BOOTSTRAP_WEDDING_ID } from "@cire/db";
import { DEV_OWNER_PROFILE_ID } from "@cire/db/seed";
import { Elysia } from "elysia";
import type { AnyElysia } from "elysia";
import { SignJWT, generateKeyPair } from "jose";

import type { Db } from "../../src/db";
import { createDb, seedBootstrapWedding } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { osnAuth, resolveOsnProfileId } from "../../src/middleware/osn-auth";
import { rateLimitMiddleware } from "../../src/middleware/rate-limit";
import { vendorOrgMember } from "../../src/middleware/vendor-org-member";
import { weddingEditor } from "../../src/middleware/wedding-editor";
import { weddingMember } from "../../src/middleware/wedding-member";
import { weddingOwner, weddingOwnerIncludingDeleted } from "../../src/middleware/wedding-owner";
import { weddingRunSheet } from "../../src/middleware/wedding-run-sheet";
import { weddingSeat } from "../../src/middleware/wedding-seat";
import { weddingTier } from "../../src/middleware/wedding-tier";
import type { OsnOrgMembershipResolver } from "../../src/services/osn-bridge";
import { appRequest, jsonBody, recordStatements } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth, OSN_TEST_ISSUER, type OsnTestAuth } from "../test-helpers/osn-token";

const KID = "test-kid-1";

const limiter = (allowed: boolean) => ({ check: () => allowed });

describe("osnAuth", () => {
  let signKey: CryptoKey;
  let verifyKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
  });

  const options = (db?: TestDb) => ({
    jwksUrl: "http://osn.test/.well-known/jwks.json",
    audience: "osn-access",
    _testKey: verifyKey,
    db,
  });

  /** A probe route behind a per-IP limiter mounted first, then the OSN check. */
  function buildApp(db?: TestDb, allowed = true) {
    return new Elysia({ aot: false })
      .use(rateLimitMiddleware(limiter(allowed)))
      .use(osnAuth(options(db)))
      .get("/probe", ({ osnProfileId }) => ({ profileId: osnProfileId ?? null }));
  }

  const mint = (audience = "osn-access", profileId = "usr_test123") =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setSubject(profileId)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

  it("returns 401 without a credential", async () => {
    const res = await appRequest(buildApp(), "/probe");
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
  });

  it("names the profile behind a valid ES256 token with aud osn-access", async () => {
    const res = await appRequest(buildApp(), "/probe", {
      headers: { Authorization: `Bearer ${await mint()}` },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ profileId: "usr_test123" });
  });

  it("returns 401 on wrong audience", async () => {
    const res = await appRequest(buildApp(), "/probe", {
      headers: { Authorization: `Bearer ${await mint("some-other-aud")}` },
    });
    expect(res.status).toBe(401);
  });

  it("names the profile behind an organiser session cookie", async () => {
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie1");
    const res = await appRequest(buildApp(db), "/probe", {
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ profileId: "usr_cookie1" });
  });

  it("lets a limiter mounted first refuse before the session lookup", async () => {
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie2");
    const statements = recordStatements(db);
    const res = await appRequest(buildApp(db, false), "/probe", {
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(res.status).toBe(429);
    expect(statements).toEqual([]);
  });

  it("lets a limiter mounted first refuse before the token's keys are fetched", async () => {
    // No injected key, so a bearer token is verified against the JWKS URL —
    // its fetch is the one visible cost of that path. Each probe has a URL of
    // its own, so the module's key cache cannot hide a fetch.
    // At most one call per probe, so one response body is enough.
    const fetches = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "unavailable" }, { status: 503 }),
    );
    try {
      const send = async (allowed: boolean) => {
        const jwksUrl = `http://osn.test/${crypto.randomUUID()}/jwks.json`;
        const app = new Elysia({ aot: false })
          .use(rateLimitMiddleware(limiter(allowed)))
          .use(osnAuth({ jwksUrl, audience: "osn-access" }))
          .get("/probe", ({ osnProfileId }) => ({ profileId: osnProfileId ?? null }));
        return appRequest(app, "/probe", {
          headers: { Authorization: `Bearer ${await mint()}` },
        });
      };

      expect((await send(false)).status).toBe(429);
      expect(fetches).not.toHaveBeenCalled();
      // Control: let through, the same token does cost the fetch.
      expect((await send(true)).status).toBe(401);
      expect(fetches).toHaveBeenCalledTimes(1);
    } finally {
      fetches.mockRestore();
    }
  });

  it("falls back to the bearer token when the organiser cookie is dead", async () => {
    const db = createDb(":memory:");
    const res = await appRequest(buildApp(db), "/probe", {
      headers: {
        cookie: "cire_org_session=not-a-live-session-token",
        Authorization: `Bearer ${await mint("osn-access", "usr_bearer1")}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ profileId: "usr_bearer1" });
  });

  it("takes the organiser cookie's profile over a bearer token's", async () => {
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie4");
    const res = await appRequest(buildApp(db), "/probe", {
      headers: {
        cookie: `cire_org_session=${token}`,
        Authorization: `Bearer ${await mint("osn-access", "usr_bearer2")}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ profileId: "usr_cookie4" });
  });

  it("refuses a dead organiser cookie", async () => {
    const db = createDb(":memory:");
    const res = await appRequest(buildApp(db), "/probe", {
      headers: { cookie: "cire_org_session=not-a-live-session-token" },
    });
    expect(res.status).toBe(401);
  });
});

// Every role gate reads `osnProfileId` and runs its own query in the
// before-handle phase, in `.use` order. So behind a limiter mounted first and
// `osnAuth`, a refused request costs neither the session lookup nor the gate's
// read, and a request let through costs both. The second half matters as much
// as the first: a gate left running in the transform phase would see no
// profile there, refuse with 401 before any query, and pass the refused case.
describe("role gates behind osnAuth and a limiter mounted first", () => {
  const ORG = "org_probe";

  /** Membership resolver that counts its calls; the dev owner is an admin of ORG. */
  function countingMembership() {
    let calls = 0;
    const resolve: OsnOrgMembershipResolver = async (orgId, profileId) => {
      calls++;
      return orgId === ORG && profileId === DEV_OWNER_PROFILE_ID ? "admin" : null;
    };
    return { resolve, calls: () => calls };
  }

  const gates: {
    name: string;
    plugins: (db: Db, membership: OsnOrgMembershipResolver) => AnyElysia[];
    /** What a request let through answers: the gate's pass, or its own refusal. */
    allowedStatus: number;
    /** Whether the gate reads D1 (false: it calls the membership resolver instead). */
    reads: boolean;
  }[] = [
    {
      name: "weddingMember",
      plugins: (db) => [weddingMember(db)],
      allowedStatus: 200,
      reads: true,
    },
    {
      name: "weddingEditor",
      plugins: (db) => [weddingEditor(db)],
      allowedStatus: 200,
      reads: true,
    },
    { name: "weddingOwner", plugins: (db) => [weddingOwner(db)], allowedStatus: 200, reads: true },
    {
      name: "weddingOwnerIncludingDeleted",
      plugins: (db) => [weddingOwnerIncludingDeleted(db)],
      allowedStatus: 200,
      reads: true,
    },
    {
      name: "weddingRunSheet",
      plugins: (db) => [weddingRunSheet(db)],
      allowedStatus: 200,
      reads: true,
    },
    { name: "weddingSeat", plugins: (db) => [weddingSeat(db)], allowedStatus: 200, reads: true },
    {
      // The bootstrap wedding is on `ivory`, so the tier gate answers 402 —
      // which it can only do once it has run, after the member gate.
      name: "weddingTier behind weddingMember",
      plugins: (db) => [weddingMember(db), weddingTier(db, "gold")],
      allowedStatus: 402,
      reads: true,
    },
    {
      name: "vendorOrgMember",
      plugins: (_db, membership) => [vendorOrgMember(ORG, membership)],
      allowedStatus: 200,
      reads: false,
    },
  ];

  async function send(
    plugins: (db: Db, membership: OsnOrgMembershipResolver) => AnyElysia[],
    allowed: boolean,
  ) {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const token = await seedOrganiserSession(db, DEV_OWNER_PROFILE_ID);
    const membership = countingMembership();
    const app = new Elysia({ aot: false })
      .use(rateLimitMiddleware(limiter(allowed)))
      .use(
        osnAuth({ jwksUrl: "http://osn.test/.well-known/jwks.json", audience: "osn-access", db }),
      )
      .group("/weddings/:weddingId", (group) => {
        let gated: AnyElysia = group;
        for (const plugin of plugins(db, membership.resolve)) gated = gated.use(plugin);
        return gated.get("/probe", () => ({ ok: true }));
      });
    const statements = recordStatements(db);
    const res = await appRequest(app, `/weddings/${BOOTSTRAP_WEDDING_ID}/probe`, {
      headers: { cookie: `cire_org_session=${token}` },
    });
    return { res, statements, membershipCalls: membership.calls() };
  }

  for (const { name, plugins, allowedStatus, reads } of gates) {
    it(`${name}: a refused request costs no query and no membership call`, async () => {
      const { res, statements, membershipCalls } = await send(plugins, false);
      expect(res.status).toBe(429);
      expect(statements).toEqual([]);
      expect(membershipCalls).toBe(0);
    });

    it(`${name}: a request let through runs the gate after the session lookup`, async () => {
      const { res, statements, membershipCalls } = await send(plugins, true);
      expect(res.status).toBe(allowedStatus);
      expect(statements[0]?.sql).toMatch(/from "organiser_sessions"/);
      if (reads) {
        expect(statements.slice(1).some((s) => /"wedding_hosts"/.test(s.sql))).toBe(true);
      } else {
        expect(membershipCalls).toBe(1);
      }
    });
  }
});

describe("resolveOsnProfileId", () => {
  let auth: OsnTestAuth;
  let baseOptions: { jwksUrl: string; audience: string; issuer: string; _testKey: CryptoKey };

  beforeAll(async () => {
    auth = await makeOsnTestAuth();
    baseOptions = {
      jwksUrl: "http://osn.test/.well-known/jwks.json",
      audience: "osn-access",
      issuer: OSN_TEST_ISSUER,
      _testKey: auth.key,
    };
  });

  const request = (headers: Record<string, string>) =>
    new Request("https://api.example.test/realtime/x", { headers });

  it("names the organiser from the cire_org_session cookie", async () => {
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie");
    const options = { ...baseOptions, db };
    expect(
      await resolveOsnProfileId(request({ cookie: `cire_org_session=${token}` }), options),
    ).toBe("usr_cookie");
  });

  it("names the organiser from a Bearer access token", async () => {
    const token = await auth.sign("usr_bearer");
    expect(
      await resolveOsnProfileId(request({ authorization: `Bearer ${token}` }), baseOptions),
    ).toBe("usr_bearer");
  });

  it("falls through a stale cookie to the Bearer token", async () => {
    const db = createDb(":memory:");
    const token = await auth.sign("usr_bearer");
    const headers = { cookie: "cire_org_session=not-a-session", authorization: `Bearer ${token}` };
    expect(await resolveOsnProfileId(request(headers), { ...baseOptions, db })).toBe("usr_bearer");
  });

  it("is undefined with neither", async () => {
    expect(await resolveOsnProfileId(request({}), baseOptions)).toBeUndefined();
  });
});
