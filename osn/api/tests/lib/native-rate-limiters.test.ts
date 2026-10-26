import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createRateLimiter, type WorkersRateLimitBinding } from "@shared/rate-limit";
import { describe, it, expect } from "vitest";

import { createInMemoryCoordination } from "../../src/lib/coordination/memory";
import {
  ALL_TIERS,
  HOUR_WINDOW_IP_AUTH_LIMITERS,
  NATIVE_BINDING_FOR_AUTH_LIMITER,
  NATIVE_BINDING_FOR_OSN_LIMITER,
  readOsnRateLimitBindings,
  selectAuthRateLimiters,
  selectOsnLimiters,
} from "../../src/lib/native-rate-limiters";
import type { AuthRateLimiters } from "../../src/routes/auth";
import { AUTH_RATE_LIMITS, MINUTE_MS, OSN_RATE_LIMITS } from "../../src/routes/auth/limiters";

/**
 * Build a fresh in-memory fallback bundle (same shape the coordination
 * bundle carries) so the selection logic can be exercised on its own.
 * Every slot is a distinct backend instance so we can assert which one
 * the selector chose by identity / behaviour.
 */
function fallbackBundle(): AuthRateLimiters {
  const rl = () => createRateLimiter({ maxRequests: 999, windowMs: 60_000 });
  return Object.fromEntries(
    (
      [
        "registerBegin",
        "registerComplete",
        "handleCheck",
        "passkeyLoginBegin",
        "passkeyLoginComplete",
        "passkeyRegisterBegin",
        "passkeyRegisterComplete",
        "profileSwitch",
        "profileList",
        "recoveryGenerate",
        "recoveryStatus",
        "recoveryComplete",
        "recoveryEmailBegin",
        "recoveryEmailComplete",
        "recoveryTotpComplete",
        "recoveryDisown",
        "stepUpPasskeyBegin",
        "stepUpPasskeyComplete",
        "stepUpOtpBegin",
        "stepUpOtpComplete",
        "stepUpTotpComplete",
        "totpDisable",
        "totpEnrollBegin",
        "totpEnrollComplete",
        "totpStatus",
        "sessionList",
        "sessionRevoke",
        "emailChangeBegin",
        "emailChangeComplete",
        "securityEventList",
        "securityEventAck",
        "passkeyList",
        "passkeyRename",
        "passkeyDelete",
        "crossDeviceBegin",
        "crossDevicePoll",
        "crossDeviceApprove",
        "crossDeviceReject",
        "oidcAuthorize",
        "oidcAuthorizeContext",
        "oidcAuthorizeDecision",
        "oidcToken",
        "oidcConnectionsList",
        "oidcConnectionsRevoke",
        "oidcClientCreate",
        "oidcClientList",
        "oidcClientDisable",
      ] as const
    ).map((k) => [k, rl()]),
  ) as unknown as AuthRateLimiters;
}

/** A stub native binding that records every key it was asked to limit. */
function recordingBinding(success = true): {
  binding: WorkersRateLimitBinding;
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }) => {
        keys.push(key);
        return { success };
      },
    },
  };
}

describe("readOsnRateLimitBindings", () => {
  it("returns undefined when no native binding is present (local / Bun path)", () => {
    expect(readOsnRateLimitBindings({})).toBeUndefined();
  });

  it("collects the present native bindings off the env record", () => {
    const b = recordingBinding().binding;
    const bindings = readOsnRateLimitBindings({ RL_AUTH_IP_10_60: b });
    expect(bindings).toBeDefined();
    expect(bindings?.RL_AUTH_IP_10_60).toBe(b);
  });
});

