/**
 * What one osn-api isolate remembers of its published outbound keys, so the
 * key route answers an app's ask for a key from memory and reads the database
 * at most once a minute for it, however often it is asked
 * (`routes/arc-jwks.ts`).
 *
 * Keyed by a kid's `<uuid>.<expiry>`. A key is held only when its row was
 * found, so every key held is one osn-api wrote; at most
 * {@link KEY_MEMORY_MAX}, about 1.4 KB each on V8, and past that a key is
 * answered from a read and not held. An absence is held only when the route
 * asks it to, for an id a MAC osn-api holds verified, at most
 * {@link ABSENT_MEMORY_MAX} of them in a map of their own: anyone holding a
 * kid secret can MAC ids that name no key, and those can fill only that map,
 * never push a key out. A key found is held {@link FOUND_KEY_HELD_MS} from
 * when its read started: with the four minutes an app keeps it from when its
 * fetch started, a key whose row is deleted stops being accepted within five
 * minutes. A key not found is held {@link ABSENT_KEY_HELD_MS}, the time an app
 * remembers a miss. Asks that arrive while a read runs share it for
 * {@link READ_SHARED_MS}; after that a new ask starts its own read, so a read
 * that never settles (its request cancelled) holds nothing up. A read that
 * fails is not held.
 */
import type { PublishedArcKey } from "./outbound-arc";

/** The most keys one isolate holds: above the 1,000 keys the published list serves. */
export const KEY_MEMORY_MAX = 1_024;

/** The most absences one isolate holds. */
export const ABSENT_MEMORY_MAX = 128;

/** How long a key found is answered without reading again, from when its read started. */
export const FOUND_KEY_HELD_MS = 60_000;

/** How long a key not found is answered as absent without reading again. */
export const ABSENT_KEY_HELD_MS = 30_000;

/** How long asks wait on a read another ask started before starting their own. */
export const READ_SHARED_MS = 5_000;

/** A key, or null when none is published, and whether answering it read the database. */
export interface KeyMemoryAnswer {
  readonly key: PublishedArcKey | null;
  readonly read: boolean;
  /** True when a key was found with the memory full of keys, so it was not held. */
  readonly full: boolean;
}

/** A read in flight, shared by the asks that arrive while it is young. */
interface Reading {
  readonly promise: Promise<{ key: PublishedArcKey | null; full: boolean }>;
  readonly startedAt: number;
}

/** One isolate's memory of its published keys. */
export function createOutboundKeyMemory(
  max: number = KEY_MEMORY_MAX,
  absentMax: number = ABSENT_MEMORY_MAX,
) {
  const found = new Map<string, { readonly key: PublishedArcKey; readonly until: number }>();
  const absent = new Map<string, number>();
  const reading = new Map<string, Reading>();

  /** The key or absence held for `id`, dropping one whose time has passed. */
  const heldFor = (id: string, now: number): { key: PublishedArcKey | null } | undefined => {
    const key = found.get(id);
    if (key) {
      if (key.until > now) return { key: key.key };
      found.delete(id);
    }
    const until = absent.get(id);
    if (until !== undefined) {
      if (until > now) return { key: null };
      absent.delete(id);
    }
    return undefined;
  };

  /** Drops every entry of `entries` whose time has passed. */
  const prune = <V>(entries: Map<string, V>, until: (value: V) => number, now: number): void => {
    for (const [id, value] of entries) if (until(value) <= now) entries.delete(id);
  };

  /** Holds what a read started at `startedAt` answered; says whether a key found was turned away. */
  const hold = (
    id: string,
    key: PublishedArcKey | null,
    startedAt: number,
    holdAbsence: boolean,
  ): boolean => {
    const now = Date.now();
    if (key) {
      absent.delete(id);
      if (found.size >= max && !found.has(id)) prune(found, (entry) => entry.until, now);
      if (found.size >= max && !found.has(id)) return true;
      found.set(id, { key, until: startedAt + FOUND_KEY_HELD_MS });
      return false;
    }
    if (!holdAbsence) return false;
    if (absent.size >= absentMax && !absent.has(id)) prune(absent, (until) => until, now);
    if (absent.size >= absentMax && !absent.has(id)) return false;
    absent.set(id, startedAt + ABSENT_KEY_HELD_MS);
    return false;
  };

  return {
    /** The key or absence held for `id`, if any: an answer with no read. */
    held(id: string): { key: PublishedArcKey | null } | undefined {
      return heldFor(id, Date.now());
    },

    /**
     * The key `id` names: from memory when held, otherwise from `read`, which
     * asks for the same id within {@link READ_SHARED_MS} share. A key found is
     * held; an absence only with `holdAbsence`.
     */
    async answer(
      id: string,
      read: () => Promise<PublishedArcKey | null>,
      holdAbsence: boolean,
    ): Promise<KeyMemoryAnswer> {
      const now = Date.now();
      const held = heldFor(id, now);
      if (held) return { key: held.key, read: false, full: false };
      const running = reading.get(id);
      if (running && now - running.startedAt < READ_SHARED_MS) {
        const shared = await running.promise;
        return { key: shared.key, read: false, full: false };
      }
      const startedAt = now;
      const promise = read().then((key) => ({ key, full: hold(id, key, startedAt, holdAbsence) }));
      const entry: Reading = { promise, startedAt };
      reading.set(id, entry);
      const settle = (): void => {
        if (reading.get(id) === entry) reading.delete(id);
      };
      promise.then(settle, settle);
      const answered = await promise;
      return { key: answered.key, read: true, full: answered.full };
    },
  };
}

export type OutboundKeyMemory = ReturnType<typeof createOutboundKeyMemory>;
