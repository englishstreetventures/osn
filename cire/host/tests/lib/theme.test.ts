// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME,
  LIGHT_QUERY,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
} from "../../src/lib/theme-boot";

/**
 * `lib/theme.ts` reads storage and the media query at module scope — that is the
 * point of it, since the signals have to hold the right value before the first
 * component reads them. So every test loads a fresh copy of the module after
 * arranging the environment it should boot into.
 */
async function loadTheme() {
  vi.resetModules();
  return await import("../../src/lib/theme");
}

type Listener = (event: MediaQueryListEvent) => void;

/** A `matchMedia` whose result we control, and whose listeners we can fire. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches,
    media: LIGHT_QUERY,
    addEventListener: vi.fn((_: string, fn: Listener) => {
      listeners.add(fn);
    }),
    removeEventListener: vi.fn((_: string, fn: Listener) => {
      listeners.delete(fn);
    }),
  };
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal("matchMedia", matchMedia);
  (window as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
  return {
    query,
    matchMedia,
    /** Pretend the OS flipped. */
    fire(next: boolean) {
      query.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readThemePreference", () => {
  it("reads 'system' when nothing has been stored", async () => {
    const { readThemePreference } = await loadTheme();
    expect(readThemePreference()).toBe("system");
  });

  it("reads back a stored choice", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { readThemePreference } = await loadTheme();
    expect(readThemePreference()).toBe("light");
  });

  it("treats an unrecognised stored value as no choice at all", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    const { readThemePreference } = await loadTheme();
    expect(readThemePreference()).toBe("system");
  });

  it("survives a localStorage that throws, as private browsing can", async () => {
    const { readThemePreference } = await loadTheme();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readThemePreference()).toBe("system");
  });
});

describe("readHapticsPreference", () => {
  it("is on by default", async () => {
    const { readHapticsPreference } = await loadTheme();
    expect(readHapticsPreference()).toBe(true);
  });

  it("is off only for the exact stored 'off'", async () => {
    const { HAPTICS_STORAGE_KEY, readHapticsPreference } = await loadTheme();
    localStorage.setItem(HAPTICS_STORAGE_KEY, "off");
    expect(readHapticsPreference()).toBe(false);
    localStorage.setItem(HAPTICS_STORAGE_KEY, "on");
    expect(readHapticsPreference()).toBe(true);
  });

  it("stays on when storage throws", async () => {
    const { readHapticsPreference } = await loadTheme();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readHapticsPreference()).toBe(true);
  });
});

describe("systemTheme", () => {
  it("follows the light media query", async () => {
    stubMatchMedia(true);
    const { systemTheme } = await loadTheme();
    expect(systemTheme()).toBe("light");
  });

  it("falls back to the house dark when the query does not match", async () => {
    const { systemTheme } = await loadTheme();
    expect(systemTheme()).toBe(DEFAULT_THEME);
  });

  it("falls back to the house dark where matchMedia does not exist", async () => {
    vi.stubGlobal("matchMedia", undefined);
    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
    const { systemTheme } = await loadTheme();
    expect(systemTheme()).toBe(DEFAULT_THEME);
  });
});

describe("applyTheme", () => {
  it("writes the resolved theme onto the document element", async () => {
    const { applyTheme } = await loadTheme();
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("setThemePreference", () => {
  it("persists an explicit choice and paints it", async () => {
    const { setThemePreference, theme, themePreference } = await loadTheme();
    setThemePreference("light");
    expect(themePreference()).toBe("light");
    expect(theme()).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("clears the key on 'system' so a later OS change is followed", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const media = stubMatchMedia(false);
    const { setThemePreference, theme } = await loadTheme();
    setThemePreference("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(theme()).toBe(DEFAULT_THEME);
    expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_THEME);
    expect(media.matchMedia).toHaveBeenCalled();
  });

  it("still holds the choice for this tab when storage refuses it", async () => {
    const { setThemePreference, theme } = await loadTheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    setThemePreference("light");
    expect(theme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("setHapticsEnabled", () => {
  it("round-trips through storage", async () => {
    const { HAPTICS_STORAGE_KEY, hapticsEnabled, setHapticsEnabled } = await loadTheme();
    expect(hapticsEnabled()).toBe(true);
    setHapticsEnabled(false);
    expect(hapticsEnabled()).toBe(false);
    expect(localStorage.getItem(HAPTICS_STORAGE_KEY)).toBe("off");
    setHapticsEnabled(true);
    expect(localStorage.getItem(HAPTICS_STORAGE_KEY)).toBe("on");
  });

  it("keeps the choice in memory when storage refuses it", async () => {
    const { hapticsEnabled, setHapticsEnabled } = await loadTheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    setHapticsEnabled(false);
    expect(hapticsEnabled()).toBe(false);
  });
});

describe("initTheme", () => {
  it("repaints when the OS flips and the host is on 'system'", async () => {
    const media = stubMatchMedia(false);
    const { initTheme, theme } = await loadTheme();
    const stop = initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_THEME);

    media.fire(true);
    expect(theme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    stop();
  });

  it("leaves an explicit choice alone when the OS flips", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const media = stubMatchMedia(false);
    const { initTheme, theme } = await loadTheme();
    const stop = initTheme();

    media.fire(true);
    expect(theme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    stop();
  });

  it("reconciles with the OS on start, in case it changed while the page was away", async () => {
    stubMatchMedia(true);
    const { initTheme } = await loadTheme();
    const stop = initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    stop();
  });

  it("hands back a teardown that removes the listener", async () => {
    const media = stubMatchMedia(false);
    const { initTheme } = await loadTheme();
    const stop = initTheme();
    expect(media.listenerCount).toBe(1);
    stop();
    expect(media.listenerCount).toBe(0);
  });

  it("is inert, and still returns a teardown, without matchMedia", async () => {
    vi.stubGlobal("matchMedia", undefined);
    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
    const { initTheme } = await loadTheme();
    expect(() => initTheme()()).not.toThrow();
  });
});

describe("THEME_BOOT_SCRIPT", () => {
  it("uses the same storage key and media query the module does", () => {
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(LIGHT_QUERY));
  });

  it("resolves a stored choice before anything else runs", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    // eslint-disable-next-line no-eval
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("falls through to the media query when nothing is stored", () => {
    stubMatchMedia(true);
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("lands on the house dark when neither storage nor matchMedia can answer", () => {
    vi.stubGlobal("matchMedia", undefined);
    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_THEME);
  });
});
