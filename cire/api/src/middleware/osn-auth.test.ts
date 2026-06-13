import { describe, it, expect, beforeAll } from "bun:test";

import { Elysia } from "elysia";
import { SignJWT, generateKeyPair } from "jose";

import { appRequest } from "../test-helpers";
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
    expect(await res.json()).toEqual({ error: "unauthorised" });
  });

  it("derives osnProfileId for a valid ES256 token with aud osn-access", async () => {
    const app = buildApp();
    const token = await mint("osn-access");
    const res = await appRequest(app, "/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profileId: "usr_test123" });
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
