import { generateArcKeyPair } from "@shared/crypto";
import { createMemoryClient } from "@shared/redis";
import { exportJWK } from "jose";
import { describe, it, expect, beforeAll } from "vitest";

import { buildAppDeps, loadJwtKeyPair, parseTrustedProxyCount } from "../src/build-deps";
import { handler, type Env } from "../src/index";
import { osnLoggerLayer } from "../src/observability";
import { createTestLayer } from "./helpers/db";

/**
 * T-S1 — non-local fail-closed guardrails (the deploy-time guards). Each unit
 * below asserts a misconfigured NON-LOCAL deployment throws at construction
 * rather than silently downgrading to a weaker dev posture.
 *
 *   S-H2  loadJwtKeyPair        — missing JWT keys in non-local ⇒ throw.
 *   S-M2  buildAppDeps          — short/absent OSN_SESSION_IP_PEPPER ⇒ throw.
 *   S-L1  buildAll (via index)  — missing Upstash bindings in non-local ⇒ throw
 *                                 (surfaced as a 503 from handler.fetch).
 *   S-M34 parseTrustedProxyCount — malformed counts ⇒ throw.
 */

// A REAL ES256 JWK pair (base64-encoded JWK JSON, exactly the wrangler-secret
// shape) generated once so the pepper / Upstash guards are what fire — not a
// JWK-import failure. `loadJwtKeyPair` runs BEFORE those guards and calls
// `importKeyFromJwk`, which rejects a malformed JWK, so the fixture must be a
// genuine key.
let privB64 = "";
let pubB64 = "";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  privB64 = b64(await exportJWK(privateKey));
  pubB64 = b64(await exportJWK(publicKey));
});

function nonLocalParts() {
  return {
    redisClient: createMemoryClient(),
    dbAndEmailLayer: createTestLayer(),
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
  };
}

describe("loadJwtKeyPair non-local guard (S-H2)", () => {
  it("throws in non-local when the JWT key pair is absent", async () => {
    await expect(loadJwtKeyPair({ OSN_ENV: "production" })).rejects.toThrow(
      /OSN_JWT_PRIVATE_KEY and OSN_JWT_PUBLIC_KEY must be set/,
    );
  });

  it("does NOT throw in local when the JWT key pair is absent (ephemeral)", async () => {
    const pair = await loadJwtKeyPair({});
    expect(pair.ephemeral).toBe(true);
  });
});

describe("loadJwtKeyPair sign-usage guard (S-M4)", () => {
  it("throws when the PUBLIC JWK is pasted into the private slot", async () => {
    await expect(
      loadJwtKeyPair({ OSN_JWT_PRIVATE_KEY: pubB64, OSN_JWT_PUBLIC_KEY: pubB64 }),
    ).rejects.toThrow(/does not import as a signing key/);
  });

  it("accepts a genuine private key", async () => {
    const pair = await loadJwtKeyPair({
      OSN_JWT_PRIVATE_KEY: privB64,
      OSN_JWT_PUBLIC_KEY: pubB64,
    });
    expect(pair.ephemeral).toBeUndefined();
    expect(pair.privateKey.usages).toContain("sign");
  });
});

describe("buildAppDeps OSN_ORIGIN non-local guard (S-L5)", () => {
  it("throws in non-local when OSN_ORIGIN is absent", async () => {
    await expect(
      buildAppDeps(
        {
          OSN_ENV: "production",
          OSN_ISSUER_URL: "https://api.osn.test",
          OSN_CORS_ORIGIN: "https://app.osn.test",
          OSN_RP_ID: "osn.test",
          OSN_JWT_PRIVATE_KEY: privB64,
          OSN_JWT_PUBLIC_KEY: pubB64,
          OSN_SESSION_IP_PEPPER: "x".repeat(32),
          OSN_PAIRWISE_SALT: "p".repeat(32),
        },
        nonLocalParts(),
      ),
    ).rejects.toThrow(/OSN_ORIGIN must be set in non-local environments/);
  });
});

describe("buildAppDeps session-IP-pepper non-local guard (S-M2)", () => {
  it("throws in non-local when OSN_SESSION_IP_PEPPER is absent", async () => {
    await expect(
      buildAppDeps(
        {
          OSN_ENV: "production",
          OSN_ISSUER_URL: "https://api.osn.test",
          OSN_CORS_ORIGIN: "https://app.osn.test",
          OSN_RP_ID: "osn.test",
          OSN_JWT_PRIVATE_KEY: privB64,
          OSN_JWT_PUBLIC_KEY: pubB64,
        },
        nonLocalParts(),
      ),
    ).rejects.toThrow(/OSN_SESSION_IP_PEPPER must be set to at least 32 bytes/);
  });

  it("throws in non-local when OSN_SESSION_IP_PEPPER is too short (<32 bytes)", async () => {
    await expect(
      buildAppDeps(
        {
          OSN_ENV: "production",
          OSN_ISSUER_URL: "https://api.osn.test",
          OSN_CORS_ORIGIN: "https://app.osn.test",
          OSN_RP_ID: "osn.test",
          OSN_JWT_PRIVATE_KEY: privB64,
          OSN_JWT_PUBLIC_KEY: pubB64,
          OSN_SESSION_IP_PEPPER: "tooshort",
        },
        nonLocalParts(),
      ),
    ).rejects.toThrow(/OSN_SESSION_IP_PEPPER must be set to at least 32 bytes/);
  });
});

