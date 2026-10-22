// What the run-sheet view decides about its rows in the browser, against the
// browser's own clock: which tasks are "coming up", when that next changes,
// and which rows are the reader's. Pure, so the view's timer and these rules
// are tested apart. Frontend code: no Effect.
import type { RunSheetItem } from "./run-sheet-store";

/** How long before a task starts it is flagged as coming up. */
export const COMING_UP_MS = 30 * 60_000;

/** A task's start, as an instant, when it has one that can be read. */
function startOf(item: RunSheetItem): number | null {
  if (item.kind !== "task" || item.status !== "open" || item.runAt === null) return null;
  const at = Date.parse(item.runAt);
  return Number.isNaN(at) ? null : at;
}

/** An open task starting within the next {@link COMING_UP_MS}, not yet
 *  started. A done task, an untimed one and an event never are. */
export function isComingUp(item: RunSheetItem, now: number): boolean {
  const start = startOf(item);
  return start !== null && now >= start - COMING_UP_MS && now < start;
}

/**
 * The next instant after `now` at which any item's "coming up" flag turns on
 * or off — when the view should look again — or null when none ever will.
 */
export function nextComingUpChange(items: readonly RunSheetItem[], now: number): number | null {
  let next: number | null = null;
  for (const item of items) {
    const start = startOf(item);
    if (start === null) continue;
    for (const edge of [start - COMING_UP_MS, start]) {
      if (edge > now && (next === null || edge < next)) next = edge;
    }
  }
  return next;
}

/** A task the reader's own seat holds, alone or with others. */
export function isOwnTask(item: RunSheetItem, viewerHostId: string | null): boolean {
  return (
    item.kind === "task" && viewerHostId !== null && item.assigneeHostIds.includes(viewerHostId)
  );
}
