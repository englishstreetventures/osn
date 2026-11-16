import { describe, expect, it } from "vitest";

import { resolveApiUrl } from "../../src/lib/api-origin";

describe("resolveApiUrl", () => {
  it("keeps an empty value rather than skipping it", () => {
    // `??`, not `||`: an empty `PUBLIC_CIRE_API_URL=` is a misconfiguration the
    // build reports (the header rewrite cannot parse it), not a silent switch
    // to the next name.
    expect(resolveApiUrl("", "https://legacy.example.test")).toBe("");
  });
});
