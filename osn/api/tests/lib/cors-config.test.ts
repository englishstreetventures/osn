import { describe, it, expect } from "vitest";

import { assertCorsOriginsConfigured, resolveCorsOrigins } from "../../src/lib/cors-config";

describe("resolveCorsOrigins", () => {
  it("falls back to monorepo dev ports when OSN_CORS_ORIGIN is unset in a non-secure env", () => {
    expect(resolveCorsOrigins({}, false)).toEqual([
      "http://localhost:1420",
      "http://localhost:1422",
    ]);
  });

  it("returns an empty list in a secure env without OSN_CORS_ORIGIN", () => {
    expect(resolveCorsOrigins({}, true)).toEqual([]);
    expect(resolveCorsOrigins({ OSN_ENV: "production" }, true)).toEqual([]);
  });

  it("splits and trims a comma-separated OSN_CORS_ORIGIN", () => {
    expect(
      resolveCorsOrigins(
        {
          OSN_CORS_ORIGIN: "https://a.example.com, https://b.example.com , https://c.example.com",
        },
        true,
      ),
    ).toEqual(["https://a.example.com", "https://b.example.com", "https://c.example.com"]);
  });

  it("drops empty entries from a malformed OSN_CORS_ORIGIN", () => {
    expect(
      resolveCorsOrigins(
        { OSN_CORS_ORIGIN: "https://a.example.com,,  ,https://b.example.com" },
        true,
      ),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("normalises trailing slash and case so ops typos still match browser Origins (S-L2)", () => {
    expect(
      resolveCorsOrigins(
        { OSN_CORS_ORIGIN: "HTTPS://App.Example.com/, http://localhost:1420/" },
        true,
      ),
    ).toEqual(["https://app.example.com", "http://localhost:1420"]);
  });

  it("prefers an explicit OSN_CORS_ORIGIN over the local-dev fallback", () => {
    expect(resolveCorsOrigins({ OSN_CORS_ORIGIN: "http://localhost:9999" }, false)).toEqual([
      "http://localhost:9999",
    ]);
  });
});

describe("assertCorsOriginsConfigured", () => {
  it("throws in a secure (non-local) env with an empty allowlist", () => {
    expect(() => assertCorsOriginsConfigured([], true)).toThrow(/OSN_CORS_ORIGIN must be set/);
  });

  it("does not throw in local dev with an empty allowlist", () => {
    expect(() => assertCorsOriginsConfigured([], false)).not.toThrow();
  });

  it("does not throw when the allowlist is populated", () => {
    expect(() => assertCorsOriginsConfigured(["https://app.example.com"], true)).not.toThrow();
  });
});
