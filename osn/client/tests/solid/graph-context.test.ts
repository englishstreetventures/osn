import { describe, expect, it } from "vitest";

import { useGraph } from "../../src/solid/graph-context";

describe("useGraph", () => {
  it("throws when called without a GraphProvider", () => {
    // With no GraphProvider wrapping the call, useContext returns the
    // default (undefined) and useGraph() must throw a clear error.
    expect(() => useGraph()).toThrow(/GraphProvider/);
  });
});
