import { createEffect, createSignal, onMount, type Accessor } from "solid-js";

/**
 * Hero backdrop load lifecycle, shared by every design pack's header.
 * The image fades in on `loaded`; on `error` (a 404'd / unreachable image) the
 * pack DROPS it entirely so the gradient base layer shows through, instead of
 * leaving a permanently-invisible 0-opacity <img> pinned over the gradient.
 * `pending` keeps it at 0 opacity only until the first load/error resolves.
 */
export type HeroBackdropState = "pending" | "loaded" | "error";

export interface HeroBackdrop {
  state: Accessor<HeroBackdropState>;
  /** Attach to the backdrop <img ref={…}> — powers the SSR already-loaded check. */
  setImgRef: (el: HTMLImageElement) => void;
  onLoad: () => void;
  onError: () => void;
}

export function createHeroBackdrop(src: Accessor<string | null>): HeroBackdrop {
  const [state, setState] = createSignal<HeroBackdropState>("pending");

  // SSR-hydration fix: on an SSR page the browser starts loading the server-
  // rendered <img> during HTML parse, and its `load` event commonly fires
  // BEFORE the Solid island hydrates and attaches `onLoad` — so `onLoad` would
  // never run and the image stays at opacity 0 forever. Hold a ref and, on
  // mount, check `complete && naturalWidth > 0`: if the browser already
  // finished loading, mark it loaded immediately. `onLoad`/`onError` still
  // cover the not-yet-loaded path.
  let imgEl: HTMLImageElement | undefined;
  const revealIfAlreadyLoaded = () => {
    const el = imgEl;
    if (el && el.complete && el.naturalWidth > 0) setState("loaded");
  };
  onMount(revealIfAlreadyLoaded);

  // Re-arm the lifecycle ONLY when the resolved backdrop src actually changes
  // (a new upload or a variant flip). The on-mount no-store revalidation
  // returns the SAME url, so without this guard it would reset a shown image
  // back to `pending` (opacity 0) while the <img src> stays unchanged —
  // meaning the browser never re-fires `load`, leaving it stuck invisible.
  // On a genuine src change we reset to `pending`; the new src fires a fresh
  // `load`, and the ref-check also catches an already-cached new src.
  let prevSrc: string | null | undefined;
  createEffect(() => {
    const current = src();
    if (prevSrc === undefined) {
      // First run: adopt the SSR src without forcing pending (the onMount
      // ref check owns the already-loaded case).
      prevSrc = current;
      return;
    }
    if (current !== prevSrc) {
      prevSrc = current;
      setState("pending");
      // The new src may already be in the browser cache (so no `load`
      // fires); re-check the ref after the DOM updates.
      queueMicrotask(revealIfAlreadyLoaded);
    }
  });

  return {
    state,
    setImgRef: (el) => {
      imgEl = el;
    },
    onLoad: () => setState("loaded"),
    onError: () => setState("error"),
  };
}
