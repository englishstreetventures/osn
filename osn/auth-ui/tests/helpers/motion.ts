import { afterEach, beforeEach } from "vitest";

/**
 * happy-dom reports every element's `animationName` as `""`, which Kobalte's
 * presence (solid-presence) reads as an exit animation still running. A closed
 * dialog then stays mounted in `data-closed` for good, which no browser does.
 *
 * Under this rule every animation is `none`: the reduced-motion path, where
 * `tokens.css` sets the overlay animations to `none` and a closed dialog
 * unmounts at once. Call it at the top of a test file whose views open a
 * dialog; a test about an exit that never ends adds {@link exitThatNeverEnds}
 * on top.
 */
export function withoutAnimations() {
  let style: HTMLStyleElement | undefined;
  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = "* { animation-name: none; }";
    document.head.append(style);
  });
  afterEach(() => {
    style?.remove();
    style = undefined;
  });
}

/**
 * Names an exit animation on every dialog that never ends, as in a tab the
 * browser has hidden, where Chromium runs no animation and so fires no
 * `animationend`. Outranks {@link withoutAnimations}' rule by specificity.
 * Returns the cleanup.
 */
export function exitThatNeverEnds(): () => void {
  const style = document.createElement("style");
  style.textContent = '[role="dialog"] { animation-name: exit-that-never-ends; }';
  document.head.append(style);
  return () => style.remove();
}
