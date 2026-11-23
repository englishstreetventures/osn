// Run a read after the browser has drawn what is on screen now, so a view drawn
// from a cache shows before any request it then sends to check that cache.

/** Call `fn` in the task after the next frame. */
export function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0));
}
