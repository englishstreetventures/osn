/**
 * Whether two versions of a sortable row differ only in `sortOrder`.
 *
 * The organiser portal's sortable lists iterate ids and look each row up by id,
 * through a memo that uses this as its `equals`. A move rewrites the stored
 * order of every row whose position changed (after a gap left by a delete, that
 * can be every row past the gap), and this keeps those rows' old objects, so
 * they move in the DOM instead of being rebuilt. Any other change gives the row
 * a new object, which rebuilds it exactly as an edit always has.
 *
 * `undefined` (a row missing from the map) equals only `undefined`.
 */
export function sameButOrder<T extends { sortOrder: number }>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (key === "sortOrder") continue;
    // SAFETY: `key` came from `Object.keys(a)`, and `hasOwn` confirms `b` has it.
    const k = key as keyof T;
    if (!Object.hasOwn(b, key) || a[k] !== b[k]) return false;
  }
  return true;
}
