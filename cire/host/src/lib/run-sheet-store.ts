// A `weddingId`-keyed cache of the day-of run sheet (`GET …/run-sheet`): the
// wedding's events and timed tasks, already narrowed by the API to what the
// reader may see. A reread cache (`reread-cache.ts`) sharing the checklist's
// write tracker, because a checklist write changes the run sheet too: a read
// sent across one is dropped and sent again, and one cached before one is
// read again the next time a view opens, whether or not a push arrives.
// Frontend code: no Effect.
import { apiUrl, weddingPath } from "./api";
import { createRereadCache } from "./reread-cache";
import { taskWrites } from "./task-writes";

/** One item of an event's run of show: an `HH:MM` on the event's own clock,
 *  and what happens then. */
export interface RunOfShowLine {
  time: string;
  label: string;
}

/** An event on the run sheet: its name, times, zone, place and run of show. */
export interface RunSheetEventItem {
  kind: "event";
  id: string;
  name: string;
  startAt: string;
  /** `""` when the event states no end. */
  endAt: string;
  timezone: string;
  venueName: string | null;
  address: string | null;
  /** In the organiser's order, as stored; `guestOrder` reads it from the
   *  event's start. Empty when the event has none. */
  runOfShow: RunOfShowLine[];
}

/** A task on the run sheet, with its time and who holds it. */
export interface RunSheetTaskItem {
  kind: "task";
  id: string;
  title: string;
  notes: string | null;
  status: "open" | "done";
  /** When it runs, `YYYY-MM-DDTHH:MM:SS±HH:MM`; null for "any time on the day". */
  runAt: string | null;
  /** The zone `runAt` is read in — the event's, for a linked task. */
  runTimezone: string | null;
  /** The event it is linked to, when the reader may see it. */
  eventId: string | null;
  /** Minutes from the linked event's start, negative before it. */
  runOffsetMinutes: number | null;
  /** The time follows the linked event. */
  anchored: boolean;
  /** Its event was removed by a schedule change; it kept its time. */
  eventRemoved: boolean;
  /** The seats holding it, in the order they were put on it. */
  assigneeHostIds: string[];
}

export type RunSheetItem = RunSheetEventItem | RunSheetTaskItem;

/** A person holding one of the run sheet's tasks. No role. */
export interface RunSheetPerson {
  hostId: string;
  osnProfileId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface RunSheet {
  /** `own`: the reader's tasks only. `full`: the whole day. */
  scope: "own" | "full";
  /** The reader's own seat, for "You". */
  viewerHostId: string | null;
  /** In run-sheet order: by instant, untimed tasks last. */
  items: RunSheetItem[];
  /** Every seat holding one of `items`' tasks, and no other. */
  people: RunSheetPerson[];
}

/** A run-sheet read the API refused or failed: `status` tells a wedding below
 *  Gold (402) from a reader who lost their seat (403, 404) or a failure. */
export class RunSheetError extends Error {
  constructor(public status: number) {
    super(`run_sheet_${status}`);
    this.name = "RunSheetError";
  }
}

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

const cache = createRereadCache<RunSheet>({ writes: taskWrites, staleOnWriteEnd: true });

/** The wedding's run sheet, `null` until loaded (or after a refused read). */
export const runSheetAccessor = (weddingId: string) => cache.accessor(weddingId);

/** Load the run sheet unless a fresh one is cached. */
export const ensureRunSheetLoaded = (weddingId: string, fetcher: () => Promise<RunSheet>) =>
  cache.ensureLoaded(weddingId, fetcher);

/** Read again because a signal said the day changed; coalesces, and waits for
 *  the portal's own task writes. */
export const rereadRunSheet = (weddingId: string, fetcher: () => Promise<RunSheet>) =>
  cache.reread(weddingId, fetcher);

/** The tab was told the day may have changed, and no run sheet is open. */
export const markRunSheetStale = (weddingId: string) => cache.markStale(weddingId);

/** This tab changed the day itself (a schedule change applied or reverted). */
export const invalidateRunSheet = (weddingId: string) => cache.invalidate(weddingId);

/** Forget the wedding's run sheet. */
export const dropRunSheet = (weddingId: string) => cache.drop(weddingId);

/** Test-only: forget every run sheet. */
export const __resetRunSheetCache = () => cache.reset();

/** Read `GET …/run-sheet`; throws {@link RunSheetError} on any refusal. */
export async function fetchRunSheet(authFetch: AuthFetch, weddingId: string): Promise<RunSheet> {
  const res = await authFetch(apiUrl(weddingPath(weddingId, "/run-sheet")));
  if (!res.ok) throw new RunSheetError(res.status);
  return readRunSheet(await res.json());
}

/** A run-sheet row as it arrives: every field unchecked. */
interface ItemWire {
  kind?: unknown;
  id?: unknown;
  name?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  timezone?: unknown;
  venueName?: unknown;
  address?: unknown;
  runOfShow?: unknown;
  title?: unknown;
  notes?: unknown;
  status?: unknown;
  runAt?: unknown;
  runTimezone?: unknown;
  eventId?: unknown;
  runOffsetMinutes?: unknown;
  anchored?: unknown;
  eventRemoved?: unknown;
  assigneeHostIds?: unknown;
}

/** A person as they arrive: every field unchecked. */
interface PersonWire {
  hostId?: unknown;
  osnProfileId?: unknown;
  handle?: unknown;
  displayName?: unknown;
  avatarUrl?: unknown;
}

/** A run-sheet answer as it arrives: every field unchecked. */
interface SheetWire {
  scope?: unknown;
  viewerHostId?: unknown;
  items?: unknown;
  people?: unknown;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** A run of show as it arrives: an item without a text time and label is left
 *  out; an answer with none, or from an API older than it, is an empty one. */
function runOfShowOf(value: unknown): RunOfShowLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { time, label } = item as { time?: unknown; label?: unknown };
    return typeof time === "string" && typeof label === "string" ? [{ time, label }] : [];
  });
}

