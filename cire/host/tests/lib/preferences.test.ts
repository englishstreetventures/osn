// @vitest-environment happy-dom
/**
 * The host portal's wiring of the shared preference and haptics helpers.
 *
 * How the helpers behave is held by `@cire/ui`'s `tests/lib/`. What holds here
 * is what only this portal decides: the two keys it stores under and no
 * others, a boot script that reads the key its preferences write, and a
 * haptics switch that reaches the haptics this portal fires.
 *
 * Each test loads fresh copies of the three modules, because the preferences
 * read storage at module scope. `navigator.vibrate` is stubbed before the
 * import, the one moment `web-haptics` reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OWN = { theme: "cire.host.theme", haptics: "cire.host.haptics" } as const;
const OTHER = { theme: "cire.vendor.theme", haptics: "cire.vendor.haptics" } as const;

async function load() {
  vi.resetModules();
  const keys = await import("../../src/lib/preference-keys");
  const preferences = await import("../../src/lib/preferences");
  const feedback = await import("../../src/lib/touch-feedback");
  return { ...keys, ...preferences, ...feedback };
}

/** Every key in storage. */
function storedKeys(): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key !== null) keys.add(key);
  }
  return keys;
}

function stubMatchMedia(light: boolean) {
  const matchMedia = vi.fn(() => ({
    matches: light,
    media: "(prefers-color-scheme: light)",
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  (window as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
}

let vibrate: ReturnType<typeof vi.fn>;
let resetHaptics: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  stubMatchMedia(false);
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", {
    configurable: true,
    writable: true,
    value: vibrate,
  });
});

afterEach(() => {
  resetHaptics?.();
  resetHaptics = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the host portal's storage keys", () => {
  it("are the host's own names", async () => {
    const { THEME_STORAGE_KEY, HAPTICS_STORAGE_KEY } = await load();
    expect(THEME_STORAGE_KEY).toBe(OWN.theme);
    expect(HAPTICS_STORAGE_KEY).toBe(OWN.haptics);
  });

  it("are the only keys a choice writes", async () => {
    const { setThemePreference, setHapticsEnabled } = await load();
    setThemePreference("light");
    setHapticsEnabled(false);
    expect(storedKeys()).toEqual(new Set([OWN.theme, OWN.haptics]));
    expect(localStorage.getItem(OWN.theme)).toBe("light");
    expect(localStorage.getItem(OWN.haptics)).toBe("off");
  });

  it("are read back on the next load", async () => {
    localStorage.setItem(OWN.theme, "light");
    localStorage.setItem(OWN.haptics, "off");
    const { themePreference, hapticsEnabled } = await load();
    expect(themePreference()).toBe("light");
    expect(hapticsEnabled()).toBe(false);
  });

  it("leave the vendor portal's keys unread", async () => {
    localStorage.setItem(OTHER.theme, "light");
    localStorage.setItem(OTHER.haptics, "off");
    const { readThemePreference, readHapticsPreference, themePreference, hapticsEnabled } =
      await load();
    expect(readThemePreference()).toBe("system");
    expect(readHapticsPreference()).toBe(true);
    expect(themePreference()).toBe("system");
    expect(hapticsEnabled()).toBe(true);
  });
});

describe("THEME_BOOT_SCRIPT", () => {
  it("paints the theme the preferences stored, over the OS", async () => {
    const { THEME_BOOT_SCRIPT, setThemePreference } = await load();
    setThemePreference("light");
    document.documentElement.removeAttribute("data-theme");
    // eslint-disable-next-line no-eval
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    stubMatchMedia(true);
    setThemePreference("dark");
    document.documentElement.removeAttribute("data-theme");
    // eslint-disable-next-line no-eval
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("touch feedback", () => {
  it("plays every name the host fires", async () => {
    const loaded = await load();
    resetHaptics = loaded.resetHaptics;
    for (const name of ["commit", "reject", "pickup", "step", "dismiss"] as const) {
      vibrate.mockClear();
      loaded.haptic(name);
      expect(vibrate).toHaveBeenCalledTimes(1);
    }
  });

  it("falls silent when the preferences switch haptics off", async () => {
    const loaded = await load();
    resetHaptics = loaded.resetHaptics;
    loaded.haptic("commit");
    expect(vibrate).toHaveBeenCalledTimes(1);
    loaded.setHapticsEnabled(false);
    loaded.haptic("commit");
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("is offered wherever there is a document", async () => {
    const { hapticsAvailable } = await load();
    expect(hapticsAvailable()).toBe(true);
  });
});
