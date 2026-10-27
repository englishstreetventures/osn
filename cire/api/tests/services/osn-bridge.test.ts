import { describe, it, expect, afterEach } from "bun:test";

import { generateArcKeyPair, exportKeyToJwk, importKeyFromJwk } from "@shared/crypto/jwk";

import {
  cacheAccountResolver,
  cacheProfileDisplayResolver,
  createAccountResolverFromEnv,
  createArcAccountResolver,
  createArcBlockCheck,
  createArcHandleResolver,
  createArcHandleSearchResolver,
  createArcConnectionSearchResolver,
  createArcOrgMembershipResolver,
  createArcProfileOrgsResolver,
  createBlockCheckFromEnv,
  createConnectionSearchResolverFromEnv,
  createHandleResolverFromEnv,
  createHandleSearchResolverFromEnv,
} from "../../src/services/osn-bridge";
import type {
  OsnAccountResolution,
  OsnAccountResolver,
  OsnProfileDisplay,
  OsnProfileDisplayResolver,
} from "../../src/services/osn-bridge";
import { mockFetch } from "../test-helpers";

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
    globalThis.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ accountId: "acc_xyz" }), { status: 200 });
    });

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
    // The token must claim the DEDICATED resolve scope — osn-api's
    // /profile-account rejects plain graph:read. A silent regression here
    // would only surface as production 401s, because cire's key is
    // manually pre-registered.
    const payloadSegment = seen!.auth!.slice("ARC ".length).split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      scope?: string;
    };
    expect(payload.scope).toBe("graph:resolve-account");
  });

  it("returns profile_not_found on a 404", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ error: "Profile not found" }), {
          status: 404,
        }),
    );

    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_gone")).toEqual({ ok: false, reason: "profile_not_found" });
  });

  it("throws on a non-404 error status (treated as osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => new Response("boom", { status: 500 }));

    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("usr_123")).rejects.toThrow(/returned 500/);
  });

  it("throws when the response is missing accountId", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));

    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("usr_123")).rejects.toThrow(/missing accountId/);
  });
  it("passes the caller's abort signal to the request", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: AbortSignal | null | undefined;
    globalThis.fetch = mockFetch(async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal;
      return new Response(JSON.stringify({ accountId: "acc_xyz" }), { status: 200 });
    });
    const resolve = createArcAccountResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const controller = new AbortController();
    await resolve("usr_123", { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe("cacheAccountResolver", () => {
  function counting(answer: (profileId: string) => Promise<OsnAccountResolution>) {
    const calls: string[] = [];
    const resolve: OsnAccountResolver = (profileId) => {
      calls.push(profileId);
      return answer(profileId);
    };
    return { calls, resolve };
  }

  it("answers a repeat lookup from the cache until it expires", async () => {
    let clock = 0;
    const inner = counting(async (id) => ({ ok: true, accountId: `acc_${id}` }));
    const resolve = cacheAccountResolver(inner.resolve, { ttlMs: 1000, now: () => clock });
    expect(await resolve("usr_a")).toEqual({ ok: true, accountId: "acc_usr_a" });
    clock = 999;
    expect(await resolve("usr_a")).toEqual({ ok: true, accountId: "acc_usr_a" });
    expect(inner.calls).toEqual(["usr_a"]);
    clock = 1000;
    await resolve("usr_a");
    expect(inner.calls).toEqual(["usr_a", "usr_a"]);
  });

  it("keeps no unknown profile and no failure", async () => {
    const missing = counting(async () => ({ ok: false, reason: "profile_not_found" }));
    const cachedMissing = cacheAccountResolver(missing.resolve);
    await cachedMissing("usr_gone");
    await cachedMissing("usr_gone");
    expect(missing.calls).toHaveLength(2);

    const down = counting(() => Promise.reject(new Error("ECONNREFUSED")));
    const cachedDown = cacheAccountResolver(down.resolve);
    await expect(cachedDown("usr_a")).rejects.toThrow("ECONNREFUSED");
    await expect(cachedDown("usr_a")).rejects.toThrow("ECONNREFUSED");
    expect(down.calls).toHaveLength(2);
  });

  it("drops the oldest profile when full", async () => {
    const inner = counting(async (id) => ({ ok: true, accountId: `acc_${id}` }));
    const resolve = cacheAccountResolver(inner.resolve, { maxEntries: 2 });
    await resolve("usr_a");
    await resolve("usr_b");
    await resolve("usr_c");
    await resolve("usr_b");
    await resolve("usr_c");
    expect(inner.calls).toEqual(["usr_a", "usr_b", "usr_c"]);
    await resolve("usr_a");
    expect(inner.calls).toEqual(["usr_a", "usr_b", "usr_c", "usr_a"]);
  });

  it("passes the caller's signal through", async () => {
    let seen: AbortSignal | undefined;
    const resolve = cacheAccountResolver(async (_id, options) => {
      seen = options?.signal;
      return { ok: true, accountId: "acc_x" };
    });
    const controller = new AbortController();
    await resolve("usr_a", { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe("cacheProfileDisplayResolver", () => {
  const face = (id: string): OsnProfileDisplay => ({
    handle: id.replace("usr_", ""),
    displayName: `${id} name`,
    avatarUrl: null,
  });
  /** A resolver that knows every id but `unknown`, and records each batch. */
  function counting(answer?: (ids: readonly string[]) => Promise<Map<string, OsnProfileDisplay>>) {
    const calls: string[][] = [];
    const resolve: OsnProfileDisplayResolver = (ids) => {
      calls.push([...ids]);
      return answer
        ? answer(ids)
        : Promise.resolve(
            new Map(ids.filter((id) => id !== "unknown").map((id) => [id, face(id)])),
          );
    };
    return { calls, resolve };
  }

  it("answers a repeat lookup from the cache until it expires", async () => {
    let clock = 0;
    const inner = counting();
    const resolve = cacheProfileDisplayResolver(inner.resolve, { ttlMs: 1000, now: () => clock });
    expect(await resolve(["usr_a"])).toEqual(new Map([["usr_a", face("usr_a")]]));
    clock = 999;
    expect(await resolve(["usr_a"])).toEqual(new Map([["usr_a", face("usr_a")]]));
    expect(inner.calls).toEqual([["usr_a"]]);
    clock = 1000;
    await resolve(["usr_a"]);
    expect(inner.calls).toEqual([["usr_a"], ["usr_a"]]);
  });

  it("asks osn-api only for the profiles it does not hold, and answers all of them", async () => {
    const inner = counting();
    const resolve = cacheProfileDisplayResolver(inner.resolve);
    await resolve(["usr_a", "usr_b"]);
    const both = await resolve(["usr_b", "usr_c", "usr_a"]);
    expect(inner.calls).toEqual([["usr_a", "usr_b"], ["usr_c"]]);
    expect(both).toEqual(
      new Map([
        ["usr_b", face("usr_b")],
        ["usr_a", face("usr_a")],
        ["usr_c", face("usr_c")],
      ]),
    );
  });

  it("does not call osn-api when it holds every profile asked for", async () => {
    const inner = counting();
    const resolve = cacheProfileDisplayResolver(inner.resolve);
    await resolve(["usr_a"]);
    await resolve(["usr_a"]);
    await resolve([]);
    expect(inner.calls).toEqual([["usr_a"]]);
  });

  it("keeps no profile osn-api did not name, and no failure", async () => {
    const inner = counting();
    const resolve = cacheProfileDisplayResolver(inner.resolve);
    expect(await resolve(["unknown"])).toEqual(new Map());
    await resolve(["unknown"]);
    expect(inner.calls).toEqual([["unknown"], ["unknown"]]);

    const down = counting(() => Promise.reject(new Error("ECONNREFUSED")));
    const cachedDown = cacheProfileDisplayResolver(down.resolve);
    await expect(cachedDown(["usr_a"])).rejects.toThrow("ECONNREFUSED");
    await expect(cachedDown(["usr_a"])).rejects.toThrow("ECONNREFUSED");
    expect(down.calls).toEqual([["usr_a"], ["usr_a"]]);
  });

  it("counts a profile looked up again after it expired as the newest", async () => {
    let clock = 0;
    const inner = counting();
    const resolve = cacheProfileDisplayResolver(inner.resolve, {
      ttlMs: 1000,
      maxEntries: 3,
      now: () => clock,
    });
    for (const id of ["usr_x", "usr_a", "usr_b"]) {
      await resolve([id]);
      clock += 1;
    }
    // X and A have expired, B has not. A, asked again, becomes the newest, so
    // the two profiles after it push out X and then B, never A.
    clock = 1001;
    await resolve(["usr_a"]);
    await resolve(["usr_c"]);
    await resolve(["usr_d"]);
    await resolve(["usr_a", "usr_c", "usr_d"]);
    expect(inner.calls).toEqual([["usr_x"], ["usr_a"], ["usr_b"], ["usr_a"], ["usr_c"], ["usr_d"]]);
  });

  it("drops the oldest profile when full", async () => {
    const inner = counting();
    const resolve = cacheProfileDisplayResolver(inner.resolve, { maxEntries: 2 });
    await resolve(["usr_a"]);
    await resolve(["usr_b"]);
    await resolve(["usr_c"]);
    await resolve(["usr_b", "usr_c"]);
    expect(inner.calls).toEqual([["usr_a"], ["usr_b"], ["usr_c"]]);
    await resolve(["usr_a"]);
    expect(inner.calls).toEqual([["usr_a"], ["usr_b"], ["usr_c"], ["usr_a"]]);
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

    globalThis.fetch = mockFetch(
      async () => new Response(JSON.stringify({ accountId: "acc_env" }), { status: 200 }),
    );

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
    globalThis.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ profileId: "usr_alice", handle: "alice" }), {
        status: 200,
      });
    });

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
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ error: "Profile not found" }), {
          status: 404,
        }),
    );

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("ghost")).toEqual({ ok: false, reason: "profile_not_found" });
  });

  it("throws on a non-404 error status (treated as osn unavailable → 502)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => new Response("boom", { status: 500 }));

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("alice")).rejects.toThrow(/returned 500/);
  });

  it("throws when the response is missing profileId", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    await expect(resolve("alice")).rejects.toThrow(/missing profileId/);
  });

  it("echoes the requested handle when osn omits it from the response", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(
      async () => new Response(JSON.stringify({ profileId: "usr_alice" }), { status: 200 }),
    );

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("alice")).toEqual({ ok: true, profileId: "usr_alice", handle: "alice" });
  });

  it("gives up once its time bound passes when osn-api never answers", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = silentOsnApi({ profileId: "usr_alice", handle: "alice" });

    const resolve = createArcHandleResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
      timeoutMs: 20,
    });
    await expect(resolve("alice")).rejects.toThrow();
  });
});

