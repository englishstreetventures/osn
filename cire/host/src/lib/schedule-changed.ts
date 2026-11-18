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
 * is dropped. Every listener is told. Called after the change commits; the
 * push the API sends reaches the wedding's other tabs.
 */
export function scheduleChanged(weddingId: string): void {
  invalidateTasks(weddingId);
  invalidateRunSheet(weddingId);
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
