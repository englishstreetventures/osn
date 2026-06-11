import { Hono } from "hono";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { describe, expect, it, beforeAll } from "vitest";

import { osnAuth } from "../src/middleware/hono";

describe("osnAuth (Hono adapter)", () => {
  let signKey: CryptoKey;
  let verifyKey: CryptoKey;
  let kid: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
    kid = "test-kid-1";
    const jwk = await exportJWK(verifyKey);
    const keys = [{ ...jwk, kid, alg: "ES256", use: "sig" }];
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      input: Parameters<typeof fetch>[0],
    ) => {
      if (String(input).endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as typeof fetch;
  });

  it("401 when no Bearer header", async () => {
    const app = new Hono();
    app.use(
      "/protected/*",
      osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }),
    );
    app.get("/protected/me", (c) =>
      c.json({ profileId: (c.var as unknown as { osnProfileId?: string }).osnProfileId }),
    );
    const res = await app.request("/protected/me");
    expect(res.status).toBe(401);
  });

  it("sets c.var.osnProfileId on valid token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_test123")
      .setAudience("osn-access")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const app = new Hono<{ Variables: { osnProfileId: string } }>();
    app.use(
      "/protected/*",
      osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }),
    );
    app.get("/protected/me", (c) => c.json({ profileId: c.var.osnProfileId }));

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileId: string };
    expect(body.profileId).toBe("usr_test123");
  });

  it("401 on wrong audience", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_test123")
      .setAudience("wrong-aud")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const app = new Hono();
    app.use(
      "/protected/*",
      osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }),
    );
    app.get("/protected/me", (c) => c.text("ok"));

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
