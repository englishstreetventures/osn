// The portal's own task writes that are out, per wedding — shared by every cache
// whose rows a task write can change (the checklist's tasks, the run sheet), so
// none of them takes a read the server may have answered from before the write
// committed. Frontend code: no Effect.

/**
 * A per-wedding count of the portal's own writes in flight, and of the starts
 * and ends of them.
 *
 * A cache asks it two things about a read that lands: is a write out now
 * ({@link WriteTracker.isOut}), and did one start or end while the read was in
 * flight ({@link WriteTracker.epoch} moved)? Either way the read may predate
 * the write, and its rows would undo on screen what the organiser just did. A
 * cache registers with {@link WriteTracker.onEnd} to send the read it owes
 * once a write ends.
 */
export interface WriteTracker {
  /** Mark one write as out, and get back the function that marks it done
   *  (calling it again does nothing). */
  begin(weddingId: string): () => void;
  /** Whether any write is out for the wedding. */
  isOut(weddingId: string): boolean;
  /** How many times a write has started or ended for the wedding. */
  epoch(weddingId: string): number;
  /** Call `listener` each time a write for any wedding ends. */
  onEnd(listener: (weddingId: string) => void): () => void;
  /** Stop counting the wedding's writes as out: it has been forgotten. A write
   *  that ends later still bumps the epoch and tells the listeners. */
  forget(weddingId: string): void;
  /** Test-only: forget every wedding. */
  reset(): void;
}

export function createWriteTracker(): WriteTracker {
  const writing = new Map<string, number>();
  const epochs = new Map<string, number>();
  const listeners = new Set<(weddingId: string) => void>();
  const bump = (weddingId: string) => epochs.set(weddingId, (epochs.get(weddingId) ?? 0) + 1);
  return {
    begin(weddingId) {
      writing.set(weddingId, (writing.get(weddingId) ?? 0) + 1);
      bump(weddingId);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = (writing.get(weddingId) ?? 1) - 1;
        if (left > 0) writing.set(weddingId, left);
        else writing.delete(weddingId);
        bump(weddingId);
        for (const listener of listeners) listener(weddingId);
      };
    },
    isOut: (weddingId) => writing.has(weddingId),
    epoch: (weddingId) => epochs.get(weddingId) ?? 0,
    onEnd(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forget(weddingId) {
      writing.delete(weddingId);
    },
    reset() {
      writing.clear();
      epochs.clear();
    },
  };
}

/** The portal's checklist task writes: a create, an edit, a tick, a delete, a
 *  reorder, a starter apply, a holder put on or taken off, a run time. */
export const taskWrites = createWriteTracker();
