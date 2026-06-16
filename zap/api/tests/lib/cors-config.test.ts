import { describe, it, expect } from "vitest";

import {
  assertCorsOriginsConfigured,
  isNonLocalEnv,
  LOCAL_DEV_CORS_ORIGINS,
  resolveCorsOrigins,
} from "../../src/lib/cors-config";

describe("cors-config (S-M2 zap)", () => {
  it("uses the explicit ZAP_CORS_ORIGIN list when set", () => {
    const origins = resolveCorsOrigins({
      ZAP_CORS_ORIGIN: "https://app.example.com, https://admin.example.com/",
    });
    expect(origins).toEqual(["https://app.example.com", "https://admin.example.com"]);
  });

  it("normalises scheme/host case and trailing slash", () => {
    const origins = resolveCorsOrigins({ ZAP_CORS_ORIGIN: "HTTPS://Foo.COM/" });
    expect(origins).toEqual(["https://foo.com"]);
  });

  it("falls back to the local dev list when unset in a local env", () => {
    expect(resolveCorsOrigins({})).toEqual([...LOCAL_DEV_CORS_ORIGINS]);
  });

  it("returns an empty list (no fallback) when unset in a non-local env", () => {
    expect(resolveCorsOrigins({ ZAP_ENV: "production" })).toEqual([]);
    expect(resolveCorsOrigins({ OSN_ENV: "production" })).toEqual([]);
  });

  it("treats unset / 'local' as local", () => {
    expect(isNonLocalEnv({})).toBe(false);
    expect(isNonLocalEnv({ ZAP_ENV: "local" })).toBe(false);
    expect(isNonLocalEnv({ OSN_ENV: "staging" })).toBe(true);
  });

  it("fails closed: throws when a non-local deploy has an empty allowlist", () => {
    expect(() => assertCorsOriginsConfigured([], true)).toThrow(/ZAP_CORS_ORIGIN must be set/);
  });

  it("permits an empty allowlist in local dev (no throw)", () => {
    expect(() => assertCorsOriginsConfigured([], false)).not.toThrow();
  });
});
