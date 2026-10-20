// The checklist's writes of who holds a task: `PUT` or `DELETE
// …/tasks/:taskId/assignees/:hostId`, one seat at a time. Effect is
// deliberately NOT imported (frontend code).
import { createSignal } from "solid-js";

import type { TaskRow } from "./tasks-store";

/**
 * A task's holders with the picks still out laid over them: a seat picked off
 * leaves, and one picked on joins at the end, in the order it was picked.
 */
export function withPicks(
  holders: readonly string[],
  picks: ReadonlyMap<string, boolean | undefined> | undefined,
): string[] {
  const shown = holders.filter((id) => picks?.get(id) !== false);
  for (const [id, on] of picks ?? []) if (on && !shown.includes(id)) shown.push(id);
  return shown;
}

/** The holders with the reader's own seat first, when it is among them. */
export function readerFirst(holders: readonly string[], readerHostId: string | null): string[] {
  if (readerHostId === null || !holders.includes(readerHostId)) return [...holders];
  return [readerHostId, ...holders.filter((id) => id !== readerHostId)];
}

/**
 * Take one write's answer into the holders the cache has. A write that flew
 * alone was sent after every earlier write of its task had answered, so its
 * list is the newest there is and is taken whole — a seat a colleague put on
 * meanwhile included. One that flew beside another write of the same task may
 * have been read before that one was stored, and its answer may still arrive
 * last, so only its own seat is taken from it: every other seat stays as the
 * cache has it, in the answer's order where the answer names it.
 */
export function mergeHolders(
  cached: readonly string[],
  answered: readonly string[],
  hostId: string,
  alone: boolean,
): string[] {
  if (alone) return [...answered];
  const merged = answered.filter((id) => id === hostId || cached.includes(id));
  for (const id of cached) if (id !== hostId && !merged.includes(id)) merged.push(id);
  return merged;
}

/** Why a write the organiser still wants was refused. */
export type HolderRefusal = "not_in_wedding" | "failed";

interface HolderWritesOptions {
  /** Send one write: put the seat on the task, or take it off. */
  send: (taskId: string, hostId: string, on: boolean) => Promise<Response>;
  /** The task's holders as the cache has them, or `undefined` with no list. */
  holdersOf: (taskId: string) => readonly string[] | undefined;
  /** Replace the task's holders in the cache. */
  setHolders: (taskId: string, holders: string[]) => void;
  isAuthExpired: (err: unknown) => boolean;
  /** The session has gone: nothing more is sent. */
  onSignedOut: () => void;
  /** A 422 — the seat is not the wedding's any more — whether or not a later
   *  pick has replaced the write it refused. */
  onSeatGone: () => void;
  /** The write of a pick the organiser still wants was refused; the seat is
   *  already back as the cache has it. */
  onRefused: (why: HolderRefusal) => void;
}

/** One write on its way, and whether another write of its task flew beside it. */
interface Flight {
  alone: boolean;
}

const pairKey = (taskId: string, hostId: string) => `${taskId}\n${hostId}`;

/**
 * The queue behind the assign popover.
 *
 * A pick shows at once: it is laid over the cached holders (`shown`) rather
 * than written into them, so the cache keeps what the server last said, a
 * refused pick goes back by dropping it, and a re-read of the tasks cannot
 * wipe a pick that is still out.
 *
 * Writes go one at a time **per task and seat** — different seats go at once,
 * since each names its own row on the server and cannot undo another. A pick
 * made while its seat's write is out waits; once the write answers, the seat's
 * latest pick is written if the cache does not already agree with it, and
 * dropped if it does. A refused write the organiser has since re-picked changes
 * nothing on screen.
 */
export function createHolderWrites(options: HolderWritesOptions) {
  /** Task → seat → wanted on (`true`) or off; `undefined` once it has
   *  settled. Bounded by the seats picked on the tasks of one visit. */
  const [picks, setPicks] = createSignal<
    ReadonlyMap<string, ReadonlyMap<string, boolean | undefined>>
  >(new Map());
  const [writing, setWriting] = createSignal<ReadonlyMap<string, number>>(new Map());
  const flights = new Map<string, Set<Flight>>();
  const sending = new Set<string>();
  let signedOut = false;

  const pickOf = (taskId: string, hostId: string) => picks().get(taskId)?.get(hostId);

  const setPick = (taskId: string, hostId: string, on: boolean | undefined) =>
    setPicks((prev) => new Map(prev).set(taskId, new Map(prev.get(taskId)).set(hostId, on)));

  const countWrite = (taskId: string, by: 1 | -1) =>
    setWriting((prev) => new Map(prev).set(taskId, (prev.get(taskId) ?? 0) + by));

  const shown = (taskId: string, holders: readonly string[]) =>
    withPicks(holders, picks().get(taskId));

  /** Write the seat's pick, unless the cache already says the same. */
  const settle = (taskId: string, hostId: string) => {
    const on = pickOf(taskId, hostId);
    if (on === undefined) return;
    if (on === (options.holdersOf(taskId) ?? []).includes(hostId)) {
      setPick(taskId, hostId, undefined);
      return;
    }
    void write(taskId, hostId, on);
  };

  const write = async (taskId: string, hostId: string, on: boolean) => {
    if (signedOut) return;
    const key = pairKey(taskId, hostId);
    sending.add(key);
    const others = flights.get(taskId) ?? new Set<Flight>();
    for (const other of others) other.alone = false;
    const flight: Flight = { alone: others.size === 0 };
    others.add(flight);
    flights.set(taskId, others);
    countWrite(taskId, 1);

    let refusal: HolderRefusal | null = null;
    try {
      const res = await options.send(taskId, hostId, on);
      if (res.status === 401) signedOut = true;
      else if (res.status === 422) refusal = "not_in_wedding";
      else if (!res.ok) refusal = "failed";
      else {
        const { task } = (await res.json()) as { task: TaskRow };
        const cached = options.holdersOf(taskId);
        if (cached) {
          options.setHolders(
            taskId,
            mergeHolders(cached, task.assigneeHostIds, hostId, flight.alone),
          );
        }
      }
    } catch (err) {
      if (options.isAuthExpired(err)) signedOut = true;
      else refusal = "failed";
    } finally {
      others.delete(flight);
      if (others.size === 0) flights.delete(taskId);
      sending.delete(key);
      countWrite(taskId, -1);
    }

    if (signedOut) {
      options.onSignedOut();
      return;
    }
    if (refusal === "not_in_wedding") options.onSeatGone();
    if (pickOf(taskId, hostId) === on) {
      // Answered as asked: the cache now holds what the pick showed. Refused:
      // dropping the pick puts the seat back as the cache has it.
      setPick(taskId, hostId, undefined);
      if (refusal) options.onRefused(refusal);
      return;
    }
    // Picked again while this write was out: the later pick decides.
    settle(taskId, hostId);
  };

  return {
    /** The task's holders as the organiser sees them: the cache's, with the
     *  picks still out laid over them. Reactive. */
    shown,
    /** Is a write of this task out? Reactive. */
    busy: (taskId: string) => (writing().get(taskId) ?? 0) > 0,
    /** Put the seat on the task if it shows as off it, or take it off. */
    toggle(taskId: string, hostId: string) {
      const on = !shown(taskId, options.holdersOf(taskId) ?? []).includes(hostId);
      setPick(taskId, hostId, on);
      if (!sending.has(pairKey(taskId, hostId))) void write(taskId, hostId, on);
    },
  };
}
