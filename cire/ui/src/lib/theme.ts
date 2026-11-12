import { createSignal, type Accessor } from "solid-js";

import { DEFAULT_THEME, LIGHT_QUERY, type Theme } from "./theme-boot";

/**
 * Theme and haptics preference for a portal, under its own storage keys.
 *
 * Three-state on purpose. "system" is not the same choice as "dark": someone
 * who has never opened the menu should follow their OS, and someone who picked
 * dark at their desk should keep dark when their laptop flips to light at
 * sunset. Collapsing the two would silently convert the first into the second
 * the moment they opened the menu to look at it.
 *
 * The resolved theme is written to `data-theme` on `<html>`, which is the only
 * thing a portal's stylesheet reads. Nothing else in the app knows a theme
 * exists.
 *
 * A factory, not a module of signals: each portal keeps its own keys
 * (`cire.host.*`, `cire.vendor.*`) — `localStorage` is partitioned by origin
 * anyway, so a shared name would promise a continuity it cannot deliver — and
 * the signals have to hold the stored value before the first component reads
 * them, so the key has to arrive before they exist. A portal calls this once,
 * at module scope, and every component reads that one set.
 */

export type { Theme } from "./theme-boot";
export type ThemePreference = Theme | "system";

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/** What the OS is currently asking for. */
export function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return DEFAULT_THEME;
  }
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : DEFAULT_THEME;
}

/**
 * Write `data-theme` on `<html>`.
 *
 * Always the resolved theme, never the preference — including for "system",
 * where the attribute mirrors what the media query would have produced anyway.
 * Writing it unconditionally means one selector answers "what theme is this
 * document", for CSS, for a screenshot script, and for a test.
 */
export function applyTheme(resolved: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Run `update` inside a view transition, so the page cross-fades from its old
 * look to its new one; the portal's stylesheet times the fade. Runs `update` at
 * once where the browser has no `startViewTransition`, and for a reader who
 * asked for reduced motion: the transition's pseudo-elements escape the
 * stylesheet's reduced-motion switch, so the script has to skip it.
 *
 * While the fade runs, the browser draws the page as a snapshot and every
 * press on it lands on `<html>`. A menu still open under the fade would read
 * that press as one outside it and close. So until the fade ends a
 * `pointerdown` on `<html>` is dropped: no `pointerdown` listener after this
 * one sees it, focus stays where it was, and the press has to be made again. The
 * `click` that follows still reaches `<html>`, so this keeps open only a menu
 * that dismisses on `pointerdown`, as Kobalte's does.
 *
 * A second change, or a resize of the viewport, skips a running fade: the
 * skipped one still applies its update, and its `ready` rejects. That
 * rejection is expected, so it is handled here rather than left to surface as
 * an unhandled one.
 */
function crossfade(update: () => void): void {
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  ) {
    update();
    return;
  }
  const root = document.documentElement;
  const hold = (event: PointerEvent) => {
    if (event.target !== root) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("pointerdown", hold, true);
  const release = () => window.removeEventListener("pointerdown", hold, true);
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => {});
  transition.finished.then(release, release);
}

export interface SetThemeOptions {
  /**
   * Cross-fade the page to the new theme. Only a choice made in a portal's
   * account menu asks for it; every other caller changes the theme at once.
   */
  readonly fade?: boolean;
}

export interface PreferenceKeys {
  /** Where the theme choice is stored; the boot script must read the same key. */
  readonly themeKey: string;
  /** Where the haptics switch is stored. */
  readonly hapticsKey: string;
}

export interface Preferences {
  /**
   * The stored choice. Anything unrecognised — a stale value, a key another tab
   * mangled, a browser that throws on `localStorage` in private mode — reads as
   * "system", which is the same answer a first-time visitor gets.
   */
  readThemePreference(): ThemePreference;
  /** Haptics are on unless the person turned them off. */
  readHapticsPreference(): boolean;
  /** The choice, including "system". What the menu puts a tick against. */
  themePreference: Accessor<ThemePreference>;
  /** The theme actually on screen. What a component branches on. */
  theme(): Theme;
  hapticsEnabled: Accessor<boolean>;
  /**
   * Store the choice and show it, at once. With `fade`, the page cross-fades to
   * the new theme where the browser has view transitions and the reader has
   * not asked for reduced motion, so the new choice and theme read back a frame
   * later there; it still changes at once everywhere else.
   */
  setThemePreference(next: ThemePreference, options?: SetThemeOptions): void;
  setHapticsEnabled(next: boolean): void;
  /**
   * Start following the OS. The boot script resolved the theme once; this
   * keeps it resolved, so someone on "system" whose machine flips at sunset
   * sees the portal flip with it without a reload. Returns its own teardown so
   * a test can undo it.
   */
  initTheme(): () => void;
}

export function createPreferences(keys: PreferenceKeys): Preferences {
  // `typeof localStorage` inside the `try` too: where a browser blocks site
  // storage, reading the name itself throws.
  function readThemePreference(): ThemePreference {
    try {
      if (typeof localStorage === "undefined") return "system";
      const stored = localStorage.getItem(keys.themeKey);
      return isTheme(stored) ? stored : "system";
    } catch {
      return "system";
    }
  }

  function readHapticsPreference(): boolean {
    try {
      if (typeof localStorage === "undefined") return true;
      return localStorage.getItem(keys.hapticsKey) !== "off";
    } catch {
      return true;
    }
  }

  const [preference, setPreferenceSignal] = createSignal<ThemePreference>(readThemePreference());
  const [system, setSystem] = createSignal<Theme>(systemTheme());
  const [hapticsOn, setHapticsSignal] = createSignal<boolean>(readHapticsPreference());

  function theme(): Theme {
    const chosen = preference();
    return chosen === "system" ? system() : chosen;
  }

  return {
    readThemePreference,
    readHapticsPreference,
    themePreference: preference,
    theme,
    hapticsEnabled: hapticsOn,
    setThemePreference(next, options) {
      try {
        if (next === "system") localStorage.removeItem(keys.themeKey);
        else localStorage.setItem(keys.themeKey, next);
      } catch {
        // Private mode, or storage full. The choice still holds for this tab.
      }
      // Everything the choice changes on screen — the menu's tick, the theme
      // every component reads, `data-theme` — happens inside the cross-fade,
      // so all of it is in the new snapshot and none in the old.
      const update = () => {
        setPreferenceSignal(next);
        applyTheme(next === "system" ? system() : next);
      };
      if (options?.fade) crossfade(update);
      else update();
    },
    setHapticsEnabled(next) {
      setHapticsSignal(next);
      try {
        localStorage.setItem(keys.hapticsKey, next ? "on" : "off");
      } catch {
        // Same as above — the tab keeps the choice, the next visit forgets it.
      }
    },
    initTheme() {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const query = window.matchMedia(LIGHT_QUERY);
      const onChange = (event: MediaQueryListEvent) => {
        const next: Theme = event.matches ? "light" : DEFAULT_THEME;
        setSystem(next);
        if (preference() === "system") applyTheme(next);
      };
      query.addEventListener("change", onChange);
      // Reconcile with whatever the boot script wrote — the OS may have changed
      // between a bfcache save and the restore that revived this document.
      setSystem(systemTheme());
      applyTheme(theme());
      return () => query.removeEventListener("change", onChange);
    },
  };
}
