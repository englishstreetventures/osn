import { Elysia } from "elysia";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { describe, expect, it, beforeAll } from "vitest";

import { osnAuth } from "../src/middleware/elysia";

describe("osnAuth (Elysia adapter)", () => {
  let signKey: CryptoKey;
  let kid: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    kid = "test-kid-1";
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

  it("401 on missing token", async () => {
    const app = new Elysia()
      .use(osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }))
      .get("/me", ({ store }) => ({
        profileId: (store as { osnProfileId?: string }).osnProfileId,
      }));

    const res = await app.handle(new Request("http://localhost/me"));
    expect(res.status).toBe(401);
  });

  it("sets osnProfileId on valid token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_elysia")
      .setAudience("osn-access")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const app = new Elysia()
      .use(osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }))
      .get("/me", (ctx) => ({
        profileId: (ctx as unknown as { osnProfileId?: string }).osnProfileId,
      }));

    const res = await app.handle(
      new Request("http://localhost/me", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileId: string };
    expect(body.profileId).toBe("usr_elysia");
  });
});
