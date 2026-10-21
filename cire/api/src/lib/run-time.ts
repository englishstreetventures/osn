/**
 * A checklist task's time on the day, as every answer that carries a task
 * reads it.
 *
 * A task is in one of four states (the columns are `tasks.run_*`, migration
 * 0093; only `services/tasks.ts` and the schedule change in
 * `services/import.ts` write them):
 *  - untimed;
 *  - fixed: a stored instant and the zone it was set in;
 *  - linked: an event and an offset in minutes from the event's START, so the
 *    time follows the event wherever it moves, day and zone included;
 *  - frozen: its event was removed, so it kept the time it last had.
 *
 * A linked task's time is never stored: it is derived here, on every read, as
 * the event's start moved by the offset in REAL elapsed minutes and read on the
 * event's own clock. Elapsed time, not wall-clock arithmetic, so "an hour after
 * 01:30" on the morning the clocks go forward is 03:30, the instant an hour
 * later, not a 02:30 that never happens.
 */

import { formatInstantInZone, parseWallTime, zoneOffsetAt } from "./event-time";

/** How far from its event's start a linked task may be: a day either way. */
export const MAX_RUN_OFFSET_MINUTES = 1440;

/** Whether `minutes` is a whole number of minutes within a day of the start. */
export function isRunOffsetInRange(minutes: number): boolean {
  return Number.isInteger(minutes) && Math.abs(minutes) <= MAX_RUN_OFFSET_MINUTES;
}

/**
 * The time `offsetMinutes` after the event's start (before it, when negative),
 * on the event's clock: `YYYY-MM-DDTHH:MM:SS±HH:MM`. Null when the start
 * cannot be read or the zone is not a real one.
 */
export function anchoredRunAt(
  startAt: string,
  timezone: string,
  offsetMinutes: number,
): string | null {
  const start = Date.parse(startAt);
  if (Number.isNaN(start)) return null;
  return formatInstantInZone(start + offsetMinutes * 60_000, timezone);
}

/**
 * The minutes from an event's start to a clock time typed against it, read on
 * the event's clock — the offset a linked task stores. Any offset typed with
 * the clock reading is ignored, as an event's own time ignores one. A reading
 * in an hour the clocks skip is moved forward, and one in an hour they repeat
 * is its second occurrence, the choices `zoneOffsetAt` makes for an event's
 * start. Rounded to whole minutes; null when the reading, the start or the
 * zone cannot be read. Whether it is in range is the caller's to check.
 */
export function clockOffsetMinutes(startAt: string, timezone: string, at: string): number | null {
  const start = Date.parse(startAt);
  const wall = parseWallTime(at);
  if (Number.isNaN(start) || wall === null) return null;
  const offset = zoneOffsetAt(timezone, wall.date, wall.time);
  if (offset === null) return null;
  const instant = Date.parse(`${wall.date}T${wall.time}:${wall.seconds}${offset}`);
  if (Number.isNaN(instant)) return null;
  return Math.round((instant - start) / 60_000);
}

/** The run-time columns of a `tasks` row. */
export interface RunTimeColumns {
  runAt: string | null;
  runTimezone: string | null;
  eventId: string | null;
  runOffsetMinutes: number | null;
  eventRemovedAt: Date | null;
}

/** What a linked task's time is counted from. */
export interface EventTime {
  startAt: string;
  timezone: string;
}

/** A task's time as every answer carries it. */
export interface DerivedRunTime {
  /** When the task runs, `YYYY-MM-DDTHH:MM:SS±HH:MM`, or null when untimed. */
  runAt: string | null;
  /** The zone `runAt` is read in: the event's, for a linked task. */
  runTimezone: string | null;
  /** The event the task is linked to, or null. */
  eventId: string | null;
  /** Minutes from the event's start, negative before it; linked tasks only. */
  runOffsetMinutes: number | null;
  /** Linked to an event that was read: the time follows the event. */
  anchored: boolean;
  /** Its event was removed by a schedule change, and it kept its last time. */
  eventRemoved: boolean;
}

/**
 * A task's time from its row and its wedding's events (`eventsById`, which
 * must hold only that wedding's events). A link to an event not among them —
 * another wedding's, which no writer leaves, or one missing its offset — reads
 * as untimed and unlinked rather than naming an event the reader cannot see.
 */
export function deriveRunTime(
  row: RunTimeColumns,
  eventsById: ReadonlyMap<string, EventTime>,
): DerivedRunTime {
  const eventRemoved = row.eventRemovedAt !== null;
  if (row.eventId !== null) {
    const event = eventsById.get(row.eventId);
    if (event === undefined || row.runOffsetMinutes === null) {
      return {
        runAt: null,
        runTimezone: null,
        eventId: null,
        runOffsetMinutes: null,
        anchored: false,
        eventRemoved,
      };
    }
    return {
      runAt: anchoredRunAt(event.startAt, event.timezone, row.runOffsetMinutes),
      runTimezone: event.timezone,
      eventId: row.eventId,
      runOffsetMinutes: row.runOffsetMinutes,
      anchored: true,
      eventRemoved,
    };
  }
  return {
    runAt: row.runAt,
    runTimezone: row.runAt === null ? null : row.runTimezone,
    eventId: null,
    runOffsetMinutes: null,
    anchored: false,
    eventRemoved,
  };
}