describe("the budget table decides where each auth limiter runs", () => {
  it("gives every one-minute auth budget a native tier with that limit", () => {
    const minute = (Object.keys(AUTH_RATE_LIMITS) as (keyof AuthRateLimiters)[]).filter(
      (key) => AUTH_RATE_LIMITS[key].windowMs === MINUTE_MS,
    );
    const expected = Object.fromEntries(
      minute.map((key) => [
        key,
        {
          tier: `RL_AUTH_IP_${AUTH_RATE_LIMITS[key].maxRequests}_60`,
          ns: AUTH_RATE_LIMITS[key].ns,
        },
      ]),
    );
    expect(NATIVE_BINDING_FOR_AUTH_LIMITER).toEqual(expected);
    expect(
      Object.keys(NATIVE_BINDING_FOR_AUTH_LIMITER).length + HOUR_WINDOW_IP_AUTH_LIMITERS.size,
    ).toBe(Object.keys(AUTH_RATE_LIMITS).length);
  });

  it("gives every endpoint its own name, so no two share a counter", () => {
    const names = Object.values(AUTH_RATE_LIMITS).map((budget) => budget.ns);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("selectAuthRateLimiters — limiter routing", () => {
  it("routes every 60s per-IP auth limiter onto a native binding", async () => {
    const tiers = {
      RL_AUTH_IP_5_60: recordingBinding(),
      RL_AUTH_IP_10_60: recordingBinding(),
      RL_AUTH_IP_20_60: recordingBinding(),
      RL_AUTH_IP_30_60: recordingBinding(),
      RL_AUTH_IP_60_60: recordingBinding(),
    };
    const bindings = {
      RL_AUTH_IP_5_60: tiers.RL_AUTH_IP_5_60.binding,
      RL_AUTH_IP_10_60: tiers.RL_AUTH_IP_10_60.binding,
      RL_AUTH_IP_20_60: tiers.RL_AUTH_IP_20_60.binding,
      RL_AUTH_IP_30_60: tiers.RL_AUTH_IP_30_60.binding,
      RL_AUTH_IP_60_60: tiers.RL_AUTH_IP_60_60.binding,
    };
    const fallback = fallbackBundle();
    const selected = selectAuthRateLimiters(bindings, fallback);

    // Drive every 60s endpoint; each must hit a native binding (not the fallback).
    const sixtySecondKeys = (Object.keys(selected) as (keyof AuthRateLimiters)[]).filter(
      (key) => !HOUR_WINDOW_IP_AUTH_LIMITERS.has(key),
    );
    await Promise.all(sixtySecondKeys.map((key) => selected[key].check("1.2.3.4")));

    const totalNativeCalls = Object.values(tiers).reduce((n, t) => n + t.keys.length, 0);
    const sixtySecondCount = Object.keys(selected).length - HOUR_WINDOW_IP_AUTH_LIMITERS.size;
    expect(totalNativeCalls).toBe(sixtySecondCount);
  });

  it("keeps the 1-hour per-IP limiters on the fallback (NOT native)", async () => {
    const tiers = {
      RL_AUTH_IP_5_60: recordingBinding(),
      RL_AUTH_IP_10_60: recordingBinding(),
      RL_AUTH_IP_20_60: recordingBinding(),
      RL_AUTH_IP_30_60: recordingBinding(),
      RL_AUTH_IP_60_60: recordingBinding(),
    };
    const bindings = {
      RL_AUTH_IP_5_60: tiers.RL_AUTH_IP_5_60.binding,
      RL_AUTH_IP_10_60: tiers.RL_AUTH_IP_10_60.binding,
      RL_AUTH_IP_20_60: tiers.RL_AUTH_IP_20_60.binding,
      RL_AUTH_IP_30_60: tiers.RL_AUTH_IP_30_60.binding,
      RL_AUTH_IP_60_60: tiers.RL_AUTH_IP_60_60.binding,
    };
    const fallback = fallbackBundle();
    const selected = selectAuthRateLimiters(bindings, fallback);

    // The 1-hour slots are returned UNCHANGED (same object identity as fallback).
    for (const key of HOUR_WINDOW_IP_AUTH_LIMITERS) {
      expect(selected[key]).toBe(fallback[key]);
    }
    // Sanity: the set is exactly the five 1-hour windows.
    expect([...HOUR_WINDOW_IP_AUTH_LIMITERS].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "emailChangeBegin",
      "oidcClientCreate",
      "recoveryComplete",
      "recoveryEmailBegin",
      "recoveryGenerate",
    ]);
  });

  it("namespaces native keys per endpoint so distinct endpoints never share a bucket", async () => {
    const rec = recordingBinding();
    // Two endpoints that share the 10-req tier must produce DISTINCT keys.
    const bindings = {
      RL_AUTH_IP_5_60: recordingBinding().binding,
      RL_AUTH_IP_10_60: rec.binding,
      RL_AUTH_IP_20_60: recordingBinding().binding,
      RL_AUTH_IP_30_60: recordingBinding().binding,
      RL_AUTH_IP_60_60: recordingBinding().binding,
    };
    const selected = selectAuthRateLimiters(bindings, fallbackBundle());
    await selected.registerComplete.check("9.9.9.9");
    await selected.passkeyRegisterBegin.check("9.9.9.9");
    expect(rec.keys).toContain(`${AUTH_RATE_LIMITS.registerComplete.ns}:9.9.9.9`);
    expect(rec.keys).toContain(`${AUTH_RATE_LIMITS.passkeyRegisterBegin.ns}:9.9.9.9`);
    expect(rec.keys[0]).not.toBe(rec.keys[1]);
  });

  it("preserves fail-closed — a throwing native binding denies", async () => {
    const throwing: WorkersRateLimitBinding = {
      limit: async () => {
        throw new Error("platform error");
      },
    };
    const bindings = {
      RL_AUTH_IP_5_60: throwing,
      RL_AUTH_IP_10_60: throwing,
      RL_AUTH_IP_20_60: throwing,
      RL_AUTH_IP_30_60: throwing,
      RL_AUTH_IP_60_60: throwing,
    };
    const selected = selectAuthRateLimiters(bindings, fallbackBundle());
    expect(await selected.registerBegin.check("1.2.3.4")).toBe(false);
  });
});

describe("selectOsnLimiters — graph, organisation, recommendation and profile limiters", () => {
  const fallback = () => {
    const bundle = createInMemoryCoordination();
    return {
      graphRateLimiter: bundle.graphRateLimiter,
      orgRateLimiter: bundle.orgRateLimiter,
      profileRateLimiters: bundle.profileRateLimiters,
      recommendationRateLimiters: bundle.recommendationRateLimiters,
      healthProbeLimiter: bundle.healthProbeLimiter,
    };
  };

  it("puts every one-minute limiter on its tier, keyed by its store name", async () => {
    const tiers = Object.fromEntries(ALL_TIERS.map((tier) => [tier, recordingBinding()]));
    const bindings = Object.fromEntries(ALL_TIERS.map((tier) => [tier, tiers[tier]!.binding]));
    const selected = selectOsnLimiters(bindings, fallback());

    await selected.graphRateLimiter.check("usr_1");
    await selected.orgRateLimiter.check("usr_1");
    await selected.recommendationRateLimiters.suggest.check("usr_1");
    await selected.recommendationRateLimiters.search.check("usr_1");
    await selected.profileRateLimiters.profileCreate.check("9.9.9.9");
    await selected.profileRateLimiters.profileDelete.check("9.9.9.9");
    await selected.profileRateLimiters.profileSetDefault.check("9.9.9.9");
    await selected.healthProbeLimiter.check("9.9.9.9");

    expect(tiers.RL_USER_60_60!.keys).toEqual([
      "graph.write:usr_1",
      "org.write:usr_1",
      "recs.search:usr_1",
    ]);
    expect(tiers.RL_USER_20_60!.keys).toEqual(["recs.read:usr_1"]);
    expect(tiers.RL_AUTH_IP_5_60!.keys).toEqual([
      "profile.create:9.9.9.9",
      "profile.delete:9.9.9.9",
    ]);
    expect(tiers.RL_AUTH_IP_10_60!.keys).toEqual([
      "profile.set_default:9.9.9.9",
      "health.coordination:9.9.9.9",
    ]);
  });

  it("runs each limiter on the tier whose limit is its budget", () => {
    for (const [budget, tier] of Object.entries(NATIVE_BINDING_FOR_OSN_LIMITER)) {
      const { maxRequests, windowMs } = OSN_RATE_LIMITS[budget as keyof typeof OSN_RATE_LIMITS];
      expect(windowMs).toBe(MINUTE_MS);
      expect(tier.endsWith(`_${maxRequests}_60`)).toBe(true);
    }
  });

  it("leaves a limiter on the fallback when its tier is absent", async () => {
    const base = fallback();
    const selected = selectOsnLimiters({}, base);
    expect(selected.graphRateLimiter).toBe(base.graphRateLimiter);
    expect(selected.recommendationRateLimiters.suggest).toBe(
      base.recommendationRateLimiters.suggest,
    );
  });

  it("denies when the binding throws", async () => {
    const throwing: WorkersRateLimitBinding = {
      limit: async () => {
        throw new Error("platform error");
      },
    };
    const selected = selectOsnLimiters({ RL_USER_60_60: throwing }, fallback());
    expect(await selected.graphRateLimiter.check("usr_1")).toBe(false);
  });
});

/**
 * Every `[[ratelimits]]` block in `wrangler.toml`, in every environment, holds
 * the limit the budget table gives the limiters that use it; and every
 * environment declares the `COORDINATION` Durable Object.
 */
describe("wrangler.toml agrees with the budget table", () => {
  interface RateLimitBlock {
    readonly name: string;
    readonly namespace_id: string;
    readonly simple: { readonly limit: number; readonly period: number };
  }
  interface Tier {
    readonly ratelimits: readonly RateLimitBlock[];
    readonly durable_objects?: {
      readonly bindings: readonly { readonly name: string; readonly class_name: string }[];
    };
  }
  const config = Bun.TOML.parse(
    readFileSync(fileURLToPath(new URL("../../wrangler.toml", import.meta.url)), "utf8"),
  ) as Tier & {
    readonly main: string;
    readonly migrations: readonly { readonly tag: string; readonly new_sqlite_classes: string[] }[];
    readonly env: Readonly<Record<"staging" | "production", Tier>>;
  };
  const tiers: [string, Tier][] = [
    ["top level", config],
    ["staging", config.env.staging],
    ["production", config.env.production],
  ];

  it.each(tiers)(
    "%s declares every tier the code reads, at the limit its name says",
    (_n, tier) => {
      expect(tier.ratelimits.map((block) => block.name).toSorted()).toEqual(
        [...ALL_TIERS].toSorted(),
      );
      for (const block of tier.ratelimits) {
        expect(block.simple.period).toBe(60);
        expect(block.name.endsWith(`_${block.simple.limit}_60`)).toBe(true);
      }
    },
  );

  it("gives every budget a tier whose limit is that budget", () => {
    const limits = new Map(config.ratelimits.map((block) => [block.name, block.simple.limit]));
    for (const [key, { tier }] of Object.entries(NATIVE_BINDING_FOR_AUTH_LIMITER)) {
      expect(limits.get(tier)).toBe(
        AUTH_RATE_LIMITS[key as keyof typeof AUTH_RATE_LIMITS].maxRequests,
      );
    }
    for (const [budget, tier] of Object.entries(NATIVE_BINDING_FOR_OSN_LIMITER)) {
      expect(limits.get(tier)).toBe(
        OSN_RATE_LIMITS[budget as keyof typeof OSN_RATE_LIMITS].maxRequests,
      );
    }
  });

  it("keeps the per-user namespaces apart from every other tier's", () => {
    const taken = new Set(
      ["2001", "2002", "2003", "2004", "2005"].flatMap((id) => [
        id,
        `21${id.slice(2)}`,
        `22${id.slice(2)}`,
      ]),
    );
    const ids = (tier: Tier) =>
      tier.ratelimits
        .filter((block) => block.name.startsWith("RL_USER_"))
        .map((block) => block.namespace_id);
    for (const id of [...ids(config.env.staging), ...ids(config.env.production)]) {
      expect(taken.has(id)).toBe(false);
    }
    const staging = new Set(config.env.staging.ratelimits.map((block) => block.namespace_id));
    for (const block of config.env.production.ratelimits) {
      expect(staging.has(block.namespace_id)).toBe(false);
    }
  });

  it.each(tiers)("%s binds COORDINATION to the CoordinationStore class", (_n, tier) => {
    expect(tier.durable_objects?.bindings).toEqual([
      { name: "COORDINATION", class_name: "CoordinationStore" },
    ]);
  });

  it("creates the class with one SQLite migration, and serves the module that exports it", () => {
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["CoordinationStore"] }]);
    expect(config.main).toBe("src/entry.ts");
  });
});
