import { describe, it, expect, beforeAll } from "bun:test";

import { Hono } from "hono";
import { SignJWT, generateKeyPair } from "jose";

import { osnAuth } from "./osn-auth";

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
    const app = new Hono<{ Variables: { osnProfileId?: string } }>();
    app.use(
      "/probe",
      osnAuth({
        jwksUrl: "http://osn.test/.well-known/jwks.json",
        audience: "osn-access",
        _testKey: verifyKey,
      }),
    );
    app.get("/probe", (c) => c.json({ profileId: c.var.osnProfileId ?? null }));
    return app;
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
    const res = await app.request("/probe");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorised" });
  });

  it("sets c.var.osnProfileId for a valid ES256 token with aud osn-access", async () => {
    const app = buildApp();
    const token = await mint("osn-access");
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profileId: "usr_test123" });
  });

  it("returns 401 on wrong audience", async () => {
    const app = buildApp();
    const token = await mint("some-other-aud");
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
