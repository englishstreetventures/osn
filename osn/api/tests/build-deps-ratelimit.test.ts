import { generateArcKeyPair } from "@shared/crypto";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { createMemoryClient } from "@shared/redis";
import { exportJWK } from "jose";
import { describe, it, expect, beforeAll } from "vitest";

import { buildAppDeps, type BuildParts, type EnvRecord } from "../src/build-deps";
import { osnLoggerLayer } from "../src/observability";
import { createTestLayer } from "./helpers/db";

/**
 * Part 1 (client-IP trust) + Part 2 (native rate-limit binding selection) wiring
 * through `buildAppDeps`. Asserts the composition root threads the new
 * `trustCloudflare` / `rateLimitBindings` BuildParts into the deps it hands to
 * `createApp`.
 */

let privB64 = "";
let pubB64 = "";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  privB64 = b64(await exportJWK(privateKey));
  pubB64 = b64(await exportJWK(publicKey));
});

function nonLocalEnv(over: Partial<Record<string, string>> = {}): EnvRecord {
  return {
    OSN_ENV: "production",
    OSN_ISSUER_URL: "https://id.cireweddings.com",
    OSN_CORS_ORIGIN: "https://app.cireweddings.com",
    OSN_RP_ID: "cireweddings.com",
    OSN_JWT_PRIVATE_KEY: privB64,
    OSN_JWT_PUBLIC_KEY: pubB64,
    OSN_SESSION_IP_PEPPER: "x".repeat(32),
    ...over,
  };
}

function parts(over: Partial<BuildParts> = {}): BuildParts {
  return {
    redisClient: createMemoryClient(),
    dbAndEmailLayer: createTestLayer(),
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
    ...over,
  };
}

const allowBinding = (record: string[]): WorkersRateLimitBinding => ({
  limit: async ({ key }) => {
    record.push(key);
    return { success: true };
  },
});

describe("Part 1 — buildAppDeps client-IP trust", () => {
  it("trustCloudflare=true → clientIpConfig trusts cf-connecting-ip exclusively", async () => {
    const built = await buildAppDeps(nonLocalEnv(), parts({ trustCloudflare: true }));
    expect(built.deps.clientIpConfig).toEqual({ trustCloudflare: true });
    // The W3.3 proxy-count warning is irrelevant under Cloudflare — suppressed.
    expect(built.trustedProxyCountUnconfigured).toBe(false);
  });

  it("trustCloudflare=true → ignores TRUSTED_PROXY_COUNT (CF attribution wins)", async () => {
    const built = await buildAppDeps(
      nonLocalEnv({ TRUSTED_PROXY_COUNT: "3" }),
      parts({ trustCloudflare: true }),
    );
    expect(built.deps.clientIpConfig).toEqual({ trustCloudflare: true });
    expect(built.deps.clientIpConfig).not.toHaveProperty("trustedProxyCount");
  });

  it("trustCloudflare=false (Bun/local) → keeps the XFF/socket trustedProxyCount path", async () => {
    const built = await buildAppDeps(
      nonLocalEnv({ TRUSTED_PROXY_COUNT: "2" }),
      parts({ trustCloudflare: false }),
    );
    expect(built.deps.clientIpConfig).toEqual({ trustedProxyCount: 2 });
  });
});

describe("Part 2 — buildAppDeps native rate-limit binding selection", () => {
  it("no bindings → all auth limiters stay on Redis (60s slot keyed by raw IP)", async () => {
    const built = await buildAppDeps(nonLocalEnv(), parts());
    // The Redis-backed registerBegin keys by the raw IP; no native-binding
    // namespace prefix is involved.
    expect(typeof built.deps.authRateLimiters.registerBegin.check).toBe("function");
    expect(await built.deps.authRateLimiters.registerBegin.check("1.2.3.4")).toBe(true);
  });

  it("bindings present → 60s per-IP auth limiters route to the native binding", async () => {
    const seen: string[] = [];
    const binding = allowBinding(seen);
    const built = await buildAppDeps(
      nonLocalEnv(),
      parts({
        rateLimitBindings: {
          RL_AUTH_IP_5_60: binding,
          RL_AUTH_IP_10_60: binding,
          RL_AUTH_IP_20_60: binding,
          RL_AUTH_IP_30_60: binding,
          RL_AUTH_IP_60_60: binding,
        },
      }),
    );
    await built.deps.authRateLimiters.registerBegin.check("9.9.9.9");
    // Native binding saw a namespaced key, not the bare IP.
    expect(seen).toEqual(["register_begin:9.9.9.9"]);
  });

  it("bindings present → 1-hour per-IP limiters stay on Redis (never the native binding)", async () => {
    const seen: string[] = [];
    const binding = allowBinding(seen);
    const built = await buildAppDeps(
      nonLocalEnv(),
      parts({
        rateLimitBindings: {
          RL_AUTH_IP_5_60: binding,
          RL_AUTH_IP_10_60: binding,
          RL_AUTH_IP_20_60: binding,
          RL_AUTH_IP_30_60: binding,
          RL_AUTH_IP_60_60: binding,
        },
      }),
    );
    await built.deps.authRateLimiters.recoveryGenerate.check("9.9.9.9");
    await built.deps.authRateLimiters.recoveryComplete.check("9.9.9.9");
    await built.deps.authRateLimiters.emailChangeBegin.check("9.9.9.9");
    // None of the 1-hour limiters touched the native binding.
    expect(seen).toEqual([]);
  });

  it("the per-account caps + per-user limiters are never affected by the bindings", async () => {
    const seen: string[] = [];
    const binding = allowBinding(seen);
    const built = await buildAppDeps(
      nonLocalEnv(),
      parts({
        rateLimitBindings: {
          RL_AUTH_IP_5_60: binding,
          RL_AUTH_IP_10_60: binding,
          RL_AUTH_IP_20_60: binding,
          RL_AUTH_IP_30_60: binding,
          RL_AUTH_IP_60_60: binding,
        },
      }),
    );
    // graph/org/recommendation per-user limiters + the two account caps stay on
    // Redis — exercising them must not hit the native binding.
    await built.deps.graphRateLimiter.check("usr_1");
    await built.deps.orgRateLimiter.check("usr_1");
    await built.deps.recommendationRateLimiter.check("usr_1");
    await built.deps.profileSwitchCap.check("acc_1");
    await built.deps.emailChangeBeginCap.check("acc_1");
    expect(seen).toEqual([]);
  });
});
