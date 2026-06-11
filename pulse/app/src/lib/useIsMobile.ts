import { createSignal, onCleanup } from "solid-js";

const MOBILE_BREAKPOINT = "(max-width: 640px)";

/**
 * Reactive `() => boolean` that flips when the viewport crosses the
 * mobile breakpoint. Lives outside any component so the matchMedia
 * subscription is shared across mounts. SSR-safe — returns `false`
 * when `window` is unavailable.
 */
export function createIsMobile(): () => boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => false;
  }
  const mql = window.matchMedia(MOBILE_BREAKPOINT);
  const [isMobile, setIsMobile] = createSignal(mql.matches);
  const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
  mql.addEventListener("change", handler);
  onCleanup(() => mql.removeEventListener("change", handler));
  return isMobile;
}
