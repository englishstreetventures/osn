import { describe, it, expect } from "vitest";

import {
  createFeatureFlags,
  createStaticFlags,
  DEFAULT_API_HOST,
  FLAGS,
  type FetchLike,
  type FlagsKV,
} from "../src/index";

const FLAG = "cire.account-linking" as const;

/**
 * Build a stub fetch that returns a GrowthBook SDK payload and records every
 * call, so tests can assert how many times (and whether) the CDN was hit.
 */
function stubFetch(
  payload: unknown,
  init: { ok?: boolean; status?: number } = {},
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(String(url));
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => payload,
    } as Response;
  };
  return { fetch, calls };
}

/** A payload where the flag is on only for `role: "vip"`, else off. */
const vipOnlyPayload = {
  features: {
    [FLAG]: {
      defaultValue: false,
      rules: [{ condition: { role: "vip" }, force: true }],
    },
  },
};

/** In-memory KV double implementing the subset the module uses. */
function memoryKv(): FlagsKV & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

describe("createFeatureFlags — key-optional (no client key)", () => {
  it("never calls the network and serves registry defaults", async () => {
    const { fetch, calls } = stubFetch(vipOnlyPayload);
    const flags = createFeatureFlags({ clientKey: undefined, fetchImpl: fetch });
    const evaluator = await flags.forRequest({ id: "u1", role: "vip" });

    // Registry default for the flag is `false`; the vip rule is ignored because
    // GrowthBook is never consulted.
    expect(evaluator.isOn(FLAG)).toBe(FLAGS[FLAG]);
    expect(evaluator.isOn(FLAG)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("treats an empty / whitespace key as unconfigured", async () => {
    const { fetch, calls } = stubFetch(vipOnlyPayload);
    const flags = createFeatureFlags({ clientKey: "   ", fetchImpl: fetch });
    await flags.forRequest({ id: "u1", role: "vip" });
    expect(calls).toHaveLength(0);
  });
});

describe("createFeatureFlags — configured", () => {
  it("fetches the payload from the CDN and evaluates attribute-targeted rules", async () => {
    const { fetch, calls } = stubFetch(vipOnlyPayload);
    const flags = createFeatureFlags({ clientKey: "sdk-123", fetchImpl: fetch });

    const vip = await flags.forRequest({ id: "u1", role: "vip" });
    expect(vip.isOn(FLAG)).toBe(true);

    const guest = await flags.forRequest({ id: "u2", role: "guest" });
    expect(guest.isOn(FLAG)).toBe(false);

    // Hit the default CDN host on the client-key path.
    expect(calls[0]).toBe(`${DEFAULT_API_HOST}/api/features/sdk-123`);
  });

  it("getValue returns the evaluated value, typed to the registry default", async () => {
    const { fetch } = stubFetch({ features: { [FLAG]: { defaultValue: true } } });
    const flags = createFeatureFlags({ clientKey: "sdk-123", fetchImpl: fetch });
    const evaluator = await flags.forRequest({ id: "u1" });
    // Typed as boolean (the registry default's type).
    const value: boolean = evaluator.getValue(FLAG);
    expect(value).toBe(true);
  });
});

describe("payload cache", () => {
  it("reuses the in-isolate memo within the TTL (one fetch for many requests)", async () => {
    const { fetch, calls } = stubFetch(vipOnlyPayload);
    let clock = 1_000;
    const flags = createFeatureFlags({
      clientKey: "sdk-123",
      fetchImpl: fetch,
      ttlSeconds: 60,
      now: () => clock,
    });

    await flags.forRequest({ id: "a" });
    clock += 30_000; // still inside the 60s window
    await flags.forRequest({ id: "b" });
    await flags.forRequest({ id: "c" });

    expect(calls).toHaveLength(1);
  });

  it("re-fetches once the TTL expires", async () => {
    const { fetch, calls } = stubFetch(vipOnlyPayload);
    let clock = 1_000;
    const flags = createFeatureFlags({
      clientKey: "sdk-123",
      fetchImpl: fetch,
      ttlSeconds: 60,
      now: () => clock,
    });

    await flags.forRequest({ id: "a" });
    clock += 61_000; // past the window
    await flags.forRequest({ id: "b" });

    expect(calls).toHaveLength(2);
  });
});

describe("fail-safe ladder", () => {
  it("falls back to the last good payload when a refresh fails", async () => {
    let ok = true;
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(String(url));
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => vipOnlyPayload,
      } as Response;
    };
    let clock = 1_000;
    const flags = createFeatureFlags({
      clientKey: "sdk-123",
      fetchImpl: fetch,
      ttlSeconds: 60,
      now: () => clock,
    });

    // Warm the memo with a good payload.
    const first = await flags.forRequest({ id: "u", role: "vip" });
    expect(first.isOn(FLAG)).toBe(true);

    // Next window the CDN is down — evaluator must keep serving the stale payload.
    ok = false;
    clock += 61_000;
    const second = await flags.forRequest({ id: "u", role: "vip" });
    expect(second.isOn(FLAG)).toBe(true);
    expect(calls).toHaveLength(2); // it did try, then fell back
  });

  it("serves registry defaults when the very first fetch fails (no payload yet)", async () => {
    const { fetch } = stubFetch(vipOnlyPayload, { ok: false, status: 503 });
    const flags = createFeatureFlags({ clientKey: "sdk-123", fetchImpl: fetch });
    const evaluator = await flags.forRequest({ id: "u", role: "vip" });
    // Cold cache + failed fetch ⇒ coded default (false), never a throw.
    expect(evaluator.isOn(FLAG)).toBe(false);
  });
});

describe("createStaticFlags", () => {
  it("returns overridden values and falls back to registry defaults", async () => {
    const on = await createStaticFlags({ [FLAG]: true }).forRequest();
    expect(on.isOn(FLAG)).toBe(true);
    expect(on.getValue(FLAG)).toBe(true);

    // No override ⇒ the registry default (false).
    const off = await createStaticFlags().forRequest();
    expect(off.isOn(FLAG)).toBe(FLAGS[FLAG]);
    expect(off.isOn(FLAG)).toBe(false);
  });
});

describe("KV cross-isolate cache", () => {
  it("writes the fetched payload to KV", async () => {
    const kv = memoryKv();
    const { fetch } = stubFetch(vipOnlyPayload);
    const flags = createFeatureFlags({ clientKey: "sdk-123", fetchImpl: fetch, kv });
    await flags.forRequest({ id: "u" });
    expect(kv.store.size).toBe(1);
  });

  it("serves a fresh payload from KV without hitting the CDN", async () => {
    const kv = memoryKv();
    // Pre-seed KV as though another isolate already fetched at the same clock.
    kv.store.set("gb:payload", JSON.stringify({ payload: vipOnlyPayload, fetchedAt: 1_000 }));
    const { fetch, calls } = stubFetch({ features: {} });
    const flags = createFeatureFlags({
      clientKey: "sdk-123",
      fetchImpl: fetch,
      kv,
      ttlSeconds: 60,
      now: () => 5_000, // 4s later — inside the 60s window
    });

    const evaluator = await flags.forRequest({ id: "u", role: "vip" });
    expect(evaluator.isOn(FLAG)).toBe(true); // came from KV's payload
    expect(calls).toHaveLength(0); // CDN never touched
  });
});
