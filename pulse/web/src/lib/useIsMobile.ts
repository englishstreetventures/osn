import { createSignal, onCleanup, onMount, sharedConfig } from "solid-js";

const MOBILE_BREAKPOINT = "(max-width: 640px)";

/**
 * Reactive `() => boolean` that flips when the viewport crosses the
 * mobile breakpoint. Lives outside any component so the matchMedia
 * subscription is shared across mounts. SSR-safe — returns `false`
 * when `window` is unavailable, and while hydrating starts at `false` too,
 * as the server did, taking the real value once mounted: a different first
 * value would render a branch the server's HTML does not hold.
 */
export function createIsMobile(): () => boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => false;
  }
  const mql = window.matchMedia(MOBILE_BREAKPOINT);
  const hydrating = Boolean(sharedConfig.context);
  const [isMobile, setIsMobile] = createSignal(hydrating ? false : mql.matches);
  if (hydrating) onMount(() => setIsMobile(mql.matches));
  const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
  mql.addEventListener("change", handler);
  onCleanup(() => mql.removeEventListener("change", handler));
  return isMobile;
}
