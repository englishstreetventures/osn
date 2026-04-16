import { describe, expect, it } from "vitest";

import { useOrgs } from "../../src/solid/org-context";

describe("useOrgs", () => {
  it("throws when called without an OrgProvider", () => {
    // Mirrors the graph-context invariant: using the hook outside its
    // provider must fail fast rather than silently returning undefined.
    expect(() => useOrgs()).toThrow(/OrgProvider/);
  });
});
