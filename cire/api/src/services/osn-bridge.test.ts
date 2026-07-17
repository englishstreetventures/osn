import { describe, it, expect, afterEach } from "bun:test";

import { generateArcKeyPair, exportKeyToJwk, importKeyFromJwk } from "@shared/crypto/jwk";

import {
  createAccountResolverFromEnv,
  createArcAccountResolver,
  createArcHandleResolver,
  createArcHandleSearchResolver,
  createArcOrgMembershipResolver,
  createArcProfileOrgsResolver,
  createHandleResolverFromEnv,
  createHandleSearchResolverFromEnv,
} from "./osn-bridge";

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
    // T-U1: the token must claim the DEDICATED resolve scope — osn-api's
    // /profile-account rejects plain graph:read (S-M1 pulse-onboarding). A
    // silent regression here would only surface as production 401s, because
    // cire's key is manually pre-registered.
    const payloadSegment = seen!.auth!.slice("ARC ".length).split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      scope?: string;
    };
    expect(payload.scope).toBe("graph:resolve-account");
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

  // A PRESENT-but-INVALID ARC key must be treated EXACTLY like an absent one:
  // the builder returns null (⇒ feature disabled, POST answers 503) and NEVER
  // throws. A throw here propagated out of the Worker setup path and 500'd every
  // authenticated request (the production dashboard login-loop incident).
  it.each([
    ["non-JSON garbage", "{not-json"],
    ["plain string", "garbage"],
    ["valid JSON but not a usable JWK", '{"kty":"EC"}'],
  ])("returns null (does NOT throw) when the ARC key is malformed: %s", async (_label, badJwk) => {
    let resolve: unknown;
    expect(async () => {
      resolve = await createAccountResolverFromEnv({
        osnApiUrl: "https://osn.example",
        arcPrivateKeyJwk: badJwk,
        arcKeyId: "kid-env",
      });
    }).not.toThrow();
    resolve = await createAccountResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: badJwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).toBeNull();
  });
});

describe("createArcHandleResolver", () => {
  it("signs an ARC token and resolves a profile id from osn-api", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ profileId: "usr_alice", handle: "alice" }), {
        status: 200,
      });
    }) as typeof fetch;

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("@Alice");

    expect(result).toEqual({ ok: true, profileId: "usr_alice", handle: "alice" });
    // Trailing slash trimmed; handle query-encoded (raw — osn normalises).
    expect(seen?.url).toBe("https://osn.example/graph/internal/profile-by-handle?handle=%40Alice");
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    expect(seen?.auth?.split(".")).toHaveLength(3);
  });

  it("returns profile_not_found on a 404", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Profile not found" }), {
        status: 404,
      })) as typeof fetch;

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("ghost")).toEqual({ ok: false, reason: "profile_not_found" });
  });

  it("throws on a non-404 error status (treated as osn unavailable → 502)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("alice")).rejects.toThrow(/returned 500/);
  });

  it("throws when the response is missing profileId", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("alice")).rejects.toThrow(/missing profileId/);
  });

  it("echoes the requested handle when osn omits it from the response", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ profileId: "usr_alice" }), { status: 200 })) as typeof fetch;

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("alice")).toEqual({ ok: true, profileId: "usr_alice", handle: "alice" });
  });
});

describe("createHandleResolverFromEnv", () => {
  it("returns null when any ARC config piece is missing", async () => {
    const { jwk } = await testKeyMaterial();
    expect(await createHandleResolverFromEnv({})).toBeNull();
    expect(
      await createHandleResolverFromEnv({ osnApiUrl: "https://osn.example", arcKeyId: "k" }),
    ).toBeNull();
    expect(await createHandleResolverFromEnv({ arcPrivateKeyJwk: jwk, arcKeyId: "k" })).toBeNull();
  });

  it("builds a working resolver when all config is present", async () => {
    const { jwk } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ profileId: "usr_env", handle: "env" }), {
        status: 200,
      })) as typeof fetch;

    const resolve = await createHandleResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: jwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).not.toBeNull();
    expect(await resolve!("env")).toEqual({ ok: true, profileId: "usr_env", handle: "env" });
  });

  // Sibling of the account-resolver guard: a corrupt CIRE_API_ARC_PRIVATE_KEY
  // must disable add-co-host-by-handle (POST 503), never crash the builder.
  it.each([
    ["non-JSON garbage", "{not-json"],
    ["plain string", "garbage"],
    ["valid JSON but not a usable JWK", '{"kty":"EC"}'],
  ])("returns null (does NOT throw) when the ARC key is malformed: %s", async (_label, badJwk) => {
    expect(async () => {
      await createHandleResolverFromEnv({
        osnApiUrl: "https://osn.example",
        arcPrivateKeyJwk: badJwk,
        arcKeyId: "kid-env",
      });
    }).not.toThrow();
    const resolve = await createHandleResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: badJwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).toBeNull();
  });
});

