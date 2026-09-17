/**
 * Pin the viewport the dietary picker asks about.
 *
 * `@cire/ui`'s picker forks on a `matchMedia` query: narrow renders its
 * checkboxes inline, wide collapses them behind a popover trigger. happy-dom
 * answers `matchMedia` from a 1024px window, so a test that mounts the RSVP
 * sheet and reaches straight for a checkbox finds a button instead — and the
 * failure reads as "the control is missing" rather than "the control is closed".
 *
 * Tests about the sheet's own behaviour want the narrow shell, where the
 * checkboxes are directly reachable and no popover has to be opened first.
 *
 * A whole `MediaQueryList` rather than `{ matches }` alone: the picker
 * subscribes with `addEventListener`, and a stub without one throws at mount.
 * Always restore in an `afterEach` — the window is shared across tests in a
 * file, so a leaked viewport silently changes every later assertion.
 */
export function mockViewport(wide: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    addListener: () => {},
    removeListener: () => {},
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}
