import { describe, it, expect, beforeAll } from "bun:test";

import { Elysia } from "elysia";
import { SignJWT, generateKeyPair } from "jose";

import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { osnAuth, osnAuthResolve } from "../../src/middleware/osn-auth";
import { rateLimitMiddleware } from "../../src/middleware/rate-limit";
import { appRequest, jsonBody, recordStatements } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";

const KID = "test-kid-1";

describe("osnAuth (cire wrapper)", () => {
  let signKey: CryptoKey;
  let verifyKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
  });

  function buildApp() {
    return new Elysia({ aot: false })
      .use(
        osnAuth({
          jwksUrl: "http://osn.test/.well-known/jwks.json",
          audience: "osn-access",
          _testKey: verifyKey,
        }),
      )
      .get("/probe", ({ osnProfileId }) => ({ profileId: osnProfileId ?? null }));
  }

  function mint(audience: string, profileId = "usr_test123") {
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setSubject(profileId)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);
  }

  it("returns 401 without a Bearer header", async () => {
    const app = buildApp();
    const res = await appRequest(app, "/probe");
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
  });

  it("derives osnProfileId for a valid ES256 token with aud osn-access", async () => {
    const app = buildApp();
    const token = await mint("osn-access");
    const res = await appRequest(app, "/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ profileId: "usr_test123" });
  });

  it("returns 401 on wrong audience", async () => {
    const app = buildApp();
    const token = await mint("some-other-aud");
    const res = await appRequest(app, "/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("osnAuthResolve (the OSN check in before-handle order)", () => {
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

  const limiter = (allowed: boolean) => ({ check: () => allowed });

  /** A probe route behind a per-IP limiter mounted first, then the OSN check. */
  function buildApp(check: "resolve" | "derive", db?: TestDb, allowed = true) {
    const limited = new Elysia({ aot: false }).use(rateLimitMiddleware(limiter(allowed)));
    return check === "resolve"
      ? limited
          .use(osnAuthResolve(options(db)))
          .get("/probe", ({ osnProfileId }) => ({ profileId: osnProfileId ?? null }))
      : limited
          .use(osnAuth(options(db)))
          .get("/probe", ({ osnProfileId }) => ({ profileId: osnProfileId ?? null }));
  }

  const mint = (profileId = "usr_resolve1") =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setSubject(profileId)
      .setAudience("osn-access")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

  it("returns 401 without a credential", async () => {
    const res = await appRequest(buildApp("resolve"), "/probe");
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
  });

  it("names the profile behind a valid bearer token", async () => {
    const res = await appRequest(buildApp("resolve"), "/probe", {
      headers: { Authorization: `Bearer ${await mint()}` },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ profileId: "usr_resolve1" });
  });

  it("names the profile behind an organiser session cookie", async () => {
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie1");
    const res = await appRequest(buildApp("resolve", db), "/probe", {
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ profileId: "usr_cookie1" });
  });

  it("lets a limiter mounted first refuse before the session lookup", async () => {
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie2");
    const statements = recordStatements(db);
    const res = await appRequest(buildApp("resolve", db, false), "/probe", {
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(res.status).toBe(429);
    expect(statements).toEqual([]);
  });

  it("is needed: osnAuth looks the session up before any limiter refuses", async () => {
    // A derive runs in the transform phase, ahead of every before-handle hook
    // whatever the mount order — the reason the resolve form exists.
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie3");
    const statements = recordStatements(db);
    const res = await appRequest(buildApp("derive", db, false), "/probe", {
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(res.status).toBe(429);
    expect(statements.map((s) => s.sql)).toEqual([
      expect.stringMatching(/from "organiser_sessions"/),
    ]);
  });
});
