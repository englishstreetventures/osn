/**
 * "Has this organiser met the CSV format guide yet?" — one bit, in
 * `localStorage`, shared by the events and guests import panels.
 *
 * The guide is long (three steps, a column key, per-field formatting rules) and
 * it is the difference between a first upload working and a 422. So the FIRST
 * time an organiser opens an import panel it is expanded and glows; from then on
 * it is collapsed and quiet, because by the second upload the guide is in the
 * way of the file picker.
 *
 * One bit for both sheets on purpose: the two guides share their shape (key,
 * chips, formatting tips), so an organiser who has read the events one does not
 * need the guests one thrown open at them as though it were new.
 *
 * Storage is best-effort. Private-mode Safari throws on `setItem`, and the
 * portal renders server-side where there is no `window` at all; either way the
 * honest fallback is "not seen yet" — an extra expansion is a much smaller cost
 * than a guide nobody can find.
 */

const KEY = "cire.import-help.seen.v1";

/** True once the guide has been shown expanded at least once. Never throws. */
export function hasSeenImportHelp(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember that the guide has been met, so the next mount starts collapsed. */
export function markImportHelpSeen(): void {
  try {
    globalThis.localStorage?.setItem(KEY, "1");
  } catch {
    // Storage disabled/full — the guide simply opens again next time.
  }
}

/** Test seam: forget the guide has been seen. */
export function resetImportHelpSeen(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