/**
 * An osn-api that never answers a request carrying an abort signal: the call
 * settles only when that signal aborts, as a real `fetch` does. A request with
 * no signal gets `answer` at once, so a call with no time bound fails the test
 * at once rather than hanging it.
 */
function silentOsnApi(answer: unknown) {
  return mockFetch(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          resolve(new Response(JSON.stringify(answer), { status: 200 }));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

describe("createArcBlockCheck", () => {
  const config = async (timeoutMs?: number) => ({
    osnApiUrl: "https://osn.example//",
    arcPrivateKey: (await testKeyMaterial()).privateKey,
    arcKeyId: "kid-1",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  it("asks osn-api with a graph:read ARC token whether either profile blocked the other", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
      return new Response(JSON.stringify({ blocked: true }), { status: 200 });
    });

    const check = createArcBlockCheck(await config());

    expect(await check("usr_a&b", "usr_c")).toBe(true);
    expect(seen?.url).toBe(
      "https://osn.example/graph/internal/either-blocked?profileA=usr_a%26b&profileB=usr_c",
    );
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    const payloadSegment = seen!.auth!.slice("ARC ".length).split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      scope?: string;
    };
    expect(payload.scope).toBe("graph:read");
  });

  it("answers false when osn-api says neither has blocked the other", async () => {
    globalThis.fetch = mockFetch(
      async () => new Response(JSON.stringify({ blocked: false }), { status: 200 }),
    );
    const check = createArcBlockCheck(await config());
    expect(await check("usr_a", "usr_b")).toBe(false);
  });

  it("throws on any error status, never reading it as no block", async () => {
    const check = createArcBlockCheck(await config());
    for (const status of [401, 404, 422, 500, 503]) {
      globalThis.fetch = mockFetch(
        async () => new Response(JSON.stringify({ blocked: false }), { status }),
      );
      await expect(check("usr_a", "usr_b"), String(status)).rejects.toThrow(
        new RegExp(`returned ${status}`),
      );
    }
  });

  it("throws on an answer it cannot read as a yes or a no", async () => {
    const check = createArcBlockCheck(await config());
    globalThis.fetch = mockFetch(async () => new Response("{}", { status: 200 }));
    await expect(check("usr_a", "usr_b")).rejects.toThrow(/missing blocked/);
    for (const body of [
      "{}",
      '{"blocked":"false"}',
      '{"blocked":0}',
      '{"blocked":null}',
      "<html>",
    ]) {
      globalThis.fetch = mockFetch(async () => new Response(body, { status: 200 }));
      await expect(check("usr_a", "usr_b"), body).rejects.toThrow();
    }
  });

  it("throws when the request itself fails", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new TypeError("network down");
    });
    const check = createArcBlockCheck(await config());
    await expect(check("usr_a", "usr_b")).rejects.toThrow(/network down/);
  });

  it("gives up once its time bound passes when osn-api never answers", async () => {
    globalThis.fetch = silentOsnApi({ blocked: false });
    const check = createArcBlockCheck(await config(20));
    await expect(check("usr_a", "usr_b")).rejects.toThrow();
  });

  it("starts each call's time bound afresh", async () => {
    globalThis.fetch = mockFetch(async (_url, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify({ blocked: false }), { status: 200 });
    });
    const check = createArcBlockCheck(await config(20));

    expect(await check("usr_a", "usr_b")).toBe(false);
    await Bun.sleep(60);
    expect(await check("usr_a", "usr_b")).toBe(false);
  });
});