describe("buildAll Upstash gate non-local (S-L1)", () => {
  // The S-L1 gate lives in `buildAll` inside index.ts; we drive it through the
  // real `handler.fetch`, which fails LOUD as a 503 when the build throws.
  it("returns 503 in non-local when the Upstash bindings are missing", async () => {
    const env = {
      OSN_ENV: "production",
      DB: {} as Env["DB"],
      OSN_ISSUER_URL: "https://api.osn.test",
      OSN_CORS_ORIGIN: "https://app.osn.test",
      OSN_RP_ID: "osn.test",
      OSN_JWT_PRIVATE_KEY: privB64,
      OSN_JWT_PUBLIC_KEY: pubB64,
      OSN_SESSION_IP_PEPPER: "x".repeat(32),
      OSN_PAIRWISE_SALT: "p".repeat(32),
      // CF email present so the Upstash gate (which runs first) is the guard
      // that fires.
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_EMAIL_API_TOKEN: "tok",
      // UPSTASH_* deliberately absent.
    } as Env;

    const res = await handler.fetch(new Request("https://api.osn.test/"), env);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Worker misconfigured");
    expect(json.error).toContain("UPSTASH_REDIS_REST_URL");
    expect(json.error).toContain("UPSTASH_REDIS_REST_TOKEN");
  });
});

describe("buildAll email fail-closed + degraded opt-in (non-local)", () => {
  // Shared non-local env with every OTHER guard satisfied so the EMAIL guard is
  // the one under test. CF creds + OSN_EMAIL_OPTIONAL are toggled per case.
  function emailEnv(over: Partial<Env>): Env {
    return {
      OSN_ENV: "production",
      DB: {} as Env["DB"],
      OSN_ISSUER_URL: "https://api.osn.test",
      OSN_CORS_ORIGIN: "https://app.osn.test",
      OSN_ORIGIN: "https://app.osn.test",
      OSN_RP_ID: "osn.test",
      OSN_JWT_PRIVATE_KEY: privB64,
      OSN_JWT_PUBLIC_KEY: pubB64,
      OSN_SESSION_IP_PEPPER: "x".repeat(32),
      OSN_PAIRWISE_SALT: "p".repeat(32),
      UPSTASH_REDIS_REST_URL: "https://upstash.test",
      UPSTASH_REDIS_REST_TOKEN: "tok",
      ...over,
    } as Env;
  }

  it("creds absent + opt-in UNSET → 503 at the edge (safe default preserved)", async () => {
    const res = await handler.fetch(new Request("https://api.osn.test/"), emailEnv({}));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Worker misconfigured");
    expect(json.error).toContain("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN");
  });

  it("creds absent + OSN_EMAIL_OPTIONAL=true → boots (200), no longer 503", async () => {
    const res = await handler.fetch(
      new Request("https://api.osn.test/"),
      emailEnv({ OSN_EMAIL_OPTIONAL: "true" }),
    );
    // Boots degraded — the root route answers instead of a misconfig 503.
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; service: string };
    expect(json.status).toBe("ok");
    expect(json.service).toBe("osn-auth");
  });

  it("creds PRESENT → boots regardless of the opt-in (creds win)", async () => {
    const res = await handler.fetch(
      new Request("https://api.osn.test/"),
      emailEnv({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_EMAIL_API_TOKEN: "tok" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("parseTrustedProxyCount (S-M34)", () => {
  it("throws on a negative count", () => {
    expect(() => parseTrustedProxyCount("-1")).toThrow(/non-negative integer/);
  });

  it("throws on a non-numeric value", () => {
    expect(() => parseTrustedProxyCount("x")).toThrow(/non-negative integer/);
  });

  it("throws on a non-integer value", () => {
    expect(() => parseTrustedProxyCount("1.5")).toThrow(/non-negative integer/);
  });

  it("returns 0 for undefined / blank (default direct mode)", () => {
    expect(parseTrustedProxyCount(undefined)).toBe(0);
    expect(parseTrustedProxyCount("")).toBe(0);
    expect(parseTrustedProxyCount("   ")).toBe(0);
  });

  it("parses a valid non-negative integer", () => {
    expect(parseTrustedProxyCount("2")).toBe(2);
    expect(parseTrustedProxyCount("0")).toBe(0);
  });
});
