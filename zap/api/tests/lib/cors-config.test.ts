import { describe, it, expect } from "vitest";

import { createApp } from "../../src/app";
import {
  assertCorsPolicyConfigured,
  LOCAL_DEV_CORS_ORIGINS,
  NO_BROWSER_ORIGINS,
  resolveCorsPolicy,
} from "../../src/lib/cors-config";
import { isNonLocalEnv } from "../../src/lib/deployment-env";
import { DEFAULT_VERIFICATION } from "../../src/lib/jwks";

describe("cors-config (S-M2 zap)", () => {
  it("uses the explicit ZAP_CORS_ORIGIN list when set", () => {
    const policy = resolveCorsPolicy({
      ZAP_CORS_ORIGIN: "https://app.example.com, https://admin.example.com/",
    });
    expect(policy.origins).toEqual(["https://app.example.com", "https://admin.example.com"]);
    expect(policy.declared).toBe(true);
  });

  it("normalises scheme/host case and trailing slash", () => {
    expect(resolveCorsPolicy({ ZAP_CORS_ORIGIN: "HTTPS://Foo.COM/" }).origins).toEqual([
      "https://foo.com",
    ]);
  });

  it("falls back to the local dev list when unset in a local env", () => {
    const policy = resolveCorsPolicy({});
    expect(policy.origins).toEqual([...LOCAL_DEV_CORS_ORIGINS]);
    expect(policy.declared).toBe(false);
  });

  it("returns an undeclared empty policy when unset in a non-local env", () => {
    for (const env of [{ ZAP_ENV: "production" }, { OSN_ENV: "production" }]) {
      expect(resolveCorsPolicy(env)).toEqual({ origins: [], declared: false });
    }
  });

  it("treats unset / 'local' as local", () => {
    expect(isNonLocalEnv({})).toBe(false);
    expect(isNonLocalEnv({ ZAP_ENV: "local" })).toBe(false);
    expect(isNonLocalEnv({ OSN_ENV: "staging" })).toBe(true);
  });

  it("lets ZAP_ENV override a shared OSN_ENV", () => {
    expect(isNonLocalEnv({ ZAP_ENV: "local", OSN_ENV: "production" })).toBe(false);
    expect(isNonLocalEnv({ ZAP_ENV: "production", OSN_ENV: "local" })).toBe(true);
  });

  it("fails closed: throws when a non-local deploy never stated a policy", () => {
    expect(() =>
      assertCorsPolicyConfigured(resolveCorsPolicy({ ZAP_ENV: "production" }), true),
    ).toThrow(/ZAP_CORS_ORIGIN must be set/);
  });

  it("does NOT quietly hand a non-local deploy the localhost dev origins", () => {
    // The regression this guards: `resolveCorsOrigins` used to be called with a
    // one-key pick (`{ ZAP_CORS_ORIGIN }`), so its own tier check saw an empty
    // object, read "local", and returned the dev fallback — a non-empty list,
    // which then sailed past the fail-closed assert. A production Worker
    // allowlisted http://localhost:1420 and nothing complained.
    const policy = resolveCorsPolicy({ ZAP_ENV: "production" });
    expect(policy.origins).toEqual([]);
    expect(() => assertCorsPolicyConfigured(policy, true)).toThrow(/must be set/);
  });

  it(`accepts "${NO_BROWSER_ORIGINS}" as an explicit no-browser-origin policy`, () => {
    for (const raw of [NO_BROWSER_ORIGINS, "NONE", " none "]) {
      const policy = resolveCorsPolicy({ ZAP_ENV: "production", ZAP_CORS_ORIGIN: raw });
      expect(policy).toEqual({ origins: [], declared: true });
      expect(() => assertCorsPolicyConfigured(policy, true)).not.toThrow();
    }
  });

  it("permits an undeclared policy in local dev (no throw)", () => {
    expect(() => assertCorsPolicyConfigured(resolveCorsPolicy({}), false)).not.toThrow();
  });
});

describe("an empty allowlist actually denies (the premise NO_BROWSER_ORIGINS rests on)", () => {
  // `NO_BROWSER_ORIGINS` is only safe because `cors({ origin: [] })` sends no
  // `Access-Control-Allow-Origin` at all. If a future @elysiajs/cors treated an
  // empty array as "unset" and fell back to reflecting the request Origin, the
  // sentinel would turn the production CORS policy from "no browser" into "every
  // browser" — silently, and in exactly the deployment that uses it. This test
  // is the tripwire on that upgrade.
  it("sends no Access-Control-Allow-Origin for any Origin", async () => {
    const app = createApp({ verification: DEFAULT_VERIFICATION, corsOrigins: [] });
    for (const origin of ["https://evil.example", "http://localhost:1420"]) {
      const res = await app.handle(new Request("http://zap.test/health", { headers: { origin } }));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("still reflects an origin that IS on the allowlist", async () => {
    const app = createApp({
      verification: DEFAULT_VERIFICATION,
      corsOrigins: ["https://allowed.example"],
    });
    const res = await app.handle(
      new Request("http://zap.test/health", { headers: { origin: "https://allowed.example" } }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  });
});