describe("createBlockCheckFromEnv", () => {
  it("returns null when any ARC config piece is missing", async () => {
    const { jwk } = await testKeyMaterial();
    expect(await createBlockCheckFromEnv({})).toBeNull();
    expect(
      await createBlockCheckFromEnv({ osnApiUrl: "https://osn.example", arcKeyId: "k" }),
    ).toBeNull();
    expect(
      await createBlockCheckFromEnv({ osnApiUrl: "https://osn.example", arcPrivateKeyJwk: jwk }),
    ).toBeNull();
    expect(await createBlockCheckFromEnv({ arcPrivateKeyJwk: jwk, arcKeyId: "k" })).toBeNull();
  });

  it("returns null, without throwing, when the ARC key does not import", async () => {
    for (const badJwk of ["{not-json", "garbage", '{"kty":"EC"}']) {
      expect(
        await createBlockCheckFromEnv({
          osnApiUrl: "https://osn.example",
          arcPrivateKeyJwk: badJwk,
          arcKeyId: "kid-env",
        }),
        badJwk,
      ).toBeNull();
    }
  });

  it("builds a working check when all config is present", async () => {
    const { jwk } = await testKeyMaterial();
    globalThis.fetch = mockFetch(
      async () => new Response(JSON.stringify({ blocked: true }), { status: 200 }),
    );
    const check = await createBlockCheckFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: jwk,
      arcKeyId: "kid-env",
    });
    expect(check).not.toBeNull();
    expect(await check!("usr_a", "usr_b")).toBe(true);
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
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ profileId: "usr_env", handle: "env" }), {
          status: 200,
        }),
    );

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
    globalThis.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
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
    });

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("al", "usr_org&1");

    expect(result).toEqual([
      { profileId: "usr_alice", handle: "alice", displayName: "Alice" },
      { profileId: "usr_alina", handle: "alina", displayName: null },
    ]);
    // Trailing slash trimmed; prefix query-encoded (raw — osn normalises); the
    // requester rides along so osn-api leaves out anyone with a block against them.
    expect(seen?.url).toBe(
      "https://osn.example/graph/internal/profile-search?prefix=al&requesterId=usr_org%261",
    );
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    expect(seen?.auth?.split(".")).toHaveLength(3);
  });

  it("returns an empty list for a blank prefix without calling osn-api", async () => {
    const { privateKey } = await testKeyMaterial();
    let called = false;
    globalThis.fetch = mockFetch(async () => {
      called = true;
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
    });

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("   ", "usr_org")).toEqual([]);
    expect(called).toBe(false);
  });

  it("FAIL-SOFT: returns an empty list on a non-ok status (osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => new Response("boom", { status: 500 }));

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("al", "usr_org")).toEqual([]);
  });

  it("FAIL-SOFT: returns an empty list when fetch throws", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => {
      throw new Error("network down");
    });

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("al", "usr_org")).toEqual([]);
  });

  it("skips malformed rows and coerces a non-string displayName to null", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            profiles: [
              { id: "usr_ok", handle: "ok", displayName: 42 },
              { id: 99, handle: "bad-id" },
              { handle: "no-id" },
            ],
          }),
          { status: 200 },
        ),
    );

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("ok", "usr_org")).toEqual([
      { profileId: "usr_ok", handle: "ok", displayName: null },
    ]);
  });

  it("FAIL-SOFT: suggests nothing once its time bound passes when osn-api never answers", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = silentOsnApi({ profiles: [{ id: "usr_ok", handle: "ok" }] });

    const resolve = createArcHandleSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
      timeoutMs: 20,
    });
    expect(await resolve("ok", "usr_org")).toEqual([]);
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
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ profiles: [{ id: "usr_env", handle: "env" }] }), {
          status: 200,
        }),
    );

    const resolve = await createHandleSearchResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: jwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).not.toBeNull();
    expect(await resolve!("env", "usr_org")).toEqual([
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

describe("createArcConnectionSearchResolver", () => {
  it("signs an ARC token and returns the viewer's matching connections", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(
        JSON.stringify({
          profiles: [
            { id: "usr_bob", handle: "bob", displayName: "Bob" },
            { id: "usr_bella", handle: "bella", displayName: null },
          ],
        }),
        { status: 200 },
      );
    });

    const resolve = createArcConnectionSearchResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("usr_organiser", "be");

    expect(result).toEqual([
      { profileId: "usr_bob", handle: "bob", displayName: "Bob" },
      { profileId: "usr_bella", handle: "bella", displayName: null },
    ]);
    // Trailing slash trimmed; viewer + raw query encoded (osn normalises).
    expect(seen?.url).toBe(
      "https://osn.example/graph/internal/connection-search?profileId=usr_organiser&q=be",
    );
    expect(seen?.auth?.startsWith("ARC ")).toBe(true);
    expect(seen?.auth?.split(".")).toHaveLength(3);
  });

  it("DOES call osn-api for a blank query — that is the on-focus case", async () => {
    const { privateKey } = await testKeyMaterial();
    let seenUrl: string | undefined;
    globalThis.fetch = mockFetch(async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ profiles: [{ id: "usr_bob", handle: "bob" }] }), {
        status: 200,
      });
    });

    const resolve = createArcConnectionSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    // Unlike the global handle search, an empty query here is meaningful: it
    // asks for the first page of the organiser's connections.
    expect(await resolve("usr_organiser", "")).toEqual([
      { profileId: "usr_bob", handle: "bob", displayName: null },
    ]);
    expect(seenUrl).toBe(
      "https://osn.example/graph/internal/connection-search?profileId=usr_organiser&q=",
    );
  });

  it("returns an empty list without calling osn-api when the viewer id is blank", async () => {
    const { privateKey } = await testKeyMaterial();
    let called = false;
    globalThis.fetch = mockFetch(async () => {
      called = true;
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
    });

    const resolve = createArcConnectionSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("  ", "be")).toEqual([]);
    expect(called).toBe(false);
  });

  it("FAIL-SOFT: returns an empty list on a non-ok status (osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => new Response("boom", { status: 500 }));

    const resolve = createArcConnectionSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_organiser", "be")).toEqual([]);
  });

  it("FAIL-SOFT: returns an empty list when fetch throws", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => {
      throw new Error("network down");
    });

    const resolve = createArcConnectionSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_organiser", "be")).toEqual([]);
  });

  it("skips malformed rows and coerces a non-string displayName to null", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            profiles: [
              { id: "usr_ok", handle: "ok", displayName: 42 },
              { id: 99, handle: "bad-id" },
              { handle: "no-id" },
            ],
          }),
          { status: 200 },
        ),
    );

    const resolve = createArcConnectionSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_organiser", "ok")).toEqual([
      { profileId: "usr_ok", handle: "ok", displayName: null },
    ]);
  });

  it("FAIL-SOFT: suggests nothing once its time bound passes when osn-api never answers", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = silentOsnApi({ profiles: [{ id: "usr_ok", handle: "ok" }] });

    const resolve = createArcConnectionSearchResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
      timeoutMs: 20,
    });
    expect(await resolve("usr_organiser", "ok")).toEqual([]);
  });
});

