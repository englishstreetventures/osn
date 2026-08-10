import { describe, it, expect } from "vitest";

import { TABS, pathForTabId, tabIdForPath } from "../../src/lib/tabs";

describe("tabs", () => {
  it("stays within the five items UITabBar shows without a More tab", () => {
    expect(TABS.length).toBeLessThanOrEqual(5);
  });

  it("gives every tab a unique id", () => {
    expect(new Set(TABS.map((tab) => tab.id)).size).toBe(TABS.length);
  });

  it("gives every tab an SF Symbol, since the native bar has no fallback", () => {
    for (const tab of TABS) {
      expect(tab.systemImage).toBeTruthy();
    }
  });

  it("maps a route to its tab", () => {
    expect(tabIdForPath("/")).toBe("home");
    expect(tabIdForPath("/calendar")).toBe("calendar");
  });

  it("reports no tab for a route that has none", () => {
    expect(tabIdForPath("/events/evt_123")).toBeUndefined();
  });

  it("maps a tab back to its route", () => {
    expect(pathForTabId("calendar")).toBe("/calendar");
  });

  it("reports no route for a tab that is only a placeholder", () => {
    expect(pathForTabId("hosting")).toBeUndefined();
  });
});
