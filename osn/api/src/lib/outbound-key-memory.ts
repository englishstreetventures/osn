/**
 * What one osn-api isolate remembers of its published outbound keys, so the
 * key route answers an app's ask for a key it can verify from memory and reads
 * the database at most once a minute for it, however often it is asked
 * (`routes/arc-jwks.ts`).
 *
 * Keyed only by a kid's `<uuid>.<expiry>` once a MAC osn-api holds has
 * verified it, so every key held is one osn-api minted; never by anything a
 * caller chose. A key found is held {@link FOUND_KEY_HELD_MS}: with the four
 * minutes an app keeps it, a key whose row is deleted stops being accepted
 * within five minutes. A key not found is held {@link ABSENT_KEY_HELD_MS},
 * the time an app remembers a miss. At most {@link KEY_MEMORY_MAX} keys are
 * held, about 1.4 KB each on V8; past that a key is answered from a read and
 * not held. A read that fails is not held either.
 */
import type { PublishedArcKey } from "./outbound-arc";

/** The most keys one isolate holds: above the 1,000 keys the published list serves. */
export const KEY_MEMORY_MAX = 1_024;

/** How long a key found is answered without reading again. */
export const FOUND_KEY_HELD_MS = 60_000;

/** How long a key not found is answered as absent without reading again. */
export const ABSENT_KEY_HELD_MS = 30_000;

type Held =
  | { readonly key: PublishedArcKey | null; readonly until: number }
  | { readonly reading: Promise<PublishedArcKey | null> };

/** A key, or null when none is published, and whether answering it read the database. */
export interface KeyMemoryAnswer {
  readonly key: PublishedArcKey | null;
  readonly read: boolean;
  /** True when the memory was full and the key was answered without being held. */
  readonly full: boolean;
}

/** One isolate's memory of its published keys, holding at most `max`. */
export function createOutboundKeyMemory(max: number = KEY_MEMORY_MAX) {
  const held = new Map<string, Held>();

  /** Drops every entry whose time has passed; reads in flight stay. */
  const prune = (now: number): void => {
    for (const [id, entry] of held) if ("until" in entry && entry.until <= now) held.delete(id);
  };

  return {
    /**
     * The key `id` names: from memory when held, otherwise from `read`, which
     * callers asking for the same id meanwhile share.
     */
    async answer(
      id: string,
      read: () => Promise<PublishedArcKey | null>,
    ): Promise<KeyMemoryAnswer> {
      const entry = held.get(id);
      if (entry) {
        if ("reading" in entry) return { key: await entry.reading, read: false, full: false };
        if (entry.until > Date.now()) return { key: entry.key, read: false, full: false };
        held.delete(id);
      }
      if (held.size >= max) prune(Date.now());
      if (held.size >= max) return { key: await read(), read: true, full: true };
      const reading = read();
      const pending: Held = { reading };
      held.set(id, pending);
      try {
        const key = await reading;
        if (held.get(id) === pending) {
          held.set(id, {
            key,
            until: Date.now() + (key ? FOUND_KEY_HELD_MS : ABSENT_KEY_HELD_MS),
          });
        }
        return { key, read: true, full: false };
      } catch (error) {
        if (held.get(id) === pending) held.delete(id);
        throw error;
      }
    },
  };
}

export type OutboundKeyMemory = ReturnType<typeof createOutboundKeyMemory>;
