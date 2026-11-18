import { describe, it, expect } from "vitest";

import { TABS } from "../../src/lib/tabs";

describe("tabs", () => {
  it("gives every tab a unique id", () => {
    expect(new Set(TABS.map((tab) => tab.id)).size).toBe(TABS.length);
  });
});
