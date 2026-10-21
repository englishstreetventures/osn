/**
 * The day-of run sheet's order and shape: pure, so the route's narrowing and
 * this ordering can each be tested alone.
 *
 * One list, events and tasks together, by the INSTANT each happens:
 *  1. Every item with a time, earliest first. At one instant an event goes
 *     before a task (so a task linked to one event that lands on another's
 *     start reads after that event); two events go by their schedule order,
 *     two tasks by their checklist order, then by id.
 *  2. Every item whose time is there but cannot be read, by id.
 *  3. Untimed tasks — "any time on the day" — by checklist order, then id.
 * Instants, never the text: a Kolkata time sorts between two Sydney times when
 * it happens between them.
 */

import type { DerivedRunTime } from "./run-time";

/** An event as the run sheet reads it. */
export interface RunSheetEventRow {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  timezone: string;
  venueName: string | null;
  address: string | null;
  sortOrder: number;
}

/** A task as the run sheet reads it: its time already derived. */
export interface RunSheetTaskRow extends DerivedRunTime {
  id: string;
  title: string;
  notes: string | null;
  status: "open" | "done";
  sortOrder: number;
  assigneeHostIds: readonly string[];
}

export interface RunSheetEventItem {
  kind: "event";
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  timezone: string;
  venueName: string | null;
  address: string | null;
}

export interface RunSheetTaskItem extends DerivedRunTime {
  kind: "task";
  id: string;
  title: string;
  notes: string | null;
  status: "open" | "done";
  assigneeHostIds: string[];
}

export type RunSheetItem = RunSheetEventItem | RunSheetTaskItem;

/** What a run-sheet event row answers: every field named, none spread, so a
 *  column added to the read never reaches a helper unseen. */
export function projectEvent(row: RunSheetEventRow): RunSheetEventItem {
  return {
    kind: "event",
    id: row.id,
    name: row.name,
    startAt: row.startAt,
    endAt: row.endAt,
    timezone: row.timezone,
    venueName: row.venueName,
    address: row.address,
  };
}

/** What a run-sheet task row answers, every field named. */
export function projectTask(row: RunSheetTaskRow): RunSheetTaskItem {
  return {
    kind: "task",
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    runAt: row.runAt,
    runTimezone: row.runTimezone,
    eventId: row.eventId,
    runOffsetMinutes: row.runOffsetMinutes,
    anchored: row.anchored,
    eventRemoved: row.eventRemoved,
    assigneeHostIds: [...row.assigneeHostIds],
  };
}

/** Where an item sorts: its band (timed, unreadable, untimed), its instant,
 *  events before tasks, then schedule or checklist order and id. */
interface Placed {
  band: 0 | 1 | 2;
  at: number;
  kind: 0 | 1;
  sortOrder: number;
  id: string;
  item: RunSheetItem;
}

function place(time: string | null, kind: 0 | 1, sortOrder: number, item: RunSheetItem): Placed {
  if (time === null) return { band: 2, at: 0, kind, sortOrder, id: item.id, item };
  const at = Date.parse(time);
  if (Number.isNaN(at)) return { band: 1, at: 0, kind, sortOrder: 0, id: item.id, item };
  return { band: 0, at, kind, sortOrder, id: item.id, item };
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compare(a: Placed, b: Placed): number {
  if (a.band !== b.band) return a.band - b.band;
  // Unreadable times have no instant to go by.
  if (a.band === 1) return byId(a.id, b.id);
  if (a.at !== b.at) return a.at - b.at;
  if (a.kind !== b.kind) return a.kind - b.kind;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return byId(a.id, b.id);
}

/** The run sheet's events and tasks, in its order, as their answers. */
export function orderRunSheet(
  events: readonly RunSheetEventRow[],
  tasks: readonly RunSheetTaskRow[],
): RunSheetItem[] {
  return [
    ...events.map((row) => place(row.startAt, 0, row.sortOrder, projectEvent(row))),
    ...tasks.map((row) => place(row.runAt, 1, row.sortOrder, projectTask(row))),
  ]
    .toSorted(compare)
    .map((placed) => placed.item);
}
