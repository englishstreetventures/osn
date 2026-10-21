// What this tab drops when it changes the schedule itself. Frontend code: no
// Effect.
import { invalidateRunSheet } from "./run-sheet-store";
import { invalidateTasks } from "./tasks-store";

/**
 * A schedule change this tab applied or reverted moved, or removed, events —
 * and with them the times of the tasks linked to them. The checklist and the
 * run sheet read again when next shown, and a read of either already in flight
 * is dropped. Called after the change commits; the push the API sends reaches
 * the wedding's other tabs.
 */
export function scheduleChanged(weddingId: string): void {
  invalidateTasks(weddingId);
  invalidateRunSheet(weddingId);
}
