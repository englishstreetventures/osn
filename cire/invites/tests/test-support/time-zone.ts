import { vi } from "vitest";

/**
 * Make the browser report `timeZone` as the guest's own, for the details
 * panel's "Your time" line.
 *
 * That line depends on the zone the test runner happens to be in — none is
 * pinned for either tier — so a test that renders the panel and does not pin it
 * passes in one city and fails in another. This spies on
 * `Intl.DateTimeFormat.prototype.resolvedOptions`, which is where
 * `browserTimeZone` reads it, and changes only the `timeZone` it returns; every
 * formatter that was given a zone of its own is untouched. Works in jsdom and
 * in Chromium alike. Undo with the returned function, or `vi.restoreAllMocks()`.
 */
export function pinGuestTimeZone(timeZone: string): () => void {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  const spy = vi
    .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
    .mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...original.call(this), timeZone };
    });
  return () => spy.mockRestore();
}
