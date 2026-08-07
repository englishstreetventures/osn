/**
 * Warm a dynamically-imported chunk while the browser is idle.
 *
 * The invite's two animation chunks are imported at the moment they are needed
 * — `UnlockReveal.motion` inside the claim handler, `Modal.motion` inside
 * `AnimatedModal`'s open transition — so their network fetch is serialised
 * AFTER the interaction the guest is waiting on. Both are on the critical path
 * of a moment that should feel instant, and both already carry a failure branch
 * precisely because that late fetch can fail.
 *
 * Prefetching them at idle removes the fetch from the interaction without
 * changing any behaviour: the call sites keep their `await import(...)` (module
 * resolution is cached, so the second import resolves from memory) and keep
 * their fallbacks (a prefetch that failed leaves them exactly as they are
 * today). This is a hint, never a dependency.
 *
 * Returns a cancel function for the case where the component unmounts before
 * the callback runs.
 */
export function prefetchOnIdle(load: () => Promise<unknown>): () => void {
  // SSR / non-DOM (the packs' unit tests import this module too).
  if (typeof window === "undefined") return () => {};

  const run = () => {
    // A prefetch is best-effort by definition: swallow the rejection so a
    // failed warm-up can never surface as an unhandled promise rejection. The
    // real import at the call site keeps its own error handling.
    void load().catch(() => {});
  };

  // `requestIdleCallback` is unsupported on Safari < 17 — a large share of a
  // wedding invite's traffic — so the timeout fallback is the common path
  // there, not a rare one.
  const ric = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  ).requestIdleCallback;

  if (typeof ric === "function") {
    // The timeout bounds how long "idle" is allowed to never arrive; on a busy
    // page the callback then runs at the next opportunity anyway.
    const handle = ric(run, { timeout: 3000 });
    return () => {
      (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(
        handle,
      );
    };
  }

  // Deliberately not 0ms: a prefetch must never compete with hydration or with
  // the hero image for the connection it is meant to be riding behind.
  const timer = window.setTimeout(run, 1500);
  return () => window.clearTimeout(timer);
}
