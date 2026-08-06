import { createSignal } from "solid-js";

import { DEFAULT_THEME, LIGHT_QUERY, THEME_STORAGE_KEY } from "./theme-boot";

/**
 * Theme and haptics preference for the vendor portal.
 *
 * Three-state on purpose. "system" is not the same choice as "dark": a vendor
 * who has never opened the menu should follow their OS, and one who picked dark
 * at their desk should keep dark when their laptop flips to light at sunset.
 * Collapsing the two would silently convert the first into the second the
 * moment they opened the menu to look at it.
 *
 * The resolved theme is written to `data-theme` on `<html>`, which is the only
 * thing `styles/global.css` reads. Nothing else in the app knows a theme exists.
 */

export type { Theme } from "./theme-boot";
export { DEFAULT_THEME, THEME_STORAGE_KEY } from "./theme-boot";

type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";

export const HAPTICS_STORAGE_KEY = "cire.vendor.haptics";

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
 * The stored choice. Anything unrecognised — a stale value, a key another tab
 * mangled, a browser that throws on `localStorage` in private mode — reads as
 * "system", which is the same answer a first-time visitor gets.
 */
export function readThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Haptics are on unless the vendor turned them off. */
export function readHapticsPreference(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(HAPTICS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
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

const [preference, setPreferenceSignal] = createSignal<ThemePreference>(readThemePreference());
const [system, setSystem] = createSignal<Theme>(systemTheme());
const [hapticsOn, setHapticsSignal] = createSignal<boolean>(readHapticsPreference());

/** The vendor's choice, including "system". What the menu puts a tick against. */
export const themePreference = preference;

/** The theme actually on screen. What a component branches on. */
export function theme(): Theme {
  const chosen = preference();
  return chosen === "system" ? system() : chosen;
}

export const hapticsEnabled = hapticsOn;

export function setThemePreference(next: ThemePreference): void {
  setPreferenceSignal(next);
  try {
    if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private mode, or storage full. The choice still holds for this tab.
  }
  applyTheme(next === "system" ? system() : next);
}

export function setHapticsEnabled(next: boolean): void {
  setHapticsSignal(next);
  try {
    localStorage.setItem(HAPTICS_STORAGE_KEY, next ? "on" : "off");
  } catch {
    // Same as above — the tab keeps the choice, the next visit forgets it.
  }
}

/**
 * Start following the OS.
 *
 * The boot script resolved the theme once; this keeps it resolved. A vendor on
 * "system" whose machine flips at sunset should see the portal flip with it
 * without a reload. Returns its own teardown so a test can undo it.
 */
export function initTheme(): () => void {
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
}
