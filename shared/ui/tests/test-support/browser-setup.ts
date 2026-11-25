/**
 * The browser tier's one `afterEach`, loaded by the `browser` project's
 * `setupFiles` in `vitest.config.ts`. It hands the next test the page this
 * file found: every render unmounted, no dialog or popover open, `<html>` and
 * `<body>` carrying the attributes they had when the file loaded, the window
 * scrolled to the top, and media emulation back to none.
 *
 * Vitest runs `afterEach` hooks in reverse order of registration, so this one
 * runs after a test file's own, which keep only what is theirs alone: a
 * viewport, a held pointer or key, a request route, a stubbed global.
 *
 * Kobalte's menus, popovers and dialogs mark everything outside themselves
 * `aria-hidden` while open, and write and clear it from a zero-delay
 * `setTimeout` that then requests a frame. An open menu that unmounts runs
 * that once more with nothing left to keep visible, so it hides `<body>` and
 * clears it again in a second callback. When a frame falls between the two,
 * a test that starts there renders into a hidden `<body>` and a `getByRole`
 * straight after `render` finds nothing. So the hook waits a task and then a
 * frame after the unmount, and does it twice: Chrome holds a timer queued five
 * timers deep for 4ms, so a write a test queued before this hook can still
 * fire after the hook's first task.
 */

import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";
import { commands } from "vitest/browser";

type Media = { reducedMotion: "no-preference"; forcedColors: "none" };

const emulateMedia = (options: Media) =>
  (commands as unknown as { emulateMedia: (o: Media) => Promise<void> }).emulateMedia(options);

// The browser's own, taken before any test can stub them, so a test that
// replaces either cannot stall the wait.
const later = window.setTimeout.bind(window);
const frame = window.requestAnimationFrame.bind(window);

const taskThenFrame = async () => {
  await new Promise<void>((resolve) => later(resolve));
  await new Promise<void>((resolve) => frame(() => resolve()));
};

/** Resolves once every write Kobalte queued before it has landed. */
const drainOverlayWrites = async () => {
  await taskThenFrame();
  await taskThenFrame();
};

const roots = [document.documentElement, document.body];
const found = new Map(
  roots.map((el) => [el, new Map(el.getAttributeNames().map((n) => [n, el.getAttribute(n)!]))]),
);

function restoreAttributes(el: HTMLElement) {
  const attributes = found.get(el)!;
  for (const name of el.getAttributeNames()) if (!attributes.has(name)) el.removeAttribute(name);
  for (const [name, value] of attributes)
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

afterEach(async () => {
  cleanup();
  // A `showModal()` dialog or an open popover sits in the top layer, which
  // outlives the render container it was drawn from.
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
  for (const popover of document.querySelectorAll<HTMLElement>(":popover-open"))
    popover.hidePopover();
  for (const layer of document.querySelectorAll("[data-kb-top-layer]")) layer.remove();
  await Promise.all([
    drainOverlayWrites(),
    emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" }),
  ]);
  for (const el of roots) restoreAttributes(el);
  window.scrollTo(0, 0);
});
