import { generateKeyPair, exportJWK } from "jose";
import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";

import { clearJwksCache, resolvePublicKeyForKid, refreshPublicKeyForKid } from "../src/jwks-cache";

type JwkEntry = Record<string, unknown>;

/** Mintable JWK for a given kid. */
async function makeJwk(kid: string): Promise<JwkEntry> {
  const pair = await generateKeyPair("ES256");
  return { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
}

/** Distinct JWKS url per index, for the LRU-eviction test. */
const lruUrl = (i: number) => `http://lru-${i}/.well-known/jwks.json`;

describe("jwks-cache", () => {
  let jwkA: JwkEntry; // kid "shared-kid"
  let jwkB: JwkEntry; // kid "shared-kid" but different material

  /** Per-URL JWKS payloads the stub serves. */
  let routes: Map<string, JwkEntry[]>;
  /** Per-URL fetch counter. */
  let calls: Map<string, number>;
  /** Optional behaviour overrides per URL. */
  let behaviour: Map<string, "network-error" | "not-ok" | "bad-json">;
  /** Resolver to gate in-flight fetches for the single-flight test. */
  let gate: { promise: Promise<void>; release: () => void } | null;

  const URL_1 = "http://issuer-1/.well-known/jwks.json";
  const URL_2 = "http://issuer-2/.well-known/jwks.json";

  beforeAll(async () => {
    jwkA = await makeJwk("shared-kid");
    jwkB = await makeJwk("shared-kid");
  });

  beforeEach(() => {
    clearJwksCache();
    routes = new Map();
    calls = new Map();
    behaviour = new Map();
    gate = null;

    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      input: Parameters<typeof fetch>[0],
    ) => {
      const url = String(input);
      calls.set(url, (calls.get(url) ?? 0) + 1);
      if (gate) await gate.promise;

      const b = behaviour.get(url);
      if (b === "network-error") throw new Error("network down");
      if (b === "not-ok") return new Response("nope", { status: 500 });
      if (b === "bad-json") {
        return new Response("{not json", { headers: { "Content-Type": "application/json" } });
      }
      const keys = routes.get(url) ?? [];
      return new Response(JSON.stringify({ keys }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    clearJwksCache();
  });

  function openGate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    gate = { promise, release };
  }

  it("S-M3: same kid on two issuers resolves to distinct keys (no collision)", async () => {
    routes.set(URL_1, [jwkA]);
    routes.set(URL_2, [jwkB]);

    const k1 = await resolvePublicKeyForKid("shared-kid", URL_1);
    const k2 = await resolvePublicKeyForKid("shared-kid", URL_2);

    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(k1).not.toBe(k2);
    // Each issuer fetched exactly once; no cross-issuer cache hit.
    expect(calls.get(URL_1)).toBe(1);
    expect(calls.get(URL_2)).toBe(1);
  });

  it("cache hit within TTL does not re-fetch", async () => {
    routes.set(URL_1, [jwkA]);
    const first = await resolvePublicKeyForKid("shared-kid", URL_1);
    const second = await resolvePublicKeyForKid("shared-kid", URL_1);
    expect(first).toBe(second);
    expect(calls.get(URL_1)).toBe(1);
  });

  it("network error → null", async () => {
    behaviour.set(URL_1, "network-error");
    expect(await resolvePublicKeyForKid("shared-kid", URL_1)).toBeNull();
  });

  it("non-OK status → null", async () => {
    behaviour.set(URL_1, "not-ok");
    expect(await resolvePublicKeyForKid("shared-kid", URL_1)).toBeNull();
  });

  it("malformed JSON → null", async () => {
    behaviour.set(URL_1, "bad-json");
    expect(await resolvePublicKeyForKid("shared-kid", URL_1)).toBeNull();
  });

  it("unknown kid → null", async () => {
    routes.set(URL_1, [jwkA]);
    expect(await resolvePublicKeyForKid("absent-kid", URL_1)).toBeNull();
  });

  it("negative cache: two consecutive unknown-kid lookups → ONE fetch", async () => {
    routes.set(URL_1, [jwkA]);
    expect(await resolvePublicKeyForKid("absent-kid", URL_1)).toBeNull();
    expect(await resolvePublicKeyForKid("absent-kid", URL_1)).toBeNull();
    expect(calls.get(URL_1)).toBe(1);
  });

  it("single-flight: two concurrent cold lookups for one url → ONE fetch", async () => {
    routes.set(URL_1, [jwkA]);
    openGate();

    const p1 = resolvePublicKeyForKid("shared-kid", URL_1);
    const p2 = resolvePublicKeyForKid("shared-kid", URL_1);
    // Let both reach the in-flight fetch, then release.
    await new Promise((r) => setTimeout(r, 5));
    gate!.release();

    const [k1, k2] = await Promise.all([p1, p2]);
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    // The defining property of single-flight: one upstream fetch, not two.
    expect(calls.get(URL_1)).toBe(1);
  });

  it("refresh bypasses the positive cache, re-fetches, and updates it", async () => {
    routes.set(URL_1, [jwkA]);
    const original = await resolvePublicKeyForKid("shared-kid", URL_1);
    expect(calls.get(URL_1)).toBe(1);

    // Rotate material under the same kid.
    routes.set(URL_1, [jwkB]);
    const refreshed = await refreshPublicKeyForKid("shared-kid", URL_1);
    expect(refreshed).not.toBeNull();
    expect(refreshed).not.toBe(original);
    expect(calls.get(URL_1)).toBe(2);

    // A subsequent resolve serves the refreshed (cached) key, no new fetch.
    const after = await resolvePublicKeyForKid("shared-kid", URL_1);
    expect(after).toBe(refreshed);
    expect(calls.get(URL_1)).toBe(2);
  });

  it("refresh bypasses the negative cache (genuine rotation not masked)", async () => {
    // First lookup misses → negative cached.
    routes.set(URL_1, []);
    expect(await resolvePublicKeyForKid("shared-kid", URL_1)).toBeNull();
    expect(calls.get(URL_1)).toBe(1);

    // Negative cache would block a plain resolve...
    expect(await resolvePublicKeyForKid("shared-kid", URL_1)).toBeNull();
    expect(calls.get(URL_1)).toBe(1);

    // ...but a refresh must still hit upstream — the kid may now exist.
    routes.set(URL_1, [jwkA]);
    const key = await refreshPublicKeyForKid("shared-kid", URL_1);
    expect(key).not.toBeNull();
    expect(calls.get(URL_1)).toBe(2);
  });

  it("M-A: a second forced refresh for the same kid within cooldown does NOT re-fetch", async () => {
    routes.set(URL_1, [jwkA]);
    await resolvePublicKeyForKid("shared-kid", URL_1);
    expect(calls.get(URL_1)).toBe(1);

    // First forced refresh hits upstream (rotation pickup) and updates the cache.
    const refreshed = await refreshPublicKeyForKid("shared-kid", URL_1);
    expect(calls.get(URL_1)).toBe(2);

    // A flood of further bad-sig-driven refreshes for the same kid within the
    // cooldown must be throttled — no additional upstream fetches, and the
    // cached key is returned so the caller can re-verify (and still reject a
    // genuinely bad signature).
    for (let i = 0; i < 20; i++) {
      const k = await refreshPublicKeyForKid("shared-kid", URL_1);
      expect(k).toBe(refreshed);
    }
    expect(calls.get(URL_1)).toBe(2);
  });

  it("LRU eviction at CACHE_MAX_SIZE (256)", async () => {
    // Distinct cache keys via distinct urls; one shared kid + jwk per url.
    routes = new Map();
    const jwk = await makeJwk("lru-kid");
    for (let i = 0; i < 257; i++) routes.set(lruUrl(i), [jwk]);

    // Fill the cache to capacity with entries 0..255, touching 0 last-ish.
    // Sequential by design — LRU access order is the property under test.
    for (let i = 0; i < 256; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential access order is the LRU property under test
      await resolvePublicKeyForKid("lru-kid", lruUrl(i));
    }
    // Re-touch entry 1 so entry 0 becomes the LRU victim.
    await resolvePublicKeyForKid("lru-kid", lruUrl(1));

    // Insert the 257th entry → triggers an eviction of the LRU (entry 0).
    await resolvePublicKeyForKid("lru-kid", lruUrl(256));

    // Entry 0 was evicted → resolving it again re-fetches.
    const before = calls.get(lruUrl(0)) ?? 0;
    await resolvePublicKeyForKid("lru-kid", lruUrl(0));
    expect(calls.get(lruUrl(0))).toBe(before + 1);

    // Entry 1 was re-touched → still cached, no new fetch.
    const before1 = calls.get(lruUrl(1)) ?? 0;
    await resolvePublicKeyForKid("lru-kid", lruUrl(1));
    expect(calls.get(lruUrl(1))).toBe(before1);
  });
});
