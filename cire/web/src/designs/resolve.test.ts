import { describe, expect, it } from "vitest";

import { resolveDesignId } from "./resolve";

describe("resolveDesignId", () => {
  it("returns a known catalog id unchanged", () => {
    expect(resolveDesignId("classic")).toBe("classic");
  });

  it("falls back to classic for an unknown id", () => {
    expect(resolveDesignId("gala")).toBe("classic");
  });

  it("falls back to classic for missing or malformed values", () => {
    expect(resolveDesignId(undefined)).toBe("classic");
    expect(resolveDesignId(null)).toBe("classic");
    expect(resolveDesignId(42)).toBe("classic");
  });
});
