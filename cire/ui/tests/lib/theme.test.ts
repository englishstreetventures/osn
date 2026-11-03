// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_THEME, LIGHT_QUERY, themeBootScript } from "../../src/lib/theme-boot";

/** Placeholder keys: each portal passes its own, and its own tests hold them. */
const THEME_STORAGE_KEY = "test.theme";
const HAPTICS_STORAGE_KEY = "test.haptics";
const THEME_BOOT_SCRIPT = themeBootScript(THEME_STORAGE_KEY);

/**
 * `createPreferences` reads storage and the media query as it is called — that
 * is the point of it, since the signals have to hold the right value before the
 * first component reads them, and a portal calls it at module scope. So every
 * test makes a fresh set after arranging the environment it should boot into.
 */
async function loadTheme() {
  vi.resetModules();
  const module = await import("../../src/lib/theme");
  const preferences = module.createPreferences({
    themeKey: THEME_STORAGE_KEY,
    hapticsKey: HAPTICS_STORAGE_KEY,
  });
  return { ...module, ...preferences, THEME_STORAGE_KEY, HAPTICS_STORAGE_KEY };
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

describe("two sets of preferences", () => {
  it("read and write only their own keys", async () => {
    const { createPreferences } = await import("../../src/lib/theme");
    const host = createPreferences({ themeKey: "a.theme", hapticsKey: "a.haptics" });
    const vendor = createPreferences({ themeKey: "b.theme", hapticsKey: "b.haptics" });
    host.setThemePreference("light");
    vendor.setHapticsEnabled(false);
    expect({ ...localStorage }).toEqual({ "a.theme": "light", "b.haptics": "off" });
    localStorage.setItem("b.theme", "dark");
    expect(host.readThemePreference()).toBe("light");
    expect(host.readHapticsPreference()).toBe(true);
  });

  it("hold their own state", async () => {
    const { createPreferences } = await import("../../src/lib/theme");
    const one = createPreferences({ themeKey: "a.theme", hapticsKey: "a.haptics" });
    const two = createPreferences({ themeKey: "b.theme", hapticsKey: "b.haptics" });
    one.setHapticsEnabled(false);
    one.setThemePreference("light");
    expect(two.hapticsEnabled()).toBe(true);
    expect(two.themePreference()).toBe("system");
  });
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

  it("reconciles the theme it reports too, when the OS changed after the set was made", async () => {
    stubMatchMedia(false);
    const { initTheme, theme } = await loadTheme();
    expect(theme()).toBe("dark");
    stubMatchMedia(true);
    const stop = initTheme();
    expect(theme()).toBe("light");
    stop();
  });

  it("hands back a teardown that removes the listener", async () => {
    const media = stubMatchMedia(false);
    const { initTheme } = await loadTheme();
    const stop = initTheme();
    expect(media.listenerCount).toBe(1);
    expect(media.query.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    stop();
    expect(media.listenerCount).toBe(0);
    expect(media.query.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("is inert, and still returns a teardown, without matchMedia", async () => {
    vi.stubGlobal("matchMedia", undefined);
    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
    const { initTheme } = await loadTheme();
    expect(() => initTheme()()).not.toThrow();
  });
});

describe("themeBootScript", () => {
  it("is the script the host portal inlines today, byte for byte, for the host's key", () => {
    expect(themeBootScript("cire.host.theme")).toBe(
      '(function(){var p=null;try{p=localStorage.getItem("cire.host.theme")}catch(e){}var t=(p==="light"||p==="dark")?p:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",t)})()',
    );
  });

  it("reads its own key and no other", () => {
    localStorage.setItem("other.theme", "light");
    // eslint-disable-next-line no-eval
    (0, eval)(themeBootScript("mine.theme"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    localStorage.setItem("mine.theme", "light");
    // eslint-disable-next-line no-eval
    (0, eval)(themeBootScript("mine.theme"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

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
    // eslint-disable-next-line no-eval
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("lands on the house dark when neither storage nor matchMedia can answer", () => {
    vi.stubGlobal("matchMedia", undefined);
    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    // eslint-disable-next-line no-eval
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_THEME);
  });
});