describe("createArcHandleSearchResolver", () => {
  it("signs an ARC token and returns the suggestion list from osn-api", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(
        JSON.stringify({
          profiles: [
            { id: "usr_alice", handle: "alice", displayName: "Alice" },
            { id: "usr_alina", handle: "alina", displayName: null },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("al");

    expect(result).toEqual([
      { profileId: "usr_alice", handle: "alice", displayName: "Alice" },
      { profileId: "usr_alina", handle: "alina", displayName: null },
    ]);
    // Trailing slash trimmed; prefix query-encoded (raw — osn normalises).
    expect(seen?.url).toBe("https://osn.example/graph/internal/profile-search?prefix=al");
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    expect(seen?.auth?.split(".")).toHaveLength(3);
  });

  it("returns an empty list for a blank prefix without calling osn-api", async () => {
    const { privateKey } = await testKeyMaterial();
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
    }) as typeof fetch;

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("   ")).toEqual([]);
    expect(called).toBe(false);
  });

  it("FAIL-SOFT: returns an empty list on a non-ok status (osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("al")).toEqual([]);
  });

  it("FAIL-SOFT: returns an empty list when fetch throws", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("al")).toEqual([]);
  });

  it("skips malformed rows and coerces a non-string displayName to null", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          profiles: [
            { id: "usr_ok", handle: "ok", displayName: 42 },
            { id: 99, handle: "bad-id" },
            { handle: "no-id" },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("ok")).toEqual([{ profileId: "usr_ok", handle: "ok", displayName: null }]);
  });
});

describe("createHandleSearchResolverFromEnv", () => {
  it("returns null when any ARC config piece is missing", async () => {
    const { jwk } = await testKeyMaterial();
    expect(await createHandleSearchResolverFromEnv({})).toBeNull();
    expect(
      await createHandleSearchResolverFromEnv({ osnApiUrl: "https://osn.example", arcKeyId: "k" }),
    ).toBeNull();
    expect(
      await createHandleSearchResolverFromEnv({ arcPrivateKeyJwk: jwk, arcKeyId: "k" }),
    ).toBeNull();
  });

  it("builds a working resolver when all config is present", async () => {
    const { jwk } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ profiles: [{ id: "usr_env", handle: "env" }] }), {
        status: 200,
      })) as typeof fetch;

    const resolve = await createHandleSearchResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: jwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).not.toBeNull();
    expect(await resolve!("env")).toEqual([
      { profileId: "usr_env", handle: "env", displayName: null },
    ]);
  });

  // Sibling of the other builder guards: a corrupt CIRE_API_ARC_PRIVATE_KEY must
  // disable autocomplete (search returns empty), never crash the builder.
  it.each([
    ["non-JSON garbage", "{not-json"],
    ["plain string", "garbage"],
    ["valid JSON but not a usable JWK", '{"kty":"EC"}'],
  ])("returns null (does NOT throw) when the ARC key is malformed: %s", async (_label, badJwk) => {
    expect(async () => {
      await createHandleSearchResolverFromEnv({
        osnApiUrl: "https://osn.example",
        arcPrivateKeyJwk: badJwk,
        arcKeyId: "kid-env",
      });
    }).not.toThrow();
    const resolve = await createHandleSearchResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: badJwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).toBeNull();
  });
});

describe("createArcProfileOrgsResolver", () => {
  it("signs an ARC token with org:read scope and returns organisationIds", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ organisationIds: ["org_1", "org_2"] }), {
        status: 200,
      });
    }) as typeof fetch;

    const resolve = createArcProfileOrgsResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("usr_x");

    expect(result).toEqual(["org_1", "org_2"]);
    // Trailing slash trimmed; profileId query-encoded.
    expect(seen?.url).toBe(
      "https://osn.example/organisations/internal/profile-orgs?profileId=usr_x",
    );
    // ARC scheme with a 3-segment JWT.
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    expect(seen?.auth?.split(".")).toHaveLength(3);
    // Assert the token carries the org:read scope (not graph:read).
    const payloadSegment = seen!.auth!.slice("ARC ".length).split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      scope?: string;
    };
    expect(payload.scope).toBe("org:read");
  });

  it("FAIL-SOFT: returns [] on a non-ok status (osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const resolve = createArcProfileOrgsResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_x")).toEqual([]);
  });

  it("FAIL-SOFT: returns [] when fetch throws (network down)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const resolve = createArcProfileOrgsResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_x")).toEqual([]);
  });
});

describe("createArcOrgMembershipResolver", () => {
  it("signs an ARC token with org:read scope and returns the role", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ role: "admin" }), { status: 200 });
    }) as typeof fetch;

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("org_1", "usr_x");

    expect(result).toBe("admin");
    // Trailing slash trimmed; params query-encoded.
    expect(seen?.url).toBe(
      "https://osn.example/organisations/internal/membership?orgId=org_1&profileId=usr_x",
    );
    // ARC scheme with a 3-segment JWT.
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    expect(seen?.auth?.split(".")).toHaveLength(3);
    // Assert the token carries the org:read scope.
    const payloadSegment = seen!.auth!.slice("ARC ".length).split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      scope?: string;
    };
    expect(payload.scope).toBe("org:read");
  });

  it("returns 'member' when the role is member", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ role: "member" }), { status: 200 })) as typeof fetch;

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBe("member");
  });

  it("FAIL-SOFT: returns null on a non-ok status (osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBeNull();
  });

  it("FAIL-SOFT: returns null when fetch throws (network down)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBeNull();
  });

  it("FAIL-SOFT: returns null when role is an unrecognised value", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ role: "superadmin" }), { status: 200 })) as typeof fetch;

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBeNull();
  });
});