function readItem(item: unknown): RunSheetItem | null {
  if (typeof item !== "object" || item === null) return null;
  const value = item as ItemWire;
  if (typeof value.id !== "string") return null;
  if (value.kind === "event") {
    const name = text(value.name);
    const startAt = text(value.startAt);
    const timezone = text(value.timezone);
    if (name === null || startAt === null || timezone === null) return null;
    return {
      kind: "event",
      id: value.id,
      name,
      startAt,
      endAt: text(value.endAt) ?? "",
      timezone,
      venueName: text(value.venueName),
      address: text(value.address),
      runOfShow: runOfShowOf(value.runOfShow),
    };
  }
  if (value.kind === "task") {
    const title = text(value.title);
    if (title === null) return null;
    return {
      kind: "task",
      id: value.id,
      title,
      notes: text(value.notes),
      status: value.status === "done" ? "done" : "open",
      runAt: text(value.runAt),
      runTimezone: text(value.runTimezone),
      eventId: text(value.eventId),
      runOffsetMinutes: typeof value.runOffsetMinutes === "number" ? value.runOffsetMinutes : null,
      anchored: value.anchored === true,
      eventRemoved: value.eventRemoved === true,
      assigneeHostIds: strings(value.assigneeHostIds),
    };
  }
  // A kind a later API adds is left out rather than drawn as something else.
  return null;
}

function readPerson(person: unknown): RunSheetPerson | null {
  if (typeof person !== "object" || person === null) return null;
  const value = person as PersonWire;
  const hostId = text(value.hostId);
  const osnProfileId = text(value.osnProfileId);
  if (hostId === null || osnProfileId === null) return null;
  const read: RunSheetPerson = { hostId, osnProfileId };
  const handle = text(value.handle);
  const displayName = text(value.displayName);
  const avatarUrl = text(value.avatarUrl);
  if (handle !== null) read.handle = handle;
  if (displayName !== null) read.displayName = displayName;
  if (avatarUrl !== null) read.avatarUrl = avatarUrl;
  return read;
}

/**
 * A run-sheet answer as the portal keeps it. What cannot be read is left out,
 * never guessed: an item of an unknown kind or missing what a row needs, a
 * person without a seat. Anything but `full` reads as the narrower `own`.
 */
export function readRunSheet(body: unknown): RunSheet {
  const value: SheetWire = typeof body === "object" && body !== null ? (body as SheetWire) : {};
  return {
    scope: value.scope === "full" ? "full" : "own",
    viewerHostId: text(value.viewerHostId),
    items: (Array.isArray(value.items) ? value.items : [])
      .map(readItem)
      .filter((item): item is RunSheetItem => item !== null),
    people: (Array.isArray(value.people) ? value.people : [])
      .map(readPerson)
      .filter((person): person is RunSheetPerson => person !== null),
  };
}
