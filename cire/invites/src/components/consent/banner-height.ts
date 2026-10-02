import { onCleanup } from "solid-js";

/**
 * The custom property on `<html>` that holds the consent banner's height while
 * the banner is on screen, and is absent otherwise. Anything fixed or anchored
 * to the bottom of the screen reads it to stay clear of the banner: the hero's
 * scroll cue (`HeroScrollCue`) lifts itself by it.
 */
export const CONSENT_BANNER_HEIGHT_VAR = "--consent-banner-height";

/**
 * Keeps {@link CONSENT_BANNER_HEIGHT_VAR} equal to `el`'s border-box height for
 * as long as the calling owner lives, then removes it. Call it from the
 * banner's `onMount`.
 *
 * A `ResizeObserver`, not one measurement: the banner's copy wraps differently
 * at every width and again once the web fonts land. The observer reports
 * before the first paint that shows the banner, so nothing reading the value
 * is ever drawn under it.
 */
export function publishBannerHeight(el: HTMLElement): void {
  const root = document.documentElement;
  const observer = new ResizeObserver(([entry]) => {
    const height = entry?.borderBoxSize[0]?.blockSize ?? el.getBoundingClientRect().height;
    root.style.setProperty(CONSENT_BANNER_HEIGHT_VAR, `${height}px`);
  });
  observer.observe(el);
  onCleanup(() => {
    observer.disconnect();
    root.style.removeProperty(CONSENT_BANNER_HEIGHT_VAR);
  });
}
