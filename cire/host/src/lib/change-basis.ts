// Which change head the cached guest-list rows were read after.
//
// The two change editors save a whole draft against the head they read before
// loading its rows; the API refuses a draft whose head has moved since. Rows
// read before that head could miss a row a co-host committed, and the save
// would read it as removed, so an editor reads the head first and the rows
// after (wiki: cire-guest-event-editor, §3.2). This module lets a later visit
// skip both reads: each editor records the head it read and the exact rows
// array it then loaded for each slice. While a slice's array in its store is
// still that object, and fresh, its rows are as new as that head or newer, and
// a draft built from them may carry it. A reload or a patch replaces the array,
// and a stale mark or a drop ends the basis.
//
// Frontend code: no Effect.

export type Slice = "events" | "guests" | "households";

interface Recorded {
  readonly revision: string;
  readonly rows: readonly unknown[];
}

const bases = new Map<string, Map<Slice, Recorded>>();

/** Record that `rows` were each read after the editor read `revision`. Call
 *  only once every slice the editor asked for has loaded. */
export function recordBasis(
  weddingId: string,
  revision: string,
  rows: Partial<Record<Slice, readonly unknown[]>>,
): void {
  let wedding = bases.get(weddingId);
  if (!wedding) {
    wedding = new Map();
    bases.set(weddingId, wedding);
  }
  for (const slice of Object.keys(rows) as Slice[]) {
    const sliceRows = rows[slice];
    if (sliceRows) wedding.set(slice, { revision, rows: sliceRows });
  }
}

/**
 * The head a draft built from the slices' current rows may carry, or `null`
 * when the editor must read the head and the rows again: no basis, a slice
 * not fresh, a slice whose rows are not the array recorded, or slices read
 * after different heads.
 */
export function basisFor(
  weddingId: string,
  current: Partial<Record<Slice, { rows: readonly unknown[] | null; fresh: boolean }>>,
): string | null {
  const wedding = bases.get(weddingId);
  if (!wedding) return null;
  let revision: string | null = null;
  for (const slice of Object.keys(current) as Slice[]) {
    const now = current[slice];
    const recorded = wedding.get(slice);
    if (!now || !recorded || !now.fresh || now.rows !== recorded.rows) return null;
    if (revision !== null && revision !== recorded.revision) return null;
    revision = recorded.revision;
  }
  return revision;
}

/** Forget the wedding's basis: its rows are being released. */
export function dropBasis(weddingId: string): void {
  bases.delete(weddingId);
}

/** Test-only: forget every wedding. */
export function __resetChangeBasis(): void {
  bases.clear();
}
