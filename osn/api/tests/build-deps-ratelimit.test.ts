import { generateArcKeyPair } from "@shared/crypto";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { exportJWK } from "jose";
import { describe, it, expect, beforeAll } from "vitest";

import { buildAppDeps, type BuildParts, type BuiltDeps, type EnvVars } from "../src/build-deps";
import { createInMemoryCoordination } from "../src/lib/coordination/memory";
import { osnLoggerLayer } from "../src/observability";
import type { AuthRateLimiters } from "../src/routes/auth/limiters";
import type { AccountCapLimiter } from "../src/services/auth/stores";
import { createTestLayer } from "./helpers/db";

/**
 * buildAppDeps threads the trustCloudflare and rateLimitBindings parts into
 * the deps it hands to createApp.
 */

type Deps = BuiltDeps["deps"];

/** Every per-account cap the deps carry. */
type CapField = {
  [K in keyof Deps]-?: Deps[K] extends AccountCapLimiter ? K : never;
}[keyof Deps];

/**
 * The key each cap is checked with. Keyed by every cap of the deps, so the
 * type checker refuses a cap left out.
 */
const CAP_KEYS: Record<CapField, string> = {
  profileSwitchCap: "acc_1",
  emailChangeBeginCap: "acc_1",
  recoveryLinkAddressCap: "rsk_1",
  recoveryResendCap: "acc_1",
  recoveryLinkCeiling: "prb_1",
  registrationSendCap: "prb_1",
  registrationFirstLinkCap: "prb_1",
  stepUpLinkCeiling: "acc_1",
  linkResendCap: "prb_1",
};

let privB64 = "";
let pubB64 = "";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  privB64 = b64(await exportJWK(privateKey));
  pubB64 = b64(await exportJWK(publicKey));
});

function nonLocalEnv(over: Partial<Record<string, string>> = {}): EnvVars {
  return {
    OSN_ENV: "production",
    OSN_ISSUER_URL: "https://id.musubi.social",
    OSN_CORS_ORIGIN: "https://host.cireweddings.com",
    OSN_ORIGIN: "https://host.cireweddings.com",
    OSN_RP_ID: "cireweddings.com",
    OSN_JWT_PRIVATE_KEY: privB64,
    OSN_JWT_PUBLIC_KEY: pubB64,
    OSN_SESSION_IP_PEPPER: "x".repeat(32),
    OSN_PAIRWISE_SALT: "p".repeat(32),
    INTERNAL_SERVICE_SECRET: "i".repeat(32),
    OSN_TOTP_ENCRYPTION_KEY: Buffer.from("t".repeat(32)).toString("base64"),
    ...over,
  };
}

function parts(over: Partial<BuildParts> = {}): BuildParts {
  return {
    coordination: () => createInMemoryCoordination(),
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

describe("buildAppDeps client-IP trust", () => {
  it("trustCloudflare=true → clientIpConfig trusts cf-connecting-ip exclusively", async () => {
    const built = await buildAppDeps(nonLocalEnv(), parts({ trustCloudflare: true }));
    expect(built.deps.clientIpConfig).toEqual({ trustCloudflare: true });
    // The unconfigured proxy-count warning does not apply under Cloudflare.
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

describe("buildAppDeps native rate-limit binding selection", () => {
  it("no bindings → all auth limiters stay on the coordination store", async () => {
    const bundle = createInMemoryCoordination();
    const built = await buildAppDeps(nonLocalEnv(), parts({ coordination: () => bundle }));
    expect(typeof built.deps.authRateLimiters.registerBegin.check).toBe("function");
    expect(await built.deps.authRateLimiters.registerBegin.check("1.2.3.4")).toBe(true);
    // Each limiter is the bundle's own, so its budget is the one every isolate
    // shares.
    for (const key of Object.keys(bundle.authRateLimiters) as (keyof AuthRateLimiters)[]) {
      expect(built.deps.authRateLimiters[key]).toBe(bundle.authRateLimiters[key]);
    }
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

  it("bindings present → 1-hour per-IP limiters stay on the coordination store", async () => {
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

  it("per-user limiters move onto the RL_USER tiers; the per-account caps never move", async () => {
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
          RL_USER_20_60: binding,
          RL_USER_60_60: binding,
        },
      }),
    );
    await built.deps.graphRateLimiter.check("usr_1");
    await built.deps.orgRateLimiter.check("usr_1");
    await built.deps.recommendationRateLimiters.suggest.check("usr_1");
    await built.deps.recommendationRateLimiters.search.check("usr_1");
    await built.deps.profileRateLimiters.profileCreate.check("9.9.9.9");
    await built.deps.accountExportIpLimiter.check("9.9.9.9");
    await built.deps.accountErasureRateLimiters.accountDeletionStatus.check("9.9.9.9");
    expect(seen).toEqual([
      "graph.write:usr_1",
      "org.write:usr_1",
      "recs.read:usr_1",
      "recs.search:usr_1",
      "profile.create:9.9.9.9",
      "account.export_ip:9.9.9.9",
      "account.deletion_status:9.9.9.9",
    ]);
    // The caps and the export / erasure limiters are hour- or day-windowed and
    // stay on the coordination store.
    seen.length = 0;
    for (const [field, key] of Object.entries(CAP_KEYS) as [CapField, string][]) {
      // eslint-disable-next-line no-await-in-loop -- one cap at a time
      await built.deps[field].check(key);
    }
    await built.deps.accountExportLimiter.check("acc_1");
    await built.deps.accountErasureRateLimiters.accountDelete.check("acc_1");
    expect(seen).toEqual([]);
  });
});
