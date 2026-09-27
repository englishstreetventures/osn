import { describe, it, expect, beforeAll } from "bun:test";

import { Elysia } from "elysia";
import { SignJWT, generateKeyPair } from "jose";

import { createDb } from "../../src/db/setup";
import { osnAuth, resolveOsnProfileId } from "../../src/middleware/osn-auth";
import { appRequest, jsonBody } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth, OSN_TEST_ISSUER, type OsnTestAuth } from "../test-helpers/osn-token";

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
