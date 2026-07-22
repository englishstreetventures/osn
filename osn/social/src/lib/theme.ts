import { createSignal } from "solid-js";

// Theme handling for @osn/social.
//
// Policy: follow the system theme by default. The fallback is DARK — light is
// only ever shown when the OS explicitly asks for light, or the user opts into
// light. `prefers-color-scheme: dark` and "no preference" both resolve to dark.
//
// The synchronous mirror of `resolveTheme` in index.html sets `.dark` before
// first paint to avoid a flash; keep the two in sync.

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "osn-theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage unavailable (private mode / SSR) — fall through */
  }
  return "system";
}

/** Resolve a preference to a concrete theme. Light only on an explicit light
 *  signal (OS says light, or user opted in); everything else is dark. */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function apply(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

const [themePref, setThemePrefSignal] = createSignal<ThemePref>(readPref());

export { themePref };

/** Change the user's preference, persist it, and apply immediately. */
export function setThemePref(pref: ThemePref): void {
  setThemePrefSignal(pref);
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore write failures */
  }
  apply(resolveTheme(pref));
}

/** Apply the current preference and start reacting to OS + cross-tab changes.
 *  Call once at startup. The inline script in index.html has already applied
 *  the pre-paint theme; this re-applies (idempotent) and wires the listeners. */
export function initTheme(): void {
  apply(resolveTheme(themePref()));

  // Follow the OS while in `system` mode.
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener?.("change", () => {
    if (themePref() === "system") apply(resolveTheme("system"));
  });

  // Keep tabs in sync when the preference changes elsewhere.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const pref = readPref();
    setThemePrefSignal(pref);
    apply(resolveTheme(pref));
  });
}
