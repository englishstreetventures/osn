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

  // Derived props land on the context root (not `store`).
  const buildApp = () =>
    new Elysia()
      .use(osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }))
      .get("/me", ({ osnProfileId }) => ({ profileId: osnProfileId }));

  it("401 on missing token", async () => {
    const res = await buildApp().handle(new Request("http://localhost/me"));
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

    const res = await buildApp().handle(
      new Request("http://localhost/me", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileId: string };
    expect(body.profileId).toBe("usr_elysia");
  });

  it("401 on wrong audience", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_elysia")
      .setAudience("wrong-aud")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const res = await buildApp().handle(
      new Request("http://localhost/me", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401 on malformed token", async () => {
    const res = await buildApp().handle(
      new Request("http://localhost/me", {
        headers: { Authorization: "Bearer not.a.jwt" },
      }),
    );
    expect(res.status).toBe(401);
  });
});
