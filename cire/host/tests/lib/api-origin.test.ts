import { describe, expect, it } from "vitest";

import { LOCAL_API_URL, resolveApiUrl } from "../../src/lib/api-origin";

describe("resolveApiUrl", () => {
  it("prefers the canonical name", () => {
    expect(resolveApiUrl("https://api.example.test", "https://legacy.example.test")).toBe(
      "https://api.example.test",
    );
  });

  it("falls back to the legacy name", () => {
    expect(resolveApiUrl(undefined, "https://legacy.example.test")).toBe(
      "https://legacy.example.test",
    );
  });

  it("falls back to the local cire-api when neither is set", () => {
    expect(resolveApiUrl(undefined, undefined)).toBe(LOCAL_API_URL);
    expect(LOCAL_API_URL).toBe("http://localhost:8787");
  });

  it("keeps an empty value rather than skipping it", () => {
    // `??`, not `||`: an empty `PUBLIC_CIRE_API_URL=` is a misconfiguration the
    // build reports (the header rewrite cannot parse it), not a silent switch
    // to the next name.
    expect(resolveApiUrl("", "https://legacy.example.test")).toBe("");
  });
});
