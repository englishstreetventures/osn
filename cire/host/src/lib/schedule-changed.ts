// What this tab drops when it changes the schedule itself. Frontend code: no
// Effect.
import { invalidateRunSheet } from "./run-sheet-store";
import { invalidateTasks } from "./tasks-store";

/** Told of every schedule change this tab commits; see {@link onScheduleChanged}. */
const listeners = new Set<(weddingId: string) => void>();

/**
 * A schedule change this tab applied or reverted moved, or removed, events —
 * and with them the times of the tasks linked to them. The checklist and the
 * run sheet read again when next shown, and a read of either already in flight
 * is dropped. Called after the change commits; the push the API sends reaches
 * the wedding's other tabs.
 *
 * Every listener is told, unless the caller is about to reload the page
 * (`reloading`): the import and the revert do, and the new page reads the
 * wedding list itself, so a re-read started now would be thrown away.
 */
export function scheduleChanged(weddingId: string, opts: { reloading?: boolean } = {}): void {
  invalidateTasks(weddingId);
  invalidateRunSheet(weddingId);
  if (opts.reloading) return;
  for (const listener of listeners) listener(weddingId);
}

/**
 * Hear each schedule change this tab commits. The dashboard re-reads the
 * wedding list on one, since whether the events can all be dated decides the
 * guest-data warning the list carries. Returns the unsubscribe.
 */
export function onScheduleChanged(listener: (weddingId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
