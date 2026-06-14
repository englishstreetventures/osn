import { describe, it, expect, afterEach } from "bun:test";

import { generateArcKeyPair, exportKeyToJwk, importKeyFromJwk } from "@shared/crypto/jwk";

import { createAccountResolverFromEnv, createArcAccountResolver } from "./osn-bridge";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function testKeyMaterial(): Promise<{ privateKey: CryptoKey; jwk: string }> {
  const pair = await generateArcKeyPair();
  return { privateKey: pair.privateKey, jwk: await exportKeyToJwk(pair.privateKey) };
}

describe("createArcAccountResolver", () => {
  it("signs an ARC token and resolves the account id from osn-api", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ accountId: "acc_xyz" }), { status: 200 });
    }) as typeof fetch;

    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("usr_123");

    expect(result).toEqual({ ok: true, accountId: "acc_xyz" });
    // Trailing slash trimmed; profile id query-encoded.
    expect(seen?.url).toBe("https://osn.example/graph/internal/profile-account?profileId=usr_123");
    // ARC scheme (not Bearer) with a JWT payload.
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    expect(seen?.auth?.split(".")).toHaveLength(3);
  });

  it("returns profile_not_found on a 404", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Profile not found" }), {
        status: 404,
      })) as typeof fetch;

    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_gone")).toEqual({ ok: false, reason: "profile_not_found" });
  });

  it("throws on a non-404 error status (treated as osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("usr_123")).rejects.toThrow(/returned 500/);
  });

  it("throws when the response is missing accountId", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("usr_123")).rejects.toThrow(/missing accountId/);
  });
});

describe("createAccountResolverFromEnv", () => {
  it("returns null when any ARC config piece is missing", async () => {
    const { jwk } = await testKeyMaterial();
    expect(await createAccountResolverFromEnv({})).toBeNull();
    expect(
      await createAccountResolverFromEnv({ osnApiUrl: "https://osn.example", arcKeyId: "k" }),
    ).toBeNull();
    expect(await createAccountResolverFromEnv({ arcPrivateKeyJwk: jwk, arcKeyId: "k" })).toBeNull();
  });

  it("builds a working resolver when all config is present", async () => {
    const { jwk } = await testKeyMaterial();
    // Sanity: the JWK round-trips to an importable key.
    await importKeyFromJwk(jwk);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accountId: "acc_env" }), { status: 200 })) as typeof fetch;

    const resolve = await createAccountResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: jwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).not.toBeNull();
    expect(await resolve!("usr_1")).toEqual({ ok: true, accountId: "acc_env" });
  });
});