describe("createConnectionSearchResolverFromEnv", () => {
  it("returns null when any ARC config piece is missing", async () => {
    const { jwk } = await testKeyMaterial();
    expect(await createConnectionSearchResolverFromEnv({})).toBeNull();
    expect(
      await createConnectionSearchResolverFromEnv({
        osnApiUrl: "https://osn.example",
        arcKeyId: "k",
      }),
    ).toBeNull();
    expect(
      await createConnectionSearchResolverFromEnv({ arcPrivateKeyJwk: jwk, arcKeyId: "k" }),
    ).toBeNull();
  });

  it("builds a working resolver when all config is present", async () => {
    const { jwk } = await testKeyMaterial();
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ profiles: [{ id: "usr_env", handle: "env" }] }), {
          status: 200,
        }),
    );

    const resolve = await createConnectionSearchResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: jwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).not.toBeNull();
    expect(await resolve!("usr_organiser", "env")).toEqual([
      { profileId: "usr_env", handle: "env", displayName: null },
    ]);
  });

  // Sibling of the other builder guards: a corrupt CIRE_API_ARC_PRIVATE_KEY must
  // disable the connection source (search falls back to the global handle
  // search), never crash the builder.
  it.each([
    ["non-JSON garbage", "{not-json"],
    ["plain string", "garbage"],
    ["valid JSON but not a usable JWK", '{"kty":"EC"}'],
  ])("returns null (does NOT throw) when the ARC key is malformed: %s", async (_label, badJwk) => {
    expect(async () => {
      await createConnectionSearchResolverFromEnv({
        osnApiUrl: "https://osn.example",
        arcPrivateKeyJwk: badJwk,
        arcKeyId: "kid-env",
      });
    }).not.toThrow();
    const resolve = await createConnectionSearchResolverFromEnv({
      osnApiUrl: "https://osn.example",
      arcPrivateKeyJwk: badJwk,
      arcKeyId: "kid-env",
    });
    expect(resolve).toBeNull();
  });
});

