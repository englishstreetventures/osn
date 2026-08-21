import { createSignal, type Accessor, type Setter } from "solid-js";

/**
 * Preferences are per-browser and worth keeping across reloads — losing the
 * dark background every time Vite restarts is a papercut you feel forty times
 * an hour. Storage failures (private mode, disabled cookies) degrade to
 * in-memory rather than throwing.
 */
function persistedSignal<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
  override?: T,
): [Accessor<T>, Setter<T>] {
  let initial = override ?? fallback;
  try {
    // Whatever is in storage was written by an older build of this file, so it
    // may name a backdrop or viewport that no longer exists. An unchecked read
    // reaches the class maps as a missing key and paints `class="undefined"`
    // and `max-width: undefinedpx` until the user picks again.
    const stored = localStorage.getItem(key);
    if (
      override === undefined &&
      stored !== null &&
      (allowed as readonly string[]).includes(stored)
    )
      initial = stored as T;
  } catch {
    /* no storage — defaults are fine */
  }
  const [get, set] = createSignal<T>(initial);
  const wrapped = ((value: unknown) => {
    const next = set(value as never);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* no storage */
    }
    return next;
  }) as Setter<T>;
  return [get, wrapped];
}

export type Theme = "light" | "dark";
/** Kept in sync with the pre-paint script in index.html. */
export const THEME_KEY = "lab-theme";

/**
 * The theme this page should start in: `?theme=` if set, else the stored
 * preference, else light. The toggle is a click and a screenshot tool cannot
 * click, so without the parameter only one of the two themes can ever be
 * captured. Mirrors the pre-paint script in index.html, which has to make the
 * same decision before this module loads.
 */
export function readTheme(): Theme {
  const requested = requestedTheme();
  if (requested) return requested;
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const THEMES: readonly Theme[] = ["light", "dark"];

/** `?theme=` if it is set, else undefined — see the override note below. */
function requestedTheme(): Theme | undefined {
  const value = new URLSearchParams(location.search).get("theme");
  return value === "dark" || value === "light" ? value : undefined;
}

// The URL parameter has to be an override rather than a fallback. As a fallback
// a stored preference beats it, and the signal then disagrees with the class
// the pre-paint script already set: right pixels, wrong toggle state, first
// click a no-op. It also must not be written back — a screenshot run asking for
// `?theme=dark` would otherwise overwrite whatever the person had chosen.
const [theme, setThemeSignal] = persistedSignal<Theme>(
  THEME_KEY,
  "light",
  THEMES,
  requestedTheme(),
);

export { theme };

export function setTheme(next: Theme) {
  setThemeSignal(next);
  document.documentElement.classList.toggle("dark", next === "dark");
}

/** Backdrop behind the story. `app` follows the theme's own background. */
export type Backdrop = "app" | "paper" | "ink" | "grid" | "checker";
export const BACKDROPS: Backdrop[] = ["app", "paper", "ink", "grid", "checker"];
export const [backdrop, setBackdrop] = persistedSignal<Backdrop>("lab-backdrop", "app", BACKDROPS);

/** Preview widths. `full` fills the pane. */
export const VIEWPORTS = {
  full: 0,
  phone: 390,
  tablet: 768,
  laptop: 1280,
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];
export const [viewport, setViewport] = persistedSignal<ViewportName>(
  "lab-viewport",
  "full",
  VIEWPORT_NAMES,
);

/**
 * The selected story lives in the URL fragment so a reload keeps its place and
 * a link to a specific story can be pasted into a PR.
 */
export function currentHash(): string {
  const raw = location.hash.replace(/^#\/?/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    // `decodeURIComponent` throws on a stray percent (`#/%zz`). This runs at
    // module scope, so an unhandled throw here is a blank page rather than a
    // story that fails to select.
    return raw;
  }
}

const [hash, setHash] = createSignal(currentHash());
window.addEventListener("hashchange", () => setHash(currentHash()));

export { hash };

export function selectStory(id: string) {
  location.hash = `#/${id}`;
}

/** `?bare` drops the lab chrome — one story, whole window. */
export function isBare(): boolean {
  return new URLSearchParams(location.search).has("bare");
}
