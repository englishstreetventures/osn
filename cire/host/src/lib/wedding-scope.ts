// Which weddings the organiser portal has closed.
//
// A wedding is open while its dashboard is mounted and closed from the moment
// the dashboard unmounts until it is mounted again. The per-wedding stores
// (`*-store.ts`) refuse writes and loads for a closed wedding, so a request a
// torn-down view started before the organiser left cannot put that wedding's
// rows back into memory after `dropWeddingCaches` released them.
//
// A wedding nobody has opened or closed counts as open, so a store used on its
// own (every store and component test) behaves as it always has.
//
// This module imports nothing, so every store can depend on it without a cycle.

const closed = new Set<string>();

export function openWeddingScope(weddingId: string): void {
  closed.delete(weddingId);
}

export function closeWeddingScope(weddingId: string): void {
  closed.add(weddingId);
}

export function isWeddingClosed(weddingId: string): boolean {
  return closed.has(weddingId);
}

/** Test-only: the set outlives a test otherwise. */
export function __resetWeddingScope(): void {
  closed.clear();
}