describe("createArcProfileOrgsResolver", () => {
  it("signs an ARC token with org:read scope and returns org summaries", async () => {
    const { privateKey } = await testKeyMaterial();
    let seen: { url: string; auth: string | null } | undefined;
    globalThis.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(
        JSON.stringify({
          organisations: [
            {
              id: "org_1",
              handle: "one",
              name: "Org One",
              description: null,
              avatarUrl: null,
              ownerId: "usr_x",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
            // Malformed neighbour: no id → dropped, the good one still returns.
            { handle: "two", name: "Org Two" },
          ],
        }),
        { status: 200 },
      );
    });

    const resolve = createArcProfileOrgsResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    const result = await resolve("usr_x");

    expect(result).toEqual([
      {
        id: "org_1",
        handle: "one",
        name: "Org One",
        description: null,
        avatarUrl: null,
        ownerId: "usr_x",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
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
    globalThis.fetch = mockFetch(async () => new Response("boom", { status: 500 }));

    const resolve = createArcProfileOrgsResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("usr_x")).toEqual([]);
  });

  it("FAIL-SOFT: returns [] when fetch throws (network down)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => {
      throw new Error("network down");
    });

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
    globalThis.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(url), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ role: "admin" }), { status: 200 });
    });

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
    globalThis.fetch = mockFetch(
      async () => new Response(JSON.stringify({ role: "member" }), { status: 200 }),
    );

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBe("member");
  });

  it("FAIL-SOFT: returns null on a non-ok status (osn unavailable)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => new Response("boom", { status: 500 }));

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBeNull();
  });

  it("FAIL-SOFT: returns null when fetch throws (network down)", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(async () => {
      throw new Error("network down");
    });

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBeNull();
  });

  it("FAIL-SOFT: returns null when role is an unrecognised value", async () => {
    const { privateKey } = await testKeyMaterial();
    globalThis.fetch = mockFetch(
      async () => new Response(JSON.stringify({ role: "superadmin" }), { status: 200 }),
    );

    const resolve = createArcOrgMembershipResolver({
      osnApiUrl: "https://osn.example",
      arcPrivateKey: privateKey,
      arcKeyId: "kid-1",
    });
    expect(await resolve("org_1", "usr_x")).toBeNull();
  });
});
