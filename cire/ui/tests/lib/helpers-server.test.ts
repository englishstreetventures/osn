import { describe, expect, it } from "vitest";

import { createHaptics } from "../../src/lib/haptics";
import { applyTheme, createPreferences, systemTheme } from "../../src/lib/theme";

/**
 * The helpers on a server, as Astro renders a portal's islands: no window, no
 * document, no `localStorage`. Each answers as a first-time visitor would and
 * touches nothing, rather than throwing out of the render.
 */
describe("the portal helpers with no browser", () => {
  it("read every preference as a first visit, and keep a teardown to hand back", () => {
    const preferences = createPreferences({ themeKey: "t.theme", hapticsKey: "t.haptics" });
    expect(preferences.readThemePreference()).toBe("system");
    expect(preferences.readHapticsPreference()).toBe(true);
    expect(systemTheme()).toBe("dark");
    expect(() => applyTheme("light")).not.toThrow();
    expect(() => preferences.initTheme()()).not.toThrow();
  });

  it("read every preference as a first visit where even naming localStorage throws", () => {
    // A browser that blocks site storage throws on the name itself, which
    // `typeof` does not stop.
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      const preferences = createPreferences({ themeKey: "t.theme", hapticsKey: "t.haptics" });
      expect(preferences.readThemePreference()).toBe("system");
      expect(preferences.readHapticsPreference()).toBe(true);
    } finally {
      if (before) Object.defineProperty(globalThis, "localStorage", before);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("offer no haptics and play none", () => {
    const haptics = createHaptics({ enabled: () => true, names: ["commit"] });
    expect(haptics.hapticsAvailable()).toBe(false);
    expect(() => haptics.haptic("commit")).not.toThrow();
  });
});
